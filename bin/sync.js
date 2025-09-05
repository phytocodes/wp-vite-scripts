#!/usr/bin/env node
import readline from 'readline';
import { spawnSync } from 'child_process';
import 'dotenv/config';
import fs from 'fs';

// 環境変数を取得
const ENV = process.env;
const WP = ENV.WP_CLI_BIN || 'wp';

// 必須環境変数のチェック
const requiredVars = ['VITE_THEMES_DIR', 'SSH_ALIAS', 'STAGING_WP_ROOT', 'STAGING_DOMAIN', 'VITE_LOCAL_DOMAIN', 'PROD_DOMAIN'];
const missingVars = requiredVars.filter(varName => !ENV[varName]);
if (missingVars.length > 0) {
	console.error(`Error: Missing required environment variables: ${missingVars.join(', ')}`);
	console.error('Run `cp .env.example .env` and configure the values.');
	process.exit(1);
}

// 確認用関数
function ask(question) {
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});
	return new Promise((resolve) => {
		rl.question(question, (answer) => {
			rl.close();
			resolve(answer.toLowerCase());
		});
	});
}

// コマンド実行ヘルパー
const runCommand = (command, args, options = { stdio: 'inherit', shell: true }) => {
	console.log(`Executing: ${command} ${args.join(' ')}`);
	const result = spawnSync(command, args, options);
	if (result.error || result.status !== 0) {
		console.error(`Error executing: ${command} ${args.join(' ')}`);
		console.error(result.stderr ? result.stderr.toString() : 'No stderr output.');
		process.exit(1);
	}
	return result;
};

// ファイル同期
const syncFiles = (direction, localPath, remotePath, exclude = [], deleteMode = true) => {
	if (direction === 'push' && !fs.existsSync(localPath)) {
		console.error(`Error: Local path does not exist: ${localPath}`);
		process.exit(1);
	}
	if (direction === 'pull' && !fs.existsSync(localPath)) {
		fs.mkdirSync(localPath, { recursive: true });
		console.log(`Created local directory: ${localPath}`);
	}
	console.log(`\n📂 Syncing ${direction === 'push' ? 'to' : 'from'} ${remotePath}...`);

	const rsyncArgs = ['-avz', '--chmod=F644,D755', '--exclude-from', '.rsyncignore'];
	if (deleteMode) rsyncArgs.push('--delete');

	rsyncArgs.push(
		direction === 'push' ? localPath : `${ENV.SSH_ALIAS}:${remotePath}`,
		direction === 'push' ? `${ENV.SSH_ALIAS}:${remotePath}` : localPath
	);

	runCommand('rsync', rsyncArgs);
	console.log(`✅ Successfully ${direction}ed files: ${localPath}`);
};

// プラグイン状態同期
const syncPluginStatus = (direction) => {
	console.log(`\n🔄 Syncing plugin activation status...`);
	if (direction === 'push') {
		const activePlugins = runCommand(
			'npx',
			['wp-env', 'run', 'cli', 'wp', 'plugin', 'list', '--status=active', '--field=name', '--allow-root'],
			{ stdio: 'pipe' }
		).stdout.toString().trim().split('\n').join(' ');
		runCommand('ssh', [ENV.SSH_ALIAS, `cd ${ENV.STAGING_WP_ROOT} && ${WP} plugin deactivate --all && ${WP} plugin activate ${activePlugins || ''}`]);
		console.log('✅ Plugin status pushed successfully.');
	} else {
		const activePlugins = runCommand(
			'ssh',
			[ENV.SSH_ALIAS, `cd ${ENV.STAGING_WP_ROOT} && ${WP} plugin list --status=active --field=name`],
			{ stdio: 'pipe' }
		).stdout.toString().trim().split('\n').join(' ');
		runCommand('npx', ['wp-env', 'run', 'cli', 'wp', 'plugin', 'deactivate', '--all', '--allow-root']);
		if (activePlugins) {
			runCommand('npx', ['wp-env', 'run', 'cli', 'wp', 'plugin', 'activate', activePlugins, '--allow-root']);
		}
		console.log('✅ Plugin status pulled successfully.');
	}
};

