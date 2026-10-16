import json
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from stem_readiness import GB, ReadinessService, valid_measurement


MEASURED = {"wall_seconds": 12., "cpu_seconds": 40., "peak_ram_gb": 1., "seconds_per_minute": 90.}


class ReadinessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="readiness-test-")
        self.path = Path(self.temp.name) / "report.json"
        self.service = ReadinessService(self.path)

    def tearDown(self):
        self.service.cancel()
        if self.service.worker:
            self.service.worker.join(15)
        self.temp.cleanup()

    def ready(self):
        self.service.state.update(state="ready", ready=True, tested_at=time.time(), measurement=dict(MEASURED), key=self.service.key)

    def test_stems_require_a_successful_test(self):
        self.assertIn("Run the CPU", self.service.check(180))

    def test_low_available_ram_blocks_trial_before_spawning(self):
        with patch("stem_readiness.psutil.virtual_memory", return_value=SimpleNamespace(total=8*GB, available=GB)), patch("stem_readiness.subprocess.Popen") as spawn:
            status = self.service.start()
        self.assertEqual(status["state"], "blocked")
        self.assertFalse(status["ready"])
        spawn.assert_not_called()

    def test_current_ram_and_song_duration_are_checked_after_passing(self):
        self.ready()
        with patch("stem_readiness.psutil.virtual_memory", return_value=SimpleNamespace(total=8*GB, available=3*GB)):
            self.assertIsNone(self.service.check(180))
            self.assertIn("RAM", self.service.check(1800))
        with patch("stem_readiness.psutil.virtual_memory", return_value=SimpleNamespace(total=8*GB, available=GB)):
            self.assertIn("RAM", self.service.check(180))

    def test_saved_report_requires_this_machine_preset_and_a_recent_valid_measurement(self):
        self.ready()
        self.path.write_text(json.dumps(self.service.state))
        self.assertTrue(ReadinessService(self.path).snapshot()["ready"])
        self.service.state["key"] = "other machine"
        self.path.write_text(json.dumps(self.service.state))
        self.assertFalse(ReadinessService(self.path).snapshot()["ready"])
        self.service.state.update(key=self.service.key, tested_at=time.time() - 8*86400)
        self.path.write_text(json.dumps(self.service.state))
        self.assertFalse(ReadinessService(self.path).snapshot()["ready"])

    def test_reports_expire_in_a_running_server_too(self):
        self.ready()
        self.service.state["tested_at"] = time.time() - 8*86400
        self.assertFalse(self.service.snapshot()["ready"])

    def test_invalid_measurements_are_never_treated_as_readiness(self):
        for value in (None, {}, {**MEASURED, "peak_ram_gb": 0}, {**MEASURED, "cpu_seconds": float("nan")}):
            self.assertFalse(valid_measurement(value))

    def test_worker_startup_failure_leaves_test_retryable(self):
        with patch("stem_readiness.psutil.virtual_memory", return_value=SimpleNamespace(total=8*GB, available=4*GB)), patch("stem_readiness.subprocess.Popen", side_effect=OSError("Cannot start interpreter")):
            self.service.start()
            self.service.worker.join(5)
        self.assertEqual(self.service.snapshot()["state"], "error")
        self.assertIn("interpreter", self.service.snapshot()["msg"])
        self.assertFalse(self.path.exists())

    def fake_trial(self, script):
        worker = Path(self.temp.name) / "worker.py"
        worker.write_text(script, encoding="utf-8")
        real_spawn = subprocess.Popen

        def spawn(args, **kwargs):
            if "--worker" in args:
                args = [sys.executable, "-u", str(worker)]
            return real_spawn(args, **kwargs)
        return patch("stem_readiness.subprocess.Popen", side_effect=spawn)

    def test_cancel_stops_the_owned_interpreter_and_does_not_save_readiness(self):
        with self.fake_trial("import time; time.sleep(60)"), patch("stem_readiness.psutil.virtual_memory", return_value=SimpleNamespace(total=8*GB, available=4*GB)):
            self.service.start()
            deadline = time.monotonic() + 5
            while self.service.process is None and time.monotonic() < deadline:
                time.sleep(.01)
            process = self.service.process
            self.assertIsNotNone(process)
            self.service.cancel()
            self.service.worker.join(10)
        self.assertIsNotNone(process.poll())
        self.assertEqual(self.service.snapshot()["state"], "cancelled")
        self.assertFalse(self.path.exists())

    def test_timeout_stops_the_trial_and_remains_retryable(self):
        with self.fake_trial("import time; time.sleep(60)"), patch("stem_readiness.MAX_SECONDS", .1), patch("stem_readiness.psutil.virtual_memory", return_value=SimpleNamespace(total=8*GB, available=4*GB)):
            self.service.start()
            self.service.worker.join(10)
        self.assertEqual(self.service.snapshot()["state"], "error")
        self.assertIn("timed out", self.service.snapshot()["msg"])

    def test_cpu_trial_tracks_child_memory_and_saves_a_valid_slow_result(self):
        script = "import json,time; block=bytearray(40*1024**2); time.sleep(.3); print(json.dumps({'measurement':{'wall_seconds':30,'cpu_seconds':40,'seconds_per_minute':225}}),flush=True)"
        with self.fake_trial(script), patch("stem_readiness.psutil.virtual_memory", return_value=SimpleNamespace(total=8*GB, available=4*GB)):
            self.service.start()
            self.service.worker.join(10)
        status = self.service.snapshot()
        self.assertEqual(status["state"], "limited", status)
        self.assertTrue(status["ready"])
        self.assertGreater(status["measurement"]["peak_ram_gb"], .04)
        self.assertTrue(ReadinessService(self.path).snapshot()["ready"])
