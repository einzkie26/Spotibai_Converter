import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import build_exe


class ExecutablePackageTests(unittest.TestCase):
    def test_release_contains_the_app_and_assets_without_personal_data_or_environments(self):
        with tempfile.TemporaryDirectory(prefix="exe-payload-test-") as temporary:
            root = Path(temporary) / "project"
            output = Path(temporary) / "release"
            root.mkdir()
            output.mkdir()
            for name in build_exe.RUNTIME_FILES:
                (root / name).write_text("public app file", encoding="utf-8")
            for name in ("static/library.js", "templates/library.html", ".env", "library/private.mp3",
                         "library/library.db", "jobs/private.json", ".cache/token", ".venv/private.py", "static/credentials.env"):
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("test fixture", encoding="utf-8")
            with patch.object(build_exe, "ROOT", root):
                build_exe.copy_runtime(output)
            self.assertTrue((output / "app.py").is_file())
            self.assertTrue((output / "static/library.js").is_file())
            self.assertTrue((output / "templates/library.html").is_file())
            for name in (".env", "library", "jobs", ".cache", ".venv", "static/credentials.env"):
                self.assertFalse((output / name).exists(), name)
            self.assertIn("Double-click Spotibai.exe", (output / "READ ME FIRST.txt").read_text())