// データベース同期
const syncDatabase = async (direction) => {
	console.log(`\n💾 Syncing database...`);
	const timestamp = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })
		.replace(/[-:]/g, '').replace(/[^\d]/g, '').slice(0, 14);

	if (direction === 'push') {
		const answer = await ask("Are you sure you want to overwrite the REMOTE database? (y/n) ");
		if (answer !== "y") {
			console.log("Cancelled.");
			process.exit(0);
		}

		// 1. リモートDBバックアップ
		const remoteBackupCmd = `cd ${ENV.STAGING_WP_ROOT} && ${WP} db export -`;
		const backupResult = spawnSync('ssh', [ENV.SSH_ALIAS, remoteBackupCmd], { encoding: 'utf-8', maxBuffer: 1024 * 1024 * 100 });
		if (backupResult.error || backupResult.status !== 0) {
			console.error(`❌ Error remote backup: ${backupResult.error?.message || backupResult.stderr}`);
			process.exit(1);
		}
		fs.writeFileSync(`sql/remote-backup-before-push-${timestamp}.sql`, backupResult.stdout);

		// 2. ローカルDBエクスポート
		runCommand('npx', ['wp-env', 'run', 'cli', 'wp', 'db', 'export', `sql/local-backup-${timestamp}.sql`, '--allow-root']);

		// 3. ローカルをリモートにインポート + search-replace --precise
		const latestLocalSql = fs.readdirSync('sql').filter(f => f.startsWith('local-backup-')).sort().reverse()[0];
		const localDump = fs.readFileSync(`sql/${latestLocalSql}`);
		const importCmd = `cd ${ENV.STAGING_WP_ROOT} && ${WP} db import - && ${WP} search-replace '${ENV.VITE_LOCAL_DOMAIN}' '${ENV.STAGING_DOMAIN}' --all-tables --precise`;
		const importResult = spawnSync('ssh', [ENV.SSH_ALIAS, importCmd], {
			input: localDump,
			encoding: 'utf-8',
			maxBuffer: 1024 * 1024 * 100,
		});
		if (importResult.error || importResult.status !== 0) {
			console.error(`❌ Error remote import: ${importResult.error?.message || importResult.stderr}`);
			process.exit(1);
		}
		console.log('✅ Database pushed and URLs replaced successfully.');

	} else {
		const answer = await ask("Are you sure you want to overwrite the LOCAL database? (y/n) ");
		if (answer !== "y") {
			console.log("Cancelled.");
			process.exit(0);
		}

		// 1. ローカルバックアップ
		runCommand('npx', ['wp-env', 'run', 'cli', 'wp', 'db', 'export', `sql/local-backup-before-pull-${timestamp}.sql`, '--allow-root']);

		// 2. リモートDB取得
		const remoteDumpCmd = `cd ${ENV.STAGING_WP_ROOT} && ${WP} db export -`;
		const dumpResult = spawnSync('ssh', [ENV.SSH_ALIAS, remoteDumpCmd], { encoding: 'utf-8', maxBuffer: 1024 * 1024 * 100 });
		if (dumpResult.error || dumpResult.status !== 0) {
			console.error(`❌ Error remote dump: ${dumpResult.error?.message || dumpResult.stderr}`);
			process.exit(1);
		}
		fs.writeFileSync(`sql/remote-backup-${timestamp}.sql`, dumpResult.stdout);

		// 3. ローカルにインポート + search-replace --precise
		const latestRemoteSql = fs.readdirSync('sql').filter(f => f.startsWith('remote-backup-')).sort().reverse()[0];
		runCommand('npx', ['wp-env', 'run', 'cli', 'wp', 'db', 'import', `sql/${latestRemoteSql}`, '--allow-root']);
		runCommand('npx', ['wp-env', 'run', 'cli', 'wp', 'search-replace', ENV.STAGING_DOMAIN, ENV.VITE_LOCAL_DOMAIN, '--all-tables', '--precise', '--allow-root']);
		console.log('✅ Database pulled and URLs replaced successfully.');
	}
};

// 本番用 DB エクスポート
const exportProd = () => {
	console.log('\n📦 Running pull before export...');
	syncDatabase('pull');
	runCommand('npx', ['wp-env', 'run', 'cli','wp', 'search-replace', ENV.VITE_LOCAL_DOMAIN, ENV.PROD_DOMAIN, '--all-tables', '--precise', '--export=sql/prod.sql', '--allow-root']);
	console.log('✅ Exported production SQL: sql/prod.sql');
	console.log('⚠️  NOTE: This file is for production import only. Do NOT import into local or staging.');
};

// メイン処理
const main = () => {
	if (!process.env.SSH_AUTH_SOCK) {
		console.error("Error: ssh-agent is not running. Please run `eval $(ssh-agent)` and `ssh-add`.");
		process.exit(1);
	}

	const [direction, ...args] = process.argv.slice(2);

	if (direction === 'db:export:prod') {
		exportProd();
		return;
	}

	if (!['push', 'pull'].includes(direction)) {
		console.error('Invalid direction. Use "push", "pull", or "db:export:prod".');
		process.exit(1);
	}

	// オプション解析
	const map = { t:'theme', p:'plugins', l:'languages', u:'uploads', d:'database' };
	let opts = [];
	args.forEach(arg => {
		if (arg === '--all') {
			opts = ['theme','plugins','languages','uploads','database','plugin-status'];
		} else if (arg.startsWith('-')) {
			arg.slice(1).split('').forEach(f => map[f] && opts.push(map[f]));
		}
	});
	if (opts.length === 0) {
		console.error('❌ No options specified. Use flags like -t, -pu, -d or --all');
		process.exit(1);
	}

	(async () => {
		for (const opt of opts) {
			switch (opt) {
				case 'theme':
					syncFiles(direction, `./${ENV.VITE_THEMES_DIR}/`, `${ENV.STAGING_WP_ROOT}/wp-content/themes/${ENV.VITE_THEMES_DIR}/`);
					break;
				case 'plugins':
					syncFiles(direction, './plugins/', `${ENV.STAGING_WP_ROOT}/wp-content/plugins/`, ['node_modules/', 'wp-vite-hmr/']);
					if (direction === 'push') syncPluginStatus(direction);
					break;
				case 'languages':
					syncFiles(direction, './languages/', `${ENV.STAGING_WP_ROOT}/wp-content/languages/`);
					break;
				case 'uploads':
					syncFiles(direction, './uploads/', `${ENV.STAGING_WP_ROOT}/wp-content/uploads/`, [], false);
					break;
				case 'database':
					await syncDatabase(direction);
					break;
				case 'plugin-status':
					syncPluginStatus(direction);
					break;
				default:
					console.error(`Invalid option: ${opt}`);
					process.exit(1);
			}
		}
	})();
};

main();