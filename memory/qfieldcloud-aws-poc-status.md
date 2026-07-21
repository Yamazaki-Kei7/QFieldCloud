# QFieldCloud AWS PoC 引き継ぎ状況

最終更新: 2026-07-22

## 作業場所

- リポジトリ: `/Users/yamakei/Documents/GitHub/01_poc/QFieldCloud`
- 分離 worktree: `/Users/yamakei/Documents/GitHub/01_poc/QFieldCloud/.worktrees/plan3-4`
- 作業ブランチ: `codex/plan3-4`
- 作業開始時の HEAD: `20942c0a34592835b41a189696099ecb931d3f8f`
- ベースブランチ: `feature/infra-cdk` (`0e085178f37045db37a18b494ad3be9dfdf53d0b`)

## 4計画の状態

1. 計画1: `docs/superpowers/plans/2026-07-16-worker-ecs-executor.md`
   - 完了済み。ECS Fargate worker executor と既存 Docker 経路の切替を実装。
2. 計画2: `docs/superpowers/plans/2026-07-16-infra-cdk.md`
   - 完了済み。AWS CDK の Network/Data/App/Frontend/Ops 基盤を実装。
3. 計画3: `docs/superpowers/plans/2026-07-21-frontend-sveltekit.md`
   - Task 1-12、レビュー修正、OpenAPI再生成は完了。フルレビューに Critical/Important はなし。
   - download-ticket 発行APIはJSON専用。`.tmp/openapi.yaml` と `frontend/src/lib/api/schema.d.ts` は再生成済みで、このエンドポイントのform/multipart定義は除去済み。
4. 計画4: `docs/superpowers/plans/2026-07-21-cicd-and-acceptance.md`
   - ローカル実装完了。OIDC/workflow、ECR、monitoring/acceptance の独立レビューはすべて承認済みで、未解決指摘なし。
   - 実AWSへのデプロイ、GitHub Environment/OIDCロールの実設定、production受け入れは未実施。

## 計画3の主な成果

- SvelteKit SPA、認証、Projects/Files/Members/Jobs/Settings、スキーマ駆動APIクライアント。
- 大容量ダウンロード向けの短命 download ticket と、nginx/Django の private/no-store download 経路。
- Content-Disposition、チケット検証、プロジェクト・ジョブ契約のレビュー修正。
- フロントの local-only Playwright smoke と配信手順文書。

## 計画4の主な成果

- `.github/workflows/aws-pr-check.yml`: PR検証と、保護された `aws-pr-diff` Environment 経由の任意CDK diff。
- `.github/workflows/aws-deploy.yml`: master向け段階デプロイ。外部actionsは完全SHA固定。
- `docs/superpowers/plans/aws-oidc-setup.md`: deploy/PR diff OIDCロールと protected Environment の設定手順。
- `infra/scripts/deploy.sh`: Registry → images → base → services off → migrate → services on/Ops → frontend の順序を固定。
- `infra/scripts/push-images.sh`: SHAタグimmutable、`latest`のみmutable、再実行時のdigest検証とfail-closed処理。
- `infra/lib/ops-stack.ts`: ALB 5xx率、ECS desired-running不足、Aurora接続数/空き容量を含む合計11 alarms。
- `docs/superpowers/acceptance-checklist.md`: exact HTTP 200、IAM証跡、migration、ECS/ALB/DB、実機同期などの受け入れ手順。
- upstream由来の既存7 workflowsは変更なし。AWS用2ファイルのみ新規追加。

## 最終検証結果

- infra TypeScript: PASS
- infra Jest: 7 suites / 46 tests PASS
- deploy script tests: PASS
- PR/deploy workflow static tests: PASS
- frontend `check`: 0 errors / 0 warnings
- frontend Vitest: 20 files / 104 tests PASS
- frontend production build: PASS
- Python compileall: PASS
- Black: 14 files PASS
- Content-Disposition: 5 tests PASS
- nginx security: 3 tests PASS
- Docker fresh DB: download-ticket 14 tests、OpenAPI schema 5 tests PASS
- `git diff --check`: PASS
- `cdk synth --all --quiet`: AWS context lookup時の restricted DNS (`ec2.ap-northeast-1.amazonaws.com`) で停止。コード上の合成は全stackを扱うJest assertionsでPASS。
- `actionlint`: ローカル取得はnetwork制限で未実施。新規workflow内のCI jobで実行する構成と、リポジトリ内static testsはPASS。

## 未完了・次の順序

1. AWS管理者が `docs/superpowers/plans/aws-oidc-setup.md` に従ってロールとGitHub Environmentを設定する。
2. AWSデプロイworkflowを実行し、`docs/superpowers/acceptance-checklist.md` をproductionで完遂する。
3. `qfieldcloud.project.tests.test_project` はDocker fresh DBで4件後に進行せず一時コンテナを停止した。ストレージ連携を含む既存テストの環境依存として、AWSまたは完全なローカル開発スタックで別途調査する。

AWSへのデプロイやproduction受け入れが完了したとは扱わない。
