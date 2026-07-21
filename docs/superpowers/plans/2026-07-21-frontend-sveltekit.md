# 計画3: SvelteKit フロントエンド 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** QFieldCloud の REST API を利用する社内向け管理 Web UI（SvelteKit SPA）を新規開発し、S3 + CloudFront（計画2の FrontendStack）から配信する。

**Architecture:** SvelteKit（Svelte 5）+ TypeScript + `adapter-static` の SPA。ビルド成果物（静的ファイル）を計画2の FrontendStack の S3 バケットへ配置し CloudFront 配信。API は実行時に `/config.json`（計画2の AppStack が S3 に配置）から取得した API 用 CloudFront ドメインへ、`openapi-fetch`（Swagger から型生成）でトークン認証アクセス。レイアウトはサイドバー型（Projects / Jobs / Members）。

**Tech Stack:** SvelteKit + Svelte 5 / TypeScript strict / `@sveltejs/adapter-static` / Tailwind CSS v4 / `openapi-typescript` + `openapi-fetch` / Vitest（コンポーネント）/ Playwright（E2E）

**参照:** 設計書 `docs/superpowers/specs/2026-07-16-qfieldcloud-aws-serverless-design.md` §5（フロントエンド設計）

---

## 事前確認済みの重要事実（実装者は前提としてよい）

- **配置**: 本リポジトリ内の新規 `frontend/` ディレクトリ（upstream に無いディレクトリなのでフォークマージと衝突しない）。
- **API 認証エンドポイント**（`docker-app/qfieldcloud/urls.py` で確認済み）:
  - `POST /api/v1/auth/login/`（= `/api/v1/auth/token/` と同一 `LoginView`）→ 認証トークンを返す
  - `GET /api/v1/auth/user/` → 現在のユーザー情報
  - `POST /api/v1/auth/logout/` → トークン無効化
  - 認証後は全 API に `Authorization: Token <key>` ヘッダーを付与
- **OpenAPI スキーマ**: drf-spectacular 0.29.0 導入済み。`GET /swagger.yaml` でスキーマ配信。バックエンドコンテナ内で `python manage.py spectacular --file /tmp/schema.yml` によりサーバー起動なしでスキーマ生成も可能。→ これを `openapi-typescript` に食わせて型を生成。
- **コア API**: `/api/v1/` 配下。プロジェクト・ファイル・ジョブ等は DRF router 登録の ViewSet（正確なパス・レスポンス形状は生成した OpenAPI 型が唯一の正）。確認済みの明示パス例: `/api/v1/status/`、`/api/v1/members/<organization>/`、`/api/v1/deltas/<projectid>/`、`/api/v1/server/info/`。**個々のパスをハードコードせず、生成した型付きクライアント経由でアクセスすること**（スキーマ駆動）。
- **実行時設定**: 計画2の AppStack が `frontendBucket` に `config.json`（`{ "apiUrl": "https://<api-cloudfront>" }`）を配置する（`prune:false` で SPA 資産と共存）。フロントは起動時に `/config.json` を fetch して API ベース URL を得る（ビルド時埋め込みではない）。
- **配信先**: 計画2 `FrontendStack` の S3 バケット（OAC・SPA フォールバック 403/404→index.html・現状プレースホルダー `index.html`）。ビルド成果物でこのプレースホルダーを置換する。**アップロード（S3 sync）と CloudFront invalidation は計画4（CI/CD）が担う**。本計画はビルド成果物を生成するところまで。
- **ローカル開発時の API**: `docker compose` で起動した QFieldCloud（`https://localhost` の nginx、または `http://localhost:8011` の Django dev）。開発時は `config.json` が無いので、`.env` の `VITE_DEV_API_URL`（デフォルト `https://localhost`）にフォールバックする。
- **CORS**: バックエンドは `CORS_ALLOWED_ORIGINS`（計画2でフロント用 CloudFront ドメインを設定済み）。ローカル開発では別途 `CORS_ALLOWED_ORIGINS` に dev サーバー（`http://localhost:5173`）を足す必要がある（ローカル `.env` 調整、本計画のスコープ外だが Task 4 の検証で必要になれば行う）。
- **Node バージョン**: Node 20 LTS 前提（`frontend/.nvmrc` に `20` を記載）。

