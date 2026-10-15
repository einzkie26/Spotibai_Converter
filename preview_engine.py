"""Short library previews, shared by Flask and the Node library bridge."""
from __future__ import annotations

import hashlib
import json
import subprocess
import uuid
from pathlib import Path

from filelock import FileLock
from mutagen import File as MutagenFile

from conversion_engine import usable_audio


def preview_clip(source: Path, ffmpeg: Path) -> Path:
    stat = source.stat()
    signature = (stat.st_size, stat.st_mtime_ns)
    key = hashlib.sha256(json.dumps([
        str(source.resolve()), *signature, "mp3-128k-7s-offset30-v1",
    ]).encode()).hexdigest()[:32]
    folder = source.parent / ".preview-cache"
    folder.mkdir(exist_ok=True)
    target = folder / f"{key}.mp3"
    with FileLock(str(target) + ".lock", timeout=35):
        if usable_audio(target):
            return target
        audio = MutagenFile(source)
        duration = getattr(getattr(audio, "info", None), "length", 0)
        # Short tracks must not seek past the end of the file.
        start = 30 if duration >= 37 else 0
        temporary = folder / f".{key}.{uuid.uuid4().hex}.mp3"
        try:
            result = subprocess.run([
                str(ffmpeg), "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
                "-ss", str(start), "-i", str(source), "-t", "7", "-map", "0:a:0",
                "-vn", "-map_metadata", "-1", "-c:a", "libmp3lame", "-b:a", "128k",
                str(temporary),
            ], capture_output=True, check=False, timeout=30)
            if result.returncode != 0 or not usable_audio(temporary):
                raise RuntimeError("Preview generation failed. Try preparing the audio again.")
            latest = source.stat()
            if signature != (latest.st_size, latest.st_mtime_ns):
                raise RuntimeError("The track changed while preparing its preview. Please retry.")
            temporary.replace(target)
        finally:
            temporary.unlink(missing_ok=True)
    return target
