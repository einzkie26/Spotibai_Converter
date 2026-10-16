from __future__ import annotations

import json
import hashlib
import os
import queue
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unicodedata
import uuid
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import closing
from pathlib import Path
from urllib.parse import quote, urlparse

import psutil
from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request, send_file, stream_with_context
from conversion_engine import DownloadSession, WORKERS, get_cover, inspect_collection
from preview_engine import preview_clip
from stem_engine import STEM_SERVICE, ready_stem
from stem_readiness import READINESS
from library_cache import clear_generated_audio
from filelock import FileLock, Timeout as FileLockTimeout

load_dotenv()
from mutagen.id3 import ID3, APIC, TIT2, TPE1, TALB, TRCK, ID3NoHeaderError
from mutagen import File as MutagenFile
from mutagen.flac import FLAC, Picture
from mutagen.mp4 import MP4, MP4Cover

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 16 * 1024

LIBRARY_DIR = Path(os.environ.get("CONVOTIFY_LIBRARY_DIR", Path(__file__).parent / "library"))
LIBRARY_DIR.mkdir(exist_ok=True)
LIBRARY_DB  = LIBRARY_DIR / "library.db"
JOBS_DIR    = Path(os.environ.get("CONVOTIFY_JOBS_DIR", "jobs"))
JOBS_DIR.mkdir(exist_ok=True)


def _db() -> sqlite3.Connection:
    con = sqlite3.connect(str(LIBRARY_DB), timeout=30)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys=ON")
    con.execute("""
        CREATE TABLE IF NOT EXISTS tracks (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            title     TEXT NOT NULL,
            artist    TEXT NOT NULL,
            album     TEXT NOT NULL,
            cover_url TEXT,
            format    TEXT,
            bitrate   TEXT,
            filename  TEXT NOT NULL UNIQUE,
            added_at  TEXT NOT NULL DEFAULT (datetime('now'))
        )
    """)
    if "source_url" not in {row[1] for row in con.execute("PRAGMA table_info(tracks)")}:
        # Old libraries remain readable; collection membership is recorded on the next conversion.
        try:
            con.execute("ALTER TABLE tracks ADD COLUMN source_url TEXT NOT NULL DEFAULT ''")
        except sqlite3.OperationalError:
            if "source_url" not in {row[1] for row in con.execute("PRAGMA table_info(tracks)")}:
                con.close()
                raise
    con.executescript("""
        CREATE INDEX IF NOT EXISTS tracks_source ON tracks(source_url, format);
        CREATE TABLE IF NOT EXISTS collections (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            url TEXT NOT NULL UNIQUE, name TEXT NOT NULL, kind TEXT NOT NULL,
            cover_url TEXT NOT NULL DEFAULT '', expected_total INTEGER NOT NULL DEFAULT 0,
            revision TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS collection_tracks (
            collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
            track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
            position INTEGER NOT NULL,
            PRIMARY KEY(collection_id, position)
        );
        CREATE INDEX IF NOT EXISTS collection_track_id ON collection_tracks(track_id);
    """)
    if "revision" not in {row[1] for row in con.execute("PRAGMA table_info(collections)")}:
        try:
            con.execute("ALTER TABLE collections ADD COLUMN revision TEXT NOT NULL DEFAULT ''")
        except sqlite3.OperationalError:
            if "revision" not in {row[1] for row in con.execute("PRAGMA table_info(collections)")}:
                con.close()
                raise
    con.commit()
    return con


def library_save(meta: dict, audio_src: Path, fmt: str, bitrate: str) -> None:
    """Copy a converted track into the library folder and record it in the DB."""
    if not meta.get("title") or not meta.get("artist"):
        return
    source_url = meta.get("source_url") or (meta.get("spotdl_data") or {}).get("url") or ""
    stem = re.sub(r'[\\/:*?"<>|\x00-\x1f]', '_', f"{meta['artist']} - {meta['title']}").strip(" .")
    stem = stem.encode("utf-8")[:160].decode("utf-8", errors="ignore") or "Track"
    with FileLock(str(LIBRARY_DIR / ".library-write.lock")), closing(_db()) as con, con:
        existing = con.execute("SELECT * FROM tracks WHERE source_url=? AND format=? LIMIT 1",
                               (source_url, fmt.upper())).fetchone() if source_url else None
        safe = existing["filename"] if existing else stem + audio_src.suffix
        collision = con.execute("SELECT * FROM tracks WHERE filename=?", (safe,)).fetchone()
        if collision and (collision["format"] != fmt.upper() or source_url and collision["source_url"] != source_url):
            legacy_match = not collision["source_url"] and all(
                collision[key] == meta.get(key, "") for key in ("title", "artist", "album")) and collision["format"] == fmt.upper()
            if not legacy_match:
                suffix = hashlib.sha256(f"{source_url}:{fmt.upper()}".encode()).hexdigest()[:12]
                safe = f"{stem} [{suffix}]{audio_src.suffix}"
        dest = LIBRARY_DIR / safe
        temporary = dest.with_name(f".{dest.name}.{uuid.uuid4().hex}.tmp")
        try:
            shutil.copy2(audio_src, temporary)
            temporary.replace(dest)
        finally:
            temporary.unlink(missing_ok=True)
        con.execute("""
            INSERT INTO tracks (title, artist, album, cover_url, format, bitrate, filename, source_url)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(filename) DO UPDATE SET
                title=excluded.title, artist=excluded.artist, album=excluded.album,
                cover_url=excluded.cover_url, format=excluded.format, bitrate=excluded.bitrate,
                source_url=CASE WHEN excluded.source_url='' THEN tracks.source_url ELSE excluded.source_url END
        """, (meta["title"], meta["artist"], meta.get("album", ""),
               meta.get("cover_url", ""), fmt.upper(), bitrate, safe, source_url))
        collection_url = meta.get("collection_url", "")
        if (is_spotify_url(collection_url) and spotify_link_type(collection_url) in ("album", "playlist")
                and meta.get("collection_name")):
            revision = meta.get("collection_revision", "")
            previous = con.execute("SELECT id,revision FROM collections WHERE url=?",
                                   (canonical_spotify_url(collection_url),)).fetchone()
            if previous and revision and previous["revision"] != revision:
                con.execute("DELETE FROM collection_tracks WHERE collection_id=?", (previous["id"],))
            con.execute("""
                INSERT INTO collections(url,name,kind,cover_url,expected_total,revision) VALUES(?,?,?,?,?,?)
                ON CONFLICT(url) DO UPDATE SET name=excluded.name, cover_url=excluded.cover_url,
                    expected_total=excluded.expected_total, revision=excluded.revision, updated_at=datetime('now')
            """, (canonical_spotify_url(collection_url), meta["collection_name"], spotify_link_type(collection_url),
                   meta.get("cover_url", ""), int(meta.get("collection_total") or 0), revision))
            con.execute("""
                INSERT INTO collection_tracks(collection_id,track_id,position)
                SELECT c.id,t.id,? FROM collections c,tracks t WHERE c.url=? AND t.filename=?
                ON CONFLICT(collection_id,position) DO UPDATE SET track_id=excluded.track_id
            """, (int(meta.get("collection_position") or meta.get("track_number") or 1),
                   canonical_spotify_url(collection_url), safe))

