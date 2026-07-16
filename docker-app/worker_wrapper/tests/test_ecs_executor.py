from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from botocore.exceptions import ClientError
from django.test import SimpleTestCase
from django.test.utils import override_settings

from worker_wrapper.executors import ecs
from worker_wrapper.wrapper import TIMEOUT_ERROR_EXIT_CODE, JobException

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

    def test_exit_code_from_described_task_success_zero(self):
        task = {"containers": [{"name": "qgis", "exitCode": 0}]}
        self.assertEqual(ecs.exit_code_from_described_task(task), 0)

    def test_exit_code_from_described_task_no_containers(self):
        task = {"containers": [], "stoppedReason": "Task failed to start"}
        self.assertIsNone(ecs.exit_code_from_described_task(task))


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

    def test_run_job_does_not_retry_non_retriable_client_error(self):
        self.ecs_client.run_task.side_effect = ClientError(
            {"Error": {"Code": "AccessDeniedException", "Message": "nope"}},
            "RunTask",
        )
        job_run = make_fake_job_run()

        with self.assertRaises(JobException):
            ecs.run_job(job_run, ["package", "project-uuid-1"])

        self.assertEqual(self.ecs_client.run_task.call_count, 1)


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
