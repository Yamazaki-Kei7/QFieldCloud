# QFieldCloud AWS サーバレス構築 + モダンフロントエンド 設計書

- 日付: 2026-07-16
- ステータス: 設計確定（ブレインストーミングセッションで各セクション承認済み）
- 対象リポジトリ: opengisch/QFieldCloud のフォーク（本リポジトリ）

## 1. 目的と要件

社内利用の QFieldCloud を AWS 上にサーバレス志向で構築し、現場（QField モバイルアプリ）と社内（Webブラウザ）から利用できるようにする。OSS 版に存在しない管理用 Web フロントエンドを新規開発する。

確定した要件:

| 項目 | 決定 |
|---|---|
| 利用規模 | 中規模（〜50人、複数チーム・複数プロジェクト、日常的にジョブ実行） |
| 最優先事項 | 運用手間の最小化（OSパッチ・サーバー監視をなくす。常駐マネージドコンテナは許容） |
| アクセス経路 | インターネット公開（HTTPS、認証はアプリレベル） |
| 認証 | QFieldCloud 内蔵認証のみ（ID/パスワード + トークン） |
| 独自ドメイン / 証明書 | **取得しない**。CloudFront 標準ドメイン（`*.cloudfront.net`）を利用 |
| IaC | AWS CDK（TypeScript） |
| フロントエンド | SvelteKit（Svelte 5）+ TypeScript、サイドバー型レイアウト |
| フロント機能範囲 | プロジェクト/ファイル管理・メンバー/権限管理・ジョブ監視（地図プレビューはスコープ外） |

## 2. アーキテクチャ選定

3案（A: フルサーバレス・要コード改修 / B: ワーカーのみ ECS on EC2・無改修 / C: EC2 1台 docker-compose）を比較検討し、**A案（フルサーバレス）を採用**。

理由: 「運用手間の最小化」を最優先とするため EC2 の OS 管理をゼロにする。QFieldCloud のワーカーは Docker コンテナを動的起動する設計（`worker_wrapper/wrapper.py` が `docker.from_env()` + `client.containers.run()` を使用）だが、コード精査の結果、QGIS コンテナとのデータ交換は大半が API 経由であり、改修は起動機構の置き換えに局所化できると確認した。

## 3. 全体構成

```
利用者（ブラウザ / QFieldアプリ、IPv4/IPv6）
  │
  ├─ CloudFront①（フロント用 dxxxx.cloudfront.net）→ S3（SvelteKit SPA 静的配信、OAC）
  └─ CloudFront②（API用 dyyyy.cloudfront.net、キャッシュ無効・全パス転送）
       │  ビューワープロトコル: HTTPS（HTTP はリダイレクト）
       ▼ VPC オリジン（AWS 網内で完結・追加料金なし）
     内部 ALB（HTTP:80、インターネット非公開）
       ▼
  ┌────────── VPC（2AZ・デュアルスタック）──────────┐
  │ パブリックサブネット（dual-stack、タスクにパブリックIP付与）│
  │   - ECS Fargate: app タスク（nginx サイドカー + gunicorn）  │
  │   - ECS Fargate: worker_wrapper（dequeue + cron サイドカー） │
  │   - ECS Fargate: qgis3/qgis4 ジョブタスク（都度起動）        │
  │ プライベートサブネット                                       │
  │   - 内部 ALB（VPC オリジン経由でのみ到達）                   │
  │   - Aurora Serverless v2（PostgreSQL + PostGIS、0.5 ACU〜）  │
  │   - EFS（/io 受け渡し + PROJ 変換格子）                      │
  │ S3 Gateway Endpoint（無料）                                  │
  └──────────────────────────────────────┘
  S3（プロジェクトファイル、バージョニング必須）/ ECR / SES / Secrets Manager
```

### 3.1 ネットワーク設計（NAT Gateway 廃止）

- VPC はデュアルスタック（IPv4 + IPv6）。ECS アカウント設定 `dualStackIPv6` を有効化。
- **NAT Gateway は設置しない**。AWS 公式ドキュメントに「デュアルスタックのプライベートサブネットで Fargate を使う場合、タスク起動時の依存サービス（ECR/SSM/Secrets Manager）との通信に IPv4 経路（NAT）が必要」と明記されているため、プライベートサブネット + EIGW 構成は不成立。代わりに **Fargate タスクをパブリックサブネットに配置しパブリック IPv4 を付与**する（IGW 直接経由）。
  - コスト: パブリック IPv4 約 $3.7/月 × 常駐2〜3タスク ≒ $8〜12/月（NAT の $45/月 + 転送課金より大幅減）。
  - セキュリティ: SG でインバウンド完全封鎖（app は ALB の SG からのみ、worker/QGIS ジョブはインバウンドなし）。