## ファイル構成

| 操作 | パス | 責務 |
|---|---|---|
| Create | `frontend/package.json` `frontend/svelte.config.js` `frontend/vite.config.ts` `frontend/tsconfig.json` `frontend/.nvmrc` `frontend/.gitignore` | SvelteKit + adapter-static + strict TS の基盤 |
| Create | `frontend/tailwind.config.js` `frontend/src/app.css` | Tailwind v4 |
| Create | `frontend/src/app.html` | HTML シェル |
| Create | `frontend/scripts/gen-api-types.sh` | swagger.yaml → `src/lib/api/schema.d.ts` 型生成 |
| Create | `frontend/src/lib/config.ts` | 実行時 `/config.json` ローダー（dev フォールバック付き） |
| Create | `frontend/src/lib/api/schema.d.ts` | openapi-typescript 生成物（コミットする） |
| Create | `frontend/src/lib/api/client.ts` | openapi-fetch クライアント + トークン注入 |
| Create | `frontend/src/lib/auth/store.svelte.ts` | 認証状態（トークン/ユーザー）の Svelte 5 rune ストア |
| Create | `frontend/src/routes/+layout.svelte` `+layout.ts` | アプリシェル（サイドバー）+ 認証ガード |
| Create | `frontend/src/routes/login/+page.svelte` | ログイン画面 |
| Create | `frontend/src/routes/(app)/projects/+page.svelte` | プロジェクト一覧 |
| Create | `frontend/src/routes/(app)/projects/[id]/+page.svelte` ほかタブ | プロジェクト詳細（ファイル/メンバー/ジョブ） |
| Create | `frontend/src/routes/(app)/jobs/+page.svelte` | ジョブ横断一覧 |
| Create | `frontend/src/routes/(app)/settings/+page.svelte` | 個人設定（トークン再発行） |
| Create | `frontend/src/lib/components/*.svelte` | 共通コンポーネント（サイドバー、テーブル、アップローダ等） |
| Create | `frontend/tests/*` `frontend/e2e/*` | Vitest / Playwright |

**検証コマンド（`frontend/` で実行）:**

```bash
npm run check      # svelte-check（型）
npm run test       # vitest
npm run build      # adapter-static ビルド（build/ に出力）
```

**TypeScript 規約**: `any`/`unknown` 禁止（生成された OpenAPI 型を使う）。`class` はエラー継承等の必然時のみ。

---

### Task 1: SvelteKit + adapter-static + Tailwind v4 の scaffold

**Files:** `frontend/package.json` / `svelte.config.js` / `vite.config.ts` / `tsconfig.json` / `.nvmrc` / `.gitignore` / `tailwind.config.js` / `src/app.css` / `src/app.html` / `src/routes/+page.svelte`

- [ ] **Step 1: `frontend/package.json`**

```json
{
  "name": "qfieldcloud-frontend",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite dev",
    "build": "vite build",
    "preview": "vite preview",
    "check": "svelte-kit sync && svelte-check --tsconfig ./tsconfig.json",
    "test": "vitest run",
    "test:e2e": "playwright test",
    "gen:api": "bash scripts/gen-api-types.sh"
  },
  "devDependencies": {
    "@sveltejs/adapter-static": "^3.0.6",
    "@sveltejs/kit": "^2.8.0",
    "@sveltejs/vite-plugin-svelte": "^4.0.0",
    "@tailwindcss/vite": "^4.0.0",
    "@playwright/test": "^1.48.0",
    "@testing-library/svelte": "^5.2.4",
    "jsdom": "^25.0.1",
    "openapi-typescript": "^7.4.0",
    "svelte": "^5.1.0",
    "svelte-check": "^4.0.0",
    "tailwindcss": "^4.0.0",
    "typescript": "^5.6.0",
    "vite": "^5.4.0",
    "vitest": "^2.1.0"
  },
  "dependencies": {
    "openapi-fetch": "^0.13.0"
  }
}
```

