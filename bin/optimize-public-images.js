#!/usr/bin/env node

/**
 * @author: phytocodes
 * @see: https://github.com/phytocodes
 */

import 'dotenv/config';
import sharp from 'sharp';
import { promises as fs } from 'fs';
import path from 'path';

// 設定
const CONFIG = {
	extensions: process.env.IMAGE_EXTENSIONS?.split(',') || ['.jpg', '.jpeg', '.png'],
	webpQuality: parseInt(process.env.WEBP_QUALITY, 10) || 75,
	publicDir: process.env.PUBLIC_DIR || 'public',
	themesDir: process.env.VITE_THEMES_DIR || 'dist',
	assetsDir: process.env.VITE_ASSETS_DIR || 'dist/assets',
	logLevel: process.env.LOG_LEVEL || 'info',
	maxConcurrency: parseInt(process.env.MAX_CONCURRENCY, 10) || 10, // 並列処理の最大数
};

// キャッシュディレクトリのパス
const cacheDir = path.join(process.cwd(), 'node_modules', '.cache', 'wp-images');
const CACHE_FILE = path.join(cacheDir, '.cache.json');

// 最終出力パス
const publicDistDir = path.join(CONFIG.themesDir, CONFIG.assetsDir);

// キャッシュ
let cache = {};

// ログ関数
const log = (level, message) => {
	if (CONFIG.logLevel === 'debug' || level === 'error' || level === 'info') {
		console.log(`[${level.toUpperCase()}] ${message}`);
	}
};

// キャッシュ読み込み
async function loadCache() {
	try {
		await fs.mkdir(cacheDir, {
			recursive: true
		});
		const data = await fs.readFile(CACHE_FILE, 'utf8');
		if (!data.trim()) {
			log('info', 'Cache file is empty, starting fresh.');
			cache = {};
			return;
		}
		cache = JSON.parse(data);
		log('info', 'Cache loaded successfully.');
	} catch (error) {
		if (error.code === 'ENOENT') {
			log('info', `Cache file not found (${CACHE_FILE}), starting fresh.`);
		} else {
			log('error', `Error loading cache: ${error.message}`);
		}
		cache = {};
	}
}

