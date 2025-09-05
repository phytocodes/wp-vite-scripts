#!/usr/bin/env node
import { sync, spawn } from 'cross-spawn';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

// ESモジュール環境で __dirname を使用するための代替策
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- 1. 定数と初期設定 ---

// wp-envの実行可能ファイルのパス
// プロジェクトルートからの相対パスを想定。必要に応じて調整
const wpEnvPath = path.resolve(process.cwd(), 'node_modules/.bin/wp-env');

// .wp-env.jsonの存在チェック
const wpEnvConfigPath = path.resolve(process.cwd(), '.wp-env.json');
if (!fs.existsSync(wpEnvConfigPath)) {
	console.error('Error: .wp-env.json not found. Please ensure it exists in your project root.');
	console.error('wp-env requires this file for configuration.');
	process.exit(1);
}

// wp-env停止の排他制御フラグ
let isWpEnvStopped = false;

/**
 * wp-envを安全に停止する関数
 * 二重停止を防ぎ、エラーハンドリングを行う
 */
const stopWpEnv = () => {
	if (isWpEnvStopped) {
		return;
	}
	isWpEnvStopped = true;
	console.log('Attempting to stop wp-env...');
	try {
		// cross-spawnのsyncで同期的に停止コマンドを実行
		sync(wpEnvPath, ['stop'], { stdio: 'inherit' });
		console.log('wp-env stopped successfully.');
	} catch (error) {
		console.error('Error stopping wp-env:', error.message);
	}
};

// --- 2. wp-envの起動 ---

console.log('Starting wp-env...');
try {
	// cross-spawnのsyncで同期的に起動コマンドを実行
	sync(wpEnvPath, ['start'], { stdio: 'inherit' });
	console.log('wp-env started successfully.');
} catch (error) {
	console.error('Failed to start wp-env. Check wp-env logs or configuration.');
	console.error('Error details:', error.message);
	process.exit(1);
}

// --- 3. Vite開発サーバーの起動 ---

console.log('Starting Vite development server...');
const vite = spawn('npm', ['run', 'vite'], { stdio: 'inherit' });

// --- 4. プロセス終了時のクリーンアップ ---

// Viteプロセスが終了したときの処理
vite.on('exit', (code, signal) => {
	console.log(`Vite process exited with code ${code} and signal ${signal || 'none'}.`);
	stopWpEnv();
	process.exit(code || 0);
});

// SIGINT (Ctrl+C) の処理
process.on('SIGINT', () => {
	console.log('\nReceived SIGINT. Attempting to stop Vite and wp-env...');
	vite.kill('SIGINT');

	const timeoutId = setTimeout(() => {
		console.warn('Vite process did not exit gracefully, forcing stop...');
		vite.kill('SIGKILL');
	}, 5000);

	vite.on('exit', () => {
		clearTimeout(timeoutId);
		stopWpEnv();
		process.exit(0);
	});
});

// 未キャッチの例外処理
process.on('uncaughtException', (err) => {
	console.error('Uncaught exception detected:', err.stack);
	stopWpEnv();
	process.exit(1);
});