SPOTIFY_HOSTS = {"open.spotify.com", "spotify.com"}
SPOTIFY_PATH = re.compile(r"^/(?:intl-[^/]+/)?(?:playlist|album|track)/[A-Za-z0-9]+/?$")
JOBS: dict[str, dict] = {}
JOBS_LOCK = threading.Lock()
CONVERSION_QUEUE = queue.Queue()
QUEUE_LOCK = threading.Lock()
QUEUE_WORKER = None
FORMATS = {"mp3", "wav", "aac", "flac", "alac"}
BITRATES = {"96": "96k", "160": "160k", "320": "320k"}
STEM_CHOICES = {"vocals", "instrumental"}
AUDIO_EXTS = {".mp3", ".wav", ".aac", ".flac", ".m4a"}


#helpers

def is_spotify_url(value: str) -> bool:
    try:
        p = urlparse(value.strip())
    except ValueError:
        return False
    return p.scheme == "https" and p.netloc.lower() in SPOTIFY_HOSTS and bool(SPOTIFY_PATH.fullmatch(p.path))


def spotify_link_type(value: str) -> str:
    m = re.search(r"/(playlist|album|track)/[A-Za-z0-9]+/?$", urlparse(value.strip()).path)
    return m.group(1) if m else ""


def canonical_spotify_url(value: str) -> str:
    parts = urlparse(value.strip()).path.rstrip("/").split("/")
    return f"https://open.spotify.com/{parts[-2]}/{parts[-1]}"


def track_key(value: str) -> str:
    #normalize unicode (é→e, ñ→n, etc.) before stripping non-alphanum
    nfkd = unicodedata.normalize("NFKD", value)
    ascii_str = nfkd.encode("ascii", "ignore").decode("ascii")
    return re.sub(r"[^a-z0-9]", "", ascii_str.lower())


def find_audio_files(folder: Path) -> list[Path]:
    return sorted(
        p for p in folder.rglob("*")
        if p.is_file() and p.suffix.lower() in AUDIO_EXTS
        and "(Vocals)" not in p.stem and "(Instrumental)" not in p.stem
        and not p.stem.endswith((".norm", ".encode"))
        and not any(part.startswith(".") for part in p.relative_to(folder).parts[:-1])
    )


def display_size(n: int | None) -> str:
    if n is None:
        return "Pending"
    return f"{n / (1024*1024):.1f} MB" if n >= 1024 * 1024 else f"{n / 1024:.1f} KB"


def remove_tree(path: Path) -> None:
    shutil.rmtree(path, ignore_errors=True)


def find_ffmpeg() -> Path | None:
    exe = shutil.which("ffmpeg")
    if exe:
        return Path(exe)
    bundled = Path(sys.executable).with_name("ffmpeg.exe" if os.name == "nt" else "ffmpeg")
    if bundled.is_file():
        return bundled
    try:
        from imageio_ffmpeg import get_ffmpeg_exe
        bundled = Path(get_ffmpeg_exe())
        if bundled.is_file():
            return bundled
    except (ImportError, RuntimeError):
        pass
    local = os.environ.get("LOCALAPPDATA")
    if local:
        for m in Path(local).glob("Microsoft/WinGet/Packages/Gyan.FFmpeg.Shared*/*/bin/ffmpeg.exe"):
            if m.is_file():
                return m
    return None


def update_job(job_id: str, *, persist=True, **kw) -> None:
    with JOBS_LOCK:
        JOBS[job_id].update(kw)
        if persist:
            _persist_job(job_id)


def _persist_job(job_id: str) -> None:
    """Write serialisable job fields to disk so they survive a server restart."""
    job = JOBS.get(job_id, {})
    data = {
        "job_id":    job_id,
        "state":     job.get("state", "converting"),
        "format":    job.get("format", "mp3"),
        "bitrate":   job.get("bitrate", "160"),
        "link_type": job.get("link_type", ""),
        "urls":      job.get("urls", []),
        "total":     job.get("total", 0),
        "completed": job.get("completed", 0),
        "tracks":    job.get("tracks", []),
        "archive_name": job.get("archive_name", ""),
        "metadata": job.get("metadata", []),
        "name": job.get("name", ""),
        "batch_id": job.get("batch_id", ""),
        "batch_position": job.get("batch_position", 0),
        "timings": job.get("timings", {}),
        "error": job.get("error", ""),
        "archive_path": str(job["archive_path"]) if job.get("archive_path") else None,
        "file_path": str(job["file_path"]) if job.get("file_path") else None,
        "track_names": job.get("track_names", []),
        "cancelled": list(job.get("cancelled", set())),
        "job_dir":   str(job["job_dir"]) if job.get("job_dir") else None,
    }
    try:
        (JOBS_DIR / f"{job_id}.json").write_text(json.dumps(data), encoding="utf-8")
    except Exception:
        pass


def _load_persisted_jobs() -> None:
    """On startup, reload jobs that were still running when the server stopped."""
    for p in JOBS_DIR.glob("*.json"):
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            continue
        job_id  = data.get("job_id", p.stem)
        state   = data.get("state", "")
        job_dir = Path(data["job_dir"]) if data.get("job_dir") else None
        #only resurrect jobs that were mid-flight and whose temp dir still exists
        recoverable = any(track.get("state") == "error" for track in data.get("tracks", [])) and data.get("metadata")
        if state in ("complete", "error") and not recoverable:
            p.unlink(missing_ok=True)
            continue
        if (job_dir is None or not job_dir.exists()) and state != "queued":
            p.unlink(missing_ok=True)
            continue
        with JOBS_LOCK:
            JOBS[job_id] = {
                "state":     state if state in ("complete", "error") else "interrupted",
                "format":    data.get("format", "mp3"),
                "bitrate":   data.get("bitrate", "160"),
                "link_type": data.get("link_type", ""),
                "urls":      data.get("urls", []),
                "total":     data.get("total", 0),
                "completed": data.get("completed", 0),
                "tracks":    data.get("tracks", []),
                "archive_name": data.get("archive_name", ""),
                "cancelled": set(data.get("cancelled", [])),
                "job_dir":   job_dir,
                "output_dir": job_dir / "tracks" if job_dir else None,
                "metadata": data.get("metadata", []),
                "name": data.get("name", ""),
                "batch_id": data.get("batch_id", ""),
                "batch_position": data.get("batch_position", 0),
                "timings": data.get("timings", {}),
                "error": data.get("error", ""),
                "archive_path": Path(data["archive_path"]) if data.get("archive_path") else None,
                "track_names": data.get("track_names", []),
            }
            if data.get("file_path"):
                JOBS[job_id]["file_path"] = Path(data["file_path"])


