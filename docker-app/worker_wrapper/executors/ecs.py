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
import time
from typing import TYPE_CHECKING, Any

import boto3
from botocore.exceptions import BotoCoreError, ClientError
from django.conf import settings
from django.utils import timezone
from tenacity import (
    retry,
    retry_if_exception,
    stop_after_attempt,
    wait_random_exponential,
)

from worker_wrapper.wrapper import TIMEOUT_ERROR_EXIT_CODE, JobException

if TYPE_CHECKING:
    from worker_wrapper.wrapper import JobRun

logger = logging.getLogger(__name__)

POLL_INTERVAL_S = 5
RUN_TASK_RETRY_COUNT = 5
RUN_TASK_RETRY_MAX_WAIT_S = 10

RETRIABLE_CLIENT_ERROR_CODES = {
    "InternalServerError",
    "ServerException",
    "ServiceUnavailableException",
    "ThrottlingException",
}

ORPHAN_CLEANUP_INTERVAL_S = 60

_last_orphan_cleanup_monotonic: float | None = None


def task_id_from_arn(task_arn: str) -> str:
    return task_arn.rsplit("/", 1)[-1]


def build_qgis_environment(
    job_environment: dict[str, str], io_subdir: str
) -> list[dict[str, str]]:
    """Builds the RunTask environment overrides for the QGIS container.

    NOTE cross-container file exchange contract: the wrapper creates
    `shared_tempdir` under its local `/tmp` (see `JobRun.__init__`), while the
    QGIS task writes to `QFC_IO_DIR` under `QFIELDCLOUD_ECS_IO_MOUNT_PATH`.
    Both paths MUST be backed by the same shared EFS volume (mounted at `/tmp`
    in the wrapper task and at the IO mount path in the QGIS task definition),
    otherwise every job fails with a missing `feedback.json`.
    """
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


def _is_retriable_run_task_error(err: BaseException) -> bool:
    """RunTask failures worth retrying: capacity, throttling, server-side and
    network-level errors. Misconfiguration (e.g. AccessDenied, ClusterNotFound)
    fails fast instead of being retried."""
    if isinstance(err, EcsRunTaskError):
        return True

    if isinstance(err, ClientError):
        error_code = err.response.get("Error", {}).get("Code", "")

        return error_code in RETRIABLE_CLIENT_ERROR_CODES

    # BotoCoreError covers network-level failures (e.g. EndpointConnectionError)
    return isinstance(err, BotoCoreError)


def _run_task_with_retry(
    ecs_client: Any, run_task_kwargs: dict[str, Any]
) -> dict[str, Any]:
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
        retry=retry_if_exception(_is_retriable_run_task_error),
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
        logger.info(f"QGIS ECS task logs:\n{logs.decode()}")
        raise JobException(
            "The QGIS ECS task stopped without an exit code: "
            f"{stopped_task.get('stoppedReason', 'unknown reason')}"
        )

    logger.info(f"Finished execution with code {exit_code}, logs:\n{logs.decode()}")

    return exit_code, logs


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

    Unlike the local Docker API, ListTasks is a remote, rate-limited call,
    while the dequeue loop invokes this function about once per second.
    Runs are therefore throttled to once per `ORPHAN_CLEANUP_INTERVAL_S`.
    Failures are logged and swallowed (best-effort cleanup, mirroring the
    Docker implementation).
    """
    global _last_orphan_cleanup_monotonic

    now = time.monotonic()

    if (
        _last_orphan_cleanup_monotonic is not None
        and now - _last_orphan_cleanup_monotonic < ORPHAN_CLEANUP_INTERVAL_S
    ):
        return

    _last_orphan_cleanup_monotonic = now

    ecs_client = get_ecs_client()

    running_task_ids: list[str] = []

    try:
        paginator = ecs_client.get_paginator("list_tasks")

        for page in paginator.paginate(
            cluster=settings.QFIELDCLOUD_ECS_CLUSTER,
            startedBy=settings.QFIELDCLOUD_ECS_STARTED_BY,
            desiredStatus="RUNNING",
        ):
            running_task_ids.extend(task_id_from_arn(arn) for arn in page["taskArns"])
    except (ClientError, BotoCoreError) as err:
        logger.warning(
            "Failed to list ECS worker tasks for orphan cleanup.", exc_info=err
        )

        return

    if not running_task_ids:
        return

    known_container_ids = _get_known_container_ids(running_task_ids)

    for task_id in find_orphan_task_ids(running_task_ids, known_container_ids):
        try:
            ecs_client.stop_task(
                cluster=settings.QFIELDCLOUD_ECS_CLUSTER,
                task=task_id,
                reason="Orphaned QFieldCloud worker task.",
            )
        except (ClientError, BotoCoreError) as err:
            # the task may have stopped on its own in the meantime
            logger.warning(
                f"Failed to stop orphaned ECS worker task {task_id}.", exc_info=err
            )

            continue

        logger.info(f"Cancel orphaned worker ECS task {task_id}")
