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

    def test_exit_code_from_described_task_success_zero(self):
        task = {"containers": [{"name": "qgis", "exitCode": 0}]}
        self.assertEqual(ecs.exit_code_from_described_task(task), 0)

    def test_exit_code_from_described_task_no_containers(self):
        task = {"containers": [], "stoppedReason": "Task failed to start"}
        self.assertIsNone(ecs.exit_code_from_described_task(task))
