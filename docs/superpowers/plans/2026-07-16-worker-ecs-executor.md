# 計画1: ワーカー ECS エグゼキュータ（バックエンドフォーク改修）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** worker_wrapper が QGIS ジョブコンテナを Docker API の代わりに AWS ECS Fargate の RunTask で起動できるようにする（環境変数で切替、既存 Docker 経路は無改修）。

**Architecture:** `QFIELDCLOUD_WORKER_EXECUTOR=docker|ecs` の環境変数スイッチを導入し、新規モジュール `worker_wrapper/executors/ecs.py` に boto3 ベースの実装（RunTask → DescribeTasks ポーリング → CloudWatch Logs 取得 → StopTask、孤児タスク掃除）を置く。`wrapper.py` への変更はディスパッチの数行のみ。QGIS コンテナ側は `/io` ハードコード2箇所を `QFC_IO_DIR` 環境変数化（デフォルト `/io` で後方互換）。Fargate 用の nginx サイドカー設定テンプレートも追加する。

**Tech Stack:** Python 3.10 / Django / boto3（1.43.38、導入済み）/ tenacity（導入済み）/ Django SimpleTestCase + unittest.mock / nginx(envsubst テンプレート)

**参照設計書:** `docs/superpowers/specs/2026-07-16-qfieldcloud-aws-serverless-design.md` §3.2, §3.3, §4

---

## 事前確認済みの重要事実（実装者は前提としてよい）

- `docker-app/worker_wrapper/wrapper.py` の Docker API 依存は5点のみ: `containers.run()`(L430) / `container.wait()`(L458) / `container.logs()`(L494) / `stop()+remove()`(L498-499) / `cancel_orphaned_workers()`(L705)。
- `Job.container_id` は `max_length=64`（`qfieldcloud/core/models.py:1319`）。ECS の taskArn は 64 文字を超えるため、**32文字のタスクID（ARN の最後のパスセグメント）を保存する**。ECS API はクラスター指定があればタスクIDを受け付ける。マイグレーション不要。
- boto3 は `docker-app/requirements/requirements.in:2` で導入済み。追加依存なし。
- `/io` のハードコードは `docker-qgis/qfc_worker/commands_base.py:79` と `docker-qgis/qfc_worker/commands/apply_deltas.py:1126` の2箇所のみ。
- `settings.py:68` に `SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")` があるため、nginx が `X-Forwarded-Proto: https` を固定送信すれば CloudFront→ALB 間が HTTP でも Django は HTTPS として扱う。
- テスト実行はリポジトリ標準の docker compose 経由（下記コマンド参照）。新規テストは DB 不要（`SimpleTestCase`）だが、ランナーの都合で `--keepdb` を付ける。

## ファイル構成

| 操作 | パス | 責務 |
|---|---|---|
| Create | `docker-app/worker_wrapper/executors/__init__.py` | パッケージマーカー（空） |
| Create | `docker-app/worker_wrapper/executors/ecs.py` | ECS RunTask エグゼキュータ本体（純粋ヘルパー + オーケストレーション + 孤児掃除） |
| Create | `docker-app/worker_wrapper/tests/__init__.py` | テストパッケージマーカー（空） |
| Create | `docker-app/worker_wrapper/tests/test_ecs_executor.py` | エグゼキュータのユニットテスト（boto3 クライアントはモック） |
| Modify | `docker-app/qfieldcloud/settings.py`（L851 の `QFIELDCLOUD_DEFAULT_NETWORK` の直後） | ECS 用設定の追加 |
| Modify | `docker-app/worker_wrapper/wrapper.py`（L267 付近 / L705 付近） | エグゼキュータへのディスパッチ（最小差分） |
| Modify | `docker-qgis/qfc_worker/commands_base.py`（L79 付近） | `QFC_IO_DIR` 対応 + `get_io_dir()` ヘルパー |
| Modify | `docker-qgis/qfc_worker/commands/apply_deltas.py`（L32, L1126） | deltafile デフォルトパスの `QFC_IO_DIR` 対応 |
| Create | `docker-nginx/templates-fargate/default.conf.template` | Fargate サイドカー用 nginx 設定（HTTP:80 のみ） |
| Modify | `docker-nginx/Dockerfile` | `TEMPLATES_DIR` ビルド引数の追加 |
| Modify | `.env.example` | 新環境変数のドキュメント |

**テスト実行コマンド（全タスク共通）:**

```bash
# 開発スタックが起動済みであること（README 参照: docker compose up -d --build）
docker compose run --rm app python manage.py test --keepdb worker_wrapper
```

---

### Task 1: ECS 用設定の追加（settings.py / .env.example）

**Files:**
- Modify: `docker-app/qfieldcloud/settings.py`（L850-851 `QFIELDCLOUD_DEFAULT_NETWORK` ブロックの直後）
- Modify: `.env.example`（末尾）

- [ ] **Step 1: settings.py に ECS 設定ブロックを追加**

`QFIELDCLOUD_DEFAULT_NETWORK = os.environ.get("QFIELDCLOUD_DEFAULT_NETWORK")`（L851）の直後に以下を追加:

```python
# Executor used by the `worker_wrapper` to run QGIS job containers.
# "docker" (default): spawn sibling Docker containers via the Docker socket (docker-compose deployments).
# "ecs": run AWS ECS Fargate tasks (AWS deployments). See `worker_wrapper.executors.ecs`.
QFIELDCLOUD_WORKER_EXECUTOR = os.environ.get("QFIELDCLOUD_WORKER_EXECUTOR", "docker")

# AWS ECS executor settings. Only required when `QFIELDCLOUD_WORKER_EXECUTOR` is "ecs".
# Name of the ECS cluster where QGIS job tasks are started.
QFIELDCLOUD_ECS_CLUSTER = os.environ.get("QFIELDCLOUD_ECS_CLUSTER", "")

# Task definition (family or family:revision) for QGIS 3 and QGIS 4 job tasks.
QFIELDCLOUD_ECS_QGIS3_TASK_DEFINITION = os.environ.get(
    "QFIELDCLOUD_ECS_QGIS3_TASK_DEFINITION", ""
)
QFIELDCLOUD_ECS_QGIS4_TASK_DEFINITION = os.environ.get(
    "QFIELDCLOUD_ECS_QGIS4_TASK_DEFINITION", ""
)

# Comma-separated subnet and security group ids used by the QGIS job tasks.
QFIELDCLOUD_ECS_SUBNET_IDS = [
    s.strip()
    for s in os.environ.get("QFIELDCLOUD_ECS_SUBNET_IDS", "").split(",")
    if s.strip()
]
QFIELDCLOUD_ECS_SECURITY_GROUP_IDS = [
    s.strip()
    for s in os.environ.get("QFIELDCLOUD_ECS_SECURITY_GROUP_IDS", "").split(",")
    if s.strip()
]

# Whether the QGIS job tasks get a public IP (required for internet egress without a NAT gateway).
QFIELDCLOUD_ECS_ASSIGN_PUBLIC_IP = parse_string_to_bool(
    os.environ.get("QFIELDCLOUD_ECS_ASSIGN_PUBLIC_IP", "1")
)

# Container name within the QGIS task definition that runs the job.
QFIELDCLOUD_ECS_QGIS_CONTAINER_NAME = os.environ.get(
    "QFIELDCLOUD_ECS_QGIS_CONTAINER_NAME", "qgis"
)

# CloudWatch Logs group and awslogs stream prefix configured on the QGIS task definition.
QFIELDCLOUD_ECS_QGIS_LOG_GROUP = os.environ.get("QFIELDCLOUD_ECS_QGIS_LOG_GROUP", "")
QFIELDCLOUD_ECS_QGIS_LOG_STREAM_PREFIX = os.environ.get(
    "QFIELDCLOUD_ECS_QGIS_LOG_STREAM_PREFIX", "qgis"
)

# Path where the shared EFS "io" volume is mounted inside the QGIS task containers.
QFIELDCLOUD_ECS_IO_MOUNT_PATH = os.environ.get("QFIELDCLOUD_ECS_IO_MOUNT_PATH", "/io")

# `startedBy` marker used to find the QGIS tasks started by this deployment.
QFIELDCLOUD_ECS_STARTED_BY = os.environ.get(
    "QFIELDCLOUD_ECS_STARTED_BY", f"qfc-worker-{ENVIRONMENT}"
)
```

注意: `parse_string_to_bool` と `ENVIRONMENT` は同ファイルで定義済み（L23 / L59）。

- [ ] **Step 2: .env.example の末尾に新環境変数のドキュメントを追加**

```bash
# Worker executor: "docker" (default) runs QGIS jobs as sibling Docker containers,
# "ecs" runs them as AWS ECS Fargate tasks. See docs/superpowers/specs/2026-07-16-qfieldcloud-aws-serverless-design.md
# QFIELDCLOUD_WORKER_EXECUTOR=docker

# Required when QFIELDCLOUD_WORKER_EXECUTOR=ecs:
# QFIELDCLOUD_ECS_CLUSTER=
# QFIELDCLOUD_ECS_QGIS3_TASK_DEFINITION=
# QFIELDCLOUD_ECS_QGIS4_TASK_DEFINITION=
# QFIELDCLOUD_ECS_SUBNET_IDS=
# QFIELDCLOUD_ECS_SECURITY_GROUP_IDS=
# QFIELDCLOUD_ECS_QGIS_LOG_GROUP=

# Optional ECS executor settings (defaults shown):
# QFIELDCLOUD_ECS_ASSIGN_PUBLIC_IP=1
# QFIELDCLOUD_ECS_QGIS_CONTAINER_NAME=qgis
# QFIELDCLOUD_ECS_QGIS_LOG_STREAM_PREFIX=qgis
# QFIELDCLOUD_ECS_IO_MOUNT_PATH=/io
# QFIELDCLOUD_ECS_STARTED_BY=qfc-worker-<ENVIRONMENT>
```

- [ ] **Step 3: 設定が読み込めることを確認**

Run: `docker compose run --rm app python -c "from django.conf import settings; print(settings.QFIELDCLOUD_WORKER_EXECUTOR, settings.QFIELDCLOUD_ECS_IO_MOUNT_PATH)"`
Expected: `docker /io`

- [ ] **Step 4: Commit**

```bash
git add docker-app/qfieldcloud/settings.py .env.example
git commit -m "feat(worker): add ECS executor settings (QFIELDCLOUD_WORKER_EXECUTOR)"
```

---

### Task 2: executors パッケージと純粋ヘルパー関数（TDD）

**Files:**
- Create: `docker-app/worker_wrapper/executors/__init__.py`
- Create: `docker-app/worker_wrapper/executors/ecs.py`
- Create: `docker-app/worker_wrapper/tests/__init__.py`
- Create: `docker-app/worker_wrapper/tests/test_ecs_executor.py`

- [ ] **Step 1: 失敗するテストを書く**

`docker-app/worker_wrapper/tests/__init__.py` を空ファイルで作成し、`docker-app/worker_wrapper/tests/test_ecs_executor.py` を以下の内容で作成:

```python
from django.test import SimpleTestCase
from django.test.utils import override_settings

from worker_wrapper.executors import ecs

TASK_ARN = "arn:aws:ecs:ap-northeast-1:123456789012:task/qfc-cluster/0123456789abcdef0123456789abcdef"


ECS_TEST_SETTINGS = {
    "QFIELDCLOUD_WORKER_EXECUTOR": "ecs",
    "QFIELDCLOUD_ECS_CLUSTER": "qfc-cluster",
    "QFIELDCLOUD_ECS_QGIS3_TASK_DEFINITION": "qfc-qgis3",
    "QFIELDCLOUD_ECS_QGIS4_TASK_DEFINITION": "qfc-qgis4",
    "QFIELDCLOUD_ECS_SUBNET_IDS": ["subnet-111", "subnet-222"],
    "QFIELDCLOUD_ECS_SECURITY_GROUP_IDS": ["sg-333"],
    "QFIELDCLOUD_ECS_ASSIGN_PUBLIC_IP": True,
    "QFIELDCLOUD_ECS_QGIS_CONTAINER_NAME": "qgis",
    "QFIELDCLOUD_ECS_QGIS_LOG_GROUP": "/qfc/qgis",
    "QFIELDCLOUD_ECS_QGIS_LOG_STREAM_PREFIX": "qgis",
    "QFIELDCLOUD_ECS_IO_MOUNT_PATH": "/io",
    "QFIELDCLOUD_ECS_STARTED_BY": "qfc-worker-test",
    "QFIELDCLOUD_QGIS3_IMAGE_NAME": "qfieldcloud-qgis3",
    "QFIELDCLOUD_QGIS4_IMAGE_NAME": "qfieldcloud-qgis4",
}


@override_settings(**ECS_TEST_SETTINGS)
class PureHelpersTestCase(SimpleTestCase):
    def test_task_id_from_arn(self):
        self.assertEqual(
            ecs.task_id_from_arn(TASK_ARN), "0123456789abcdef0123456789abcdef"
        )

    def test_task_id_from_arn_accepts_bare_id(self):
        self.assertEqual(ecs.task_id_from_arn("abcdef"), "abcdef")

    def test_build_qgis_environment_injects_io_dir(self):
        environment = ecs.build_qgis_environment(
            {"QFIELDCLOUD_TOKEN": "secret", "JOB_ID": "job-1"}, "abc123"
        )

        self.assertIn({"name": "QFC_IO_DIR", "value": "/io/abc123"}, environment)
        self.assertIn({"name": "QFIELDCLOUD_TOKEN", "value": "secret"}, environment)
        # entries are sorted by name for deterministic RunTask payloads
        names = [e["name"] for e in environment]
        self.assertEqual(names, sorted(names))

    def test_derive_log_stream_name(self):
        self.assertEqual(
            ecs.derive_log_stream_name("0123456789abcdef0123456789abcdef"),
            "qgis/qgis/0123456789abcdef0123456789abcdef",
        )

    def test_find_orphan_task_ids(self):
        self.assertEqual(
            ecs.find_orphan_task_ids(["id-1", "id-2", "id-3"], ["id-2"]),
            {"id-1", "id-3"},
        )

    def test_exit_code_from_described_task(self):
        task = {"containers": [{"name": "qgis", "exitCode": 137}]}
        self.assertEqual(ecs.exit_code_from_described_task(task), 137)

    def test_exit_code_from_described_task_missing_exit_code(self):
        task = {
            "containers": [{"name": "qgis"}],
            "stoppedReason": "Task failed to start",
        }
        self.assertIsNone(ecs.exit_code_from_described_task(task))
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `docker compose run --rm app python manage.py test --keepdb worker_wrapper`
Expected: FAIL — `ModuleNotFoundError: No module named 'worker_wrapper.executors'`

- [ ] **Step 3: 最小実装を書く**

`docker-app/worker_wrapper/executors/__init__.py` を空ファイルで作成し、`docker-app/worker_wrapper/executors/ecs.py` を以下の内容で作成:

```python
"""AWS ECS Fargate executor for QGIS job containers.

Used when `QFIELDCLOUD_WORKER_EXECUTOR` is set to "ecs". Instead of spawning
sibling Docker containers via the Docker socket, jobs run as one-off ECS
Fargate tasks. Files are exchanged with the QGIS container via a shared EFS
volume; job logs are read back from CloudWatch Logs.

NOTE `Job.container_id` is limited to 64 chars, so the 32-char ECS task id
(the last path segment of the task ARN) is stored instead of the full ARN.
ECS APIs accept the bare task id as long as the cluster is provided.
"""

import logging
from typing import Any

from django.conf import settings

logger = logging.getLogger(__name__)

POLL_INTERVAL_S = 5
RUN_TASK_RETRY_COUNT = 5
RUN_TASK_RETRY_MAX_WAIT_S = 10


def task_id_from_arn(task_arn: str) -> str:
    return task_arn.rsplit("/", 1)[-1]


def build_qgis_environment(
    job_environment: dict[str, str], io_subdir: str
) -> list[dict[str, str]]:
    io_mount_path = settings.QFIELDCLOUD_ECS_IO_MOUNT_PATH.rstrip("/")
    environment = {
        **job_environment,
        "QFC_IO_DIR": f"{io_mount_path}/{io_subdir}",
    }

    return [
        {"name": name, "value": str(value)}
        for name, value in sorted(environment.items())
    ]


def derive_log_stream_name(task_id: str) -> str:
    prefix = settings.QFIELDCLOUD_ECS_QGIS_LOG_STREAM_PREFIX
    container_name = settings.QFIELDCLOUD_ECS_QGIS_CONTAINER_NAME

    return f"{prefix}/{container_name}/{task_id}"


def find_orphan_task_ids(
    running_task_ids: list[str], known_container_ids: list[str]
) -> set[str]:
    return set(running_task_ids) - set(known_container_ids)


def exit_code_from_described_task(task: dict[str, Any]) -> int | None:
    for container in task.get("containers", []):
        if container.get("name") == settings.QFIELDCLOUD_ECS_QGIS_CONTAINER_NAME:
            exit_code = container.get("exitCode")

            return int(exit_code) if exit_code is not None else None

    return None
```

- [ ] **Step 4: テストが通ることを確認**

Run: `docker compose run --rm app python manage.py test --keepdb worker_wrapper`
Expected: PASS — `OK` （7 tests）

- [ ] **Step 5: Commit**

```bash
git add docker-app/worker_wrapper/executors/ docker-app/worker_wrapper/tests/
git commit -m "feat(worker): add ECS executor pure helpers with tests"
```

---

### Task 3: run_job オーケストレーション（TDD）

**Files:**
- Modify: `docker-app/worker_wrapper/executors/ecs.py`
- Modify: `docker-app/worker_wrapper/tests/test_ecs_executor.py`

- [ ] **Step 1: 失敗するテストを書く**

`test_ecs_executor.py` の先頭 import 群を以下に置き換え:

```python
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from django.test import SimpleTestCase
from django.test.utils import override_settings