#cover art download

def fetch_cover(url: str, cache: dict[str, bytes]) -> bytes | None:
    if not url:
        return None
    if url in cache:
        return cache[url]
    data = get_cover(url)
    if data:
        cache[url] = data
    return data


#tag embedding with mutagen

def embed_tags(audio_file: Path, meta: dict, cover_data: bytes | None) -> None:
    ext = audio_file.suffix.lower()
    title  = meta.get("title", "")
    artist = meta.get("artist", "")
    album  = meta.get("album", "")
    track  = str(meta.get("track_number", 0))

    if ext == ".mp3":
        try:
            tags = ID3(str(audio_file))
        except ID3NoHeaderError:
            # file has no ID3 header — create one and save it first
            tags = ID3()
            tags.save(str(audio_file), v2_version=3)
            tags = ID3(str(audio_file))
        tags["TIT2"] = TIT2(encoding=3, text=title)
        tags["TPE1"] = TPE1(encoding=3, text=artist)
        tags["TALB"] = TALB(encoding=3, text=album)
        tags["TRCK"] = TRCK(encoding=3, text=track)
        if cover_data:
            tags.delall("APIC")
            tags["APIC"] = APIC(
                encoding=3, mime="image/png" if cover_data.startswith(b"\x89PNG") else "image/jpeg", type=3,
                desc="Cover", data=cover_data,
            )
        tags.save(str(audio_file), v2_version=3)

    elif ext == ".flac":
        f = FLAC(str(audio_file))
        f["title"]  = title
        f["artist"] = artist
        f["album"]  = album
        f["tracknumber"] = track
        if cover_data:
            f.clear_pictures()
            pic = Picture()
            pic.type = 3
            pic.mime = "image/png" if cover_data.startswith(b"\x89PNG") else "image/jpeg"
            pic.data = cover_data
            f.add_picture(pic)
        f.save()

    elif ext in {".m4a", ".aac"}:
        f = MP4(str(audio_file))
        f["\xa9nam"] = title
        f["\xa9ART"] = artist
        f["\xa9alb"] = album
        f["trkn"]    = [(int(track) if track.isdigit() else 0, 0)]
        if cover_data:
            f["covr"] = [MP4Cover(cover_data, imageformat=MP4Cover.FORMAT_PNG if cover_data.startswith(b"\x89PNG") else MP4Cover.FORMAT_JPEG)]
        f.save()


#Spotify metadata

def process_error(result, fallback: str) -> str:
    lines = (result.stderr or result.stdout or "").strip().splitlines()
    return lines[-1][:240] if lines else fallback


def archive_filename(metadata: list[dict], link_type: str) -> str:
    names = list(dict.fromkeys(item["collection_name"].strip() for item in metadata
                               if item.get("collection_name", "").strip()))
    title = " + ".join(names) or f"Spotify {link_type if link_type in ('album', 'playlist') else 'collection'}"
    title = re.sub(r'[<>:"/\\|?*\x00-\x1f\x7f]', "_", title).strip(" .")
    # Leave room for the extension on Windows and for UTF-8 filenames elsewhere.
    title = title[:150].encode("utf-8")[:180].decode("utf-8", errors="ignore").rstrip(" .")
    if re.match(r"^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)", title, re.I):
        title = "_" + title
    return (title or "Spotify collection") + ".zip"


