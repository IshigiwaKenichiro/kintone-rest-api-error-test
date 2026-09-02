# @kintone/rest-api-client バンドルエラー再現プロジェクト

npm install後、以下のコマンドを実行してください。
```bash
npm run build
```

ビルドは成功しますので、作成されるJSファイルを実行してください

```bash
node dist/index.mjs
```

> **このエラーは 5.7.5 のものです。** 6.2.1 では解消していますが、別の理由で
> `--format=esm` のままでは実行できません。回避策とあわせて **続報** にまとめました。

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

## 続報: 6.2.1 での状況（2026-09-01 検証）

**当初の `Cannot find module .` は 6.2.1 で解消しています。** ただし `--format=esm` だけでは
依然として実行できず、**エラーが別のものに変わります。**

6.2.1 の `index.mjs` は、`require(".")` が失敗したら ESM 版に切り替える形になりました。

```javascript
let mod;
try {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  mod = require(".");
} catch {
  // Non-Node runtimes (e.g. Cloudflare Workers): fall back to the ESM entry
  mod = await import("./esm/src/index.js");
}
```

esbuild はこの `import("./esm/src/index.js")` を静的に辿るため、**バンドルに本体が取り込まれます**
（452b → 約 694KB）。

`require(".")` 自体はバンドル後も残りますが、`try` の中にあるため失敗しても例外になりません。

```javascript
// バンドル後の dist/index.mjs
var mod;
try {
  const { createRequire } = await import("node:module");
  const require2 = createRequire(import.meta.url);
  mod = require2(".");                     // ← 失敗するが
} catch {
  mod = await Promise.resolve().then(() => (init_src(), src_exports));  // ← こちらに落ちる
}
```

`catch` 側の `src_exports` はバンドルに取り込まれた ESM 版です。**5.7.5 で表面化していた**
**`Cannot find module '.'` は、この `catch` に吸収されて出なくなります。**

ただし、そうして読み込まれた ESM 版が依存する `form-data` / `combined-stream` は CommonJS で
`require("util")` しており、今度はそこが esbuild の挿入する shim に引っかかります。

```
Error: Dynamic require of "util" is not supported
    at node_modules/combined-stream/lib/combined_stream.js
    at node_modules/form-data/lib/form_data.js
    at node_modules/@kintone/rest-api-client/esm/src/client/FileClient.js
```

### 条件別の検証結果

Node.js v24.14.0 / esbuild 0.25.10 で、同じ `index.ts` をビルドして実行した結果です。

| 版 | ビルド条件 | ビルド | 実行 | 結果 |
|---|---|---|---|---|
| 5.7.5 | `--format=esm` | ✅ | ❌ | `Cannot find module .` |
| 5.7.5 | `--format=esm` + createRequire の banner | ✅ | ❌ | `Cannot find module .`（変わらず） |
| 5.7.5 | `--format=cjs` | ✅ | ❌ | `createRequire` に `import.meta.url` が渡らず `ERR_INVALID_ARG_VALUE` |
| 5.7.5 | `--format=esm --packages=external` | ✅ | ✅ | **動く** |
| 6.2.1 | `--format=esm` | ✅ | ❌ | `Dynamic require of "util" is not supported` |
| 6.2.1 | `--format=esm` + createRequire の banner | ✅ | ✅ | **動く** |
| 6.2.1 | `--format=cjs` | ❌ | — | `Top-level await is currently not supported with the "cjs" output format` |
| 6.2.1 | `--format=esm --packages=external` | ✅ | ✅ | **動く** |

### 回避策

**`--packages=external` を付ける**のが確実です。5.7.5 でも 6.2.1 でも動きます。
バンドルに含めない代わりに `node_modules` を配置する必要があるため、Lambda ならレイヤーか
デプロイパッケージへの同梱が要ります。

```bash
esbuild index.ts --bundle --platform=node --format=esm --packages=external --outfile=dist/index.mjs
```

**バンドルに含めたい場合は 6.2.1 以降に上げたうえで、banner で `createRequire` を注入します。**

```bash
esbuild index.ts --bundle --platform=node --format=esm   --banner:js="import{createRequire}from'module';const require=createRequire(import.meta.url);"   --outfile=dist/index.mjs
```

**この banner は 5.7.5 では効きません。** 5.7.5 の `require(".")` は
「バンドル後の位置から見た `.`」を解決しようとするため、`require` が定義されていても
参照先が見つからないからです。バンドルしたいなら 6.2.1 以降に上げてください。

## ライセンス

MIT

## 参考リンク

- [@kintone/rest-api-client - npm](https://www.npmjs.com/package/@kintone/rest-api-client)
- [kintone/js-sdk - GitHub](https://github.com/kintone/js-sdk)
- [esbuild - Documentation](https://esbuild.github.io/)