from worker_wrapper.executors import ecs
from worker_wrapper.wrapper import TIMEOUT_ERROR_EXIT_CODE, JobException
```

ファイル末尾に以下のテストクラスを追加:

```python
def make_fake_job_run() -> SimpleNamespace:
    """Duck-typed stand-in for `worker_wrapper.wrapper.JobRun`."""
    job = SimpleNamespace(
        id="job-uuid-1",
        project_id="project-uuid-1",
        type="package",
        docker_started_at=None,
        docker_finished_at=None,
        container_id="",
        save=mock.Mock(),
    )

    return SimpleNamespace(
        job=job,
        job_id="job-uuid-1",
        shared_tempdir=Path("/tmp/abc123"),
        container_timeout_secs=60,
        get_environment=lambda: {"QFIELDCLOUD_TOKEN": "secret", "JOB_ID": "job-uuid-1"},
        get_qgis_image=lambda: "qfieldcloud-qgis3",
    )


@override_settings(**ECS_TEST_SETTINGS)
class RunJobTestCase(SimpleTestCase):
    def setUp(self):
        self.ecs_client = mock.Mock()
        self.logs_client = mock.Mock()

        patcher_ecs = mock.patch.object(
            ecs, "get_ecs_client", return_value=self.ecs_client
        )
        patcher_logs = mock.patch.object(
            ecs, "get_logs_client", return_value=self.logs_client
        )
        patcher_ecs.start()
        patcher_logs.start()
        self.addCleanup(patcher_ecs.stop)
        self.addCleanup(patcher_logs.stop)

        self.logs_client.get_log_events.side_effect = [
            {
                "events": [{"message": "line1"}, {"message": "line2"}],
                "nextForwardToken": "token-1",
            },
            {"events": [], "nextForwardToken": "token-1"},
        ]

    def test_run_job_success(self):
        self.ecs_client.run_task.return_value = {"tasks": [{"taskArn": TASK_ARN}]}
        self.ecs_client.describe_tasks.return_value = {
            "tasks": [
                {
                    "lastStatus": "STOPPED",
                    "containers": [{"name": "qgis", "exitCode": 0}],
                }
            ]
        }
        job_run = make_fake_job_run()

        exit_code, logs = ecs.run_job(job_run, ["package", "project-uuid-1"])

        self.assertEqual(exit_code, 0)
        self.assertEqual(logs, b"line1\nline2")

        run_task_kwargs = self.ecs_client.run_task.call_args.kwargs
        self.assertEqual(run_task_kwargs["cluster"], "qfc-cluster")
        self.assertEqual(run_task_kwargs["taskDefinition"], "qfc-qgis3")
        self.assertEqual(run_task_kwargs["launchType"], "FARGATE")
        self.assertEqual(run_task_kwargs["startedBy"], "qfc-worker-test")
        self.assertEqual(
            run_task_kwargs["networkConfiguration"]["awsvpcConfiguration"]["subnets"],
            ["subnet-111", "subnet-222"],
        )

        container_override = run_task_kwargs["overrides"]["containerOverrides"][0]
        self.assertEqual(container_override["name"], "qgis")
        self.assertEqual(container_override["command"], ["package", "project-uuid-1"])
        self.assertIn(
            {"name": "QFC_IO_DIR", "value": "/io/abc123"},
            container_override["environment"],
        )

        # the 32-char task id is stored, not the full ARN (container_id is max_length=64)
        self.assertEqual(job_run.job.container_id, "0123456789abcdef0123456789abcdef")

    def test_run_job_timeout_stops_task(self):
        self.ecs_client.run_task.return_value = {"tasks": [{"taskArn": TASK_ARN}]}
        self.ecs_client.describe_tasks.return_value = {
            "tasks": [{"lastStatus": "RUNNING", "containers": []}]
        }
        job_run = make_fake_job_run()
        job_run.container_timeout_secs = 0

        exit_code, logs = ecs.run_job(job_run, ["package", "project-uuid-1"])

        self.assertEqual(exit_code, TIMEOUT_ERROR_EXIT_CODE)
        self.assertIn(b"Timeout error!", logs)
        self.ecs_client.stop_task.assert_called_once()

    def test_run_job_raises_when_run_task_returns_no_task(self):
        self.ecs_client.run_task.return_value = {
            "tasks": [],
            "failures": [{"reason": "Capacity is unavailable at this time."}],
        }
        job_run = make_fake_job_run()

        with (
            mock.patch.object(ecs, "RUN_TASK_RETRY_COUNT", 2),
            mock.patch.object(ecs, "RUN_TASK_RETRY_MAX_WAIT_S", 0.01),
        ):
            with self.assertRaises(JobException):
                ecs.run_job(job_run, ["package", "project-uuid-1"])

        self.assertEqual(self.ecs_client.run_task.call_count, 2)

    def test_run_job_raises_when_task_failed_to_start(self):
        self.ecs_client.run_task.return_value = {"tasks": [{"taskArn": TASK_ARN}]}
        self.ecs_client.describe_tasks.return_value = {
            "tasks": [
                {
                    "lastStatus": "STOPPED",
                    "containers": [{"name": "qgis"}],
                    "stoppedReason": "CannotPullContainerError",
                }
            ]
        }
        job_run = make_fake_job_run()

        with self.assertRaises(JobException) as ctx:
            ecs.run_job(job_run, ["package", "project-uuid-1"])

        self.assertIn("CannotPullContainerError", str(ctx.exception))
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `docker compose run --rm app python manage.py test --keepdb worker_wrapper`
Expected: FAIL — `AttributeError: module 'worker_wrapper.executors.ecs' has no attribute 'get_ecs_client'`（または `run_job` 不在）

- [ ] **Step 3: 実装を書く**

`ecs.py` の import 群を以下に置き換え:

```python
import logging
import time
from typing import TYPE_CHECKING, Any

import boto3
from botocore.exceptions import BotoCoreError, ClientError
from django.conf import settings
from django.utils import timezone
from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_random_exponential,
)

from worker_wrapper.wrapper import TIMEOUT_ERROR_EXIT_CODE, JobException

if TYPE_CHECKING:
    from worker_wrapper.wrapper import JobRun
```

