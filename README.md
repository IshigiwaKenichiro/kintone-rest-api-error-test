# @kintone/rest-api-client バンドルエラー再現プロジェクト

npm install後、以下のコマンドを実行してください。
```bash
npm run build
```

ビルドは成功しますので、作成されるJSファイルを実行してください

```bash
node dist/index.mjs
```

## 概要

このプロジェクトは、`@kintone/rest-api-client` パッケージを esbuild でバンドルした際に発生する `Cannot find module '.'` エラーを再現するための最小限の環境です。

## 問題の発見経緯

### 背景

AWS Amplify Gen2 を使用した kintone 連携 Lambda 関数の開発中、`@kintone/rest-api-client` パッケージをインポートすると、ビルドは成功するものの、Lambda 実行時に以下のエラーが発生することが判明しました。

```
Error: Cannot find module '.'
Require stack:
- /var/task/index.mjs
```

### 問題の切り分け

当初、以下の原因を疑いました：

1. **Dynamic import の問題**: ESM と CommonJS の混在による問題
2. **Amplify Gen2 のバンドル設定**: Lambda 関数のバンドル設定の問題
3. **TypeScript の設定**: `tsconfig.json` のモジュール設定の問題

しかし、これらの修正を試みても問題は解決せず、最終的に **esbuild 自体のバンドル処理** に問題があることが判明しました。

### 根本原因の特定

調査の結果、以下のことが明らかになりました：

#### 1. パッケージの内部構造

`@kintone/rest-api-client` (v5.7.5) は、ESM と CommonJS の両方をサポートするため、以下の構造を持っています：

```
@kintone/rest-api-client/
├── index.mjs              ← ESM エントリーポイント（問題の原因）
├── lib/src/index.js       ← CommonJS 版（正常動作）
└── esm/src/index.js       ← ESM 版
```

`package.json` の `exports` フィールド：

```json
{
  "exports": {
    ".": {
      "node": {
        "import": "./index.mjs",      // Node.js ESM 環境
        "require": "./lib/src/index.js", // Node.js CommonJS 環境
        "default": "./lib/src/index.js"
      }
    }
  }
}
```

#### 2. 疑義のあるコード

`index.mjs` の実装：

```javascript
import module from "module";
const require = module.createRequire(import.meta.url);

export const {
  KintoneRestAPIClient,
  KintoneAbortSearchError,
  KintoneAllRecordsError,
  KintoneRestAPIError,
} = require(".");  // ← ここが問題！
```

このコードは、ESM 環境で CommonJS の `require` を使えるようにするためのラッパーですが、`require(".")` は **自分自身のディレクトリ** を指し、`package.json` の `main` フィールド（`lib/src/index.js`）を読み込もうとします。

#### 3. esbuild のバンドル処理

esbuild がこのコードをバンドルする際：

1. `import { KintoneRestAPIClient } from '@kintone/rest-api-client'` を検出
2. `package.json` の `exports["."].node.import` を参照 → `index.mjs` を使用
3. `index.mjs` の内容をバンドルに **そのまま含める**
4. `require(".")` も **そのまま残る**

バンドル後のコード（`dist/index.mjs`）：

```javascript
// node_modules/@kintone/rest-api-client/index.mjs
import module from "module";
var require2 = module.createRequire(import.meta.url);
var {
  KintoneRestAPIClient,
  KintoneAbortSearchError,
  KintoneAllRecordsError,
  KintoneRestAPIError
} = require2(".");  // ← バンドル後も残っている

// index.ts
var client = new KintoneRestAPIClient({
  baseUrl: "https://example.cybozu.com",
  auth: { apiToken: "dummy-token" }
});
```

#### 4. 実行時エラーの発生

バンドルされた `dist/index.mjs` を実行すると：

```bash
$ node dist/index.mjs
Error: Cannot find module '.'
```

**なぜエラーが発生するのか**：

- `require(".")` は、**実行時のファイルの場所** を基準にモジュールを解決しようとする
- バンドル後の `dist/index.mjs` の場所には `package.json` が存在しない
- Node.js は `"."` が何を指すのか判断できず、`MODULE_NOT_FOUND` エラーを発生させる

## 再現手順

### 1. セットアップ

```bash
npm install
```

### 2. ビルド

```bash
npm run build
```

**結果**: ✅ ビルドは成功します（警告なし）

### 3. 実行

```bash
node dist/index.mjs
```

**結果**: ❌ 以下のエラーが発生します

```
Error: Cannot find module '.'
Require stack:
- C:\work\kintone-test\dist\index.mjs
    at Function._resolveFilename (node:internal/modules/cjs/loader:1225:15)
    ...
```

## 技術的な詳細

### なぜ esbuild は `require(".")` を解決できないのか？

esbuild は **静的解析** でモジュールの依存関係を解決します：

- `import` や `require('specific-module')` のような明示的な指定は解決可能
- `require(".")` のような相対パスは、**実行時にしか解決できない**
- esbuild はこれを「解決不可能」とは判断せず、そのままバンドルに含める

### なぜビルド時にエラーが出ないのか？

esbuild は、解決できないモジュールがあっても：

1. **警告を出さない**（オプションで制御可能）
2. コードをそのまま残す
3. ビルドを成功させる

これは、一部の動的な `require` を許容するための設計ですが、このケースでは問題を引き起こします。

## 影響範囲

この問題は、以下の条件が揃った場合に発生します：

1. ✅ `@kintone/rest-api-client` を使用
2. ✅ esbuild でバンドル（`--bundle` オプション使用）
3. ✅ ESM フォーマット出力（`--format=esm`）
4. ✅ Node.js プラットフォーム（`--platform=node`）

### 影響を受けるかもしれない環境

- AWS Lambda（Amplify Gen2、SAM、CDK など）
- Cloudflare Workers
- Vercel Edge Functions
- その他、esbuild でバンドルする Node.js 環境

### 影響を受けない環境

- ブラウザ環境（`package.json` の `browser` フィールドが使われる）
- CommonJS 環境（`lib/src/index.js` が直接使われる）
- バンドルしない環境（`node_modules` から直接読み込む）

## ライセンス

MIT

## 参考リンク

- [@kintone/rest-api-client - npm](https://www.npmjs.com/package/@kintone/rest-api-client)
- [kintone/js-sdk - GitHub](https://github.com/kintone/js-sdk)
- [esbuild - Documentation](https://esbuild.github.io/)