- [ ] **Step 2: `frontend/svelte.config.js`（SPA モード）**

```javascript
import adapter from "@sveltejs/adapter-static";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  kit: {
    adapter: adapter({ fallback: "index.html" }), // SPA: all routes -> index.html
  },
};

export default config;
```

- [ ] **Step 3: `frontend/vite.config.ts`**

```typescript
import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  test: {
    environment: "jsdom",
    include: ["tests/**/*.{test,spec}.ts"],
  },
});
```

- [ ] **Step 4: `frontend/tsconfig.json`**

```json
{
  "extends": "./.svelte-kit/tsconfig.json",
  "compilerOptions": {
    "strict": true,
    "noUnusedLocals": true,
    "moduleResolution": "bundler",
    "esModuleInterop": true,
    "skipLibCheck": true
  }
}
```

- [ ] **Step 5: `.nvmrc`（`20`）、`.gitignore`（`node_modules/`, `.svelte-kit/`, `build/`, `test-results/`, `playwright-report/`）、`tailwind.config.js`（空 export でよい: `export default {}`）、`src/app.css`（`@import "tailwindcss";`）**

- [ ] **Step 6: `src/app.html`**

```html
<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    %sveltekit.head%
  </head>
  <body>
    <div>%sveltekit.body%</div>
  </body>
</html>
```

- [ ] **Step 7: 仮トップページ `src/routes/+page.svelte`**

```svelte
<script lang="ts">
  import "../app.css";
</script>

<h1 class="text-xl font-bold p-4">QFieldCloud</h1>
```

- [ ] **Step 8: インストールとビルド検証**

```bash
cd frontend
npm install
npm run build
```
Expected: `build/` ディレクトリに `index.html` 等が出力され、エラーなし。

- [ ] **Step 9: Commit**

```bash
git add frontend/
git commit -m "chore(frontend): scaffold SvelteKit SPA with Tailwind v4"
```

（以降のコミットフッター: 空行の後に `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` と `Claude-Session: <このセッションURL>`）

---

### Task 2: 実行時設定ローダー（`/config.json`）

**Files:** Create `frontend/src/lib/config.ts` / Test `frontend/tests/config.test.ts`

- [ ] **Step 1: 失敗するテストを書く** `tests/config.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadApiBaseUrl } from "../src/lib/config";

describe("loadApiBaseUrl", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("uses config.json apiUrl when present", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ apiUrl: "https://api.example.cloudfront.net" }),
    })));
    expect(await loadApiBaseUrl("https://dev.local")).toBe("https://api.example.cloudfront.net");
  });

  it("falls back to the dev URL when config.json is missing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    expect(await loadApiBaseUrl("https://dev.local")).toBe("https://dev.local");
  });
});
```

- [ ] **Step 2: 失敗確認** `npm run test` → FAIL（`loadApiBaseUrl` 未定義）

- [ ] **Step 3: 実装** `src/lib/config.ts`

```typescript
/**
 * Resolves the API base URL at runtime. Production reads /config.json (written
 * to the frontend S3 bucket by the AppStack, plan 2); local dev falls back to
 * the dev URL (VITE_DEV_API_URL, default https://localhost).
 */
export const loadApiBaseUrl = async (devFallback: string): Promise<string> => {
  try {
    const res = await fetch("/config.json", { cache: "no-store" });
    if (res.ok) {
      const cfg = (await res.json()) as { apiUrl?: string };
      if (cfg.apiUrl) return cfg.apiUrl;
    }
  } catch {
    // fall through to dev fallback
  }
  return devFallback;
};

export const DEV_API_URL: string =
  import.meta.env.VITE_DEV_API_URL ?? "https://localhost";
```