`ecs.py` 末尾に以下を追加:

```python
class EcsRunTaskError(Exception):
    """Raised when ECS RunTask does not return a started task, e.g. due to capacity issues."""


def get_ecs_client() -> Any:
    return boto3.client("ecs")


def get_logs_client() -> Any:
    return boto3.client("logs")


def _get_task_definition(qgis_image_name: str) -> str:
    task_definitions = {
        settings.QFIELDCLOUD_QGIS3_IMAGE_NAME: settings.QFIELDCLOUD_ECS_QGIS3_TASK_DEFINITION,
        settings.QFIELDCLOUD_QGIS4_IMAGE_NAME: settings.QFIELDCLOUD_ECS_QGIS4_TASK_DEFINITION,
    }
    task_definition = task_definitions.get(qgis_image_name, "")

    if not task_definition:
        raise JobException(
            f"No ECS task definition configured for QGIS image {qgis_image_name!r}."
        )

    return task_definition


def _run_task_with_retry(ecs_client: Any, run_task_kwargs: dict[str, Any]) -> dict[str, Any]:
    def do_run_task() -> dict[str, Any]:
        response = ecs_client.run_task(**run_task_kwargs)
        tasks = response.get("tasks", [])

        if not tasks:
            failures = response.get("failures", [])
            raise EcsRunTaskError(f"ECS RunTask returned no started task: {failures}")

        return tasks[0]

    retriable = retry(
        wait=wait_random_exponential(max=RUN_TASK_RETRY_MAX_WAIT_S),
        stop=stop_after_attempt(RUN_TASK_RETRY_COUNT),
        retry=retry_if_exception_type((EcsRunTaskError, ClientError, BotoCoreError)),
        reraise=True,
    )

    try:
        return retriable(do_run_task)()
    except (EcsRunTaskError, ClientError, BotoCoreError) as err:
        raise JobException(f"Failed to start the QGIS ECS task: {err}") from err


def _wait_until_stopped(
    ecs_client: Any, task_id: str, timeout_secs: int
) -> dict[str, Any] | None:
    """Polls the task until it is STOPPED. Returns the described task, or `None` on timeout."""
    deadline = time.monotonic() + timeout_secs

    while True:
        response = ecs_client.describe_tasks(
            cluster=settings.QFIELDCLOUD_ECS_CLUSTER, tasks=[task_id]
        )
        tasks = response.get("tasks", [])

        if tasks and tasks[0].get("lastStatus") == "STOPPED":
            return tasks[0]

        if time.monotonic() >= deadline:
            return None

        time.sleep(POLL_INTERVAL_S)


def _read_task_logs(logs_client: Any, task_id: str) -> bytes:
    lines: list[str] = []
    kwargs: dict[str, Any] = {
        "logGroupName": settings.QFIELDCLOUD_ECS_QGIS_LOG_GROUP,
        "logStreamName": derive_log_stream_name(task_id),
        "startFromHead": True,
    }

    try:
        while True:
            response = logs_client.get_log_events(**kwargs)
            lines.extend(event["message"] for event in response.get("events", []))

            next_token = response.get("nextForwardToken")

            # CloudWatch signals the end of the stream by returning the same token
            if not next_token or next_token == kwargs.get("nextToken"):
                break

            kwargs["nextToken"] = next_token
    except (ClientError, BotoCoreError) as err:
        logger.warning(f"Failed to read CloudWatch logs for task {task_id}.", exc_info=err)
        return b"[QFC/Worker/1001] Failed to read logs."

    return "\n".join(lines).encode()


def run_job(job_run: "JobRun", command: list[str]) -> tuple[int, bytes]:
    """ECS counterpart of `JobRun._run_docker`: returns `(exit_code, logs)`."""
    assert settings.QFIELDCLOUD_ECS_CLUSTER

    ecs_client = get_ecs_client()
    logs_client = get_logs_client()

    task_definition = _get_task_definition(job_run.get_qgis_image())
    container_environment = build_qgis_environment(
        job_run.get_environment(), job_run.shared_tempdir.name
    )

    run_task_kwargs = {
        "cluster": settings.QFIELDCLOUD_ECS_CLUSTER,
        "taskDefinition": task_definition,
        "launchType": "FARGATE",
        "startedBy": settings.QFIELDCLOUD_ECS_STARTED_BY,
        "networkConfiguration": {
            "awsvpcConfiguration": {
                "subnets": settings.QFIELDCLOUD_ECS_SUBNET_IDS,
                "securityGroups": settings.QFIELDCLOUD_ECS_SECURITY_GROUP_IDS,
                "assignPublicIp": (
                    "ENABLED"
                    if settings.QFIELDCLOUD_ECS_ASSIGN_PUBLIC_IP
                    else "DISABLED"
                ),
            }
        },
        "overrides": {
            "containerOverrides": [
                {
                    "name": settings.QFIELDCLOUD_ECS_QGIS_CONTAINER_NAME,
                    "command": command,
                    "environment": container_environment,
                }
            ]
        },
        "tags": [
            {"key": "qfc:job_id", "value": str(job_run.job.id)},
            {"key": "qfc:project_id", "value": str(job_run.job.project_id)},
            {"key": "qfc:job_type", "value": str(job_run.job.type)},
        ],
    }

    logger.info(f"Execute on ECS: {' '.join(command)}")

    # `docker_started_at`/`docker_finished_at` tracks the time spent on the job task only
    job_run.job.docker_started_at = timezone.now()
    job_run.job.save(update_fields=["docker_started_at"])

    task = _run_task_with_retry(ecs_client, run_task_kwargs)
    task_id = task_id_from_arn(task["taskArn"])

    job_run.job.container_id = task_id
    job_run.job.save(update_fields=["docker_started_at", "container_id"])
    logger.info(f"Starting worker ECS task {task_id} ...")

    stopped_task = _wait_until_stopped(
        ecs_client, task_id, job_run.container_timeout_secs
    )

    job_run.job.docker_finished_at = timezone.now()
    job_run.job.save(update_fields=["docker_finished_at"])

    if stopped_task is None:
        ecs_client.stop_task(
            cluster=settings.QFIELDCLOUD_ECS_CLUSTER,
            task=task_id,
            reason=f"QFieldCloud job {job_run.job_id} timed out.",
        )
        logs = _read_task_logs(logs_client, task_id)
        logs += f"\nTimeout error! The job failed to finish within {job_run.container_timeout_secs} seconds!\n".encode()

        return TIMEOUT_ERROR_EXIT_CODE, logs

    logs = _read_task_logs(logs_client, task_id)
    exit_code = exit_code_from_described_task(stopped_task)

    if exit_code is None:
        raise JobException(
            "The QGIS ECS task stopped without an exit code: "
            f"{stopped_task.get('stoppedReason', 'unknown reason')}"
        )

    logger.info(f"Finished execution with code {exit_code}, logs:\n{logs.decode()}")

    return exit_code, logs
```

