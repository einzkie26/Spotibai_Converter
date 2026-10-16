from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.request
import uuid
from pathlib import Path
from contextlib import contextmanager


def application_root():
    """Writable portable app files live next to the EXE, outside its bundled runtime."""
    return Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else Path(__file__).resolve().parent


ROOT = application_root()
NO_WINDOW = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
SUPPORTED = "Python 3.11-3.13 (3.13 recommended)"
DLL_LOCK = threading.RLock()


def external_environment(base=None):
    env = dict(os.environ if base is None else base)
    if getattr(sys, "frozen", False):
        for key in tuple(env):
            if key in {"TCL_LIBRARY", "TK_LIBRARY", "PYTHONHOME", "PYTHONPATH", "PYTHONEXECUTABLE", "__PYVENV_LAUNCHER__"} or key.startswith("_PYI_"):
                env.pop(key, None)
        bundle = Path(sys._MEIPASS).resolve()
        env["PATH"] = os.pathsep.join(part for part in env.get("PATH", "").split(os.pathsep)
            if part and not Path(part.strip('"')).resolve().is_relative_to(bundle))
    return env


@contextmanager
def external_libraries():
    """Prevent the frozen launcher's DLLs from being loaded by system Python/tools."""
    if os.name != "nt" or not getattr(sys, "frozen", False):
        yield
        return
    import ctypes
    with DLL_LOCK:
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.GetDllDirectoryW.argtypes = [ctypes.c_ulong, ctypes.c_wchar_p]
        kernel.SetDllDirectoryW.argtypes = [ctypes.c_wchar_p]
        previous = ctypes.create_unicode_buffer(32768)
        kernel.GetDllDirectoryW(len(previous), previous)
        if not kernel.SetDllDirectoryW(None):
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            yield
        finally:
            kernel.SetDllDirectoryW(previous.value or None)


def run_external(args, **kwargs):
    kwargs["env"] = external_environment(kwargs.get("env"))
    kwargs.setdefault("creationflags", NO_WINDOW)
    with external_libraries():
        return subprocess.run(args, **kwargs)


def spawn_external(args, **kwargs):
    kwargs["env"] = external_environment(kwargs.get("env"))
    kwargs.setdefault("creationflags", NO_WINDOW)
    with external_libraries():
        return subprocess.Popen(args, **kwargs)


def python_info(executable):
    try:
        if getattr(sys, "frozen", False) and Path(executable).resolve() == Path(sys.executable).resolve():
            return None
        # A frozen UI includes its own Tk; the separate audio runtime need not have it.
        tk_check = "" if getattr(sys, "frozen", False) else "import tkinter; tkinter.Tcl(); "
        result = run_external([str(executable), "-c", "import json,sys; " + tk_check + "print(json.dumps({'version':list(sys.version_info[:3]),'base':sys._base_executable}))"],
            capture_output=True, text=True, timeout=15, creationflags=NO_WINDOW)
        info = json.loads(result.stdout) if result.returncode == 0 else None
        return info if info and (3, 11) <= tuple(info["version"][:2]) < (3, 14) else None
    except (OSError, ValueError, KeyError, subprocess.TimeoutExpired):
        return None


def find_python(root=ROOT):
    candidates = [project_python(root)]
    if not getattr(sys, "frozen", False):
        candidates.append(Path(sys.executable))
    local = Path(os.environ.get("LOCALAPPDATA", ""))
    candidates.extend(local / "Programs" / "Python" / f"Python{version}" / "python.exe" for version in (313, 312, 311))
    if shutil.which("py"):
        for version in ("3.13", "3.12", "3.11"):
            try:
                result = run_external(["py", f"-{version}", "-c", "import sys; print(sys.executable)"],
                    capture_output=True, text=True, timeout=10, creationflags=NO_WINDOW)
                if result.returncode == 0:
                    candidates.append(Path(result.stdout.strip()))
            except (OSError, subprocess.TimeoutExpired):
                pass
    if shutil.which("python"):
        candidates.append(Path(shutil.which("python")))
    for candidate in dict.fromkeys(candidates):
        if Path(candidate).is_file():
            info = python_info(candidate)
            if info:
                return Path(candidate), info
    return None, None


def project_python(root=ROOT):
    return root / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def check_requirements(root=ROOT):
    executable = project_python(root)
    if not executable.is_file():
        return False, "Install the app requirements to create its Python environment."
    code = """
import importlib.metadata, pathlib, shutil, sys
from packaging.requirements import Requirement
assert (3,11) <= sys.version_info[:2] < (3,14), 'Use Python 3.11-3.13.'
for line in pathlib.Path('requirements.txt').read_text().splitlines():
    line=line.split('#',1)[0].strip()
    if not line: continue
    req=Requirement(line)
    if req.marker is None or req.marker.evaluate():
        assert importlib.metadata.version(req.name) in req.specifier, 'Update '+req.name
import app, demucs.separate
assert app.find_ffmpeg() is not None, 'FFmpeg is missing.'
assert shutil.which('ffprobe') or pathlib.Path(sys.executable).with_name('ffprobe.exe').is_file(), 'FFprobe is missing.'
print('All app requirements and audio tools are ready.')
"""
    try:
        env = external_environment()
        env["PATH"] = str(executable.parent) + os.pathsep + env.get("PATH", "")
        # Importing the app during setup must not migrate the user's Library.
        import tempfile
        with tempfile.TemporaryDirectory(prefix="spotibai-setup-check-") as scratch:
            env["CONVOTIFY_LIBRARY_DIR"] = scratch
            env["CONVOTIFY_JOBS_DIR"] = scratch
            result = run_external([str(executable), "-c", code], cwd=root, env=env,
                capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=90, creationflags=NO_WINDOW)
        if result.returncode:
            detail = (result.stderr or result.stdout).strip().splitlines()
            return False, "Requirements need installation or repair. " + (detail[-1] if detail else "Open setup details for help.")
        checked = run_external([str(executable), "-m", "pip", "check"], cwd=root,
            capture_output=True, text=True, timeout=60, creationflags=NO_WINDOW)
        return (True, "All app requirements and audio tools are ready.") if checked.returncode == 0 else (False, checked.stdout.strip())
    except (OSError, subprocess.TimeoutExpired) as exc:
        return False, f"Could not complete the requirements check: {exc}"