- IPv6-only サブネット + EIGW 案は、地理院タイル等 IPv4-only の外部 WMS/タイルサービスへ到達できずジョブが失敗するリスクがあるため不採用（将来の再検討事項）。
- Aurora / EFS はプライベートサブネット（アウトバウンド不要のため NAT 不要）。
- ALB は internal（VPC オリジン専用、§3.2）のためデュアルスタック不要。モバイル回線の IPv6 クライアント対応は CloudFront 側（IPv6 有効、デフォルト）で担保。

### 3.2 ドメイン・TLS（Route 53 / ACM 不使用）

- フロント: CloudFront + S3。標準ドメインに自動付与される証明書を利用。
- API: **ALB 単体では有効な証明書を付けられない**（ACM はドメイン所有が前提）ため、API 用 CloudFront を立てて標準ドメインで包む。キャッシュ無効（CachingDisabled）+ 全ヘッダー転送（AllViewer 系オリジンリクエストポリシー、Host 含む）。
- **CloudFront VPC オリジンを採用（2026-07-16 設計更新・ユーザー承認済み）**: ALB は internal（インターネット非公開・プライベートサブネット）とし、CloudFront から VPC オリジン経由で直接接続する。当初案（パブリック ALB + プレフィックスリスト SG + シークレットヘッダー検証）は不要になり、CloudFront→ALB 間のトラフィックが公衆経路を通らなくなる。追加料金なし。ALB の SG は VPC 内からの HTTP:80 のみ許可。
- **CloudFront→ALB 間は HTTP（平文だが AWS 網内・VPC 内で完結）**。以下で整合性を担保（コード確認済み・無改修）:
  - Django は `SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")` 設定済み（`settings.py:68`）
  - サイドカー用 nginx 設定で `proxy_set_header X-Forwarded-Proto https;` を**固定値**で送る（現行テンプレートの `$scheme` のままだと管理画面ログインが CSRF 403 になり、メール内リンクが `http://` になる）
  - API 用 CloudFront のビューワープロトコルは HTTPS のみなので、固定値は事実と一致
  - ファイルダウンロード分岐（`filestorage/view_helpers.py:278`）は `X-Forwarded-For` の存在のみを見るため影響なし（ALB が必ず付与）
- 了承済みトレードオフ:
  1. URL がランダム文字列（`dxxxx.cloudfront.net`）になる。独自ドメインは後から ACM + エイリアス追加のみで導入可能
  2. CloudFront→ALB 間が平文（VPC オリジン採用により経路は AWS 網内・VPC 内で完結。公衆経路の平文という当初の懸念は解消済み）
  3. 数 GB 級の大容量アップロードは CloudFront 経由の実測が必要（必要ならタイムアウト緩和申請）
- `QFIELDCLOUD_HOST` は API 用 CloudFront ドメイン。`DJANGO_ALLOWED_HOSTS` は `*` とする: ALB ヘルスチェックが Host=タスクIP で `/api/v1/status/` を叩くため固定リストでは賄えない。CloudFront は自身のドメインと一致しない Host を転送できず、ALB は internal で VPC 外から到達不能なため、Host ヘッダー攻撃の現実的経路はなく許容範囲（独自ドメイン導入時に再検討）。

### 3.3 コンポーネント設計