- [ ] **Step 4: テストが通ることを確認**

Run: `docker compose run --rm app python manage.py test --keepdb worker_wrapper`
Expected: PASS — `OK`（11 tests）

- [ ] **Step 5: Commit**

```bash
git add docker-app/worker_wrapper/executors/ecs.py docker-app/worker_wrapper/tests/test_ecs_executor.py
git commit -m "feat(worker): implement ECS run_job orchestration with tests"
```

---

### Task 4: 孤児タスクの掃除（TDD）

**Files:**
- Modify: `docker-app/worker_wrapper/executors/ecs.py`
- Modify: `docker-app/worker_wrapper/tests/test_ecs_executor.py`

- [ ] **Step 1: 失敗するテストを書く**

`test_ecs_executor.py` 末尾に追加:

```python
@override_settings(**ECS_TEST_SETTINGS)
class CancelOrphanedEcsWorkersTestCase(SimpleTestCase):
    def test_stops_only_orphaned_tasks(self):
        ecs_client = mock.Mock()
        paginator = mock.Mock()
        paginator.paginate.return_value = [
            {"taskArns": [TASK_ARN]},
            {
                "taskArns": [
                    "arn:aws:ecs:ap-northeast-1:123456789012:task/qfc-cluster/ffffffffffffffffffffffffffffffff"
                ]
            },
        ]
        ecs_client.get_paginator.return_value = paginator

        with (
            mock.patch.object(ecs, "get_ecs_client", return_value=ecs_client),
            mock.patch.object(
                ecs,
                "_get_known_container_ids",
                return_value=["0123456789abcdef0123456789abcdef"],
            ),
        ):
            ecs.cancel_orphaned_ecs_workers()

        ecs_client.stop_task.assert_called_once_with(
            cluster="qfc-cluster",
            task="ffffffffffffffffffffffffffffffff",
            reason="Orphaned QFieldCloud worker task.",
        )
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `docker compose run --rm app python manage.py test --keepdb worker_wrapper`
Expected: FAIL — `AttributeError: ... has no attribute '_get_known_container_ids'`

- [ ] **Step 3: 実装を書く**

`ecs.py` 末尾に追加:

```python
def _get_known_container_ids(task_ids: list[str]) -> list[str]:
    from qfieldcloud.core.models import Job

    return list(
        Job.objects.filter(container_id__in=task_ids).values_list(
            "container_id", flat=True
        )
    )


def cancel_orphaned_ecs_workers() -> None:
    """ECS counterpart of `worker_wrapper.wrapper.cancel_orphaned_workers`.

    Stops QGIS tasks started by this deployment whose `Job` row no longer
    exists in the database (e.g. the `Project` was deleted mid-job).
    """
    ecs_client = get_ecs_client()

    running_task_ids: list[str] = []
    paginator = ecs_client.get_paginator("list_tasks")

    for page in paginator.paginate(
        cluster=settings.QFIELDCLOUD_ECS_CLUSTER,
        startedBy=settings.QFIELDCLOUD_ECS_STARTED_BY,
        desiredStatus="RUNNING",
    ):
        running_task_ids.extend(task_id_from_arn(arn) for arn in page["taskArns"])

    if not running_task_ids:
        return

    known_container_ids = _get_known_container_ids(running_task_ids)

    for task_id in find_orphan_task_ids(running_task_ids, known_container_ids):
        ecs_client.stop_task(
            cluster=settings.QFIELDCLOUD_ECS_CLUSTER,
            task=task_id,
            reason="Orphaned QFieldCloud worker task.",
        )
        logger.info(f"Cancel orphaned worker ECS task {task_id}")
```

- [ ] **Step 4: テストが通ることを確認**

Run: `docker compose run --rm app python manage.py test --keepdb worker_wrapper`
Expected: PASS — `OK`（12 tests）

- [ ] **Step 5: Commit**

```bash
git add docker-app/worker_wrapper/executors/ecs.py docker-app/worker_wrapper/tests/test_ecs_executor.py
git commit -m "feat(worker): add orphaned ECS task cleanup"
```

---

### Task 5: wrapper.py へのディスパッチ組み込み

**Files:**
- Modify: `docker-app/worker_wrapper/wrapper.py:267`（`run()` 内）
- Modify: `docker-app/worker_wrapper/wrapper.py:705`（`cancel_orphaned_workers()` 冒頭）

- [ ] **Step 1: `run()` のディスパッチを追加**

`wrapper.py` L265-267 の

```python
            command = self.get_command()

            exit_code, output = self._run_docker(command)
```

を以下に変更（インデントは `run()` メソッド内のまま）:

```python
            command = self.get_command()

            if settings.QFIELDCLOUD_WORKER_EXECUTOR == "ecs":
                # deferred import: keeps boto3 out of the import path of docker-compose deployments
                from worker_wrapper.executors import ecs as ecs_executor

                exit_code, output = ecs_executor.run_job(self, command)
            else:
                exit_code, output = self._run_docker(command)
```

- [ ] **Step 2: `cancel_orphaned_workers()` のディスパッチを追加**

`wrapper.py` L705-706 の

```python
def cancel_orphaned_workers() -> None:
    client: docker.client.DockerClient = docker.from_env()
