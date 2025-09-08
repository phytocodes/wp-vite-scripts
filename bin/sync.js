#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import minimist from "minimist";
import readline from "readline";

// -- 定数と初期設定 --
const CONFIG_FILENAME = "sync.config.json";
const DEFAULT_BACKUP_DIR = "sql";
const LOG_FILENAME = "sync.log";

// -- 設定ファイル読み込み --
const configPath = path.join(process.cwd(), CONFIG_FILENAME);
if (!fs.existsSync(configPath)) {
	console.error(`❌ ${CONFIG_FILENAME} not found. Please create one in project root.`);
	process.exit(1);
}
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

// -- ログユーティリティ（ローテーション付き） --
const logFilePath = path.join(process.cwd(), LOG_FILENAME);
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB

const log = (message) => {
	const timestamp = new Date().toISOString();
	const logMessage = `[${timestamp}] ${message}\n`;
	console.log(logMessage.trim());

	try {
		if (fs.existsSync(logFilePath)) {
			const stats = fs.statSync(logFilePath);
			if (stats.size > MAX_LOG_SIZE) {
				fs.renameSync(logFilePath, logFilePath + "." + Date.now());
			}
		}
		fs.appendFileSync(logFilePath, logMessage);
	} catch (err) {
		console.error("❌ Failed to write log:", err.message);
	}
};

// -- ユーティリティ --
const ask = (q) => {
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	return new Promise((resolve) =>
		rl.question(q, (ans) => {
			rl.close();
			resolve(ans.trim().toLowerCase());
		})
	);
};

const confirm = async ({ message, expected }) => {
	const ans = await ask(message);
	return ans === expected.toLowerCase();
};