| コンポーネント | 構成 | 備考 |
|---|---|---|
| app タスク | nginx サイドカー + gunicorn（Fargate サービス、1〜2タスク） | **nginx は廃止しない**。ファイルダウンロードが nginx の `X-Accel-Redirect` 内部リダイレクト（`filestorage/view_helpers.py:327`、S3 署名付き URL を nginx がストリーミング）に依存するため。サイドカー用に HTTP:80 のみの簡易 nginx 設定を新規作成（certbot/TLS/Docker DNS 部分を除去、リゾルバは VPC DNS） |
| 静的ファイル | コンテナ起動時に `collectstatic` → タスク内共有ボリューム → nginx が配信 | |
| worker_wrapper | Fargate サービス（0.25 vCPU / 1GB × 2レプリカ、環境変数で増減） | `manage.py dequeue` ループ。1レプリカ=同時1ジョブ（既存モデル維持） |
| cron | worker_wrapper タスク内サイドカー（`runcrons` を60秒ループ） | ofelia の代替 |
| QGIS ジョブ | Fargate タスク都度起動（qgis3 / qgis4 タスク定義、1 vCPU / 4GB、環境変数で調整可） | ジョブ実行中のみ課金 |
| DB | Aurora Serverless v2（PostgreSQL + PostGIS）0.5 ACU〜 | cron が毎分 DB を叩くため auto-pause は実質効かない前提でコスト見積 |
| オブジェクトストレージ | S3（バージョニング有効） | QFieldCloud の必須要件。`STORAGES` 環境変数で設定 |
| キャッシュ | memcached を app タスクのサイドカーとして同居 | ElastiCache は将来の拡張オプション |
| ファイル受け渡し | EFS（アクセスポイント2つ: `/io` と `/transformation_grids`） | 詳細は §4 |
| メール | SES（**送信元メールアドレス検証方式**、ドメイン検証不要） | サンドボックス解除申請が必要。SMTP 認証情報は Secrets Manager |
| シークレット | Secrets Manager（SECRET_KEY / SALT_KEY / DB / SES） | 非機密設定は SSM Parameter Store |
| PROJ 格子データ | EventBridge Scheduler 月次 → wget ミラータスク（compose の `mirror_transformation_grids` 相当） | |

### 3.4 CDK スタック分割（TypeScript、`infra/` ディレクトリ）

1. **NetworkStack** — dual-stack VPC / サブネット / S3 Gateway Endpoint / SG
2. **DataStack** — Aurora / S3 / EFS / Secrets Manager
3. **AppStack** — ECS クラスター / タスク定義 / サービス / ALB / API 用 CloudFront
4. **FrontendStack** — フロント用 S3 + CloudFront / SPA デプロイ / `config.json` 生成（API URL を実行時注入）
5. **OpsStack** — CloudWatch アラーム / SNS / バックアップ設定

## 4. ワーカーの ECS RunTask 化（フォーク改修設計）

### 4.1 方針: エグゼキュータ切替式

- 環境変数 `QFIELDCLOUD_WORKER_EXECUTOR=docker|ecs`（デフォルト `docker`）で切替。
- 既存 Docker 経路は無改修で温存 → ローカル開発・既存テスト・upstream 追従を維持。
- 新規コード: `worker_wrapper/executors/ecs.py`（boto3）。`_run_docker()` は起動/待機/ログ/停止をエグゼキュータへ委譲する最小リファクタ。

### 4.2 Docker API → ECS のマッピング（コード精査済みの5点）

| 現行（docker-py） | ECS 版 |
|---|---|
| `client.containers.run(image, command, environment, volumes, network, mem_limit, cpu_shares, labels, detach)` | `ecs:RunTask`（qgis3/qgis4 タスク定義、containerOverrides で command/environment 注入、タグに job_id/project_id/type、`startedBy=qfc-worker-<env>`）。taskArn を `job.container_id` に保存 |
| `container.wait(timeout=container_timeout_secs)` | `DescribeTasks` ポーリング（5秒間隔）。タイムアウト時は `StopTask`（既存の `TIMEOUT_ERROR_EXIT_CODE` 経路を維持） |
| `container.logs()` | awslogs ドライバ → `logs:GetLogEvents`（ストリーム名は taskArn から導出）。読取失敗時のリトライ・フォールバック文言は既存踏襲 |
| `container.stop()` / `container.remove()` | `StopTask`（remove は不要、ECS が自動処分） |
| `cancel_orphaned_workers()`（ラベルで docker ps 相当） | `ListTasks(startedBy)` と DB の Job を突合 → 孤児は `StopTask` |

- 終了コード: `containers[].exitCode`。137（SIGKILL/OOM）の既存ハンドリングを stopCode/exitCode にマッピング。
- RunTask 失敗（キャパシティ/スロットル）: エグゼキュータ内で指数バックオフのリトライ、最終失敗は既存の feedback 機構で `error_origin=worker_wrapper` として記録。

### 4.3 ファイル受け渡し（/io）

