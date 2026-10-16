"""Shared, bounded conversion pipeline for the Flask and Node backends.

Spotify collections are read in bulk. Each worker owns a reusable spotDL
session, and FFmpeg filters run during the first encode. Completed audio and
metadata are cached separately; a cache hit never contacts an audio provider.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import fields
from functools import lru_cache
from pathlib import Path
from urllib.parse import urlparse

from filelock import FileLock
from mutagen import File as MutagenFile
from metadata_enrichment import METADATA_VERSION, enrich_playlist, metadata_complete

ENGINE_VERSION = 1
CACHE_DIR = Path(os.environ.get("CONVOTIFY_CACHE_DIR", Path(__file__).parent / ".cache" / "conversion"))
try:
    WORKERS = max(1, min(8, int(os.environ.get("CONVOTIFY_WORKERS", "4"))))
except ValueError:
    WORKERS = 4
NORMAL_FILTER = "highpass=f=40,loudnorm=I=-16:TP=-1.5:LRA=11"
_init_lock = threading.Lock()
_settings = None


@lru_cache(maxsize=1)
def _node_available() -> bool:
    node = shutil.which("node")
    if not node:
        return False
    try:
        version = subprocess.check_output([node, "--version"], text=True, timeout=5)
        return int(version.strip().lstrip("v").split(".")[0]) >= 22
    except (OSError, ValueError, subprocess.SubprocessError):
        return False


def canonical_url(url: str) -> str:
    parsed = urlparse(url.strip())
    match = re.fullmatch(r"/(?:intl-[^/]+/)?(album|playlist|track)/([A-Za-z0-9]+)/?", parsed.path)
    if parsed.scheme != "https" or parsed.hostname not in {"open.spotify.com", "spotify.com"} or not match:
        raise ValueError("Use a valid Spotify album, playlist or track link.")
    return f"https://open.spotify.com/{match[1]}/{match[2]}"


def _key(value) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()


def _atomic_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + f".{uuid.uuid4().hex}.tmp")
    try:
        temporary.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def _spotdl_settings():
    global _settings
    with _init_lock:
        if _settings is None:
            from spotdl.utils.config import create_settings
            from spotdl.utils.spotify import SpotifyClient

            spotify, downloader, _ = create_settings(argparse.Namespace(config=False))
            if SpotifyClient._instance is None:
                SpotifyClient.init(**spotify)
            _settings = downloader
        return dict(_settings)


def _fetch_metadata(url: str) -> list[dict]:
    _spotdl_settings()
    from spotdl.utils.search import get_simple_songs

    # parse_query/CLI save reinitializes every Song, even for a complete album.
    # get_simple_songs preserves the album's bulk metadata and track order.
    return [song.json for song in get_simple_songs([url])]


def _enrich_playlist(rows: list[dict], cache_dir: Path) -> list[dict]:
    local = threading.local()
    sessions = []
    sessions_lock = threading.Lock()

    def lookup(url):
        if not hasattr(local, "reader"):
            _spotdl_settings()
            from spotdl.utils.spotify import SpotifyClient
            from SpotipyFree import Spotify as FreeSpotify

            client = SpotifyClient()
            if isinstance(client, FreeSpotify):
                # Reuse a public SDK session per worker. The generic track()
                # wrapper creates/authenticates a new session on every call.
                from spotapi import Song
                from spotapi.http.request import TLSClient

                http = TLSClient("chrome120", "", auto_retries=1)
                http.timeout = 15
                reader = Song(client=http)
                local.reader = lambda link: reader.get_track_info(link.rsplit("/", 1)[-1])["data"]["trackUnion"]
                with sessions_lock:
                    sessions.append(http)
            else:
                local.reader = client.track
        return local.reader(url)

    try:
        return enrich_playlist(rows, cache_dir, lookup, workers=WORKERS)
    finally:
        for session in sessions:
            session.close()


def _valid_metadata(rows) -> bool:
    return isinstance(rows, list) and bool(rows) and all(
        isinstance(row, dict) and row.get("name") and row.get("url")
        and re.fullmatch(r"https://open\.spotify\.com/track/[A-Za-z0-9]+", row["url"])
        for row in rows
    )


def read_metadata(url: str, cache_dir: Path | None = None, *, enrich=True) -> tuple[list[dict], bool]:
    url = canonical_url(url)
    root = (cache_dir or CACHE_DIR) / "metadata"
    root.mkdir(parents=True, exist_ok=True)
    path = root / (_key([ENGINE_VERSION, url]) + ".json")
    ttl = 300 if "/playlist/" in url else 3600
    with FileLock(str(path) + ".lock", timeout=180):
        cached = None
        try:
            cached = json.loads(path.read_text(encoding="utf-8"))
            if 0 <= time.time() - cached["created"] < ttl and _valid_metadata(cached["songs"]):
                if not enrich or "/playlist/" not in url or (cached.get("metadata_version") == METADATA_VERSION and
                    (not cached.get("metadata_incomplete") or time.time() - cached.get("enriched_at", 0) < 60)):
                    return cached["songs"], True
            else:
                cached = None
        except (OSError, ValueError, KeyError, TypeError):
            cached = None
        songs = cached["songs"] if cached else _fetch_metadata(url)
        if not _valid_metadata(songs):
            raise RuntimeError("No tracks found. Check that the Spotify album or playlist is available.")
        if enrich and "/playlist/" in url:
            songs = _enrich_playlist(songs, cache_dir or CACHE_DIR)
        _atomic_json(path, {"created": cached["created"] if cached else time.time(), "songs": songs,
                            "metadata_version": METADATA_VERSION if enrich else 0, "enriched_at": time.time() if enrich else 0,
                            "metadata_incomplete": any(not metadata_complete(row) for row in songs)})
        return songs, False


def inspect_collection(url: str, cache_dir: Path | None = None) -> dict:
    """Verify the collection without per-track artwork lookups or audio work."""
    url = canonical_url(url)
    songs, _ = read_metadata(url, cache_dir, enrich=False)
    kind = url.split("/")[-2]
    first = songs[0]
    name = first.get("name") if kind == "track" else next(
        (song.get("list_name") for song in songs if song.get("list_name")), None)
    if not name and kind == "album":
        name = first.get("album_name")
    if not name:
        raise RuntimeError("The collection title could not be verified. Please try this link again.")
    return {"url": url, "type": kind, "name": name, "total": len(songs),
            "large_playlist": kind == "playlist" and len(songs) >= 200}


def usable_audio(path: Path) -> bool:
    try:
        audio = MutagenFile(str(path))
        return path.is_file() and audio is not None and audio.info.length > 0
    except Exception:
        return False


def get_cover(url: str, cache_dir: Path | None = None) -> bytes | None:
    if not url:
        return None
    root = (cache_dir or CACHE_DIR) / "covers"
    root.mkdir(parents=True, exist_ok=True)
    path = root / (_key(url) + ".image")
    try:
        with FileLock(str(path) + ".lock", timeout=15):
            if path.is_file() and time.time() - path.stat().st_mtime < 7 * 86400:
                return path.read_bytes()
            import requests

            response = requests.get(url, timeout=10)
            response.raise_for_status()
            data = response.content
            if not data or len(data) > 10 * 1024 * 1024:
                return None
            temporary = path.with_suffix(f".{uuid.uuid4().hex}.tmp")
            try:
                temporary.write_bytes(data)
                temporary.replace(path)
            finally:
                temporary.unlink(missing_ok=True)
            return data
    except Exception:
        return None


def _add_cover(path: Path, data: bytes | None) -> None:
    if not data:
        return
    from mutagen.id3 import APIC, ID3
    from mutagen.flac import FLAC, Picture
    from mutagen.mp4 import MP4, MP4Cover

    png = data.startswith(b"\x89PNG")
    mime = "image/png" if png else "image/jpeg"
    if path.suffix == ".mp3":
        tags = ID3(str(path))
        tags.delall("APIC")
        tags.add(APIC(encoding=3, mime=mime, type=3, desc="Cover", data=data))
        tags.save(str(path), v2_version=3)
    elif path.suffix == ".flac":
        audio = FLAC(str(path))
        picture = Picture()
        picture.type, picture.mime, picture.data = 3, mime, data
        audio.clear_pictures()
        audio.add_picture(picture)
        audio.save()
    elif path.suffix == ".m4a":
        audio = MP4(str(path))
        audio["covr"] = [MP4Cover(data, imageformat=MP4Cover.FORMAT_PNG if png else MP4Cover.FORMAT_JPEG)]
        audio.save()


def ffmpeg_arguments(fmt: str, audio_filter: str) -> str:
    # Explicit bitrate forces spotDL to run FFmpeg even for an m4a source.
    # The lossless codecs ignore/reset it here. One filter pass, one encode.
    extra = " -c:a alac -b:a 0" if fmt == "alac" else " -b:a 0" if fmt in {"wav", "flac"} else ""
    return f'-af "{audio_filter}" -ar 44100 -threads 1{extra}'


class DownloadSession:
    """One downloader/event loop per worker, reused for all its tracks."""

    def __init__(self, ffmpeg: str | Path, fmt: str, bitrate: str,
                 audio_filter: str = NORMAL_FILTER, cache_dir: Path | None = None):
        self.ffmpeg, self.fmt, self.bitrate = str(ffmpeg), fmt, bitrate
        self.audio_filter = audio_filter
        self.cache_dir = cache_dir or CACHE_DIR
        self.local = threading.local()
        self.downloaders = []
        self.lock = threading.Lock()

    def _downloader(self):
        downloader = getattr(self.local, "downloader", None)
        if downloader is None:
            from spotdl.download.downloader import Downloader

            options = _spotdl_settings()
            # yt-dlp enables Deno by default; explicitly use an existing Node 22+
            # runtime too, so YouTube challenges don't trigger avoidable failures.
            yt_args = options.get("yt_dlp_args") or ""
            if "--js-runtimes" not in yt_args and _node_available():
                yt_args += " --js-runtimes node"
            for flag, value in (("--socket-timeout", "20"), ("--retries", "2"), ("--extractor-retries", "1")):
                if flag not in yt_args:
                    yt_args += f" {flag} {value}"
            options.update({
                "format": "m4a" if self.fmt in {"aac", "alac"} else self.fmt,
                "bitrate": self.bitrate, "ffmpeg": self.ffmpeg,
                "ffmpeg_args": ffmpeg_arguments(self.fmt, self.audio_filter),
                "threads": 1, "lyrics_providers": [], "skip_album_art": True,
                "audio_providers": ["youtube-music", "youtube"],
                "overwrite": "force", "simple_tui": True, "print_errors": False,
                "fetch_albums": False, "scan_for_songs": False,
                "yt_dlp_args": yt_args.strip() or None,
            })
            downloader = Downloader(options)
            self.local.downloader = downloader
            with self.lock:
                self.downloaders.append(downloader)
        return downloader

    def _produce(self, item: dict, output_dir: Path) -> Path:
        from spotdl.types.song import Song

        data = dict(item.get("spotdl_data") or item)
        if item.get("retry_count"):
            data["download_url"] = None
        data.setdefault("url", item.get("source_url"))
        data.setdefault("name", item.get("title"))
        # The collection response has no genre list. An empty list is valid and
        # avoids spotDL fetching the same track from Spotify a second time.
        defaults = {"genres": [], "disc_number": 1, "disc_count": 1, "tracks_count": 1,
                    "track_number": 1, "album_id": "", "album_artist": data.get("artist", ""),
                    "isrc": "", "publisher": "", "date": ""}
        for key, value in defaults.items():
            if data.get(key) is None:
                data[key] = value
        song = Song.from_missing_data(**{field.name: data.get(field.name) for field in fields(Song)})
        downloader = self._downloader()
        downloader.settings["output"] = str(output_dir / "{artist} - {title}.{output-ext}")
        downloader.errors.clear()
        report = self.local.report
        handler = getattr(downloader, "progress_handler", None)
        if handler is not None:
            def progress(tracker, message):
                stages = {
                    "Searching for song": ("preparing", "Finding an audio source"),
                    "Getting audio meta": ("preparing", "Checking the audio source"),
                    "Downloading": ("downloading", "Downloading audio"),
                    "Converting": ("converting", "Encoding and normalizing audio"),
                    "Embedding metadata": ("finishing", "Writing track metadata"),
                    "Done": ("finishing", "Saving the completed audio"),
                }
                if message in stages:
                    state, text = stages[message]
                    report(state, text, getattr(tracker, "progress", 0))

            handler.update_callback = progress
        # A total per-track timeout also covers slow provider searches.
        async def retrieve():
            _, path = await downloader.async_search_and_download(song)
            # A provider can find a match whose audio is unavailable. Retry the
            # alternate search provider only on source failure, not tag/codec errors.
            if path is None and downloader.errors and any(
                marker in downloader.errors[-1] for marker in ("AudioProviderError", "LookupError")
            ) and len(downloader.audio_providers) > 1:
                providers = downloader.audio_providers
                try:
                    report("retrying", "Source unavailable; trying another source", 0)
                    downloader.audio_providers = providers[1:]
                    song.download_url = None
                    _, path = await downloader.async_search_and_download(song)
                finally:
                    downloader.audio_providers = providers
            return path

        path = downloader.loop.run_until_complete(asyncio.wait_for(retrieve(), timeout=600))
        if path is None or not usable_audio(Path(path)):
            message = downloader.errors[-1] if downloader.errors else "No usable audio file was produced for this track."
            raise RuntimeError(message[-500:])
        path = Path(path)
        report("finishing", "Adding artwork and saving audio", 97)
        try:
            _add_cover(path, get_cover(data.get("cover_url", ""), self.cache_dir))
        except Exception:
            pass  # Missing artwork must not discard valid audio.
        if self.fmt == "aac":
            # spotDL writes MP4 tags first; turn it into ADTS without re-encoding.
            target = path.with_suffix(".aac")
            result = subprocess.run([self.ffmpeg, "-v", "error", "-y", "-i", str(path),
                                     "-map", "0:a:0", "-c:a", "copy", "-f", "adts", str(target)],
                                    capture_output=True, timeout=60, check=False)
            if result.returncode or not usable_audio(target):
                raise RuntimeError("AAC packaging failed.")
            path.unlink()
            path = target
        return path

    def download(self, item: dict, output_dir: Path, on_progress=None) -> dict:
        previous = [None, None, 0.0]
        progress_lock = threading.Lock()

        def report(state, message, progress=0):
            if on_progress is None:
                return
            now = time.monotonic()
            with progress_lock:
                if previous[0] == state and previous[1] == message and now - previous[2] < 1:
                    return
                previous[:] = [state, message, now]
                on_progress({"state": state, "message": message,
                             "progress_pct": max(0, min(99, int(progress)))})

        self.local.report = report
        report("preparing", "Checking saved audio and track details")
        output_dir = Path(output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)
        data = item.get("spotdl_data") or item
        source = canonical_url(item.get("source_url") or data["url"])
        # Include metadata and processing options so quality/filter changes never
        # return an old encode. Provider download URLs are deliberately excluded.
        identity = {key: data.get(key) for key in ("name", "artist", "album_name", "track_number", "cover_url")}
        key = _key([ENGINE_VERSION, source, identity, self.fmt, self.bitrate, self.audio_filter])
        root = self.cache_dir / "audio"
        root.mkdir(parents=True, exist_ok=True)
        ext = ".m4a" if self.fmt == "alac" else f".{self.fmt}"
        cached = root / (key + ext)
        name = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", f"{data.get('artist') or item.get('artist') or 'Artist'} - {data.get('name') or item.get('title') or 'Track'}")
        target = output_dir / (name[:150].rstrip(". ") + ext)
        with FileLock(str(root / (key + ".lock")), timeout=660):
            if cached.exists() and time.time() - cached.stat().st_mtime < 7 * 86400 and usable_audio(cached):
                shutil.copy2(cached, target)
                os.utime(cached, None)
                report("finishing", "Reusing the completed audio", 99)
                return {"path": str(target), "cached": True}
            cached.unlink(missing_ok=True)
            # Work files stay hidden so a partial encode never appears complete.
            with tempfile.TemporaryDirectory(prefix=".download-", dir=output_dir) as folder:
                produced = self._produce(item, Path(folder))
                shutil.copy2(produced, target)
            temporary = root / (key + f".{uuid.uuid4().hex}.tmp")
            try:
                shutil.copy2(target, temporary)
                temporary.replace(cached)
            finally:
                temporary.unlink(missing_ok=True)
        self._prune_audio()
        return {"path": str(target), "cached": False}

    def _prune_audio(self):
        files = []
        for path in (self.cache_dir / "audio").iterdir():
            if path.suffix in {".mp3", ".m4a", ".aac", ".wav", ".flac"}:
                try:
                    files.append((path.stat().st_mtime, path.stat().st_size, path))
                except OSError:
                    pass
        total = sum(row[1] for row in files)
        for modified, size, path in sorted(files):
            if total <= 512 * 1024 * 1024 and time.time() - modified < 7 * 86400:
                break
            try:
                # Never evict an entry another worker is currently copying.
                with FileLock(str(path.with_suffix(".lock")), timeout=0):
                    path.unlink(missing_ok=True)
                    total -= size
            except Exception:
                pass

    def close(self):
        for downloader in self.downloaders:
            loop = downloader.loop
            if not loop.is_closed():
                loop.run_until_complete(loop.shutdown_asyncgens())
                loop.run_until_complete(loop.shutdown_default_executor())
                loop.close()


def serve(ffmpeg: str, fmt: str, bitrate: str, audio_filter: str):
    """JSON-lines bridge: keep one Python process and four sessions per Node job."""
    output = sys.stdout
    sys.stdout = sys.stderr
    lock = threading.Lock()
    session = DownloadSession(ffmpeg, fmt, bitrate, audio_filter)

    def emit(event):
        with lock:
            output.write(json.dumps(event, ensure_ascii=False) + "\n")
            output.flush()

    def handle(request):
        try:
            result = session.download(request["track"], Path(request["output_dir"]),
                                      on_progress=lambda progress: emit({"type": "progress", "index": request["index"], **progress}))
            if request.get("save_library"):
                try:
                    from app import library_save

                    library_save(request["track"], Path(result["path"]), fmt, bitrate)
                except Exception as exc:
                    result["library_error"] = str(exc)
            event = {"type": "result", "index": request["index"], "success": True, **result}
        except Exception as exc:
            event = {"type": "result", "index": request["index"], "success": False, "error": str(exc)}
        emit(event)

    try:
        with ThreadPoolExecutor(max_workers=WORKERS) as pool:
            futures = []
            for line in sys.stdin:
                futures.append(pool.submit(handle, json.loads(line)))
            for future in futures:
                future.result()
    finally:
        session.close()


def main():
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    save = sub.add_parser("save")
    save.add_argument("url")
    save.add_argument("--save-file", required=True)
    worker = sub.add_parser("serve")
    worker.add_argument("--ffmpeg", required=True)
    worker.add_argument("--format", required=True, choices=["mp3", "wav", "flac", "aac", "alac"])
    worker.add_argument("--bitrate", default="160k")
    worker.add_argument("--filter", default=NORMAL_FILTER)
    args = parser.parse_args()
    logging.basicConfig(level=logging.ERROR, stream=sys.stderr)
    try:
        if args.command == "save":
            started = time.perf_counter()
            songs, cached = read_metadata(args.url)
            _atomic_json(Path(args.save_file), songs)
            print(json.dumps({"tracks": len(songs), "cached": cached,
                              "seconds": round(time.perf_counter() - started, 3)}))
        else:
            serve(args.ffmpeg, args.format, args.bitrate, args.filter)
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1) from exc


if __name__ == "__main__":
    main()
