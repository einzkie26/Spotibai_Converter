import json
import socket
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import launcher_core as core


class DesktopLauncherTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="desktop-launcher-test-")
        self.root = Path(self.temp.name)
        self.python = core.project_python(self.root)
        self.python.parent.mkdir(parents=True)
        self.python.touch()
        self.controller = core.DesktopController(self.root)

    def tearDown(self):
        self.temp.cleanup()

    def test_python_version_check_rejects_unsupported_versions(self):
        with patch.object(core.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout=json.dumps({"version": [3, 15, 0], "base": "python"}))):
            self.assertIsNone(core.python_info(self.python))
        with patch.object(core.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout=json.dumps({"version": [3, 13, 16], "base": "python"}))):
            self.assertEqual(core.python_info(self.python)["version"], [3, 13, 16])

    def test_existing_app_is_opened_without_becoming_an_owned_process(self):
        with patch.object(core, "health", return_value={"app": "spotibai", "protocol": 1}), patch.object(self.controller, "_spawn") as spawn:
            self.assertEqual(self.controller.start(), "http://127.0.0.1:5000")
            spawn.assert_not_called()
        self.assertTrue(self.controller.external)
        with patch.object(self.controller, "_stop_owned") as stop:
            self.assertFalse(self.controller.stop())
            stop.assert_not_called()

    def test_other_local_server_gets_a_different_port_and_startup_checks_ownership(self):
        with socket.socket() as occupied:
            occupied.bind(("127.0.0.1", 0))
            preferred = occupied.getsockname()[1]
            owned = Mock(pid=12345)
            owned.poll.return_value = None
            state = {}

            def spawn(args, env):
                state.update(env)
                return owned

            def status(port):
                return {"app": "spotibai", "launch_id": state["CONVOTIFY_LAUNCH_ID"], "pid": 23456} if state else None

            with patch.object(core, "health", side_effect=status), patch.object(self.controller, "_spawn", side_effect=spawn):
                self.controller.start(preferred)
            self.assertNotEqual(self.controller.port, preferred)
            self.assertIs(self.controller.server, owned)
            self.assertTrue(state["CONVOTIFY_LAUNCH_ID"])
            self.assertEqual(state["CONVOTIFY_PORT"], str(self.controller.port))

    def test_startup_failure_has_a_useful_message(self):
        dead = Mock()
        dead.poll.return_value = 1
        with patch.object(core, "health", return_value=None), patch.object(self.controller, "_spawn", return_value=dead):
            with self.assertRaisesRegex(RuntimeError, "stopped during startup"):
                self.controller.start()

    def test_requirement_failure_returns_actionable_details(self):
        result = SimpleNamespace(returncode=1, stdout="", stderr="Traceback\nModuleNotFoundError: No module named 'flask'")
        with patch.object(core.subprocess, "run", return_value=result):
            ready, message = core.check_requirements(self.root)
        self.assertFalse(ready)
        self.assertIn("flask", message)

    def test_stopping_only_targets_the_process_created_by_this_window(self):
        process = Mock()
        self.controller.server = process
        self.controller.port = 5010
        with patch.object(self.controller, "_stop_owned") as stop:
            self.assertTrue(self.controller.stop())
            stop.assert_called_once_with(process)
        self.assertEqual(self.controller.url, "")

    def test_frozen_root_uses_the_executable_folder_instead_of_internal_files(self):
        executable = self.root / "Spotibai.exe"
        with patch.object(core.sys, "frozen", True, create=True), patch.object(core.sys, "executable", str(executable)):
            self.assertEqual(core.application_root(), self.root)

    def test_frozen_python_detection_cannot_launch_another_copy_of_the_gui(self):
        with patch.object(core.sys, "frozen", True, create=True), patch.object(core.sys, "executable", str(self.python)), patch.object(core.subprocess, "run") as run:
            self.assertIsNone(core.python_info(self.python))
            run.assert_not_called()

    def test_external_tools_do_not_inherit_the_frozen_python_and_tcl_paths(self):
        bundle = self.root / "_internal"
        original = {"PATH": str(bundle / "bin") + core.os.pathsep + str(self.root / "outside"),
            "TCL_LIBRARY": str(bundle / "_tcl_data"), "TK_LIBRARY": str(bundle / "_tk_data"),
            "PYTHONHOME": str(bundle), "PYTHONPATH": str(bundle), "_PYI_APPLICATION_HOME_DIR": str(bundle), "USER_SETTING": "keep"}
        with patch.object(core.sys, "frozen", True, create=True), patch.object(core.sys, "_MEIPASS", str(bundle), create=True):
            result = core.external_environment(original)
        self.assertEqual(result["PATH"], str(self.root / "outside"))
        self.assertEqual(result["USER_SETTING"], "keep")
        for key in ("TCL_LIBRARY", "TK_LIBRARY", "PYTHONHOME", "PYTHONPATH", "_PYI_APPLICATION_HOME_DIR"):
            self.assertNotIn(key, result)
        self.assertIn("TCL_LIBRARY", original)