- 現行: wrapper が `tempfile.mkdtemp(dir=TMP_FILE)` で作った一時ディレクトリをホストバインドで QGIS コンテナの `/io` にマウント。中身は主に `feedback.json`（プロジェクトデータ本体は QGIS コンテナが `QFIELDCLOUD_URL` + ワーカートークンで API から直接取得/返却）。
- 新構成: EFS アクセスポイント `/io` を wrapper タスク（`TMP_DIRECTORY` として）と QGIS タスク定義（`/mnt/io`）の両方にマウント。wrapper の既存 mkdtemp はそのまま動く。
- **QGIS 側の改修は1箇所**: `docker-qgis/qfc_worker/commands_base.py:79` の `Path("/io/feedback.json")` を環境変数 `QFC_IO_DIR`（デフォルト `/io`）化し、エグゼキュータが `QFC_IO_DIR=/mnt/io/<ジョブ用サブディレクトリ>` を注入。後方互換のため upstream への PR 提案も可能。
- 後始末: ジョブ完了時に wrapper がサブディレクトリを削除（これが唯一の削除手段）。EFS のライフサイクルポリシー（IA移行）はコスト最適化であり自動削除ではない点に注意 — wrapper 異常終了で孤児化したディレクトリは残るが、内容は feedback.json 中心の数MB規模で実害は小さい（2026-07-17 レビュー指摘で表現を是正）。

### 4.4 IAM（wrapper タスクロール）

- `ecs:RunTask` / `DescribeTasks` / `StopTask` / `ListTasks`（クラスター・タスク定義ファミリーに限定）
- `iam:PassRole`（QGIS タスクの実行ロール・タスクロールのみ）
- `logs:GetLogEvents`（QGIS ログループのみ）
- 運用ノート: QGIS タスクへ渡す環境変数は `ecs:DescribeTasks` や CloudTrail から参照可能（§9 の受容済みリスク参照）。人間用 IAM プリンシパルには `ecs:DescribeTasks` と CloudTrail 閲覧権限を管理者のみに限定すること。

### 4.5 トレードオフ（承認済み）

- ジョブ開始レイテンシ: Fargate 起動 + 数 GB の QGIS イメージ pull で **2〜4分程度**の開始遅延見込み。ジョブは元々非同期のため許容。改善オプション（SOCI / zstd 圧縮）は後付け可能。
- フォーク保守: 差分は新規ファイル + 局所改修に限定し、upstream との衝突面を最小化。

## 5. フロントエンド設計

### 5.1 技術スタック

- **SvelteKit（Svelte 5）+ TypeScript + adapter-static**（SPA、fallback: `index.html`）。S3 + CloudFront から静的配信、SSR サーバーなし。
- **API クライアント**: QFieldCloud の Swagger（OpenAPI）から `openapi-typescript` で型生成 + `openapi-fetch`。`any` / `unknown` / `class` 不使用（コーディング規約）。
- **スタイリング**: Tailwind CSS v4。
- **API URL 注入**: ビルド時埋め込みではなく、CDK デプロイが生成する `config.json` を実行時にフェッチ。
- **配置**: 本リポジトリ内 `frontend/` ディレクトリ（新規ディレクトリのため upstream マージと衝突しない）。

### 5.2 認証

- ログイン画面 → `POST /api/v1/auth/token/` → トークンを localStorage に保持 → `Authorization: Token <key>` で API 呼び出し。
- CORS: Django 側の既存設定（`CORS_ALLOWED_ORIGINS` にフロント用 CloudFront ドメインを設定）。トークン認証のため credentials 不要。

### 5.3 画面構成（サイドバー型レイアウト・承認済み）

- 左サイドバー: プロジェクト / ジョブ一覧（横断） / メンバー。将来の画面追加（地図プレビュー等）に耐える構成。
- 画面一覧（MVP）:
  1. ログイン
  2. プロジェクト一覧（作成・削除・検索）
  3. プロジェクト詳細 — タブ3つ:
     - ファイル: 一覧・複数アップロード（進捗表示）・ダウンロード・バージョン履歴
     - メンバー: コラボレーター追加/削除・ロール変更
     - ジョブ: 状態一覧・ログ/エラー表示・再実行
  4. ジョブ一覧（プロジェクト横断の監視ビュー）
  5. 個人設定（トークン再発行）

## 6. 運用設計

### 6.1 CI/CD（GitHub Actions）

- PR: lint / テスト / `cdk diff`
- master マージ: イメージビルド（app / qgis3 / qgis4）→ ECR push → **ECS 一回限りタスクで `manage.py migrate`** → `cdk deploy`（サービス更新・フロントデプロイ含む）
- 環境は当面 production 1面のみ。

### 6.2 監視 / 通知

