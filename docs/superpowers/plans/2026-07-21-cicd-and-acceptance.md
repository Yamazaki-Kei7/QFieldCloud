# 計画4: CI/CD + 受け入れ 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** GitHub Actions で、PR 検証（lint/test/cdk diff/型 drift）と master マージ時のデプロイ（イメージ push → migrate → ECS 更新 → フロント配信）を自動化し、受け入れチェックリストを整備する。

**Architecture:** 既存の upstream ワークフロー（`.github/workflows/*.yml`、7本）は変更せず、AWS デプロイ用の新規ワークフローを**追加**する。デプロイは計画2の段階的順序（RegistryStack → push → 基盤 → App(services 0) → migrate → App/Ops(services 有効) → フロント sync）に従う。認証は GitHub OIDC → AWS IAM ロール（長期キーを置かない）。

**Tech Stack:** GitHub Actions / aws-actions/configure-aws-credentials（OIDC）/ AWS CDK CLI / Docker Buildx / Node 20

**参照:** 設計書 `docs/superpowers/specs/2026-07-16-qfieldcloud-aws-serverless-design.md` §6（運用設計）§7（テスト戦略）、計画2 `docs/superpowers/plans/2026-07-16-infra-cdk.md`（`infra/README.md` の手動ランブックを自動化する）、計画3 `docs/superpowers/plans/2026-07-21-frontend-sveltekit.md`

---

## 事前確認済みの重要事実（実装者は前提としてよい）

- **既存 CI**（`.github/workflows/`）: `build_and_push.yml`（DockerHub への matrix ビルド）, `check_urls.yml`, `codeql.yml`, `pyqt6_check.yml`, `stale.yml`, `sync_translations.yml`, `test.yml`。**これらは upstream 由来。改変せず、新規ファイルを追加する**（フォーク差分最小化）。
- **デプロイ順序（計画2で確定・`infra/README.md` に記載）**: 段階的に必要。
  1. `cdk deploy QfcRegistry`（ECR 先出し）
  2. `push-images.sh`（5イメージを ECR へ、`--platform linux/amd64`）
  3. `cdk deploy QfcNetwork QfcData QfcFrontend`
  4. `cdk deploy QfcApp -c servicesEnabled=false`（タスク0で安定化待ちなし）
  5. migrate 単発 RunTask（`qfc-migrate`、`CREATE EXTENSION postgis`→`migrate` 込み）
  6. `cdk deploy QfcApp QfcOps`（services 有効化）
  7. フロント build → `frontend/build/` を FrontendStack の S3 へ sync + CloudFront invalidation
- **`latest` タグ問題（計画2バックログ #8）**: 全イメージ `latest` 固定のため、`cdk deploy` は TaskDefinition 差分を生まず app/worker/cron を再デプロイしない。→ **本計画で恒久対応**: イメージタグに **commit SHA** を使い、CDK に `-c imageTag=<sha>` で渡して TaskDefinition を毎回更新する（`app-stack.ts` を要修正、Task 3 参照）。
- **認証**: GitHub OIDC。AWS 側に OIDC プロバイダと deploy 用 IAM ロール（信頼ポリシーで当該リポジトリ・ブランチに限定）が必要。これは**手動 or 別 CDK スタックで事前準備**（本計画 Task 1 でセットアップ手順を文書化。ロール ARN は GitHub Secrets `AWS_DEPLOY_ROLE_ARN` に格納）。
- **リージョン/命名**: `ap-northeast-1`、クラスター `qfc-cluster`、タスク定義 `qfc-migrate`/`qfc-app` 等（計画2 `CONFIG.appName="qfc"`）。
- **フロント配信先**: FrontendStack の S3 バケット名は CloudFormation 出力から取得（`QfcFrontend` スタックの `FrontendUrl` 出力、およびバケット名出力を計画で追加）。CloudFront ディストリビューション ID も同様。
- **PoC 環境は production 1面**（設計書 §6.1）。ステージングは無し。

## ファイル構成

| 操作 | パス | 責務 |
|---|---|---|
| Create | `.github/workflows/aws-pr-check.yml` | PR: infra 型/test/cdk diff、frontend 型/test、schema drift |
| Create | `.github/workflows/aws-deploy.yml` | master push: 段階デプロイ（push→migrate→ECS→フロント） |
| Modify | `infra/lib/app-stack.ts` | イメージタグを context `imageTag`（既定 `latest`）で受ける |
| Modify | `infra/lib/frontend-stack.ts` | バケット名・ディストリビューションID を CfnOutput |
| Modify | `infra/scripts/push-images.sh` | タグ引数（SHA）対応 |
| Create | `infra/scripts/deploy.sh` | 段階デプロイを1スクリプト化（ローカル/CI 共用） |
| Create | `docs/superpowers/acceptance-checklist.md` | デプロイ後の受け入れチェックリスト |
| Modify | `infra/README.md` | CI/CD 前提での更新手順に追記 |

