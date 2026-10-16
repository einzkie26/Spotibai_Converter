"""A bounded, cancellable CPU separation trial, isolated from the web server."""
from __future__ import annotations

import hashlib
import importlib.metadata
import json
import math
import os
import platform
import queue
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

import psutil
from filelock import FileLock, Timeout

GB = 1024 ** 3
SAMPLE_SECONDS = 8
MAX_SECONDS = 300
MIN_FREE_RAM = 2 * GB
PRESET = "htdemucs-cpu-shifts1-overlap025-threads4-v1"


def hardware():
    ram = psutil.virtual_memory()
    return {"physical_cores": psutil.cpu_count(logical=False) or 1,
            "logical_cores": psutil.cpu_count() or 1,
            "total_ram_gb": ram.total / GB, "available_ram_gb": ram.available / GB}


def machine_key():
    versions = []
    for package in ("torch", "demucs"):
        try:
            versions.append(importlib.metadata.version(package))
        except importlib.metadata.PackageNotFoundError:
            versions.append("missing")
    return hashlib.sha256(json.dumps([platform.platform(), platform.processor(),
        psutil.cpu_count(), psutil.virtual_memory().total, sys.version_info[:2], versions, PRESET]).encode()).hexdigest()


def valid_measurement(value):
    return isinstance(value, dict) and all(isinstance(value.get(key), (float, int)) and
        math.isfinite(value[key]) and value[key] > 0 for key in
        ("wall_seconds", "cpu_seconds", "peak_ram_gb", "seconds_per_minute"))


