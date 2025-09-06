# wp-vite-scripts

[WP Vite Starter](https://github.com/phytocodes/wp-vite-starter)で利用する補助スクリプト集です。  


- optimize-public-images.js: 公開用画像の最適化スクリプト
- start-dev.js: 開発サーバー起動スクリプト
- sync.js: WordPress同期スクリプト

---

## インストール

GitHub リポジトリから直接インストールしてください:

```bash
npm install -D phytocodes/wp-vite-scripts#v0.0.1
```

## アップデート方法

新しいバージョンがリリースされた場合は、タグを指定して再インストールしてください:

```bash
npm install -D phytocodes/wp-vite-scripts#v0.0.2
```

## 利用可能なコマンド

### 開発サーバー起動

```bash
wp-start-dev
```

### wp-env を起動

- Vite の開発サーバーを起動
- 終了時に wp-env を自動停止

### 画像最適化
```bash
wp-optimize-images
```

- public/ ディレクトリ以下の画像を最適化

### WordPress 環境同期
```bash
wp-sync <command>
```

- 例: wp-sync push / wp-sync pull / wp-sync db:export:prod

## 免責文

このプロジェクトはまだ初期開発段階 (0.x 系) にあります。  
安定性や後方互換性は保証されません。利用は自己責任でお願いします。