**検証コマンド**: ワークフローYAMLは `actionlint`（`docker run --rm -v $(pwd):/repo rhysd/actionlint:latest -color`）で構文検証。infra 変更は `cd infra && node_modules/.bin/tsc --noEmit && node_modules/.bin/jest --config jest.config.js`。

**注意**: 本計画のデプロイワークフローは**実 AWS アカウントと OIDC ロールが無いと実行できない**。CI 上での完全な end-to-end 実行は AWS 資格情報の準備後。本計画の完了条件は「YAML が actionlint を通り、infra 変更のテストが通り、手動で `deploy.sh` の各ステップが正しい順序・引数であることをレビューで確認」まで。実デプロイは受け入れフェーズ。

---

### Task 1: GitHub OIDC ロールのセットアップ文書化

**Files:** Create `docs/superpowers/plans/aws-oidc-setup.md`（または `infra/README.md` に追記）

- [ ] **Step 1:** GitHub OIDC を AWS に設定する手順を文書化:
  - IAM OIDC プロバイダ作成（`token.actions.githubusercontent.com`）
  - deploy 用 IAM ロール（信頼ポリシー: `repo:Yamazaki-Kei7/QFieldCloud:ref:refs/heads/master` 等に限定、`sub` 条件）
  - 権限: CDK デプロイに必要な範囲（CloudFormation/ECR/ECS/S3/CloudFront/IAM PassRole/Secrets/RDS/EFS/EC2/logs/events/sns）。PoC では広めのマネージドポリシー + 明示的な最小化はバックログ
  - ロール ARN を GitHub リポジトリの Secret `AWS_DEPLOY_ROLE_ARN` に登録
- [ ] **Step 2:** この設定は CDK 化（OidcStack）も可能だが、ブートストラップの鶏卵（デプロイロールが無いとデプロイできない）を避けるため**初回は手動 or 管理者がローカルから1度だけ作成**する方針を明記。
- [ ] **Step 3: Commit** `git commit -m "docs(ci): github oidc deploy role setup"`

---

### Task 2: イメージタグを CDK context で受ける（latest 固定の解消）

**Files:** Modify `infra/lib/app-stack.ts` / `infra/lib/registry-stack.ts`（必要なら）/ `infra/test/app-stack.test.ts`

- [ ] **Step 1: 失敗するテスト** `app-stack.test.ts` に追加: `-c imageTag=abc123` を与えて synth したとき、app/worker/qgis/migrate/cron の各 ContainerDefinition の Image が `:abc123` で終わることを assert。

```typescript
test("container images use the imageTag context (not hardcoded latest)", () => {
  const app = new cdk.App({ context: { imageTag: "abc123" } });
  // ... build stacks as in synthApp() but on this app ...
  const template = Template.fromStack(appStack);
  const taskDefs = template.findResources("AWS::ECS::TaskDefinition");
  const images = Object.values(taskDefs).flatMap((t) =>
    (t.Properties.ContainerDefinitions as Array<{ Image: unknown }>).map((c) => c.Image),
  );
  // ECR-based images should reference the abc123 tag somewhere in their Fn::Join
  const ecrImages = images.filter((img) => JSON.stringify(img).includes("abc123"));
  expect(ecrImages.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: 失敗確認** `node_modules/.bin/jest` → FAIL（現状 `"latest"` 固定）

- [ ] **Step 3: 実装** `app-stack.ts` のコンストラクタ冒頭付近に:

```typescript
    // Image tag for the ECR-based containers. CI passes the commit SHA so each
    // deploy updates the TaskDefinition (a fixed "latest" produces no CFN diff
    // and would not roll the services — plan 2 backlog #8).
    const imageTag = (this.node.tryGetContext("imageTag") as string) ?? "latest";
