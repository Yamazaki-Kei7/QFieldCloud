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