const runAsync = (cmd, args = [], opts = {}) => {
	return new Promise((resolve, reject) => {
		if (opts.dryRun) {
			console.log(`[DRY-RUN] 👉 ${cmd} ${args.join(" ")}`);
			return resolve();
		}
		console.log(`👉 ${cmd} ${args.join(" ")}`);
		const proc = spawn(cmd, args, { stdio: "inherit", ...opts });
		proc.on("close", (code) =>
			code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${code}`))
		);
		proc.on("error", reject);
	});
};

const resolveBackupDir = (envName) => {
	const baseDir = path.join(process.cwd(), DEFAULT_BACKUP_DIR);
	const dir = path.join(baseDir, envName);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
};

const normalizeDomain = (urlString) => {
	try {
		return new URL(urlString).host;
	} catch {
		return urlString.replace(/^https?:\/\//, "").replace(/\/$/, "");
	}
};

// -- 環境解決 --
const resolveEnvironment = (cliEnv, config, { requireExplicit = false } = {}) => {
	const envs = Object.keys(config.environments || {});

	if (cliEnv) {
		if (!envs.includes(cliEnv)) {
			console.error(`❌ Unknown environment "${cliEnv}". Available: ${envs.join(", ")}`);
			process.exit(1);
		}
		return cliEnv;
	}

	if (requireExplicit) {
		console.error(`❌ -e <env> is required for this command. Available: ${envs.join(", ")}`);
		process.exit(1);
	}

	if (envs.length === 1) {
		return envs[0];
	}

	console.error(`❌ -e <env> is required. Available: ${envs.join(", ")}`);
	process.exit(1);
};

// -- rsync --
const syncFiles = async (direction, env, localDir, remoteDir, exclude = [], deleteMode = true, dryRun = false) => {
	const localSource = path.resolve(localDir) + path.sep;
	const remoteSource = `${env.sshAlias}:${path.posix.join(remoteDir, "")}` + path.sep;

	// 環境ごとの exclude のみ
	const fullExclude = [...(env.exclude || []), ...exclude];

	// exclude を --exclude=pattern として展開
	const rsyncArgs = [
		"-avz",
		"--no-perms",
		"--chmod=F644,D755",
		"--progress",
		...fullExclude.map((p) => `--exclude=${p}`)
	];
	if (deleteMode) rsyncArgs.push("--delete");

	if (direction === "push") {
		if (!fs.existsSync(localSource)) {
			console.error(`❌ Local path not found: ${localSource}`);
			process.exit(1);
		}
		await runAsync("rsync", [...rsyncArgs, localSource, remoteSource], { dryRun });
	} else {
		if (!fs.existsSync(localSource)) {
			fs.mkdirSync(localSource, { recursive: true });
		}
		await runAsync("rsync", [...rsyncArgs, remoteSource, localSource], { dryRun });
	}
	log(`✅ File sync (${direction}) complete for ${localDir}.`);
};


// -- DB helpers --
const pipeProcesses = (srcCmd, srcArgs, snkCmd, snkArgs, dryRun = false) => {
	if (dryRun) {
		console.log(`[DRY-RUN] 👉 ${srcCmd} ${srcArgs.join(" ")} -> ${snkCmd} ${snkArgs.join(" ")}`);
		return Promise.resolve();
	}
	return new Promise((resolve, reject) => {
		const src = spawn(srcCmd, srcArgs, { stdio: ["ignore", "pipe", "pipe"] });
		const snk = spawn(snkCmd, snkArgs, { stdio: ["pipe", "inherit", "pipe"] });

		src.stdout.pipe(snk.stdin);
		src.stderr.pipe(process.stderr);
		snk.stderr.pipe(process.stderr);

		let srcExited = false, snkExited = false, errorOccurred = false;

		const checkExit = () => {
			if (srcExited && snkExited && !errorOccurred) resolve();
		};

		src.on("close", (code) => {
			srcExited = true;
			if (code !== 0 && !errorOccurred) {
				errorOccurred = true;
				return reject(new Error(`Source exited with code ${code}`));
			}
			checkExit();
		});

		snk.on("close", (code) => {
			snkExited = true;
			if (code !== 0 && !errorOccurred) {
				errorOccurred = true;
				return reject(new Error(`Sink exited with code ${code}`));
			}
			checkExit();
		});

		src.on("error", (err) => { if (!errorOccurred) { errorOccurred = true; reject(err); }});
		snk.on("error", (err) => { if (!errorOccurred) { errorOccurred = true; reject(err); }});
	});
};

const exportLocalDB = async (wpBin, dumpPath, dryRun = false) => {
	if (dryRun) {
		console.log(`[DRY-RUN] 👉 Exporting local DB to ${dumpPath}`);
		return;
	}
	try {
		await new Promise((resolve, reject) => {
			const args = [...wpBin.split(" "), "db", "export", "-", "--allow-root", "--single-transaction", "--quick"];
			const proc = spawn(args[0], args.slice(1), { stdio: ["ignore", "pipe", "inherit"] });
			const out = fs.createWriteStream(dumpPath);
			proc.stdout.pipe(out);
			proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`wp export failed with code ${code}`))));
			proc.on("error", reject);
		});
	} catch (err) {
		console.error(`❌ Local export failed: ${err.message}`);
		process.exit(1);
	}
};

const exportRemoteDB = async (env, dumpPath, dryRun = false, replaceDomain = false) => {
	if (dryRun) {
		console.log(`[DRY-RUN] 👉 Exporting remote DB to ${dumpPath}`);
		return;
	}
	try {
		await new Promise((resolve, reject) => {
			let wpCmd;
			if (replaceDomain) {
				const remoteDomain = normalizeDomain(env.domain);
				wpCmd = `${env.wpBin || "wp"} search-replace '${remoteDomain}' '${normalizeDomain(replaceDomain)}' --all-tables --export=-`;
			} else {
				wpCmd = `${env.wpBin || "wp"} db export - --single-transaction --quick`;
			}
			const cmd = "ssh";
			const args = [env.sshAlias, `cd ${env.wpRoot} && ${wpCmd}`];
			const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "inherit"] });
			const out = fs.createWriteStream(dumpPath);
			proc.stdout.pipe(out);
			proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`SSH export failed with code ${code}`))));
			proc.on("error", reject);
		});
	} catch (err) {
		console.error(`❌ Remote export failed: ${err.message}`);
		process.exit(1);
	}
};

// -- DB Sync --
const syncDatabase = async (direction, envName, env, localDomain, remoteDomain, dryRun = false) => {
	const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
	const localBackupDir = resolveBackupDir("local");
	const remoteBackupDir = resolveBackupDir(envName);

	const wpBinLocal = config.environments.local?.wpBin || config.wpBin || "wp";
	const wpOptions = [
		"--precise", "--recurse-objects", "--skip-columns=guid",
		"--report-changed-only", "--skip-plugins", "--skip-themes",
		"--all-tables", "--allow-root"
	];

	const multisite = config.multisite || false;
	if (multisite) wpOptions.push("--network");

	if (direction === "push") {
		const ok = await confirm({ message: "⚠️ Overwrite REMOTE DB? (y/n) ", expected: "y" });
		if (!ok) process.exit(0);

		const localDumpPath = path.join(localBackupDir, `local-backup-${ts}.sql`);
		await exportLocalDB(wpBinLocal, localDumpPath, dryRun);

		if (dryRun) return;

		console.log("👉 Piping local DB (with search-replace) to remote import...");
		await pipeProcesses(
			wpBinLocal.split(" ")[0], [...wpBinLocal.split(" ").slice(1), "search-replace", ...wpOptions, localDomain, remoteDomain, "--export"],
			"ssh", [env.sshAlias, `cd ${env.wpRoot} && ${env.wpBin || "wp"} db import -`]
		);
		log("✅ Remote DB sync (push) complete.");
	} else {
		const ok = await confirm({ message: "⚠️ Overwrite LOCAL DB? (y/n) ", expected: "y" });
		if (!ok) process.exit(0);

		const localBeforePullBackupPath = path.join(localBackupDir, `local-backup-before-pull-${ts}.sql`);
		await exportLocalDB(wpBinLocal, localBeforePullBackupPath, dryRun);

		const remoteBackupPath = path.join(remoteBackupDir, `remote-backup-${ts}.sql`);
		console.log("👉 Exporting remote DB to backup...");
		await exportRemoteDB(env, remoteBackupPath, dryRun);

		if (dryRun) return;

		const transformedPath = path.join(localBackupDir, `transformed-${ts}.sql`);
		console.log("👉 Performing search-replace on exported DB...");
		await runAsync(wpBinLocal.split(" ")[0], [...wpBinLocal.split(" ").slice(1), "search-replace", ...wpOptions, remoteDomain, localDomain, "--export=" + transformedPath]);

		console.log("👉 Importing transformed DB to local...");
		await runAsync(wpBinLocal.split(" ")[0], [...wpBinLocal.split(" ").slice(1), "db", "import", transformedPath, "--allow-root"]);
		log(`✅ Local DB sync (pull) complete. Backups retained: remote-backup-${ts}.sql, transformed-${ts}.sql.`);
	}
};

// -- ヘルプ --
const showHelp = () => {
	console.log(`
Usage:
	node sync.js push -e <env> <targets...>
	node sync.js pull -e <env> <targets...>
	node sync.js db:export -e <env>

Targets:
	themes, plugins, muplugins, languages, uploads, database

Options:
	--all      Sync all targets
	--dry-run  Test mode (rsync/WP-CLI dry-run, no changes)
	--help     Show this help

Notes:
	-e <env> can be omitted for push/pull only if exactly 1 environment is defined
	db:export always requires -e <env>.
`);
};

// -- メイン --
const main = async () => {
	const argv = minimist(process.argv.slice(2));
	const cmd = argv._[0];
	const dryRun = argv["dry-run"] || false;
	const useAll = argv.all || false;

	if (!cmd || argv.help) {
		showHelp();
		process.exit(0);
	}

	if (cmd === "push" || cmd === "pull") {
		const envName = resolveEnvironment(argv.e || argv.env, config);
		let targets = argv._.filter((arg) => arg !== envName).slice(1);

		const env = config.environments[envName];
		if (!env) {
			console.error(`❌ Unknown environment: ${envName}`);
			process.exit(1);
		}

		if (cmd === "push" && envName === "production") {
			console.log("⚠️ You are about to PUSH to PRODUCTION!");
			const ok = await confirm({ message: "Type exactly 'I WANT TO PUSH' to continue: ", expected: "i want to push" });
			if (!ok) process.exit(0);
		}

		const localFullDomain = config.environments.local?.domain;
		if (!localFullDomain) {
			console.error("❌ Local domain not defined in config.");
			process.exit(1);
		}
		const remoteFullDomain = env.domain;
		if (!remoteFullDomain) {
			console.error(`❌ Domain not defined for environment ${envName}.`);
			process.exit(1);
		}

		const localDomain = normalizeDomain(localFullDomain);
		const remoteDomain = normalizeDomain(remoteFullDomain);

		const map = {
			themes: () => syncFiles(cmd, env, "wp-content/themes", path.posix.join(env.wpRoot, "wp-content/themes/"), [], true, dryRun),
			plugins: () => syncFiles(cmd, env, "wp-content/plugins", path.posix.join(env.wpRoot, "wp-content/plugins/"), [], true, dryRun),
			muplugins: () => syncFiles(cmd, env, "wp-content/mu-plugins", path.posix.join(env.wpRoot, "wp-content/mu-plugins/"), [], true, dryRun),
			languages: () => syncFiles(cmd, env, "wp-content/languages", path.posix.join(env.wpRoot, "wp-content/languages/"), [], true, dryRun),
			uploads: () => syncFiles(cmd, env, "wp-content/uploads", path.posix.join(env.wpRoot, "wp-content/uploads/"), [], false, dryRun),
			database: () => syncDatabase(cmd, envName, env, localDomain, remoteDomain, dryRun),
		};

		if (!targets.length && !useAll) {
			console.error("❌ No sync targets specified. Use --all or list targets.");
			process.exit(1);
		}

		const selectedTargets = useAll ? Object.keys(map) : targets;

		for (const t of selectedTargets) {
			if (!map[t]) {
				console.warn(`⚠️ Unknown sync target: ${t}`);
				continue;
			}
			const allowed = env.syncOptions?.[t]?.[cmd];
			if (allowed === false) {
				console.error(`❌ ${cmd.toUpperCase()} of "${t}" is not allowed for environment "${envName}"`);
				process.exit(1);
			}
			await map[t]();
		}
	}

	if (cmd === "db:export") {
		const envName = argv.e || argv.env;

		if (!envName) {
			console.error("❌ Error: Please specify environment with -e");
			process.exit(1);
		}
		const env = config.environments[envName];
		if (!env) {
			console.error(`❌ Error: Unknown environment '${envName}'`);
			process.exit(1);
		}

		// --replace=staging または --replace staging に対応
		let replaceEnv = null;
		if (argv.replace !== undefined) {
			if (typeof argv.replace === "string") {
				replaceEnv = argv.replace;
			} else {
				console.error("❌ Error: --replace requires an environment name (e.g. --replace=staging)");
				process.exit(1);
			}
		}

		// バックアップファイルパス生成
		const dumpsDir = resolveBackupDir(envName);
		const filename = `${envName}-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}.sql`;
		const dumpPath = path.join(dumpsDir, filename);

		if (replaceEnv) {
			const targetEnv = config.environments[replaceEnv];
			if (!targetEnv) {
				console.error(`❌ Error: Unknown environment '${replaceEnv}'. Available: ${Object.keys(config.environments).join(", ")}`);
				process.exit(1);
			}
			console.log(`🔄 Replacing domain: ${env.domain} → ${targetEnv.domain}`);
			await exportRemoteDB(env, dumpPath, dryRun, targetEnv.domain);
		} else {
			await exportRemoteDB(env, dumpPath, dryRun, false);
		}

		log(`✅ Export complete: ${dumpPath}`);
	}


}

main();