def load_metadata(playlist_url: str, save_path=None, env=None, on_item=None, on_track=None) -> list[dict]:
    """Read bulk metadata and publish each track as soon as it is parsed."""
    if save_path is None:
        with tempfile.TemporaryDirectory(prefix="convotify-metadata-") as folder:
            return load_metadata(playlist_url, Path(folder) / "metadata.spotdl", env, on_item, on_track)

    save_path = Path(save_path)
    save_path.unlink(missing_ok=True)
    try:
        result = subprocess.run(
            [sys.executable, str(Path(__file__).with_name("conversion_engine.py")),
             "save", canonical_spotify_url(playlist_url), "--save-file", str(save_path)],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            check=False, env=env, timeout=180,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("Reading Spotify tracks timed out. Please try the album link again.") from exc
    if result.returncode != 0:
        raise RuntimeError(process_error(result, "Could not read tracks from Spotify."))
    try:
        raw = json.loads(save_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise RuntimeError("Spotify track metadata could not be read. Please try again.") from exc
    if not isinstance(raw, list) or not raw:
        raise RuntimeError("No tracks found. Check that the Spotify album or playlist is available.")

    collection_revision = hashlib.sha256(json.dumps([item.get("url") for item in raw if isinstance(item, dict)],
                                                   separators=(",", ":")).encode()).hexdigest()
    metadata = []
    for i, item in enumerate(raw, 1):
        if not isinstance(item, dict):
            raise RuntimeError("Spotify returned incomplete track metadata. Please try again.")
        source_url = item.get("url") or (playlist_url if spotify_link_type(playlist_url) == "track" else "")
        if not is_spotify_url(source_url) or spotify_link_type(source_url) != "track":
            raise RuntimeError("Spotify returned a track without a download link. Please try again.")
        track = {
            "title": item.get("name") or item.get("title") or "Unknown Title",
            "artist": item.get("artist") or ", ".join(item.get("artists") or []) or "Unknown Artist",
            "album": item.get("album_name") or item.get("album") or "Unknown Album",
            "collection_name": item.get("list_name") or
                               ((item.get("album_name") or item.get("album"))
                                if spotify_link_type(playlist_url) == "album" else "") or "",
            "cover_url": item.get("cover_url") or "",
            "source_url": canonical_spotify_url(source_url),
            "collection_url": canonical_spotify_url(playlist_url) if spotify_link_type(playlist_url) in ("album", "playlist") else "",
            "collection_kind": spotify_link_type(playlist_url),
            "collection_position": i,
            "collection_total": len(raw),
            "collection_revision": collection_revision,
            "track_number": item.get("track_number") or i,
            "spotdl_data": item,
        }
        metadata.append(track)
        if on_track:
            on_track(track, i, len(raw))
        if on_item:
            on_item(i, len(raw), f"Discovered {track['artist']} - {track['title']}")
    return metadata


def find_track_audio(item: dict, output_dir: Path) -> Path | None:
    """Use a track's own folder so concurrent downloads cannot be mixed up."""
    if item.get("output_subdir"):
        return next(iter(find_audio_files(output_dir / item["output_subdir"])), None)
    ek = track_key(f"{item.get('artist', '')} {item.get('title', '')}")
    return next((p for p in find_audio_files(output_dir)
                 if ek and (ek in track_key(p.stem) or track_key(p.stem) in ek)), None)


#track status builder

def track_statuses(metadata: list[dict], output_dir: Path, active: set[int],
                   cancelled: set[int], fmt: str, bitrate: str,
                   track_start_times: dict[int, float] | None = None,
                   errors: dict[int, str] | None = None,
                   phases: dict[int, dict] | None = None) -> list[dict]:
    now = time.monotonic()
    out = []
    for i, item in enumerate(metadata):
        found = find_track_audio(item, output_dir)
        if i in cancelled:
            state = "cancelled"
        elif errors and i in errors:
            state = "error"
        elif i in active:
            state = (phases or {}).get(i, {}).get("state", "preparing")
        elif (phases or {}).get(i, {}).get("state") == "pending":
            state = "pending"
        elif found:
            state = "converted"
        else:
            state = "pending"
        elapsed_s = round(now - track_start_times[i], 1) if (track_start_times and i in track_start_times) else None
        try:
            size = found.stat().st_size if found else None
        except OSError:
            size = None
        out.append({
            "title":        item["title"],
            "artist":       item["artist"],
            "album":        item["album"],
            "cover_url":    item["cover_url"],
            "track_number": item.get("track_number", i + 1),
            "format":       fmt.upper(),
            "quality":      bitrate.replace("k", " kbps"),
            "size":         display_size(size),
            "state":        state,
            "elapsed_s":    elapsed_s,
            "output_subdir": item.get("output_subdir", ""),
            "error":        errors.get(i, "") if errors else "",
            "cached":       bool(item.get("cached")),
            "retry_count":  item.get("retry_count", 0),
            "message":      "Ready to download" if state == "converted" else
                            "Track skipped" if state == "cancelled" else
                            errors.get(i, "") if state == "error" and errors else
                            (phases or {}).get(i, {}).get("message", ""),
            "progress_pct": 100 if state == "converted" else (phases or {}).get(i, {}).get("progress_pct", 0),
        })
    return out


#per-track download worker

def download_track(item: dict, output_dir: Path, session: DownloadSession, on_progress=None) -> tuple[bool, str]:
    """Reuse the worker session and validate the finished audio before display."""
    try:
        result = session.download(item, output_dir, on_progress=on_progress)
        audio = MutagenFile(result["path"])
        if audio is None or audio.info.length <= 0:
            raise RuntimeError("No usable audio file was produced for this track.")
        item["cached"] = result.get("cached", False)
        return True, ""
    except Exception as exc:
        return False, str(exc) or "Track download failed."


#main conversion job

def convert_job(job_id: str, playlist_urls: list[str] | str, ffmpeg: Path,
                output_format: str, bitrate: str, link_type: str, retry_indices=None) -> None:
    started = time.perf_counter()
    if isinstance(playlist_urls, str):
        playlist_urls = [playlist_urls]

    with JOBS_LOCK:
        existing_dir = JOBS[job_id].get("job_dir")
    if existing_dir and Path(existing_dir).exists():
        job_dir = Path(existing_dir)
        output_dir = job_dir / "tracks"
        output_dir.mkdir(exist_ok=True)
    else:
        job_dir    = Path(tempfile.mkdtemp(prefix="convotify-"))
        output_dir = job_dir / "tracks"
        output_dir.mkdir()
    env = os.environ.copy()
    env["PATH"] = f"{ffmpeg.parent}{os.pathsep}{env.get('PATH', '')}"
    env["SPOTIBAI_FFMPEG"] = str(ffmpeg)

    update_job(job_id, job_dir=job_dir, output_dir=output_dir)

    try:
        retrying = retry_indices is not None
        old_job = JOBS[job_id]
        metadata = old_job.get("metadata", []) if retrying else []
        metadata_errors = old_job.get("metadata_errors", []) if retrying else []
        update_job(job_id, state="processing" if retrying else "metadata", error="",
                   meta_log="" if retrying else "Reading Spotify metadata...",
                   meta_count=len(metadata), meta_total=len(metadata), metadata_loading=not retrying,
                   metadata_errors=metadata_errors)
        active: set[int] = set()
        errors = {i: track.get("error") or "Track failed." for i, track in enumerate(old_job.get("tracks", []))
                  if retrying and track.get("state") == "error"}
        phases: dict[int, dict] = {}
        start_times: dict[int, float] = {}
        cover_cache: dict[str, bytes] = {}
        progress_lock = threading.RLock()
        session = DownloadSession(ffmpeg, output_format, bitrate)

        def refresh_tracks(persist=True):
            with progress_lock:
                with JOBS_LOCK:
                    cancelled = set(JOBS[job_id]["cancelled"])
                statuses = track_statuses(metadata, output_dir, active, cancelled,
                                          output_format, bitrate, start_times, errors, phases)
                update_job(job_id, persist=persist, tracks=statuses,
                           completed=sum(t["state"] == "converted" for t in statuses),
                           cached_tracks=sum(bool(item.get("cached")) for item in metadata))
                return statuses

        def convert_one(index: int, item: dict):
            with progress_lock:
                with JOBS_LOCK:
                    cancelled = index in JOBS[job_id]["cancelled"]
                if cancelled:
                    refresh_tracks()
                    return
                errors.pop(index, None)
                active.add(index)
                start_times[index] = time.monotonic()
                phases[index] = {"state": "preparing", "message": "Preparing this track again" if item.get("retry_count")
                                 else "Preparing this track", "progress_pct": 0}
                refresh_tracks()

            def on_progress(progress):
                with progress_lock:
                    phases[index] = progress
                    refresh_tracks(persist=False)

            try:
                track_dir = output_dir / item["output_subdir"]
                track_dir.mkdir(exist_ok=True)
                ok, error = download_track(item, track_dir, session, on_progress)
                if not ok:
                    raise RuntimeError(error)
                audio = find_track_audio(item, output_dir)
                on_progress({"state": "finishing", "message": "Saving track metadata and library copy", "progress_pct": 99})
                cover = fetch_cover(item.get("cover_url", ""), cover_cache)
                try:
                    embed_tags(audio, item, cover)
                    tagged = MutagenFile(str(audio))
                    if tagged is not None and tagged.info.length > 0:
                        library_save(item, audio, output_format, bitrate)
                except Exception:
                    pass
            except Exception as exc:
                with progress_lock:
                    errors[index] = str(exc)
            finally:
                with progress_lock:
                    active.discard(index)
                    refresh_tracks()

        conversion_started = None
        try:
            with ThreadPoolExecutor(max_workers=WORKERS) as pool:
                futures = []
                if retrying:
                    for index in retry_indices:
                        metadata[index]["retry_count"] = metadata[index].get("retry_count", 0) + 1
                        errors.pop(index, None)
                        phases[index] = {"state": "pending", "message": "Waiting for manual retry", "progress_pct": 0}
                    refresh_tracks()
                    conversion_started = time.perf_counter()
                    futures = [pool.submit(convert_one, index, metadata[index]) for index in retry_indices]
                for url_index, url in enumerate([] if retrying else playlist_urls):
                    offset = len(metadata)

                    def on_track(track, count, total):
                        nonlocal conversion_started
                        with progress_lock:
                            index = len(metadata)
                            track["output_subdir"] = f"{index + 1:04d}"
                            metadata.append(track)
                            update_job(job_id, state="processing", metadata=list(metadata),
                                       name=track.get("collection_name") or JOBS[job_id].get("name") or track["title"],
                                       total=offset + total, meta_count=offset + count,
                                       meta_total=offset + total, meta_log="")
                            refresh_tracks()
                        if conversion_started is None:
                            conversion_started = time.perf_counter()
                        futures.append(pool.submit(convert_one, index, track))

                    try:
                        load_metadata(url, job_dir / f"metadata-{url_index}.spotdl", env, on_track=on_track)
                    except Exception as exc:
                        metadata_errors.append({"url": url, "error": str(exc)})
                        update_job(job_id, metadata_errors=list(metadata_errors))
                if not metadata:
                    raise RuntimeError(metadata_errors[0]["error"] if metadata_errors else
                                       "No tracks found in the Spotify album or playlist.")
                metadata_seconds = time.perf_counter() - started
                update_job(job_id, metadata_loading=False, total=len(metadata),
                           meta_count=len(metadata), meta_total=len(metadata),
                           archive_name=archive_filename(metadata, link_type))
                for future in as_completed(futures):
                    future.result()

        finally:
            session.close()
        timings = {"metadata_s": round(metadata_seconds, 3),
                   "conversion_s": round(time.perf_counter() - conversion_started, 3),
                   "overlapped": True}
        packaging_started = time.perf_counter()
        
        final_statuses = refresh_tracks()
        tracks = [find_track_audio(item, output_dir) for item, status in zip(metadata, final_statuses)
                  if status["state"] == "converted"]
        if not tracks:
            msg = next(iter(errors.values()), "All tracks were skipped.")
            raise RuntimeError(msg)

        completed = sum(t["state"] == "converted" for t in final_statuses)
        track_names = [t.relative_to(output_dir).as_posix() for t in tracks]

        if link_type == "track" and len(metadata) == 1:
            update_job(job_id, state="complete", file_path=tracks[0],
                       track_names=track_names, tracks=final_statuses,
                       completed=1, total=1,
                       timings={**timings, "packaging_s": 0,
                                "total_s": round(time.perf_counter() - started, 3)})
            (JOBS_DIR / f"{job_id}.json").unlink(missing_ok=True)
            return

        update_job(job_id, state="packaging", tracks=final_statuses, completed=completed)
        archive_folder = job_dir / f"archive-{uuid.uuid4().hex[:8]}"
        archive_folder.mkdir()
        archive_path = archive_folder / archive_filename(metadata, link_type)
        with zipfile.ZipFile(archive_path, "w", zipfile.ZIP_STORED) as zf:
            for t in tracks:
                zf.write(t, arcname=t.relative_to(output_dir))

        update_job(job_id, state="complete", archive_path=archive_path,
                   tracks=final_statuses, track_names=track_names, completed=completed,
                   timings={**timings, "packaging_s": round(time.perf_counter() - packaging_started, 3),
                            "total_s": round(time.perf_counter() - started, 3)})
        if not any(track["state"] == "error" for track in final_statuses):
            (JOBS_DIR / f"{job_id}.json").unlink(missing_ok=True)

    except Exception as exc:
        if not JOBS[job_id].get("metadata"):
            remove_tree(job_dir)
        update_job(job_id, state="error", error=str(exc), metadata_loading=False)


def _conversion_dispatch():
    while True:
        entry = CONVERSION_QUEUE.get()
        if entry is None:
            CONVERSION_QUEUE.task_done()
            return
        job_id, ffmpeg, retry_indices = entry
        try:
            with JOBS_LOCK:
                job = JOBS.get(job_id)
            if job is not None:
                convert_job(job_id, job["urls"], ffmpeg, job["format"],
                            BITRATES[job["bitrate"]], job["link_type"], retry_indices)
        except Exception as exc:
            update_job(job_id, state="error", error=str(exc), metadata_loading=False)
        finally:
            CONVERSION_QUEUE.task_done()


def enqueue_conversions(entries):
    global QUEUE_WORKER
    with QUEUE_LOCK:
        for entry in entries:
            CONVERSION_QUEUE.put(entry)
        if QUEUE_WORKER is None or not QUEUE_WORKER.is_alive():
            QUEUE_WORKER = threading.Thread(target=_conversion_dispatch, name="conversion-queue", daemon=True)
            QUEUE_WORKER.start()


@app.post("/collections/preview")
def collection_preview():
    url = (request.get_json(silent=True) or {}).get("url", "")
    if not isinstance(url, str) or not is_spotify_url(url):
        return jsonify({"error": "Paste a valid Spotify playlist, album, or track link."}), 400
    try:
        return jsonify(inspect_collection(url))
    except Exception as exc:
        return jsonify({"error": f"Could not verify this link: {exc}"}), 502


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/net-stats")
def net_stats():
    try:
        counters = psutil.net_io_counters()
        if counters is None:
            raise RuntimeError("No network counters are available.")
        response = jsonify({
            "bytes_sent": counters.bytes_sent, "bytes_recv": counters.bytes_recv,
            "packet_loss": counters.dropin + counters.dropout,
            "buffer_overflow": counters.errin + counters.errout,
            "sampled_at": time.monotonic(), "scope": "computer",
        })
        response.headers["Cache-Control"] = "no-store"
        return response
    except (OSError, RuntimeError) as exc:
        return jsonify({"error": f"Network statistics are unavailable: {exc}"}), 503


@app.post("/convert")
def convert():
    payload     = request.get_json(silent=True) or {}
    raw_urls    = payload.get("urls") or ([payload.get("url", "")] if payload.get("url") else [])
    if isinstance(raw_urls, str):
        raw_urls = [raw_urls]
    if not isinstance(raw_urls, list):
        return jsonify({"error": "Paste valid Spotify playlist, album, or track links."}), 400
    urls        = [str(u).strip() for u in raw_urls if str(u).strip()]
    fmt         = str(payload.get("format", "mp3")).lower()
    bitrate_key = str(payload.get("bitrate", "160"))

    if not urls or not all(is_spotify_url(u) for u in urls):
        return jsonify({"error": "Paste valid Spotify playlist, album, or track links."}), 400
    if len(urls) > 5:
        return jsonify({"error": "You can queue up to 5 links at a time."}), 400
    urls = [canonical_spotify_url(url) for url in urls]
    if len(set(urls)) != len(urls):
        return jsonify({"error": "This link is already in the queue."}), 400
    if fmt not in FORMATS or bitrate_key not in BITRATES:
        return jsonify({"error": "Choose a supported format and bitrate."}), 400

    ffmpeg = find_ffmpeg()
    if ffmpeg is None:
        return jsonify({"error": "FFmpeg not found. Install it and add to PATH."}), 500

    batch_id = uuid.uuid4().hex
    hints = payload.get("collections", [])
    hints = {item.get("url"): item for item in hints if isinstance(item, dict)} if isinstance(hints, list) else {}
    jobs = []
    with JOBS_LOCK:
        for position, url in enumerate(urls):
            job_id = uuid.uuid4().hex
            JOBS[job_id] = {"state": "queued", "tracks": [], "total": 0, "completed": 0,
                            "cancelled": set(), "started_at": time.monotonic(), "format": fmt,
                            "bitrate": bitrate_key, "link_type": spotify_link_type(url), "urls": [url],
                            "name": str(hints.get(url, {}).get("name", ""))[:300],
                            "batch_id": batch_id, "batch_position": position}
            _persist_job(job_id)
            jobs.append({"job_id": job_id, **public_job(JOBS[job_id])})
    enqueue_conversions([(item["job_id"], ffmpeg, None) for item in jobs])
    return jsonify({"job_id": jobs[0]["job_id"], "jobs": jobs, "batch_id": batch_id})


def public_job(job):
    fields = ("state", "tracks", "total", "completed", "format", "bitrate", "link_type", "timings",
              "cached_tracks", "metadata_loading", "meta_count", "meta_total", "metadata_errors", "archive_name",
              "name", "urls", "batch_id", "batch_position", "error")
    return {key: job[key] for key in fields if key in job}


@app.post("/convert/<job_id>/retry")
def retry_failed_tracks(job_id):
    ffmpeg = find_ffmpeg()
    if ffmpeg is None:
        return jsonify({"error": "FFmpeg not found."}), 500
    payload = request.get_json(silent=True) or {}
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if job is None:
            return jsonify({"error": "Job not found."}), 404
        if job.get("state") not in ("complete", "error"):
            return jsonify({"error": "Wait until all tracks finish before retrying."}), 409
        failed = [i for i, track in enumerate(job.get("tracks", [])) if track.get("state") == "error"]
        indices = payload.get("indices", failed)
        if (not isinstance(indices, list) or not indices or any(type(i) is not int or i not in failed for i in indices)
                or len(set(indices)) != len(indices)):
            return jsonify({"error": "Choose failed tracks to retry."}), 400
        if not job.get("metadata") or not job.get("job_dir") or not Path(job["job_dir"]).is_dir():
            return jsonify({"error": "This job is no longer available. Add its link again."}), 409
        job["state"] = "queued"
        _persist_job(job_id)
    enqueue_conversions([(job_id, ffmpeg, indices)])
    return jsonify({"job_id": job_id, "state": "queued"}), 202


@app.get("/convert/<job_id>/events")
def conversion_events(job_id: str):
    def stream():
        while True:
            with JOBS_LOCK:
                job = JOBS.get(job_id)
            if job is None:
                yield f"data: {json.dumps({'type': 'error', 'error': 'Job not found.'})}\n\n"
                return
            snapshot = public_job(job)
            state     = job.get("state", "converting")
            if state == "complete":
                yield f"data: {json.dumps({'type': 'complete', **snapshot})}\n\n"
                return
            if state == "error":
                yield f"data: {json.dumps({'type': 'error', **snapshot})}\n\n"
                return
            meta_log   = job.get('meta_log', '')
            yield f"data: {json.dumps({'type': 'snapshot', **snapshot, 'meta_log': meta_log})}\n\n"
            time.sleep(0.8)
    return app.response_class(
        stream_with_context(stream()), mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/convert/<job_id>/status")
def conversion_status(job_id: str):
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if job is None:
            return jsonify({"error": "Job not found."}), 404
        out = public_job(job)
        if "error" in job:
            out["error"] = job["error"]
    return jsonify(out)


@app.post("/convert/<job_id>/tracks/<int:idx>/cancel")
def cancel_track(job_id: str, idx: int):
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if job is None or idx < 0 or idx >= job.get("total", 0):
            return jsonify({"error": "Track not found."}), 404
        job["cancelled"].add(idx)
    return jsonify({"ok": True})


@app.get("/convert/<job_id>/download")
def conversion_download(job_id: str):
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if job is None:
            return jsonify({"error": "Job not found."}), 404
        if job["state"] != "complete":
            return jsonify({"error": "Not ready yet."}), 409
        dl_path      = job.get("file_path") or job.get("archive_path")
        track_names  = job["track_names"]
        is_single    = "file_path" in job
        retain = any(track.get("state") == "error" for track in job.get("tracks", []))
        cleanup_dir = job.get("job_dir") or dl_path.parent
    name     = dl_path.name
    mimetype = "audio/*" if is_single else "application/zip"
    resp = send_file(dl_path, as_attachment=True, download_name=name, mimetype=mimetype)
    resp.headers["X-Converted-Tracks"] = json.dumps(track_names)
    resp.headers["X-Download-Name"]    = quote(name)
    if not retain:
        resp.direct_passthrough = False
        resp.call_on_close(lambda: remove_tree(cleanup_dir))
        with JOBS_LOCK:
            JOBS.pop(job_id, None)
    return resp


@app.get("/convert/<job_id>/tracks/<int:idx>/download")
def track_download(job_id: str, idx: int):
    stem_req = request.args.get("stem", "").lower()
    if stem_req:
        return jsonify({"error": "Vocal and instrumental downloads are available in the library.",
                        "library_url": "/library"}), 410
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if job is None:
            return jsonify({"error": "Job not found."}), 404
        output_dir = job.get("output_dir")
        tracks     = job.get("tracks", [])
        if output_dir is None or idx < 0 or idx >= len(tracks):
            return jsonify({"error": "Track not found."}), 404
        track = tracks[idx]
        if track.get("state") != "converted":
            return jsonify({"error": "Track not ready."}), 409
        audio = find_track_audio(track, output_dir)
        if audio is None:
            return jsonify({"error": "File not found."}), 404
    resp = send_file(audio, as_attachment=True, download_name=audio.name, mimetype="audio/*")
    resp.headers["X-Download-Name"] = quote(audio.name)
    return resp


@app.post("/convert/<job_id>/tracks/<int:idx>/separate")
def separate_track(job_id: str, idx: int):
    return jsonify({"error": "Vocal and instrumental downloads are available in the library.",
                    "library_url": "/library"}), 410


@app.get("/jobs")
def list_jobs():
    """Restore collection panels, including failures awaiting manual retry."""
    with JOBS_LOCK:
        out = [{"job_id": jid, **public_job(job)} for jid, job in JOBS.items()]
    return jsonify(out)


@app.post("/convert/<job_id>/resume")
def resume_job(job_id: str):
    """Re-run an interrupted job, skipping already-downloaded tracks."""
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if job is None:
            return jsonify({"error": "Job not found."}), 404
        if job.get("state") != "interrupted":
            return jsonify({"error": "Job is not resumable."}), 409
        urls      = job.get("urls", [])
        fmt       = job.get("format", "mp3")
        bitrate   = job.get("bitrate", "160")
        link_type = job.get("link_type", "")
        job["state"] = "metadata"
        job["cancelled"] = set()
    if not urls:
        return jsonify({"error": "No URLs stored for this job."}), 400
    ffmpeg = find_ffmpeg()
    if ffmpeg is None:
        return jsonify({"error": "FFmpeg not found."}), 500
    update_job(job_id, state="queued")
    enqueue_conversions([(job_id, ffmpeg, None)])
    return jsonify({"job_id": job_id})


@app.get("/library")
def library_page():
    return render_template("library.html")


@app.get("/library/tracks")
def library_tracks():
    q = request.args.get("q", "").strip().lower()
    collection = request.args.get("collection_id", "")
    clauses, params = [], []
    if q:
        clauses.append("(lower(t.title) LIKE ? OR lower(t.artist) LIKE ? OR lower(t.album) LIKE ?)")
        params.extend([f"%{q}%"] * 3)
    if collection == "unfiled":
        clauses.append("NOT EXISTS (SELECT 1 FROM collection_tracks ct WHERE ct.track_id=t.id)")
    elif collection:
        if not collection.isdigit():
            return jsonify({"error": "Choose a valid Library shelf."}), 400
        clauses.append("ct.collection_id=?")
        params.append(int(collection))
    join = " JOIN collection_tracks ct ON ct.track_id=t.id" if collection.isdigit() else ""
    where = " WHERE " + " AND ".join(clauses) if clauses else ""
    order = "MIN(ct.position), t.id" if join else "t.added_at DESC, t.id DESC"
    with closing(_db()) as con:
        rows = con.execute(f"SELECT t.* FROM tracks t{join}{where} GROUP BY t.id ORDER BY {order}", params).fetchall()
    return jsonify([dict(r) for r in rows])


@app.get("/library/collections")
def library_collections():
    with closing(_db()) as con:
        rows = con.execute("""
            SELECT c.*,count(ct.position) saved_entries,count(DISTINCT ct.track_id) saved_tracks
            FROM collections c LEFT JOIN collection_tracks ct ON ct.collection_id=c.id
            GROUP BY c.id ORDER BY c.updated_at DESC,c.id DESC
        """).fetchall()
        unfiled = con.execute("""SELECT count(*) FROM tracks t WHERE NOT EXISTS
            (SELECT 1 FROM collection_tracks ct WHERE ct.track_id=t.id)""").fetchone()[0]
        total = con.execute("SELECT count(*) FROM tracks").fetchone()[0]
    return jsonify({"collections": [{**dict(r), "complete": r["expected_total"] > 0 and
                     r["saved_entries"] >= r["expected_total"]} for r in rows],
                    "unfiled_tracks": unfiled, "total_tracks": total})


@app.get("/health")
def health():
    return jsonify({"app": "spotibai", "protocol": 1, "backend": "flask", "pid": os.getpid(),
                    "launch_id": os.environ.get("CONVOTIFY_LAUNCH_ID", "")})


@app.route("/library/readiness", methods=["GET", "POST", "DELETE"])
def library_readiness():
    if request.method == "GET":
        return jsonify(READINESS.snapshot())
    if request.method == "DELETE":
        return jsonify(READINESS.cancel())
    with STEM_SERVICE.lock:
        if any(job["state"] in ("queued", "running") for job in STEM_SERVICE.jobs.values()):
            return jsonify({"error": "Wait for stem preparation to finish before testing this computer."}), 409
        return jsonify(READINESS.start()), 202


@app.delete("/library/cache")
def library_clear_cache():
    try:
        with FileLock(str(LIBRARY_DIR / ".cache-maintenance.lock"), timeout=0), STEM_SERVICE.lock:
            if any(job["state"] in ("queued", "running") for job in STEM_SERVICE.jobs.values()):
                return jsonify({"error": "Wait for vocal and instrumental preparation to finish before clearing cache."}), 409
            with closing(_db()) as con:
                names = [row["filename"] for row in con.execute("SELECT filename FROM tracks")]
            result = clear_generated_audio(LIBRARY_DIR, names)
            if result["failed_paths"]:
                return jsonify({**result, "error": "Some cached files are in use. Close playback/downloads and try again."}), 409
            STEM_SERVICE.jobs.clear()
            STEM_SERVICE.active.clear()
            return jsonify({"ok": True, **result})
    except FileLockTimeout:
        return jsonify({"error": "The library cache is in use. Please try again shortly."}), 409
    except (OSError, RuntimeError) as exc:
        return jsonify({"error": str(exc)}), 409


def _library_row(track_id: int):
    with closing(_db()) as con:
        return con.execute("SELECT * FROM tracks WHERE id=?", (track_id,)).fetchone()


def _library_quality(row) -> str:
    match = re.search(r"\d+", str(row["bitrate"] or "160"))
    return f"{min(320, max(32, int(match.group()) if match else 160))}k"


@app.post("/library/tracks/<int:track_id>/separate")
def library_separate(track_id: int):
    payload = request.get_json(silent=True) or {}
    stem = str(payload.get("stem", "")).lower()
    if stem not in STEM_CHOICES:
        return jsonify({"error": "Choose vocals or instrumental."}), 400
    row = _library_row(track_id)
    if row is None:
        return jsonify({"error": "Track not found."}), 404
    source = LIBRARY_DIR / row["filename"]
    if not source.is_file():
        return jsonify({"error": "File missing from library."}), 404
    ffmpeg = find_ffmpeg()
    if ffmpeg is None:
        return jsonify({"error": "FFmpeg not found."}), 500
    metadata = {"title": row["title"], "artist": row["artist"], "album": row["album"],
                "cover_url": row["cover_url"], "track_number": 0}
    fmt = (row["format"] or "mp3").lower()
    with STEM_SERVICE.lock:
        if ready_stem(source, stem, fmt, _library_quality(row)) is None:
            try:
                audio = MutagenFile(source)
                duration = float(audio.info.length) if audio and audio.info else 600
            except Exception:
                duration = 600
            problem = READINESS.check(duration, STEM_SERVICE.separator is not None)
            if problem:
                return jsonify({"error": problem, "readiness_required": True}), 428
        job_id = STEM_SERVICE.start(track_id, source, stem, fmt, _library_quality(row), ffmpeg, metadata)
    return jsonify({"sep_id": job_id}), 202


@app.get("/library/tracks/<int:track_id>/separate/<sep_id>/status")
def library_separate_status(track_id: int, sep_id: str):
    job = STEM_SERVICE.snapshot(sep_id, track_id)
    if job is None:
        return jsonify({"error": "Separation job not found for this track."}), 404
    return jsonify(job)


@app.get("/library/tracks/<int:track_id>/separate/<sep_id>/events")
def library_separate_events(track_id: int, sep_id: str):
    if STEM_SERVICE.snapshot(sep_id, track_id) is None:
        return jsonify({"error": "Separation job not found for this track."}), 404

    def stream():
        revision = None
        heartbeat = time.monotonic()
        while True:
            job = STEM_SERVICE.snapshot(sep_id, track_id)
            if job is None:
                yield f"data: {json.dumps({'state': 'error', 'msg': 'Job no longer available.'})}\n\n"
                return
            if job["revision"] != revision:
                yield f"data: {json.dumps(job)}\n\n"
                revision = job["revision"]
                heartbeat = time.monotonic()
            elif time.monotonic() - heartbeat >= 15:
                yield ": keepalive\n\n"
                heartbeat = time.monotonic()
            if job["state"] in ("done", "error"):
                return
            time.sleep(0.25)
    return app.response_class(
        stream_with_context(stream()), mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/library/tracks/<int:track_id>/download")
def library_download(track_id: int):
    stem_req = request.args.get("stem", "").lower()
    with closing(_db()) as con, con:
        row = con.execute("SELECT * FROM tracks WHERE id=?", (track_id,)).fetchone()
    if row is None:
        return jsonify({"error": "Not found."}), 404
    path = LIBRARY_DIR / row["filename"]
    if stem_req in STEM_CHOICES:
        fmt   = (row["format"] or "mp3").lower()
        path = ready_stem(path, stem_req, fmt, _library_quality(row))
        if path is None:
            return jsonify({"error": "Prepare this stem from the library download menu first."}), 409
    elif stem_req:
        return jsonify({"error": "Choose original, vocals or instrumental."}), 400
    if not path.exists():
        return jsonify({"error": "File missing from library."}), 404
    return send_file(path, as_attachment=True, download_name=path.name, mimetype="audio/*")


@app.get("/library/tracks/<int:track_id>/preview")
def library_preview(track_id: int):
    """Play the selected original or prepared stem without downloading the full file."""
    stem = request.args.get("stem", "").lower()
    if stem and stem not in STEM_CHOICES:
        return jsonify({"error": "Choose original, vocals or instrumental."}), 400
    with closing(_db()) as con, con:
        row = con.execute("SELECT * FROM tracks WHERE id=?", (track_id,)).fetchone()
    if row is None:
        return jsonify({"error": "Not found."}), 404
    path = LIBRARY_DIR / row["filename"]
    if not path.exists():
        return jsonify({"error": "File missing."}), 404
    if stem:
        path = ready_stem(path, stem, (row["format"] or "mp3").lower(), _library_quality(row))
        if path is None:
            return jsonify({"error": "This stem needs preparation.", "needs_preparation": True}), 409
    ffmpeg = find_ffmpeg()
    if ffmpeg is None:
        return jsonify({"error": "FFmpeg not found."}), 500
    try:
        with FileLock(str(LIBRARY_DIR / ".cache-maintenance.lock"), timeout=35):
            clip = preview_clip(path, ffmpeg)
    except Exception as exc:
        app.logger.warning("Library preview failed for %s: %s", track_id, exc)
        return jsonify({"error": "Preview could not be prepared. Please retry."}), 500
    return send_file(clip, mimetype="audio/mpeg", as_attachment=False, max_age=0)


@app.delete("/library/tracks/<int:track_id>")
def library_delete(track_id: int):
    with STEM_SERVICE.lock, closing(_db()) as con, con:
        row = con.execute("SELECT filename FROM tracks WHERE id=?", (track_id,)).fetchone()
        if row is None:
            return jsonify({"error": "Not found."}), 404
        if any(job.get("track_id") == track_id and job["state"] in ("queued", "running") for job in STEM_SERVICE.jobs.values()):
            return jsonify({"error": "Wait for this track's separation to finish before removing it."}), 409
        names = [item["filename"] for item in con.execute("SELECT filename FROM tracks")]
        source = LIBRARY_DIR / row["filename"]
        try:
            with FileLock(str(LIBRARY_DIR / ".cache-maintenance.lock"), timeout=0):
                result = clear_generated_audio(LIBRARY_DIR, names, source)
                if result["failed_paths"]:
                    return jsonify({"error": "This track's cached audio is in use. Close playback and retry."}), 409
                source.unlink(missing_ok=True)
        except (FileLockTimeout, OSError, RuntimeError) as exc:
            return jsonify({"error": str(exc) or "The cached audio is in use."}), 409
        con.execute("DELETE FROM tracks WHERE id=?", (track_id,))
    return jsonify({"ok": True})


if __name__ == "__main__":
    _load_persisted_jobs()
    port = int(os.environ.get("CONVOTIFY_PORT", "5000"))
    try:
        from waitress import serve
        print(f"Starting on http://127.0.0.1:{port}", flush=True)
        serve(app, host="127.0.0.1", port=port, threads=16)
    except ImportError:
        app.run(debug=False, host="127.0.0.1", port=port, threaded=True)