class ReadinessService:
    def __init__(self, report_path=None):
        self.report_path = Path(report_path or os.environ.get("CONVOTIFY_READINESS_FILE",
            Path(__file__).parent / ".cache" / "readiness" / "report.json"))
        self.lock = threading.RLock()
        self.cancel_event = threading.Event()
        self.worker = None
        self.process = None
        self.state = {"state": "idle", "ready": False, "pct": 0,
                      "msg": "Run the CPU & RAM test before preparing new stems."}
        self.key = machine_key()
        try:
            saved = json.loads(self.report_path.read_text(encoding="utf-8"))
            if (saved.get("key") == self.key and 0 <= time.time() - saved["tested_at"] < 7 * 86400
                    and valid_measurement(saved.get("measurement"))):
                self.state = saved
        except (OSError, ValueError, KeyError, TypeError):
            pass

    def snapshot(self):
        with self.lock:
            result = dict(self.state)
        result["hardware"] = hardware()
        if result.get("ready") and time.time() - result.get("tested_at", 0) >= 7 * 86400:
            result.update(ready=False, state="idle", msg="The hardware test has expired. Run it again before preparing new stems.")
        return result

    def start(self):
        with self.lock:
            if self.state["state"] == "running":
                return self.snapshot()
            available = psutil.virtual_memory().available
            if available < MIN_FREE_RAM:
                self.state = {"state": "blocked", "ready": False, "pct": 0,
                    "msg": "Close other apps and free at least 2 GB of RAM to run this app's separation trial."}
                return self.snapshot()
            self.cancel_event.clear()
            self.report_path.unlink(missing_ok=True)
            self.state = {"state": "running", "ready": False, "pct": 0,
                          "msg": "Starting the CPU trial. The first run may download model weights."}
            self.worker = threading.Thread(target=self._run, args=(available,), daemon=True, name="stem-readiness")
            self.worker.start()
            return self.snapshot()

    def cancel(self):
        with self.lock:
            if self.state["state"] == "running":
                self.cancel_event.set()
                self.state["msg"] = "Stopping the test and releasing memory..."
            return self.snapshot()

    def check(self, duration=0, model_loaded=False):
        status = self.snapshot()
        if not status.get("ready"):
            return status["msg"] if status["state"] == "running" else "Run the CPU & RAM test in Library before preparing new stems."
        peak = status["measurement"]["peak_ram_gb"] * GB
        # Whole-song decoded tensors and four separated sources also need space.
        buffers = max(0, duration) * 44100 * 2 * 4 * 12
        required = (max(.5 * GB, peak * .35) if model_loaded else peak * 1.25) + .5 * GB + buffers
        if psutil.virtual_memory().available < required:
            return f"Not enough available RAM for this track. Free about {required / GB:.1f} GB, then try again."
        return None

    def _update(self, **fields):
        with self.lock:
            self.state.update(fields)

    def _run(self, initial_available):
        process = None
        terminal = None
        try:
            self.report_path.parent.mkdir(parents=True, exist_ok=True)
            with FileLock(str(self.report_path.with_suffix(".lock")), timeout=0), tempfile.TemporaryFile() as errors:
                process = subprocess.Popen([sys.executable, "-u", str(Path(__file__).resolve()), "--worker"],
                    stdout=subprocess.PIPE, stderr=errors, text=True, encoding="utf-8", errors="replace",
                    creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
                with self.lock:
                    self.process = process
                messages = queue.Queue()

                def read_lines():
                    try:
                        for line in process.stdout:
                            try:
                                messages.put(json.loads(line))
                            except ValueError:
                                pass
                    finally:
                        process.stdout.close()

                reader = threading.Thread(target=read_lines, daemon=True)
                reader.start()
                monitor = psutil.Process(process.pid)
                started, peak, measurement = time.monotonic(), 0, None
                while True:
                    if self.cancel_event.is_set():
                        raise InterruptedError("Test cancelled. New stems still require a completed test.")
                    if time.monotonic() - started > MAX_SECONDS:
                        raise RuntimeError("The trial timed out after 5 minutes. Check the model download or close other apps and retry.")
                    try:
                        # Windows venv python.exe is a small redirector; the real interpreter
                        # can be its child. Include the owned process tree in RAM accounting.
                        family = [monitor] + monitor.children(recursive=True)
                        used = 0
                        for member in family:
                            try:
                                memory = member.memory_info()
                                used += max(memory.rss, getattr(memory, "peak_wset", 0))
                            except psutil.NoSuchProcess:
                                pass
                        peak = max(peak, used)
                        if psutil.virtual_memory().available < .375 * GB or peak > initial_available - .5 * GB:
                            raise RuntimeError("The trial stopped to leave RAM available for Windows. Close other apps and retry.")
                    except psutil.NoSuchProcess:
                        pass
                    while not messages.empty():
                        message = messages.get_nowait()
                        if message.get("measurement"):
                            measurement = message["measurement"]
                        elif "msg" in message:
                            self._update(msg=str(message["msg"]), pct=message.get("pct"))
                    if process.poll() is not None:
                        reader.join(timeout=2)
                        while not messages.empty():
                            message = messages.get_nowait()
                            measurement = message.get("measurement", measurement)
                        break
                    self.cancel_event.wait(.15)
                if process.returncode != 0:
                    errors.seek(0, 2)
                    length = errors.tell()
                    errors.seek(max(0, length - 1800))
                    detail = errors.read().decode("utf-8", errors="replace").strip().splitlines()
                    raise RuntimeError("The CPU trial failed. Check requirements and model connectivity. " + (detail[-1] if detail else ""))
                if measurement:
                    measurement["peak_ram_gb"] = peak / GB
                if self.cancel_event.is_set():
                    raise InterruptedError("Test cancelled. New stems still require a completed test.")
                if not valid_measurement(measurement):
                    raise RuntimeError("The trial returned no valid timing or RAM measurement. Please retry.")
                slow = measurement["seconds_per_minute"] > 180
                result = {"state": "limited" if slow else "ready", "ready": True, "pct": 100,
                    "msg": "Test passed. This CPU is slower; stems will run one track at a time." if slow else
                           "Test passed. New stems are enabled; available RAM is checked again for each track.",
                    "measurement": measurement, "key": self.key, "tested_at": time.time()}
                temporary = self.report_path.with_suffix(".tmp")
                temporary.write_text(json.dumps(result), encoding="utf-8")
                temporary.replace(self.report_path)
                terminal = result
        except InterruptedError as exc:
            terminal = dict(state="cancelled", ready=False, pct=0, msg=str(exc))
        except Timeout:
            terminal = dict(state="error", ready=False, pct=0, msg="Another hardware trial is running. Wait for it to finish.")
        except Exception as exc:
            terminal = dict(state="error", ready=False, pct=0, msg=str(exc))
        finally:
            if process and process.poll() is None:
                try:
                    descendants = psutil.Process(process.pid).children(recursive=True)
                except psutil.NoSuchProcess:
                    descendants = []
                for child in reversed(descendants):
                    try:
                        child.kill()
                    except psutil.NoSuchProcess:
                        pass
                if process.poll() is None:
                    process.kill()
                process.wait(timeout=10)
            with self.lock:
                self.process = None
                if terminal:
                    self.state.update(terminal)


def trial_worker():
    def emit(**value):
        print(json.dumps(value), flush=True)

    emit(msg="Loading separation tools...", pct=5)
    import torch
    from demucs.api import Separator
    torch.set_num_threads(min(4, psutil.cpu_count(logical=False) or 1))
    emit(msg="Loading htdemucs. Model weights download automatically on the first test...", pct=15)
    started = time.monotonic()
    separator = Separator(model="htdemucs", device="cpu", shifts=1, overlap=.25, jobs=0, progress=False)
    load_seconds = time.monotonic() - started
    sample_rate = separator.samplerate
    axis = torch.arange(SAMPLE_SECONDS * sample_rate, dtype=torch.float32) / sample_rate
    sample = (.1 * torch.sin(2 * math.pi * 220 * axis) + .05 * torch.sin(2 * math.pi * 440 * axis)).repeat(2, 1)
    emit(msg="Separating the 8-second generated sample on CPU...", pct=None)
    wall, cpu = time.monotonic(), time.process_time()
    _, stems = separator.separate_tensor(sample, sr=sample_rate)
    elapsed, cpu_elapsed = time.monotonic() - wall, time.process_time() - cpu
    if "vocals" not in stems or len(stems) < 2 or any(value.numel() == 0 or not torch.isfinite(value).all() for value in stems.values()):
        raise RuntimeError("The separation model did not return valid audio tensors.")
    emit(measurement={"wall_seconds": elapsed, "cpu_seconds": cpu_elapsed,
         "seconds_per_minute": elapsed / SAMPLE_SECONDS * 60, "load_seconds": load_seconds,
         "sample_seconds": SAMPLE_SECONDS})


if __name__ == "__main__" and "--worker" in sys.argv:
    trial_worker()
else:
    READINESS = ReadinessService()