- [ ] **Step 4: 成功確認** `npm run test` → PASS

- [ ] **Step 5: Commit** `git commit -m "feat(frontend): runtime API base URL loader"`

---

### Task 3: OpenAPI 型生成 + 型付き API クライアント

**Files:** Create `frontend/scripts/gen-api-types.sh` / `src/lib/api/schema.d.ts`（生成物・コミット） / `src/lib/api/client.ts`

- [ ] **Step 1: 型生成スクリプト** `scripts/gen-api-types.sh`

```bash
#!/usr/bin/env bash
# Generates src/lib/api/schema.d.ts from the QFieldCloud OpenAPI schema.
# Requires the backend running locally (docker compose) serving /swagger.yaml,
# OR a schema file exported via `manage.py spectacular`.
set -euo pipefail
SCHEMA_URL="${QFC_SCHEMA_URL:-https://localhost/swagger.yaml}"
cd "$(dirname "$0")/.."
npx openapi-typescript "$SCHEMA_URL" -o src/lib/api/schema.d.ts
echo "Generated src/lib/api/schema.d.ts from $SCHEMA_URL"
```

実行（バックエンドをローカル起動した状態で。自己署名証明書のため `--no-check` 相当が必要なら `NODE_TLS_REJECT_UNAUTHORIZED=0` を前置）:
```bash
chmod +x scripts/gen-api-types.sh
NODE_TLS_REJECT_UNAUTHORIZED=0 QFC_SCHEMA_URL=https://localhost/swagger.yaml npm run gen:api
```
生成された `src/lib/api/schema.d.ts` は**コミットする**（CI で再生成もするが、ビルド再現性のためリポジトリに置く。計画4で drift チェック）。

- [ ] **Step 2: 型付きクライアント** `src/lib/api/client.ts`

```typescript
import createClient from "openapi-fetch";
import type { paths } from "./schema";
import { getToken } from "../auth/store.svelte";

/**
 * Creates an openapi-fetch client bound to `baseUrl`. Injects the auth token
 * (Token <key>) on every request via a middleware reading the auth store.
 */
export const createApiClient = (baseUrl: string) => {
  const client = createClient<paths>({ baseUrl });
  client.use({
    onRequest({ request }) {
      const token = getToken();
      if (token) request.headers.set("Authorization", `Token ${token}`);
      return request;
    },
  });
  return client;
};

export type ApiClient = ReturnType<typeof createApiClient>;
```

注: `getToken` は Task 4 で作る認証ストアの関数。Task 4 と対で実装するため、Task 4 完了までは `client.ts` の型チェックが通らない。**Task 3 と Task 4 は連続して実装し、Task 4 完了時に両方の検証を行う**こと（この2タスクは相互依存）。

- [ ] **Step 3: Commit（Task 4 と合わせて）** — Task 4 のコミットに含める

---

### Task 4: 認証（ログイン / トークンストア / ガード / ログアウト）

**Files:** Create `frontend/src/lib/auth/store.svelte.ts` / `src/routes/login/+page.svelte` / `src/routes/+layout.ts` / Test `frontend/tests/auth-store.test.ts`

- [ ] **Step 1: 失敗するテスト** `tests/auth-store.test.ts`

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { setToken, getToken, clearToken } from "../src/lib/auth/store.svelte";

describe("auth token store", () => {
  beforeEach(() => localStorage.clear());

  it("persists the token to localStorage", () => {
    setToken("abc123");
    expect(getToken()).toBe("abc123");
    expect(localStorage.getItem("qfc_token")).toBe("abc123");
  });

  it("clears the token", () => {
    setToken("abc123");
    clearToken();
    expect(getToken()).toBeNull();
  });
});
```

- [ ] **Step 2: 失敗確認** `npm run test` → FAIL

- [ ] **Step 3: 実装** `src/lib/auth/store.svelte.ts`

```typescript
const TOKEN_KEY = "qfc_token";

