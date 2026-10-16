"""Library stem jobs: one reusable model, one inference for both outputs."""
from __future__ import annotations

import hashlib
import importlib.util
import json
import math
import queue
import shutil
import subprocess
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from filelock import FileLock

from conversion_engine import usable_audio

STEMS = {"vocals": "Vocals", "instrumental": "Instrumental"}


def stem_path(source: Path, stem: str, fmt: str) -> Path:
    ext = ".m4a" if fmt in {"aac", "alac"} else f".{fmt}"
    return cache_folder(source) / f"{source.stem} ({STEMS[stem]}){ext}"


def fingerprint(source: Path, fmt: str, bitrate: str) -> str:
    stat = source.stat()
    return hashlib.sha256(json.dumps([str(source.resolve()), stat.st_size, stat.st_mtime_ns,
                                     fmt, bitrate, "htdemucs-1-0.25-v1"]).encode()).hexdigest()


def cache_folder(source: Path) -> Path:
    key = hashlib.sha256(str(source.resolve()).encode()).hexdigest()[:20]
    return source.parent / ".stem-cache" / key


def ready_stem(source: Path, stem: str, fmt: str, bitrate: str) -> Path | None:
    path = stem_path(source, stem, fmt)
    try:
        manifest = cache_folder(source) / "ready.json"
        if manifest.exists():
            if json.loads(manifest.read_text())["fingerprint"] != fingerprint(source, fmt, bitrate):
                return None
        else:
            # Continue to serve valid stems prepared by the earlier implementation.
            if not path.is_file():
                path = source.parent / path.name
            if path.stat().st_mtime_ns < source.stat().st_mtime_ns:
                return None
        return path if usable_audio(path) else None
    except (OSError, ValueError, KeyError):
        return None