```
そして ECR 由来イメージの `fromEcrRepository(repos.X, "latest")` をすべて `fromEcrRepository(repos.X, imageTag)` に置換（app/nginx/worker/migrate/cron/qgis3/qgis4。ただし nginx/qgis も同じ SHA タグで push する前提。`public.ecr.aws` の memcached/alpine はそのまま）。

- [ ] **Step 4: 成功確認** `node_modules/.bin/jest` → PASS。`-c imageTag` 未指定時は `latest` で既存テストも維持されることを確認。
- [ ] **Step 5: Commit** `git commit -m "feat(infra): parameterize container image tag via context"`

---

### Task 3: push-images.sh のタグ対応 + deploy.sh

**Files:** Modify `infra/scripts/push-images.sh` / Create `infra/scripts/deploy.sh`

- [ ] **Step 1:** `push-images.sh` を、第1引数または `IMAGE_TAG` 環境変数でタグを受け取り、`:latest` に加えて `:$IMAGE_TAG`（SHA）でも push するよう変更（両タグ push で `latest` も最新に保つ）。
- [ ] **Step 2:** `infra/scripts/deploy.sh` を作成（計画2の段階順序を1スクリプトに。ローカルでもCIでも使える）:

```bash
#!/usr/bin/env bash
# Phased deploy of QFieldCloud to AWS (plan 2 ordering). Idempotent-ish.
# Usage: AWS_ACCOUNT_ID=... IMAGE_TAG=<sha> ./deploy.sh
set -euo pipefail
: "${AWS_ACCOUNT_ID:?}"; : "${IMAGE_TAG:?}"
REGION="ap-northeast-1"; CLUSTER="qfc-cluster"
cd "$(dirname "$0")/.."   # infra/

npx cdk deploy QfcRegistry --require-approval never
AWS_ACCOUNT_ID="$AWS_ACCOUNT_ID" IMAGE_TAG="$IMAGE_TAG" ./scripts/push-images.sh
npx cdk deploy QfcNetwork QfcData QfcFrontend --require-approval never
npx cdk deploy QfcApp -c servicesEnabled=false -c imageTag="$IMAGE_TAG" --require-approval never

# run migrations (creates postgis extension then migrates) and wait
TASK_ARN=$(aws ecs run-task --cluster "$CLUSTER" --launch-type FARGATE \
  --task-definition qfc-migrate --region "$REGION" \
  --network-configuration "$(cat network-config.json)" \
  --query 'tasks[0].taskArn' --output text)
aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK_ARN" --region "$REGION"
EXIT=$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" --region "$REGION" \
  --query 'tasks[0].containers[0].exitCode' --output text)
[ "$EXIT" = "0" ] || { echo "migrate failed (exit $EXIT)"; exit 1; }