/**
 * Token persistence. Kept as plain module functions (not a rune) so it is
 * usable from the api client middleware. Internal-tool trade-off: token lives
 * in localStorage (design doc §5.2).
 */
export const getToken = (): string | null =>
  typeof localStorage === "undefined" ? null : localStorage.getItem(TOKEN_KEY);

export const setToken = (token: string): void => {
  localStorage.setItem(TOKEN_KEY, token);
};

export const clearToken = (): void => {
  localStorage.removeItem(TOKEN_KEY);
};
```

- [ ] **Step 4: 成功確認** `npm run test` → PASS

- [ ] **Step 5: ログイン画面** `src/routes/login/+page.svelte`（`POST /api/v1/auth/login/` → `{ token }` を保存して `/projects` へ）

```svelte
<script lang="ts">
  import { goto } from "$app/navigation";
  import { createApiClient } from "$lib/api/client";
  import { setToken } from "$lib/auth/store.svelte";
  import { loadApiBaseUrl, DEV_API_URL } from "$lib/config";

  let username = $state("");
  let password = $state("");
  let error = $state<string | null>(null);
  let submitting = $state(false);

  const submit = async (e: SubmitEvent) => {
    e.preventDefault();
    submitting = true;
    error = null;
    try {
      const baseUrl = await loadApiBaseUrl(DEV_API_URL);
      const client = createApiClient(baseUrl);
      // openapi-fetch: path/verb come from the generated schema. The login
      // endpoint is POST /api/v1/auth/login/ returning { token }.
      const { data, error: apiError } = await client.POST("/api/v1/auth/login/", {
        body: { username, password },
      });
      if (apiError || !data?.token) {
        error = "ユーザー名またはパスワードが違います";
        return;
      }
      setToken(data.token);
      await goto("/projects");
    } finally {
      submitting = false;
    }
  };
</script>