- CloudWatch アラーム最小セット: ALB 5xx 率・ターゲット異常 / ECS サービス実行数不足 / Aurora CPU・接続数・空き容量。SNS → メール通知。
- ログメトリクスフィルターで ERROR 急増検知。
- ALB ヘルスチェックは既存の `/api/v1/status/`（DB・ストレージ疎通付き）。
- Sentry は環境変数設定のみで有効化できる後付けオプション。

### 6.3 バックアップ

- Aurora: 自動バックアップ 7日（PITR）。
- S3: バージョニング有効。**旧バージョン削除のライフサイクルは設定しない**（QFieldCloud のファイル履歴機能の実体のため）。未完了マルチパートアップロードの中断ルールのみ。
- EFS: バックアップ不要（`/io` は一時データ、格子データは再取得可能）。

### 6.4 エラー処理

- ジョブ失敗: 既存 feedback 機構で DB 記録 → フロントの「ジョブ」タブで確認・再実行。
- wrapper 異常終了: ECS サービスが自動再起動。孤児 QGIS タスクは `cancel_orphaned_workers` の ECS 版が回収。
- 502/503: 既存 nginx の loading/エラーページ挙動を踏襲。

## 7. テスト戦略

| レイヤー | 内容 |
|---|---|
| バックエンド既存 | 既存 Django テストスイートを CI で維持（Docker 経路無改修の保証） |
| ECS エグゼキュータ | boto3 スタブによるユニットテスト（正常系 / タイムアウト / RunTask 失敗リトライ / 孤児掃除） |
| フロントエンド | Vitest（コンポーネント）+ Playwright（ログイン→一覧→アップロード→ジョブ確認のスモーク E2E、ローカル docker compose スタック相手） |
| インフラ | `cdk synth` + assertions テスト |
| 受け入れ | デプロイ後チェックリスト（QField モバイル実機からの接続・同期・パッケージングの手動確認を含む） |

## 8. コスト概算（東京リージョン、月額）

| 項目 | 概算 |
|---|---|
| ALB | ~$25 |
| Fargate 常駐（app 1〜2 + wrapper 2 + サイドカー） | ~$30〜50 |
| QGIS ジョブ（従量） | 利用量次第（例: 1 vCPU/4GB × 5分 × 300ジョブ/月 ≒ $3〜5） |
| Aurora Serverless v2（0.5 ACU 常時） | ~$45 |
| パブリック IPv4 | ~$8〜12 |
| S3 / EFS / ECR / CloudWatch / SES | ~$5〜15 |
| CloudFront | 無料枠内（〜1TB/月） |
| **合計** | **~$120〜150/月**（NAT 廃止・独自ドメイン不要化を反映） |

## 9. リスクと対応

| リスク | 対応 |
|---|---|
| upstream 更新でフォーク差分が衝突 | 差分を新規ファイル中心に限定。`QFC_IO_DIR` は upstream へ PR 提案 |
| 数 GB 級ファイルの CloudFront 経由アップロード | 構築後に実測。問題があればタイムアウト緩和申請、最終手段は独自ドメイン + ALB 直結 |
| ジョブ開始レイテンシ（2〜4分）が現場で不評 | SOCI / zstd による pull 高速化を後付け検討 |
| SES サンドボックス解除の審査 | 送信元検証 + 解除申請を構築初期に実施（リードタイムあり） |
| Aurora の PostGIS バージョン制約 | 構築時に QFieldCloud 要件（PostGIS 3系）と Aurora サポートバージョンを照合 |
| QGIS ジョブへ渡す環境変数（短命ワーカートークン・PGSERVICE・ユーザー定義シークレット）が RunTask の平文 `environment` として CloudTrail と `ecs:DescribeTasks` に露出する | **受容（2026-07-16 ユーザー承認）**。社内専用 AWS アカウント・限定された IAM ユーザーが前提。運用では `ecs:DescribeTasks`/CloudTrail 閲覧を管理者に限定（§4.4）。将来の強化案: EFS のジョブディレクトリ経由のファイル受け渡しへ切替（docker-qgis エントリポイント改修が必要） |

## 10. スコープ外（明示）

- 地図プレビュー（MapLibre 等）
- Google 等の SSO / ソーシャルログイン
- ステージング環境（当面 production 1面）
- 独自ドメイン・経路の完全暗号化（§3.2 に将来導入する場合の方針のみ記載）
- ElastiCache / SOCI / Sentry（後付けオプションとして記載）