npx cdk deploy QfcApp QfcOps -c imageTag="$IMAGE_TAG" --require-approval never
echo "Backend deploy complete."
```
（`network-config.json` は subnet/SG を含む awsvpcConfiguration。CI が CloudFormation 出力から生成する。ローカルは手動作成）

- [ ] **Step 3: 検証** `bash -n infra/scripts/*.sh`（構文）
- [ ] **Step 4: Commit** `git commit -m "feat(infra): phased deploy script and tagged image push"`

---

### Task 4: PR 検証ワークフロー

**Files:** Create `.github/workflows/aws-pr-check.yml`

- [ ] **Step 1:** 以下をトリガーする PR ワークフロー（`infra/**` または `frontend/**` 変更時）:
  - `infra` ジョブ: Node 20 → `cd infra && npm ci && node_modules/.bin/tsc --noEmit && node_modules/.bin/jest --config jest.config.js`。（`cdk diff` は AWS 資格情報が要るため OIDC ありの場合のみ実行する条件付きステップ、無ければスキップ）
  - `frontend` ジョブ: Node 20 → `cd frontend && npm ci && npm run check && npm run test && npm run build`
  - `schema-drift` ジョブ: バックエンドを軽く起動 or `manage.py spectacular` でスキーマ生成 → `openapi-typescript` で再生成し `git diff --exit-code frontend/src/lib/api/schema.d.ts`（コミット済み型が最新かチェック）
- [ ] **Step 2: 検証** `actionlint` で構文チェック
- [ ] **Step 3: Commit** `git commit -m "ci: add AWS PR check workflow"`

---

### Task 5: デプロイワークフロー

**Files:** Create `.github/workflows/aws-deploy.yml`

- [ ] **Step 1:** master push（`infra/**`,`docker-*/**`,`frontend/**`,`docker-app/**` 変更時）で起動、`concurrency` で直列化、`permissions: id-token: write` を付与:
  - `configure-aws-credentials`（OIDC、`role-to-assume: ${{ secrets.AWS_DEPLOY_ROLE_ARN }}`, region ap-northeast-1）
  - `IMAGE_TAG=${{ github.sha }}` を決定
  - `infra/scripts/deploy.sh` を実行（バックエンド段階デプロイ）
  - フロント配信: `cd frontend && npm ci && npm run gen:api（or コミット済みschema使用）&& npm run build` → S3 sync（`aws s3 sync frontend/build/ s3://<frontend-bucket>/ --delete` は config.json を消さないよう `--exclude config.json`）→ CloudFront invalidation（`/*`）
  - バケット名/ディストリビューションIDは `aws cloudformation describe-stacks` の出力から取得
- [ ] **Step 2:** デプロイ後スモーク: `curl -fsS https://<api-cloudfront>/api/v1/status/` が 200 かつ JSON の database/storage が ok かを jq で検証（失敗ならワークフロー失敗）。
- [ ] **Step 3: 検証** `actionlint`
- [ ] **Step 4: Commit** `git commit -m "ci: add phased AWS deploy workflow"`

---

### Task 6: FrontendStack の出力追加

**Files:** Modify `infra/lib/frontend-stack.ts` / `infra/test/frontend-stack.test.ts`

- [ ] **Step 1: テスト** バケット名・ディストリビューションID の CfnOutput が存在することを assert。
- [ ] **Step 2: 実装** `frontend-stack.ts` に `new cdk.CfnOutput(this, "FrontendBucketName", { value: this.bucket.bucketName })` と `new cdk.CfnOutput(this, "FrontendDistributionId", { value: this.distribution.distributionId })` を追加（デプロイワークフローが sync/invalidation 先を取得するため）。
- [ ] **Step 3: 検証** `node_modules/.bin/jest` / `tsc --noEmit`
- [ ] **Step 4: Commit** `git commit -m "feat(infra): output frontend bucket and distribution id"`

---

### Task 7: 受け入れチェックリスト

**Files:** Create `docs/superpowers/acceptance-checklist.md`

- [ ] **Step 1:** デプロイ後に人手で確認する受け入れ項目を文書化（設計書 §7 の受け入れ基準を具体化）:
  - [ ] `curl https://<ApiUrl>/api/v1/status/` → database:ok / storage:ok
  - [ ] `https://<ApiUrl>/admin/` にスーパーユーザーでログイン（CSRF が通る = X-Forwarded-Proto 配線の確認）
  - [ ] フロント `https://<FrontendUrl>` でログイン → プロジェクト作成 → ファイルアップロード → メンバー追加
  - [ ] **QField モバイル実機**: サーバー URL に `https://<ApiUrl>` を設定 → ログイン → プロジェクト同期（ダウンロード）→ 変更を加えて同期（デルタ適用ジョブ）→ パッケージング。ECS コンソールで `qfc-qgis3`/`qgis4` タスクがジョブごとに起動・終了することを確認
  - [ ] ジョブ失敗時、フロントのジョブタブでログ/エラーが見え、再実行できる
  - [ ] 大容量（数百MB〜GB）ファイルのアップロード/ダウンロードが CloudFront 経由で成立するか（**計画2バックログ #10: CloudFront VPCオリジンの応答timeout 30s に注意。30s 超で 504 になる場合は readTimeout 調整が必要**）
  - [ ] メール（招待/通知）が SES 経由で届く（SES サンドボックス解除後）
  - [ ] CloudWatch アラーム（SNS→メール）購読が confirm 済みで発報が届く
- [ ] **Step 2:** 各項目に「失敗時の一次対応・確認ログ（CloudWatch `/qfc/app`,`/qfc/worker`,`/qfc/qgis`）」を併記。
- [ ] **Step 3: Commit** `git commit -m "docs: post-deploy acceptance checklist"`

---

## 自己レビュー結果（spec §6/§7 との照合）

- §6.1 CI/CD（PR: lint/test/cdk diff、master: build→ECR→migrate→cdk deploy）→ Task 4,5 ✅。migrate 順序は計画2の段階デプロイに整合（Task 3 deploy.sh）✅
- §6.2 監視 → 計画2 OpsStack で実装済み。デプロイ後スモーク（status 200 チェック）を Task 5 に追加 ✅
- §7 テスト戦略（既存Djangoテスト維持 / infra assertions / フロント Vitest+Playwright / 受け入れ手動）→ 既存 `test.yml` 維持、infra は Task 4、フロントは計画3、受け入れは Task 7 ✅
- `latest` タグ問題（計画2バックログ #8）を Task 2 で恒久対応 ✅
- CloudFront 30s timeout（バックログ #10）を受け入れチェックに明記 ✅

## スコープ外 / 前提

- 実 AWS アカウント・OIDC ロールの実作成（Task 1 は手順文書化。実作成は管理者）
- ステージング環境（PoC は production 1面）
- ロールバック自動化（`latest`/SHA タグと `cdk deploy` の手動再実行で対応。circuitBreaker 導入は計画2バックログ）
- CI 上での完全 e2e デプロイ検証（AWS 資格情報準備後の受け入れフェーズ）

## 依存関係

- **計画2（infra）が master にマージ済みであること**（RegistryStack/servicesEnabled/migrate タスク定義が前提）。
- **計画3（frontend）の `frontend/build/` が生成できること**（デプロイワークフローの sync 対象）。
- 実行順序: 計画2 → 計画3 → 計画4。