def health(port):
    try:
        # Ignore system HTTP proxies for loopback requests.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(f"http://127.0.0.1:{port}/health", timeout=.6) as response:
            result = json.loads(response.read(4096))
        return result if result.get("app") == "spotibai" and result.get("protocol") == 1 else None
    except (OSError, ValueError, AttributeError):
        return None


class DesktopController:
    def __init__(self, root=ROOT, log=lambda line: None):
        self.root, self.log = Path(root), log
        self.lock = threading.RLock()
        self.server = None
        self.installer = None
        self.port = None
        self.external = False

    @property
    def url(self):
        return f"http://127.0.0.1:{self.port}" if self.port else ""

    def _spawn(self, args, env=None):
        process = spawn_external([str(arg) for arg in args], cwd=self.root, env=env,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace",
            creationflags=NO_WINDOW)

        def read():
            try:
                for line in process.stdout:
                    self.log(line.rstrip())
            finally:
                process.stdout.close()
        threading.Thread(target=read, daemon=True).start()
        return process

    def install(self, base_python):
        if os.name != "nt":
            raise RuntimeError("The guided installer is for Windows. See README for manual setup.")
        with self.lock:
            if self.server and self.server.poll() is None or self.external:
                raise RuntimeError("Stop the running app before updating its requirements.")
            self.installer = self._spawn(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
                self.root / "setup.ps1", "-Python", base_python, "-SkipNode"])
            installer = self.installer
        try:
            if installer.wait() != 0:
                raise RuntimeError("Installation did not finish. Check your connection and the setup details, then try again.")
        finally:
            with self.lock:
                self.installer = None

    def start(self, preferred_port=5000, timeout=45, extra_env=None):
        with self.lock:
            if self.server and self.server.poll() is None:
                return self.url
            existing = health(preferred_port)
            if existing:
                self.port, self.external = preferred_port, True
                self.log("Connected to an app that was already running. This window will leave it running.")
                return self.url
            self.external = False
            for candidate in range(preferred_port, min(preferred_port + 50, 65536)):
                with socket.socket() as probe:
                    try:
                        probe.bind(("127.0.0.1", candidate))
                    except OSError:
                        continue
                self.port = candidate
                break
            else:
                raise RuntimeError("No local port is available. Close another local server and retry.")
            executable = project_python(self.root)
            if not executable.is_file():
                raise RuntimeError("Install the app requirements first.")
            env = external_environment()
            env.update(extra_env or {})
            env["CONVOTIFY_PORT"] = str(self.port)
            launch_id = uuid.uuid4().hex
            env["CONVOTIFY_LAUNCH_ID"] = launch_id
            env["PYTHONUNBUFFERED"] = "1"
            env["PATH"] = str(executable.parent) + os.pathsep + env.get("PATH", "")
            self.server = self._spawn([executable, self.root / "app.py"], env)
            process = self.server
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise RuntimeError("The app stopped during startup. Check setup details, then install or repair requirements.")
            status = health(self.port)
            # Windows venv executables may spawn the actual Python interpreter.
            if status and status.get("launch_id") == launch_id:
                return self.url
            time.sleep(.25)
        self.stop()
        raise RuntimeError("The app took too long to start. Check setup details and try again.")

    def _stop_owned(self, process):
        if not process or process.poll() is not None:
            return
        if os.name == "nt":
            # The UI can run under base Python before dependencies are installed.
            # Use the app environment to inspect only the tree this window owns.
            code = """
import psutil,sys
try:
    family=psutil.Process(int(sys.argv[1])).children(recursive=True)
except psutil.NoSuchProcess:
    family=[]
for child in reversed(family):
    try: child.kill()
    except psutil.NoSuchProcess: pass
"""
            result = run_external([str(project_python(self.root)), "-c", code, str(process.pid)],
                capture_output=True, text=True, timeout=15, creationflags=NO_WINDOW)
            if result.returncode:
                raise RuntimeError("Could not stop the app's child processes. Keep this window open and try Stop app again.")
            if process.poll() is None:
                process.kill()
        else:
            process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)

    def stop(self):
        with self.lock:
            if self.external:
                return False
            self._stop_owned(self.server)
            self.server = None
            self.port = None
            return True

