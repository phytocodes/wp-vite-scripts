#!/usr/bin/env node

/**
 * @author: phytocodes
 * @see: https://github.com/phytocodes
 */

import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import readline from "readline";
import { parseArgs } from "node:util";

// -- 定数と初期設定 --
const CONFIG_FILENAME = "sync.config.json";
const DEFAULT_BACKUP_DIR = "sql";
const LOG_FILENAME = "sync.log";

// -- 設定ファイル読み込み --
const configPath = path.join(process.cwd(), CONFIG_FILENAME);
if (!fs.existsSync(configPath)) {
	fatal(`❌ ${CONFIG_FILENAME} not found. Please create one in project root.`);
}
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

// -- ログユーティリティ（ローテーション付き） --
const logFilePath = path.join(process.cwd(), LOG_FILENAME);
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_LOG_FILES = 10;

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

		// --- ログローテーション処理 ---
		const dir = path.dirname(logFilePath);
		const base = path.basename(logFilePath);
		const files = fs.readdirSync(dir)
			.filter(f => f.startsWith(base + "."))
			.sort();

		if (files.length > MAX_LOG_FILES) {
			const excess = files.slice(0, files.length - MAX_LOG_FILES);
			for (const f of excess) {
				fs.unlinkSync(path.join(dir, f));
			}
		}
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

