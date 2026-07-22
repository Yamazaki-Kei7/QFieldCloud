# QFieldCloud AWS インフラ（CDK）

QFieldCloud を AWS 上（ECS Fargate + Aurora Serverless v2 + EFS + CloudFront）にデプロイするための CDK スタック群。

スタック構成（6つ、依存順）:

```
QfcNetwork  ─┬─▶ QfcData ─┐
             │            ├─▶ QfcApp ─▶ QfcOps
             ├─▶ QfcRegistry ┘
             │
             └─▶ QfcFrontend ─────────┘
```

- **QfcNetwork**: dual-stack VPC（NAT ゲートウェイなし。タスクはパブリックサブネット + パブリックIP）
- **QfcData**: S3（プロジェクトファイル）、EFS（ジョブ間ファイル交換）、Aurora Serverless v2（PostgreSQL/PostGIS）、Secrets Manager
- **QfcRegistry**: ECR リポジトリ（app / worker / nginx / qgis3 / qgis4）。**App より先にデプロイする**（下記「初回デプロイ手順」参照）
- **QfcFrontend**: SPA 用 S3 + CloudFront（計画3で実体を配置）
- **QfcApp**: ECS クラスタ、ALB、CloudFront（API）、各サービス/タスク定義
- **QfcOps**: CloudWatch アラーム、PROJ 格子データ月次ミラーリングの EventBridge スケジュール

## 前提

- Node.js 20+ / Docker / AWS CLI v2（認証済みプロファイル）
- リージョン: `ap-northeast-1`

## 初回デプロイ手順

ECR とサービスを同一スタックにすると「イメージが無いので `cdk deploy` が待ち続ける」「サービスが無いと ECR を作れない」という鶏卵問題が起きるため、**ECR（QfcRegistry）→ イメージ push → 基盤スタック → サービス0台でAppデプロイ → migrate → サービス起動**の順で進める。

1. **(任意) ECS dual-stack IPv6 設定**（アカウントで未設定の場合）
   ```bash
   aws ecs put-account-setting-default --name dualStackIPv6 --value enabled --region ap-northeast-1
   ```

2. **CDK bootstrap**
   ```bash
   cd infra && npm install && npx cdk bootstrap
   ```

3. **RegistryStack を先にデプロイ**（ECR リポジトリのみ作成。まだイメージは無い）
   ```bash
   npx cdk deploy QfcRegistry --require-approval never
   ```

4. **イメージを push**（qgis3/qgis4 は初回ビルドに20分以上かかる場合がある）
   ```bash
   AWS_ACCOUNT_ID=<id> ./scripts/push-images.sh
   ```

5. **基盤スタックをデプロイ**
   ```bash
   npx cdk deploy QfcNetwork QfcData QfcFrontend --require-approval never
   ```

6. **サービス0台で QfcApp をデプロイ**（`servicesEnabled=false` でタスク数0にし、安定化待ちなしで完了させる。まだ migrate していないスキーマに対してタスクを起動させないため）
   ```bash
   npx cdk deploy QfcApp -c servicesEnabled=false --require-approval never
   ```

7. **DB マイグレーション（PostGIS 拡張の作成込み）を単発 RunTask で実行**（`<subnet-id>` / `<sg-id>` は QfcApp の出力やコンソールで確認）
   ```bash
   aws ecs run-task --cluster qfc-cluster --launch-type FARGATE \
     --task-definition qfc-migrate \
     --network-configuration 'awsvpcConfiguration={subnets=[<public-subnet-id>],securityGroups=[<worker-sg-id>],assignPublicIp=ENABLED}'
   ```
   実行後、CloudWatch Logs `/qfc/app`（streamPrefix `migrate`）で
   `CREATE EXTENSION` の完了 → `Applying ... OK` の順に出ることを確認する。
   （Aurora には `postgis` 拡張がデフォルトで無く、geometry 型を含む migration がここで失敗するため、拡張作成を migrate の前段に組み込んである）

8. **サービスを起動**（`servicesEnabled` を外す＝既定で有効。QfcOps もここで併せてデプロイ）
   ```bash
   npx cdk deploy QfcApp QfcOps --require-approval never
   ```

9. **管理ユーザー作成**（同じ run-task の要領で `--overrides` を使い、`DJANGO_SUPERUSER_USERNAME/EMAIL/PASSWORD` を環境変数上書きしつつ `python manage.py createsuperuser --noinput` を実行）

10. **PROJ 変換格子データの初回ミラー**（`qfc-grids-mirror` タスクを同様に run-task。数百MBのダウンロードがあるため数分かかる）

11. **SES セットアップ**
    - 送信元メールアドレスをコンソールで検証
    - SMTP 認証情報を作成
    - Secrets Manager の `SesSmtpSecret`（プレースホルダー `CHANGE_ME`）を実値に更新
    - 本番アクセス（サンドボックス解除）を申請
    - app / worker / cron サービスを `--force-new-deployment` で再デプロイ（Secret 値の変更はタスク再起動しないと反映されない）

12. **動作確認**
    - `curl https://<ApiUrl>/api/v1/status/` → `{"database":"ok","storage":"ok"}` などが返ることを確認
    - `https://<ApiUrl>/admin/` にブラウザでログイン（CSRF が通ること = X-Forwarded-Proto 配線の確認）
    - QField アプリでサーバー URL `https://<ApiUrl>` を設定 → プロジェクト同期 → パッケージングを実行し、ジョブが Fargate タスク（qgis3/qgis4）として起動・完了することを ECS コンソールで確認

## 日常運用

- **更新デプロイ**: `./scripts/push-images.sh` でイメージを再push → `aws ecs update-service --cluster qfc-cluster --service <app|worker|cron> --force-new-deployment`
  - 注意: タスク定義のイメージタグは常に `latest` 固定のため、push しただけでは CDK の diff は発生しない（`cdk deploy` してもタスクは切り替わらない）。イメージ更新時は必ず `--force-new-deployment` が必要（バックログ: タグをイメージダイジェスト等に変えて CDK diff で検知できるようにする）
  - スキーマ変更を伴う場合は Step 7 の migrate タスクを再実行してから反映する
- **ロールバック**: 旧タグを指すイメージを再度 `latest` として push し直す、または ECR の旧リビジョンを指す新しいタスク定義リビジョンを作成する（本格運用は計画4の CI/CD で自動化予定）

## 既知の制約

- ジョブ開始レイテンシ 2〜4分（RunTask のコールドスタート）
- 秘密情報を RunTask の平文 environment に渡している箇所がある（受容済みリスク。`ecs:DescribeTasks` / CloudTrail の閲覧権限は管理者に限定すること）
- タスク定義のイメージタグが `latest` 固定のため、イメージ更新は CDK の diff に現れない（上記「日常運用」参照。バックログ）
- RDS が管理する DB 認証情報の Secret は保持（RETAIN）だが、Aurora のマスターパスワードリセットで復旧可能なためアプリ所有の Secret（`SECRET_KEY`/`SALT_KEY`/SES SMTP）とは異なり優先度は低いバックログ扱い