```

を以下に変更:

```python
def cancel_orphaned_workers() -> None:
    if settings.QFIELDCLOUD_WORKER_EXECUTOR == "ecs":
        from worker_wrapper.executors import ecs as ecs_executor

        ecs_executor.cancel_orphaned_ecs_workers()

        return

    client: docker.client.DockerClient = docker.from_env()
```

- [ ] **Step 3: 全テストが通ることを確認（デフォルト docker 経路の無影響確認を含む）**

Run: `docker compose run --rm app python manage.py test --keepdb worker_wrapper`
Expected: PASS — `OK`（12 tests）

Run: `docker compose run --rm app python -c "import worker_wrapper.wrapper; print('import ok')"`
Expected: `import ok`

- [ ] **Step 4: Commit**

```bash
git add docker-app/worker_wrapper/wrapper.py
git commit -m "feat(worker): dispatch to ECS executor via QFIELDCLOUD_WORKER_EXECUTOR"
```

---

### Task 6: QGIS ワーカーの QFC_IO_DIR 対応

**Files:**
- Modify: `docker-qgis/qfc_worker/commands_base.py`（import 群と L70-80 の `handle()`）
- Modify: `docker-qgis/qfc_worker/commands/apply_deltas.py:32`（import）と `:1126`（argparse デフォルト）

- [ ] **Step 1: commands_base.py に `get_io_dir()` を追加し feedback パスを差し替え**

import 群（L3-8）に `os` を追加:

```python
import argparse
import logging
import os
from pathlib import Path
from typing import Any

from qfc_worker.workflow import Workflow, run_workflow
```

`logger = logging.getLogger(__name__)`（L10）の直後に追加:

```python
def get_io_dir() -> Path:
    """Directory used to exchange files (feedback.json, deltafile.json) with the `worker_wrapper`.

    Defaults to `/io` (docker-compose deployments, mounted by the wrapper).
    AWS deployments mount a shared EFS volume and pass a per-job subdirectory
    via the `QFC_IO_DIR` environment variable.
    """
    return Path(os.environ.get("QFC_IO_DIR", "/io"))
```

`handle()` 内（L77-80）の

```python
        run_workflow(
            workflow,
            Path("/io/feedback.json"),
        )
```

を以下に変更:

```python
        run_workflow(
            workflow,
            get_io_dir() / "feedback.json",
        )
```

- [ ] **Step 2: apply_deltas.py の deltafile デフォルトパスを差し替え**

L32 の import を変更:

```python
from qfc_worker.commands_base import QfcBaseCommand, get_io_dir
```

L1123-1128 の

```python
        parser.add_argument(
            "--delta-file",
            type=str,
            default="/io/deltafile.json",
            help="Path to the delta file JSON file",
        )
```

を以下に変更:

```python
        parser.add_argument(
            "--delta-file",
            type=str,
            default=str(get_io_dir() / "deltafile.json"),
            help="Path to the delta file JSON file",
        )
```

- [ ] **Step 3: qgis3 コンテナ内で動作確認**

Run:

```bash
docker compose run --rm --entrypoint python3 -e QFC_IO_DIR=/custom qgis3 -c "from qfc_worker.commands_base import get_io_dir; assert str(get_io_dir()) == '/custom'; print('ok')"
docker compose run --rm --entrypoint python3 qgis3 -c "from qfc_worker.commands_base import get_io_dir; assert str(get_io_dir()) == '/io'; print('default ok')"
```

Expected: `ok` / `default ok`（QFC_IO_DIR 未設定時は従来の `/io` で後方互換）

- [ ] **Step 4: Commit**

```bash
git add docker-qgis/qfc_worker/commands_base.py docker-qgis/qfc_worker/commands/apply_deltas.py
git commit -m "feat(qgis-worker): make /io exchange directory configurable via QFC_IO_DIR"
```

---

### Task 7: Fargate 用 nginx テンプレートと Dockerfile

**Files:**
- Create: `docker-nginx/templates-fargate/default.conf.template`
- Modify: `docker-nginx/Dockerfile`

- [ ] **Step 1: Fargate 用テンプレートを作成**

`docker-nginx/templates-fargate/default.conf.template` を以下の内容で作成。
設計意図: TLS は CloudFront で終端し ALB からは平文 HTTP が来るため、`X-Forwarded-Proto` は **固定値 `https`** を送る（`settings.py:68` の `SECURE_PROXY_SSL_HEADER` が信頼する。`$scheme` のままだと管理画面ログインが CSRF 403 になる）。gunicorn は同一タスク内なので `127.0.0.1:8000`。`/storage-download/` の S3 リダイレクト解決には VPC DNS（169.254.169.253）を使う。

```nginx
# Fargate sidecar configuration.
# - TLS terminates at CloudFront; the ALB forwards plain HTTP to this container.
# - gunicorn runs in the same ECS task, reachable on 127.0.0.1:8000.
# - /storage-download/ streams S3 presigned URLs (X-Accel-Redirect), resolved via the VPC DNS.

upstream django {
  server 127.0.0.1:8000;
  keepalive 32;
}

