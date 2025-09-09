#!/usr/bin/env node

/**
 * @author: phytocodes
 * @see: https://github.com/phytocodes
 */

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
      console.error(`❌ Unknown environment "${cliEnv}". Available: ${allEnvs.join(", ")}`);
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

  if (envs.length === 0) {
    console.error(`❌ No remote environments defined (only "local" found). Please add staging/production/etc.`);
    process.exit(1);
  }

  console.error(`❌ -e <env> is required. Available: ${envs.join(", ")}`);
  process.exit(1);
};

// -- rsync --
const syncFiles = async (direction, env, localDir, remoteDir, exclude = [], deleteMode = true, dryRun = false) => {
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
		console.error(`❌ Remote export failed: ${err.message}`);
		process.exit(1);
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
    await runAsync("ssh", [target, `cd ${wpRoot} && ${wpBin || "wp"} search-replace ${shellEscape(fromDomain)} ${shellEscape(toDomain)} ${wpOptions.join(" ")}`
    ]);
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
  --all        Sync all targets (respects syncOptions=false)
  --dry-run    Test mode (rsync/WP-CLI dry-run, no changes)
  --help       Show this help
  -e, --env    Specify environment (e.g., staging)
  -t<flags>    Abbreviated target selection (e.g., -tpud = themes+plugins+uploads+database)

Notes:
  -e <env> can be omitted for push/pull only if exactly 1 non-local environment is defined.
  db:export always requires -e <env>.
  The --replace option for db:export replaces the domain in the exported database.
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

		const targetAliases = {
		  t: "themes",
		  p: "plugins",
		  m: "muplugins",
		  l: "languages",
		  u: "uploads",
		  d: "database",
		};

		targets = targets.flatMap((t) => {
		  if (/^-[a-z]+$/i.test(t)) {
		    return t
		      .slice(1)
		      .split("")
		      .map((ch) => targetAliases[ch] || ch);
		  }
		  return [t];
		});

		Object.entries(targetAliases).forEach(([short, full]) => {
		  if (argv[short]) {
		    targets.push(full);
		  }
		});

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
				console.log(`⏭️ Skipping "${t}" (${cmd}) because syncOptions disallows it.`);
				continue;
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

		let replaceEnv = null;
		if (argv.replace !== undefined) {
			if (typeof argv.replace === "string") {
				replaceEnv = argv.replace;
			} else {
				console.error("❌ Error: --replace requires an environment name (e.g. --replace=staging)");
				process.exit(1);
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