function shellEscape(arg) {
	if (typeof arg !== "string") arg = String(arg);
	return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function fatal(msg) {
	console.error(msg);
	process.exit(1);
}

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

const resolveBackupDir = (envName, isExportReplace = false) => {
	const baseDir = path.join(process.cwd(), DEFAULT_BACKUP_DIR);
	const dir = isExportReplace
		? path.join(baseDir, "exports")
		: path.join(baseDir, envName);
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
	const allEnvs = Object.keys(config.environments || {});
	const envs = allEnvs.filter((e) => e !== "local"); // local を除外

	if (cliEnv) {
		if (!allEnvs.includes(cliEnv)) {
			fatal(`❌ Unknown environment "${cliEnv}". Available: ${allEnvs.join(", ")}`);
		}
		return cliEnv;
	}

	if (requireExplicit) {
		fatal(`❌ -e <env> is required for this command. Available: ${envs.join(", ")}`);
	}

	if (envs.length === 1) {
		return envs[0];
	}

	if (envs.length === 0) {
		fatal(`❌ No remote environments defined (only "local" found). Please add staging/production/etc.`);
	}

	fatal(`❌ -e <env> is required. Available: ${envs.join(", ")}`);
};

// -- rsync --
const syncFiles = async (direction, env, localDir, remoteDir, exclude = [], deleteMode = false, dryRun = false) => {
	const localSource = path.resolve(localDir) + path.sep;
	const remoteSource = `${env.sshAlias}:${remoteDir}`;

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
	if (dryRun) rsyncArgs.push("--dry-run");
	if (deleteMode) rsyncArgs.push("--delete-before");

	if (direction === "push") {
		if (!fs.existsSync(localSource)) {
			fatal(`❌ Local path not found: ${localSource}`);
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
			if (snk.stdin) {
				snk.stdin.end();
			}
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
		fatal(`❌ Local export failed: ${err.message}`);
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
				wpCmd = `${env.wpBin || "wp"} search-replace ${shellEscape(remoteDomain)} ${shellEscape(replaceDomain)} --all-tables --export=-`;
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
		fatal(`❌ Remote export failed: ${err.message}`);
	}
};

const runSearchReplace = async (target, fromDomain, toDomain, wpBin, wpRoot, wpOptions, dryRun = false) => {
	if (dryRun) {
		console.log(`[DRY-RUN] 👉 ${target} search-replace ${fromDomain} → ${toDomain}`);
		return;
	}

	if (target === "local") {
		const [bin, ...binArgs] = wpBin.split(" ");
			const needsPathArg = wpBin.trim().startsWith("wp ");
			const pathArgs = needsPathArg && wpRoot ? [`--path=${wpRoot}`] : [];
		await runAsync(bin, [...binArgs, ...pathArgs, "search-replace", fromDomain, toDomain, ...wpOptions]);
	} else {
		await runAsync("ssh", [target, `cd ${wpRoot} && ${wpBin || "wp"} search-replace ${shellEscape(fromDomain)} ${shellEscape(toDomain)} ${wpOptions.join(" ")}`]);
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

	if (dryRun) wpOptions.push("--dry-run");

	const multisite = config.multisite || false;
	if (multisite) wpOptions.push("--network");

	if (direction === "push") {
		const ok = await confirm({ message: "⚠️ Overwrite REMOTE DB? (y/n) ", expected: "y" });
		if (!ok) process.exit(0);

		// ローカルをバックアップ
		const localDumpPath = path.join(localBackupDir, `local-backup-${ts}.sql`);
		await exportLocalDB(wpBinLocal, localDumpPath, dryRun);

		if (dryRun) return;

		console.log("👉 Importing local DB to remote...");
		await pipeProcesses(
			wpBinLocal.split(" ")[0],
			[...wpBinLocal.split(" ").slice(1), "db", "export", "-", "--allow-root", "--single-transaction", "--quick"],
			"ssh",
			[env.sshAlias, `cd ${env.wpRoot} && ${env.wpBin || "wp"} db import -`]
		);

		console.log("👉 Running search-replace on remote...");
		await runSearchReplace(env.sshAlias, localDomain, remoteDomain, env.wpBin || "wp", env.wpRoot, wpOptions, dryRun);

		log("✅ Remote DB sync (push) complete.");
	} else {
		const ok = await confirm({ message: "⚠️ Overwrite LOCAL DB? (y/n) ", expected: "y" });
		if (!ok) process.exit(0);

		// ローカルを事前バックアップ
		const localBeforePullBackupPath = path.join(localBackupDir, `local-backup-before-pull-${ts}.sql`);
		await exportLocalDB(wpBinLocal, localBeforePullBackupPath, dryRun);

		// リモートをバックアップ
		const remoteBackupPath = path.join(remoteBackupDir, `remote-backup-${ts}.sql`);
		console.log("👉 Exporting remote DB to backup...");
		await exportRemoteDB(env, remoteBackupPath, dryRun);

		if (dryRun) return;

		// リモートをローカルへインポート
		console.log("👉 Importing remote DB to local...");
		await pipeProcesses("ssh", [env.sshAlias, `cd ${env.wpRoot} && ${env.wpBin || "wp"} db export - --single-transaction --quick`], wpBinLocal.split(" ")[0], [...wpBinLocal.split(" ").slice(1), "db", "import", "-", "--allow-root"]);

		// インポート後に search-replace
		console.log("👉 Running search-replace on local...");
		await runSearchReplace("local", remoteDomain, localDomain, wpBinLocal, env.wpRoot, wpOptions, dryRun);

		log(`✅ Local DB sync (pull) complete. Backups retained: remote-backup-${ts}.sql`);
	}
};

// -- ヘルプ --
const showHelp = () => {
	console.log(`
Usage:
	node sync.js push -e <env> <targets...>
	node sync.js pull -e <env> <targets...>
	node sync.js db:export -e <env> [--replace=<env>]

Targets (can be combined or abbreviated with -t flags):
	themes (t), plugins (p), muplugins (m), languages (l), uploads (u), database (d)

Options:
	--all, -a     Sync all targets (respects syncOptions=false)
	--dry-run, -n Test mode (rsync/WP-CLI dry-run, no changes)
	--help, -h    Show this help
	-e, --env     Specify environment (e.g., staging)
	-t<flags>   Abbreviated targets, e.g. -tpud = themes + plugins + uploads + database
	--replace, -R Environment for domain replacement in db:export (e.g., --replace=staging)

Notes:
	-e <env> can be omitted for push/pull only if exactly 1 non-local environment is defined.
	db:export always requires -e <env>.
	The --replace option for db:export replaces the domain in the exported database.
`);
};

// -- メイン --
const main = async () => {
	// util.parseArgs に置き換え
	const { values, positionals, tokens } = parseArgs({
		options: {
			// フラグ
			dryRun: { type: 'boolean', short: 'n' },
			all: { type: 'boolean', short: 'a' },
			help: { type: 'boolean', short: 'h' },
			// 環境指定 (-e or --env, string)
			env: { type: 'string', short: 'e' },
			// 短縮ターゲットフラグ (boolean)
			t: { type: 'boolean', short: 't' },
			p: { type: 'boolean', short: 'p' },
			m: { type: 'boolean', short: 'm' },
			l: { type: 'boolean', short: 'l' },
			u: { type: 'boolean', short: 'u' },
			d: { type: 'boolean', short: 'd' },
			// replace (db:export用, string)
			replace: { type: 'string', short: 'R' },
		},
		args: process.argv.slice(2),  // process.argv.slice(2) を args に
		allowPositionals: true,
		strict: false,  // 未知引数をエラーにせず positionals に
		tokens: true,  // 短縮形処理のため
	});

	const cmd = positionals[0];  // 位置引数の最初の要素 (push, pull, db:export)
	const dryRun = values.dryRun ?? false;  // ?? でデフォルト false
	const useAll = values.all ?? false;

	if (!cmd || values.help) {
		showHelp();
		process.exit(0);
	}

	if (cmd === "push" || cmd === "pull") {
		let envName = values.e;  // -e or --env の値
		let targets = positionals.slice(1);  // 位置引数の残り (envName 除外は後処理)

		// envName が位置引数から来る場合の処理 (例: push dev -t)
		if (!envName && targets.length > 0) {
			const potentialEnv = targets[0];
			const tempEnv = resolveEnvironment(potentialEnv, config, { requireExplicit: false });
			if (tempEnv) {
				envName = targets.shift();
			}
		}

		const targetAliases = {
			t: "themes",
			p: "plugins",
			m: "muplugins",
			l: "languages",
			u: "uploads",
			d: "database",
		};

		// 短縮フラグ処理 (values.t etc. で boolean フラグ)
		Object.entries(targetAliases).forEach(([short, full]) => {
			if (values[short]) {
				targets.push(full);
			}
		});

		// 複数短縮形 (-tp) 処理: positionals に含まれる短縮形を flatMap (tokens で拡張可能だが簡易的に)
		const expandedTargets = tokens
			.filter(t => t.kind === "option" && /^-[a-z]+$/i.test(t.rawName))
			.flatMap(t => t.rawName.slice(1).split("").map(ch => targetAliases[ch] || ch));

		targets = Array.from(new Set([...targets, ...expandedTargets]));

		const env = config.environments[envName];
		if (!env) {
			fatal(`❌ Unknown environment: ${envName}`);
		}

		if (cmd === "push" && envName === "production") {
			console.log("⚠️ You are about to PUSH to PRODUCTION!");
			const ok = await confirm({ message: "Type exactly 'I WANT TO PUSH' to continue: ", expected: "i want to push" });
			if (!ok) process.exit(0);
		}

		const localFullDomain = config.environments.local?.domain;
		if (!localFullDomain) {
			fatal("❌ Local domain not defined in config.");
		}
		const remoteFullDomain = env.domain;
		if (!remoteFullDomain) {
			fatal(`❌ Domain not defined for environment ${envName}.`);
		}

		const localDomain = normalizeDomain(localFullDomain);
		const remoteDomain = normalizeDomain(remoteFullDomain);

		const map = {
			themes: () => syncFiles(cmd, env, "wp-content/themes", path.posix.join(env.wpRoot, "wp-content/themes/"), [], false, dryRun),
			plugins: () => syncFiles(cmd, env, "wp-content/plugins", path.posix.join(env.wpRoot, "wp-content/plugins/"), [], false, dryRun),
			muplugins: () => {
				const localDir = "wp-content/mu-plugins";
				const remoteDir = path.posix.join(env.wpRoot, "wp-content/mu-plugins/");
				return syncFiles(cmd, env, localDir, remoteDir, [], true, dryRun).catch((err) => {
					if (err.message.includes("rsync exited with 23")) {
						console.warn(`⚠️ Skipping mu-plugins: directory not found on remote (${remoteDir})`);
						return;
					}
					throw err;
				});
			},
			languages: () => syncFiles(cmd, env, "wp-content/languages", path.posix.join(env.wpRoot, "wp-content/languages/"), [], false, dryRun),
			uploads: () => syncFiles(cmd, env, "wp-content/uploads", path.posix.join(env.wpRoot, "wp-content/uploads/"), [], false, dryRun),
			database: () => syncDatabase(cmd, envName, env, localDomain, remoteDomain, dryRun),
		};

		if (!targets.length && !useAll) {
			fatal("❌ No sync targets specified. Use --all or list targets.");
		}

		const selectedTargets = useAll ? Object.keys(map) : targets;

		for (const t of selectedTargets) {
			if (!map[t]) {
				console.warn(`⚠️ Unknown sync target: ${t}`);
				continue;
			}
			const allowed = env.syncOptions?.[t]?.[cmd];
			if (allowed === false) {
				console.log(`⏭️ Skipping "${t}" (${cmd}) because syncOptions disallows it.`);
				continue;
			}
			await map[t]();
		}
	}

	if (cmd === "db:export") {
		const envName = values.e;  // values.e で -e/--env
		if (!envName) {
			fatal("❌ Error: Please specify environment with -e");
		}
		const env = config.environments[envName];
		if (!env) {
			fatal(`❌ Error: Unknown environment '${envName}'`);
		}

		let replaceEnv = null;
		if (values.replace !== undefined) {
			if (typeof values.replace === "string") {
				replaceEnv = values.replace;
			} else {
				fatal("❌ Error: --replace requires an environment name (e.g. --replace=staging)");
			}
		}

		// 保存先: --replace の場合は exports、それ以外は環境ごと
		const dumpsDir = resolveBackupDir(envName, !!replaceEnv);
		const filename = replaceEnv
			? `${envName}-to-${replaceEnv}-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}.sql`
			: `${envName}-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}.sql`;
		const dumpPath = path.join(dumpsDir, filename);

		if (replaceEnv) {
			const targetEnv = config.environments[replaceEnv];
			if (!targetEnv) {
				fatal(`❌ Error: Unknown environment '${replaceEnv}'. Available: ${Object.keys(config.environments).join(", ")}`);
			}
			console.log(`🔄 Replacing domain: ${env.domain} → ${targetEnv.domain}`);
			await exportRemoteDB(env, dumpPath, dryRun, targetEnv.domain);
		} else {
			await exportRemoteDB(env, dumpPath, dryRun, false);
		}

		log(`✅ Export complete: ${dumpPath}`);
	}
};

main();