<form onsubmit={submit} class="max-w-sm mx-auto mt-24 flex flex-col gap-3 p-6">
  <h1 class="text-xl font-bold">QFieldCloud ログイン</h1>
  <input class="border rounded p-2" bind:value={username} placeholder="ユーザー名" autocomplete="username" />
  <input class="border rounded p-2" type="password" bind:value={password} placeholder="パスワード" autocomplete="current-password" />
  {#if error}<p class="text-red-600 text-sm">{error}</p>{/if}
  <button class="bg-emerald-600 text-white rounded p-2 disabled:opacity-50" disabled={submitting}>ログイン</button>
</form>
```

注: 生成した `schema.d.ts` の実際の login リクエスト/レスポンス型に合わせて body/`data.token` のプロパティ名を調整すること（`LoginView` のシリアライザ定義が正）。型が合わない場合は生成スキーマを確認。

- [ ] **Step 6: 認証ガード** `src/routes/+layout.ts`

```typescript
import { redirect } from "@sveltejs/kit";
import { browser } from "$app/environment";
import { getToken } from "$lib/auth/store.svelte";

export const ssr = false; // SPA only
export const prerender = false;

export const load = ({ url }: { url: URL }) => {
  if (browser && !getToken() && url.pathname !== "/login") {
    throw redirect(302, "/login");
  }
};
```

- [ ] **Step 7: 検証** `npm run check`（型）→ エラーなし、`npm run test` → PASS、`npm run build` → 成功

- [ ] **Step 8: Commit（Task 3 の client.ts 含む）**

```bash
git add frontend/
git commit -m "feat(frontend): typed API client and token auth (login/guard)"
```

---

### Task 5: アプリシェル（サイドバー型レイアウト）

**Files:** Create `frontend/src/routes/(app)/+layout.svelte` / `src/lib/components/Sidebar.svelte` / `src/lib/components/TopBar.svelte`

- [ ] **Step 1: サイドバー** `src/lib/components/Sidebar.svelte`（Projects / Jobs / Members のリンク、現在ルートをハイライト）

```svelte
<script lang="ts">
  import { page } from "$app/stores";
  const items = [
    { href: "/projects", label: "📁 プロジェクト" },
    { href: "/jobs", label: "⚙️ ジョブ" },
    { href: "/members", label: "👥 メンバー" },
  ];
</script>

<nav class="w-52 bg-slate-100 h-screen p-3 flex flex-col gap-1">
  <div class="font-bold px-2 py-3">🌏 QFieldCloud</div>
  {#each items as item}
    <a href={item.href}
       class="px-3 py-2 rounded {$page.url.pathname.startsWith(item.href) ? 'bg-emerald-200 font-semibold' : 'hover:bg-slate-200'}">
      {item.label}
    </a>
  {/each}
</nav>
```

- [ ] **Step 2: トップバー** `src/lib/components/TopBar.svelte`（現在ユーザー表示 + ログアウト。`GET /api/v1/auth/user/`、`POST /api/v1/auth/logout/` → `clearToken()` → `/login`）。実装は login 画面と同じ client 生成パターン。

- [ ] **Step 3: アプリレイアウト** `src/routes/(app)/+layout.svelte`

```svelte
<script lang="ts">
  import "../../app.css";
  import Sidebar from "$lib/components/Sidebar.svelte";
  import TopBar from "$lib/components/TopBar.svelte";
  let { children } = $props();
</script>

<div class="flex">
  <Sidebar />
  <div class="flex-1 flex flex-col h-screen">
    <TopBar />
    <main class="flex-1 overflow-auto p-6">{@render children()}</main>
  </div>
</div>
```

- [ ] **Step 4: 検証** `npm run check` / `npm run build` → エラーなし
- [ ] **Step 5: Commit** `git commit -m "feat(frontend): sidebar app shell"`

---

### Task 6: プロジェクト一覧画面

**Files:** Create `frontend/src/routes/(app)/projects/+page.svelte` / `src/lib/api/projects.ts`

- [ ] **Step 1: API ラッパ** `src/lib/api/projects.ts` — プロジェクト一覧取得・作成・削除を型付きクライアントで実装（正確なパス・パラメータは `schema.d.ts` を参照。プロジェクト系は `/api/v1/projects/` 系 ViewSet）。関数: `listProjects(client)` / `createProject(client, {name, owner, ...})` / `deleteProject(client, id)`。各関数は `openapi-fetch` の `GET`/`POST`/`DELETE` を呼び、`{data, error}` を返す。

- [ ] **Step 2: 一覧画面** `+page.svelte`：
  - マウント時に `loadApiBaseUrl` → `createApiClient` → `listProjects` でプロジェクトカードを表示（名前・更新日時・メンバー数・最新ジョブ状態）
  - 「+ 新規プロジェクト」ボタン → モーダルで名前入力 → `createProject`
  - 検索ボックス（クライアント側フィルタ）
  - 各カードクリックで `/projects/<id>` へ

- [ ] **Step 3: コンポーネントテスト** `tests/projects-page.test.ts`（`@testing-library/svelte` で、`listProjects` をモックしカードが描画されることを検証）
- [ ] **Step 4: 検証** `npm run test` / `npm run check` / `npm run build`
- [ ] **Step 5: Commit** `git commit -m "feat(frontend): project list screen"`

---

### Task 7: プロジェクト詳細 — ファイルタブ

**Files:** Create `frontend/src/routes/(app)/projects/[id]/+page.svelte`（タブ切替の親） / `src/lib/components/FilesTab.svelte` / `src/lib/api/files.ts`

- [ ] **Step 1: ファイル API ラッパ** `src/lib/api/files.ts` — プロジェクトのファイル一覧・アップロード・ダウンロード URL 取得・バージョン一覧。ファイルはプロジェクト配下のエンドポイント（`schema.d.ts` 参照）。アップロードは `multipart/form-data`（`openapi-fetch` の `body` に `FormData`）。

- [ ] **Step 2: ファイルタブ** `FilesTab.svelte`：
  - ファイル一覧（パス・サイズ・最新バージョン・更新日時）
  - 複数ファイルアップロード（`<input type="file" multiple>`、`XMLHttpRequest` で進捗イベント取得しプログレスバー表示。`openapi-fetch` は進捗非対応のため、アップロードのみ生 `XMLHttpRequest` + 手動で `Authorization: Token` 付与）
  - ダウンロード（ダウンロード用エンドポイントへ遷移。バックエンドが nginx X-Accel 経由で S3 ストリーミング）
  - バージョン履歴の展開表示

- [ ] **Step 3: 詳細ページ親** `[id]/+page.svelte`：タブ（ファイル/メンバー/ジョブ）を切り替える。URL クエリ `?tab=files|members|jobs` で状態保持。
- [ ] **Step 4: 検証** `npm run check` / `npm run build`
- [ ] **Step 5: Commit** `git commit -m "feat(frontend): project detail files tab with upload progress"`

---

### Task 8: プロジェクト詳細 — メンバータブ

**Files:** Create `frontend/src/lib/components/MembersTab.svelte` / `src/lib/api/collaborators.ts`

- [ ] **Step 1: コラボレーター API ラッパ** `src/lib/api/collaborators.ts` — プロジェクトのコラボレーター一覧・追加・ロール変更・削除（`schema.d.ts` 参照。組織メンバーは `/api/v1/members/<organization>/`、プロジェクトコラボレーターは projects 配下）。
- [ ] **Step 2: メンバータブ** `MembersTab.svelte`：コラボレーター一覧（ユーザー名・ロール）、追加（ユーザー名 + ロール選択）、ロール変更（セレクト）、削除。
- [ ] **Step 3: 検証** `npm run check` / `npm run build`
- [ ] **Step 4: Commit** `git commit -m "feat(frontend): project detail members tab"`

---

### Task 9: プロジェクト詳細 — ジョブタブ + ジョブ横断一覧

**Files:** Create `frontend/src/lib/components/JobsTab.svelte` / `src/routes/(app)/jobs/+page.svelte` / `src/lib/api/jobs.ts`

- [ ] **Step 1: ジョブ API ラッパ** `src/lib/api/jobs.ts` — ジョブ一覧（プロジェクト別・全体）、ジョブ詳細（状態・種別・feedback・output ログ）、再実行（新規ジョブ投入）。`schema.d.ts` 参照。ジョブ状態は PENDING/QUEUED/STARTED/FINISHED/FAILED（バックエンド `Job.Status`）。
- [ ] **Step 2: ジョブタブ** `JobsTab.svelte`：プロジェクトのジョブ一覧（種別・状態バッジ・時刻・所要時間）、行展開でログ/エラー（`feedback`/`output`）表示、失敗ジョブに再実行ボタン。状態は数秒ポーリングで更新（実行中がある時のみ）。
- [ ] **Step 3: ジョブ横断一覧** `jobs/+page.svelte`：全プロジェクトのジョブを新しい順に一覧（監視ビュー）。
- [ ] **Step 4: 検証** `npm run check` / `npm run build`
- [ ] **Step 5: Commit** `git commit -m "feat(frontend): jobs tab and cross-project jobs view"`

---

### Task 10: 個人設定（トークン再発行）

**Files:** Create `frontend/src/routes/(app)/settings/+page.svelte`

- [ ] **Step 1:** 現在のトークン表示（マスク）、再発行ボタン（`POST /api/v1/auth/login/` を再実行するか、トークン再発行エンドポイントがあればそれを使用。無ければ「再ログインで新トークン取得」導線）、ログアウト。実際のトークン再発行手段は `schema.d.ts` とバックエンド `authentication` アプリの API を確認して決定。
- [ ] **Step 2: 検証** `npm run check` / `npm run build`
- [ ] **Step 3: Commit** `git commit -m "feat(frontend): personal settings screen"`

---

### Task 11: E2E スモークテスト（Playwright）

**Files:** Create `frontend/playwright.config.ts` / `frontend/e2e/smoke.spec.ts`

- [ ] **Step 1: Playwright 設定** `playwright.config.ts`（baseURL は環境変数 `E2E_BASE_URL`、デフォルト `http://localhost:4173`＝`vite preview`。webServer に `npm run build && npm run preview` を設定）。
- [ ] **Step 2: スモーク E2E** `e2e/smoke.spec.ts`：
  - ローカル docker compose の QFieldCloud を相手に、ログイン → プロジェクト一覧表示 → プロジェクト作成 → ファイルアップロード → ジョブ一覧確認、の一連をテスト
  - テストユーザーは docker compose 側で `createsuperuser` 済みの前提（テスト前提条件としてコメント明記）
  - CI では計画4がバックエンドを起動して実行（本タスクではローカルで通ることを確認）
- [ ] **Step 3: 実行** `npx playwright install --with-deps chromium && npm run test:e2e`（ローカルにバックエンド起動が必要）
- [ ] **Step 4: Commit** `git commit -m "test(frontend): playwright smoke e2e"`

---

### Task 12: FrontendStack プレースホルダーの扱いを整理

**Files:** Modify `infra/lib/frontend-stack.ts`（コメントのみ）/ `frontend/README.md`（新規）

- [ ] **Step 1:** `infra/lib/frontend-stack.ts` の Placeholder BucketDeployment のコメントを「計画3のビルド成果物は計画4のCIが `frontend/build/` を S3 sync する。このプレースホルダーは CI 導入までの暫定」と明確化（プレースホルダー自体は CI が `prune` せず上書きするので残してよい。削除は計画4で判断）。
- [ ] **Step 2:** `frontend/README.md` を作成：開発手順（`npm install` → バックエンドを docker compose 起動 → `npm run gen:api` → `npm run dev`）、ビルド（`npm run build` → `build/`）、S3 への配置は計画4 CI が担うこと、`config.json` の役割を記載。
- [ ] **Step 3: Commit** `git commit -m "docs(frontend): dev/build readme and frontend-stack note"`

---

## 自己レビュー結果（spec §5 との照合）

- §5.1 技術スタック（SvelteKit/Svelte5/TS/adapter-static/openapi-typescript+openapi-fetch/Tailwind v4/config.json 実行時注入）→ Task 1-3 でカバー ✅
- §5.2 認証（login → token → localStorage → Authorization: Token、CORS）→ Task 4 ✅
- §5.3 画面構成（サイドバー型、ログイン/プロジェクト一覧/詳細3タブ/ジョブ横断/個人設定）→ Task 5-10 ✅
- テスト（Vitest + Playwright）→ Task 2,4,6,11 ✅
- スキーマ駆動でパスをハードコードしない方針を明記（プレースホルダーではなく、生成型が唯一の正）✅

## スコープ外（計画4へ）

- ビルド成果物の S3 アップロード + CloudFront invalidation（CI）
- `schema.d.ts` の drift チェック（CI）
- E2E をCIで実行するためのバックエンド起動

## 既知の留意点（実装時に確認）

- `openapi-fetch` のパス指定は生成 `schema.d.ts` の実パスに完全一致が必要。ログインの body/レスポンス（`token` プロパティ名）は `LoginView` のシリアライザで確認。
- 自己署名 TLS のローカルバックエンドに対する型生成は `NODE_TLS_REJECT_UNAUTHORIZED=0` が必要。
- ファイルアップロードの進捗は `openapi-fetch` では取れないため当該箇所のみ `XMLHttpRequest`。