class StemService:
    def __init__(self):
        self.jobs = {}
        self.active = {}
        self.lock = threading.RLock()
        self.pending = queue.Queue()
        self.worker = None
        self.separator = None

    def _update(self, job_id, **fields):
        with self.lock:
            job = self.jobs[job_id]
            if "pct" in fields:
                fields["pct"] = max(job["pct"], min(100, fields["pct"]))
            job.update(fields, revision=job["revision"] + 1, updated_at=time.time())

    def snapshot(self, job_id, track_id):
        with self.lock:
            job = self.jobs.get(job_id)
            return dict(job) if job and job["track_id"] == track_id else None

    def start(self, track_id, source, stem, fmt, bitrate, ffmpeg, metadata=None):
        source = Path(source)
        key = fingerprint(source, fmt, bitrate)
        with self.lock:
            existing = self.active.get((track_id, key))
            if existing and self.jobs[existing]["state"] not in {"done", "error"}:
                return existing
            # Keep completed jobs long enough for reconnecting or simultaneous SSE clients.
            for old_id, old in list(self.jobs.items()):
                if old["state"] in {"done", "error"} and time.time() - old["updated_at"] > 900:
                    self.jobs.pop(old_id)
                    if self.active.get((old["track_id"], old["key"])) == old_id:
                        self.active.pop((old["track_id"], old["key"]), None)
            job_id = uuid.uuid4().hex
            cached = ready_stem(source, stem, fmt, bitrate)
            self.jobs[job_id] = {"track_id": track_id, "key": key, "revision": 0,
                                 "state": "done" if cached else "queued", "pct": 100 if cached else 0,
                                 "msg": "Using the prepared file" if cached else "Queued for separation",
                                 "cached": bool(cached), "updated_at": time.time()}
            if cached:
                return job_id
            if importlib.util.find_spec("demucs") is None:
                self._update(job_id, state="error", msg="Demucs is not installed. Run the project installer.")
                return job_id
            self.active[(track_id, key)] = job_id
            self.pending.put((job_id, source, stem, fmt, bitrate, Path(ffmpeg), metadata or {}))
            if self.worker is None or not self.worker.is_alive():
                self.worker = threading.Thread(target=self._dispatch, name="library-stem-worker", daemon=True)
                self.worker.start()
            return job_id

    def _dispatch(self):
        while True:
            request = self.pending.get()
            try:
                if request is None:
                    return
                self._run(*request)
            finally:
                self.pending.task_done()

    def _model(self):
        if self.separator is None:
            import psutil
            import torch
            from demucs.api import Separator

            torch.set_num_threads(max(1, min(4, psutil.cpu_count(logical=False) or 1)))
            self.separator = Separator(model="htdemucs", device="cuda" if torch.cuda.is_available() else "cpu",
                                       shifts=1, overlap=0.25, jobs=0, progress=False)
        return self.separator

    def _infer(self, source, progress, ffmpeg):
        import numpy as np
        import torch

        separator = self._model()

        def callback(info):
            if info["state"] != "end":
                return
            models = getattr(separator.model, "models", [separator.model])
            segment = float(models[info["model_idx_in_bag"]].segment)
            stride = max(1, int(segment * separator.samplerate * 0.75))
            count = max(1, math.ceil(info["audio_length"] / stride))
            completed = min(count, info["segment_offset"] // stride + 1)
            fraction = (info["model_idx_in_bag"] + completed / count) / info["models"]
            progress(10 + int(70 * fraction), "Separating vocals and instrumental")

        separator.update_parameter(callback=callback)
        progress(6, "Reading library audio")
        decoded = subprocess.run([str(ffmpeg), "-v", "error", "-i", str(source), "-f", "f32le",
                                  "-ar", str(separator.samplerate), "-ac", str(separator.audio_channels), "pipe:1"],
                                 capture_output=True, timeout=180,
                                 creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        if decoded.returncode or not decoded.stdout:
            raise RuntimeError("Could not read the library audio for separation.")
        audio = torch.from_numpy(np.frombuffer(decoded.stdout, dtype="<f4").reshape(-1, separator.audio_channels).T.copy())
        del decoded
        with torch.inference_mode():
            original, estimates = separator.separate_tensor(audio, separator.samplerate)
            vocals = estimates.pop("vocals")
            # Match Demucs' default two-stem 'add' method.
            instrumental = torch.zeros_like(vocals)
            for estimate in estimates.values():
                instrumental.add_(estimate)
            del estimates, original
        return {"vocals": vocals.cpu(), "instrumental": instrumental.cpu()}, separator.samplerate

    def _encode(self, samples, samplerate, target, fmt, bitrate, ffmpeg):
        from demucs.audio import prevent_clip

        samples = prevent_clip(samples, mode="rescale")
        pcm = samples.detach().cpu().transpose(0, 1).contiguous().numpy().astype("<f4", copy=False)
        codec = {"mp3": "libmp3lame", "wav": "pcm_s16le", "flac": "flac", "aac": "aac", "alac": "alac"}[fmt]
        quality = ["-b:a", bitrate] if fmt in {"mp3", "aac"} else []
        result = subprocess.run([str(ffmpeg), "-v", "error", "-y", "-f", "f32le", "-ar", str(samplerate),
                                 "-ac", str(pcm.shape[1]), "-i", "pipe:0", "-vn", "-c:a", codec,
                                 *quality, "-threads", "1", str(target)],
                                input=memoryview(pcm).cast("B"), capture_output=True, timeout=180,
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        if result.returncode or not usable_audio(target):
            raise RuntimeError("Could not encode the separated audio.")

    def _run(self, job_id, source, requested, fmt, bitrate, ffmpeg, metadata):
        temporary = []
        try:
            self._update(job_id, state="running", pct=1, msg="Preparing separation")
            folder = cache_folder(source)
            folder.mkdir(parents=True, exist_ok=True)
            with FileLock(str(folder / "separation.lock"), timeout=3600):
                prepared = {stem: ready_stem(source, stem, fmt, bitrate) for stem in STEMS}
                needed = [stem for stem in STEMS if prepared[stem] is None]
                if needed:
                    # A track may have waited in the queue while other apps used RAM.
                    from stem_readiness import READINESS
                    from mutagen import File as MutagenFile
                    try:
                        audio = MutagenFile(source)
                        duration = float(audio.info.length) if audio and audio.info else 600
                    except Exception:
                        duration = 600
                    problem = READINESS.check(duration, self.separator is not None)
                    if problem:
                        raise RuntimeError(problem)
                    self._update(job_id, pct=3, msg="Loading the separation model" if self.separator is None else "Reading audio")
                    samples, samplerate = self._infer(source, lambda pct, msg: self._update(job_id, pct=pct, msg=msg), ffmpeg)
                    self._update(job_id, pct=82, msg="Encoding vocals and instrumental")
                    for stem, existing in prepared.items():
                        target = stem_path(source, stem, fmt)
                        if existing is not None and existing != target:
                            tmp = target.with_name(f".{target.stem}.{job_id}{target.suffix}")
                            temporary.append((tmp, target, stem))
                            shutil.copy2(existing, tmp)
                    with ThreadPoolExecutor(max_workers=2) as encoders:
                        futures = []
                        for stem in needed:
                            target = stem_path(source, stem, fmt)
                            tmp = target.with_name(f".{target.stem}.{job_id}{target.suffix}")
                            temporary.append((tmp, target, stem))
                            futures.append(encoders.submit(self._encode, samples[stem], samplerate, tmp, fmt, bitrate, ffmpeg))
                        for future in futures:
                            future.result()
                    del samples
                    self._update(job_id, pct=94, msg="Saving separated audio and artwork")
                    from conversion_engine import get_cover
                    from app import embed_tags

                    cover = get_cover(metadata.get("cover_url", ""))
                    for tmp, target, stem in temporary:
                        try:
                            embed_tags(tmp, {**metadata, "title": f"{metadata.get('title', source.stem)} ({STEMS[stem]})"}, cover)
                        except Exception:
                            pass
                    if fingerprint(source, fmt, bitrate) != self.jobs[job_id]["key"]:
                        raise RuntimeError("This library track changed during separation. Please try again.")
                    for tmp, target, stem in temporary:
                        tmp.replace(target)
                    manifest = folder / f"{job_id}.json"
                    manifest.write_text(json.dumps({"fingerprint": self.jobs[job_id]["key"]}))
                    manifest.replace(folder / "ready.json")
                self._update(job_id, state="done", pct=100, msg="Vocals and instrumental are ready", cached=not needed)
        except Exception as exc:
            self._update(job_id, state="error", msg=str(exc) or "Stem separation failed.")
        finally:
            for tmp, target, stem in temporary:
                tmp.unlink(missing_ok=True)

    def close(self):
        if self.worker is not None and self.worker.is_alive():
            self.pending.put(None)
            self.worker.join(timeout=10)


STEM_SERVICE = StemService()