// キャッシュ保存
async function saveCache() {
	try {
		await fs.writeFile(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
		log('info', 'Cache saved successfully.');
	} catch (error) {
		log('error', `Error saving cache: ${error.message}`);
	}
}

// 並列処理制限用
async function limitConcurrency(items, fn, maxConcurrency) {
	const results = [];
	const inFlight = new Set();

	for (const item of items) {
		const promise = fn(item).finally(() => inFlight.delete(promise));
		inFlight.add(promise);
		results.push(promise);

		if (inFlight.size >= maxConcurrency) {
			await Promise.race(inFlight);
		}
	}

	await Promise.all(results);
}

// 画像最適化
export async function optimizeImages() {
	log('info', 'Optimizing images in public folder...');

	await loadCache();

	const filesToProcess = [];

	try {
		const allPublicFiles = await fs.readdir(CONFIG.publicDir, {
			recursive: true
		});

		for (const file of allPublicFiles) {
			const fullPath = path.join(CONFIG.publicDir, file);
			const ext = path.extname(file).toLowerCase();

			if (CONFIG.extensions.includes(ext)) {
				const stats = await fs.stat(fullPath);
				const mtime = stats.mtimeMs;

				if (cache[fullPath] && cache[fullPath].mtime === mtime) {
					log('debug', `Skipping (cached): ${fullPath}`);
					continue;
				}

				filesToProcess.push({
					fullPath,
					ext,
					mtime
				});
			}
		}

		if (filesToProcess.length === 0) {
			log('info', 'No new or changed images to optimize.');
		} else {
			await limitConcurrency(filesToProcess, async ({
				fullPath,
				ext,
				mtime
			}) => {
				try {
					const baseName = path.basename(fullPath, ext);
					const relativePath = path.relative(CONFIG.publicDir, fullPath);

					// キャッシュディレクトリ内の出力パス
					const cacheOutputPathBase = path.join(cacheDir, relativePath);
					await fs.mkdir(path.dirname(cacheOutputPathBase), {
						recursive: true
					});

					// 1. 元の形式を最適化してキャッシュに保存
					await sharp(fullPath)
						.toFormat(ext.replace('.', ''))
						.toFile(cacheOutputPathBase);
					log('info', `Optimized and cached: ${cacheOutputPathBase}`);

					// 2. WebP形式を生成してキャッシュに保存
					const webpOutputPath = cacheOutputPathBase + '.webp';
					await sharp(fullPath)
						.webp({
							quality: CONFIG.webpQuality
						})
						.toFile(webpOutputPath);
					log('info', `Generated and cached WebP: ${webpOutputPath}`);

					// 3. @2x 画像から1x画像を生成し、キャッシュに保存
					if (baseName.endsWith('@2x')) {
						const baseName1x = baseName.replace(/@2x$/, '');
						const cacheOutputPathBase1x = path.join(path.dirname(cacheOutputPathBase), baseName1x + ext);
						const webpOutputPath1x = cacheOutputPathBase1x + '.webp';
						const metadata = await sharp(fullPath).metadata();

						if (!metadata || typeof metadata.width !== 'number' || metadata.width === 0) {
							log('warn', `Invalid metadata for ${fullPath}. Skipping 1x generation.`);
							return;
						}

						const targetWidth = Math.round(metadata.width / 2);

						await sharp(fullPath)
							.resize(targetWidth)
							.toFormat(ext.replace('.', ''))
							.toFile(cacheOutputPathBase1x);
						log('info', `Generated and cached 1x (Optimized): ${cacheOutputPathBase1x}`);

						await sharp(fullPath)
							.resize(targetWidth)
							.webp({
								quality: CONFIG.webpQuality
							})
							.toFile(webpOutputPath1x);
						log('info', `Generated and cached 1x (WebP): ${webpOutputPath1x}`);
					}

					cache[fullPath] = {
						mtime
					};
				} catch (error) {
					log('error', `Error processing ${fullPath}: ${error.message}`);
					delete cache[fullPath];
				}
			}, CONFIG.maxConcurrency);
		}

		// キャッシュから最終出力ディレクトリにファイルをコピー
		log('info', 'Copying cached images to public distribution directory...');
		const allCachedFiles = await fs.readdir(cacheDir, {
			recursive: true
		});

		for (const file of allCachedFiles) {
			if (file === '.cache.json') continue;
			const sourcePath = path.join(cacheDir, file);
			const destPath = path.join(publicDistDir, 'images', file);

			try {
				const stats = await fs.stat(sourcePath);

				// ディレクトリの場合はスキップ
				if (stats.isDirectory()) {
					await fs.mkdir(destPath, {
						recursive: true
					}); // ディレクトリは作成だけ行う
					continue;
				}

				// ファイルの場合のみコピー
				await fs.mkdir(path.dirname(destPath), {
					recursive: true
				});
				await fs.copyFile(sourcePath, destPath);
			} catch (error) {
				log('error', `Failed to copy ${sourcePath} to ${destPath}: ${error.message}`);
			}
		}

		log('info', 'Image optimization and copy complete.');
	} catch (error) {
		log('error', `Fatal error during image optimization: ${error.message}`);
		process.exit(1);
	} finally {
		await saveCache();
	}
}

const isDirectlyExecuted = import.meta.url === `file://${process.argv[1]}`;
const isNpmExecuted = process.env.npm_lifecycle_event === 'wp-optimize-public-images';

if (isDirectlyExecuted || isNpmExecuted) {
  optimizeImages().catch(error => {
    console.error('An unhandled error occurred:', error);
    process.exit(1);
  });
}