server {
  listen 80 default_server;
  server_name _;

  error_log /var/log/nginx/error.log error;

  client_max_body_size 10g;
  keepalive_timeout 5;

  # path for static files and error pages
  root /var/www/html/;

  proxy_http_version 1.1;
  proxy_set_header Connection '';
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  # the viewer protocol is always HTTPS (CloudFront viewer-protocol-policy: https-only),
  # trusted by Django via SECURE_PROXY_SSL_HEADER
  proxy_set_header X-Forwarded-Proto https;
  proxy_set_header X-Request-Id $request_id;
  proxy_set_header Host $http_host;
  proxy_connect_timeout 5s;
  proxy_read_timeout 300s;
  proxy_send_timeout 300s;
  proxy_redirect off;

  location /staticfiles/ {
    try_files $uri =404;
    access_log off;
    expires 1h;
  }

  location /pages/ {
    try_files $uri =404;
    access_log off;
    expires 1h;
  }

  location ^~ /api/ {
    proxy_pass http://django;
  }

  location /swagger.yaml {
    proxy_pass http://django;
  }

  location / {
    try_files $uri @proxy_to_app;
  }

  location @proxy_to_app {
    error_page 403 =403 /pages/403.html;
    error_page 404 =404 /pages/404.html;
    error_page 502 503 504 =503 /pages/loading.html;
    error_page 500 501 505 =500 /pages/500.html;

    proxy_intercept_errors on;
    proxy_pass http://django;
  }

  location /storage-download/ {
    # Only allow internal redirects
    internal;

    # used for redirecting file requests to storage.
    set $redirect_uri "$upstream_http_redirect_uri";
    # webdav storage requires a HTTP auth (Basic, mostly).
    set $webdav_auth "$upstream_http_webdav_auth";
    # if a Range header is provided
    set $file_range "$upstream_http_file_range";

    # AmazonProvidedDNS (VPC resolver) instead of the Docker embedded DNS
    resolver 169.254.169.253 ipv6=off;

    # Stops the local disk from being written to (just forwards data through)
    proxy_max_temp_file_size 0;
    proxy_buffering off;

    # Required when keepalive is used
    proxy_http_version 1.1;

    # does not work with S3 otherwise
    proxy_ssl_server_name on;

    # remove the authorization and the cookie headers
    proxy_set_header Connection '';
    proxy_set_header Authorization $webdav_auth;
    proxy_set_header Cookie '';
    proxy_set_header Content-Type '';
    proxy_set_header Accept-Encoding '';
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header Range $file_range;

    # hide Object Storage related headers
    proxy_hide_header Access-Control-Allow-Credentials;
    proxy_hide_header Access-Control-Allow-Headers;
    proxy_hide_header Access-Control-Allow-Methods;
    proxy_hide_header Access-Control-Allow-Origin;
    proxy_hide_header Access-Control-Expose-Headers;
    proxy_hide_header X-Amz-Meta-Sha256sum;
    proxy_hide_header X-Amz-Req-Time-Micros;
    proxy_hide_header X-Amz-Request-Id;
    proxy_hide_header A-Amz-Meta-Server-Side-Encryption;
    proxy_hide_header X-Amz-Storage-Class;
    proxy_hide_header X-Amz-Version-Id;
    proxy_hide_header X-Amz-Id-2;
    proxy_hide_header X-Amz-Server-Side-Encryption;
    proxy_hide_header Set-Cookie;
    proxy_ignore_headers Set-Cookie;

    proxy_intercept_errors on;

    proxy_pass $redirect_uri;
    error_page 404 =404 /pages/404.html;
    error_page 403 =403 /pages/403.html;
    error_page 401 402 405 406 407 408 409 410 411 412 413 414 415 416 417 500 501 502 503 504 505 =500 /pages/500.html;
  }
}
```

- [ ] **Step 2: Dockerfile に TEMPLATES_DIR ビルド引数を追加**

`docker-nginx/Dockerfile` 全体を以下に変更（既存 compose ビルドはデフォルト値で無影響）:

```dockerfile
FROM nginx:stable

ARG TEMPLATES_DIR=templates

COPY pages /var/www/html/pages/
COPY ${TEMPLATES_DIR}/ /etc/nginx/templates/
COPY options-ssl-nginx.conf /etc/nginx/options-ssl-nginx.conf
COPY 99-autoreload.sh /docker-entrypoint.d/99-autoreload.sh

RUN chmod 755 /docker-entrypoint.d/99-autoreload.sh
```

- [ ] **Step 3: ビルドして構文検証**

Run:

```bash
docker build -t qfc-nginx-fargate-test --build-arg TEMPLATES_DIR=templates-fargate docker-nginx
docker run --rm qfc-nginx-fargate-test nginx -t
```

Expected: `nginx: configuration file /etc/nginx/nginx.conf test is successful`

Run（既存テンプレートのリグレッション確認）:

```bash
docker build -t qfc-nginx-default-test docker-nginx
docker run --rm qfc-nginx-default-test ls /etc/nginx/templates
```

Expected: `default.conf.template`（と `includes` ディレクトリ）— 従来と同じ内容

- [ ] **Step 4: Commit**

```bash
git add docker-nginx/templates-fargate/ docker-nginx/Dockerfile
git commit -m "feat(nginx): add Fargate sidecar template (HTTP-only, fixed X-Forwarded-Proto)"
```

---

### Task 8: 仕上げ（lint / 全テスト）

**Files:** なし（検証のみ）

- [ ] **Step 1: ruff で lint**

Run: `docker compose run --rm app ruff check worker_wrapper/`
（ruff がコンテナにない場合はホストで: `ruff check docker-app/worker_wrapper/ docker-qgis/qfc_worker/`）
Expected: エラーなし（指摘があれば修正してから次へ）

- [ ] **Step 2: worker_wrapper テスト全体を最終確認**

Run: `docker compose run --rm app python manage.py test --keepdb worker_wrapper`
Expected: PASS — `OK`（12 tests）

- [ ] **Step 3: 既存スイートの回帰スモーク（コアの権限テストで代表確認）**

Run: `docker compose run --rm app python manage.py test --keepdb qfieldcloud.core.tests.test_permission`
Expected: PASS — `OK`（デフォルト `docker` エグゼキュータで既存挙動が不変であること）

- [ ] **Step 4: Commit（lint 修正があった場合のみ）**

```bash
git add -A docker-app/worker_wrapper docker-qgis/qfc_worker
git commit -m "chore(worker): lint fixes for ECS executor"
```

---

## この計画のスコープ外（後続計画）

- ECS クラスター・タスク定義・EFS・IAM ロールの作成 → **計画2（CDKインフラ）**。本計画の環境変数（`QFIELDCLOUD_ECS_*`）の実値は計画2が供給する。
- cron サイドカー・collectstatic・タスク定義への EFS/静的ボリュームマウント → 計画2（インフラ構成であり、アプリコード変更は不要）。
- フロントエンド / CI/CD → 計画3・4。
