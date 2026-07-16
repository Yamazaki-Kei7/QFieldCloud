import json
import tempfile
from pathlib import Path
from unittest import mock

from django.test import SimpleTestCase
from django.test.utils import override_settings

from worker_wrapper import wrapper
from worker_wrapper.executors import ecs


def make_job_run_for_dispatch(shared_tempdir: Path) -> wrapper.JobRun:
    """Builds a `JobRun` without touching the database."""
    job_run = wrapper.JobRun.__new__(wrapper.JobRun)
    job_run.job_id = "job-uuid-1"
    job_run.job = mock.Mock()
    job_run.job.project.jobs.filter.return_value.exclude.return_value.count.return_value = 0
    job_run.shared_tempdir = shared_tempdir
    job_run.debug_qgis_container_is_enabled = False

    return job_run


class RunDispatchTestCase(SimpleTestCase):
    def setUp(self):
        self.shared_tempdir = Path(tempfile.mkdtemp())

        with open(self.shared_tempdir / "feedback.json", "w") as f:
            json.dump({}, f)

    @override_settings(QFIELDCLOUD_WORKER_EXECUTOR="ecs")
    def test_run_dispatches_to_ecs_executor(self):
        job_run = make_job_run_for_dispatch(self.shared_tempdir)
        job_run.get_command = mock.Mock(return_value=["package", "project-uuid-1"])
        job_run._run_docker = mock.Mock()

        with mock.patch.object(ecs, "run_job", return_value=(0, b"job logs")) as run_job:
            job_run.run()

        run_job.assert_called_once_with(job_run, ["package", "project-uuid-1"])
        job_run._run_docker.assert_not_called()
        # the happy path must have completed, not silently failed in run()'s global handler
        self.assertEqual(job_run.job.status, wrapper.Job.Status.FINISHED)

    def test_run_uses_docker_executor_by_default(self):
        job_run = make_job_run_for_dispatch(self.shared_tempdir)
        job_run.get_command = mock.Mock(return_value=["package", "project-uuid-1"])
        job_run._run_docker = mock.Mock(return_value=(0, b"job logs"))

        with mock.patch.object(ecs, "run_job") as run_job:
            job_run.run()

        job_run._run_docker.assert_called_once_with(["package", "project-uuid-1"])
        run_job.assert_not_called()
        self.assertEqual(job_run.job.status, wrapper.Job.Status.FINISHED)


class CancelOrphanedWorkersDispatchTestCase(SimpleTestCase):
    @override_settings(QFIELDCLOUD_WORKER_EXECUTOR="ecs")
    def test_dispatches_to_ecs(self):
        with (
            mock.patch.object(ecs, "cancel_orphaned_ecs_workers") as cancel_ecs,
            mock.patch.object(wrapper.docker, "from_env") as from_env,
        ):
            wrapper.cancel_orphaned_workers()

        cancel_ecs.assert_called_once_with()
        from_env.assert_not_called()

    def test_uses_docker_by_default(self):
        docker_client = mock.Mock()
        docker_client.containers.list.return_value = []

        with (
            mock.patch.object(ecs, "cancel_orphaned_ecs_workers") as cancel_ecs,
            mock.patch.object(wrapper.docker, "from_env", return_value=docker_client),
        ):
            wrapper.cancel_orphaned_workers()

        cancel_ecs.assert_not_called()
        docker_client.containers.list.assert_called_once()
