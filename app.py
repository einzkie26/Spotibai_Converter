from __future__ import annotations

import json
import os
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
from conversion_engine import DownloadSession, WORKERS, get_cover
from preview_engine import preview_clip
from stem_engine import STEM_SERVICE, ready_stem

load_dotenv()
from mutagen.id3 import ID3, APIC, TIT2, TPE1, TALB, TRCK, ID3NoHeaderError
from mutagen import File as MutagenFile
from mutagen.flac import FLAC, Picture
from mutagen.mp4 import MP4, MP4Cover

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 4 * 1024

LIBRARY_DIR = Path(os.environ.get("CONVOTIFY_LIBRARY_DIR", Path(__file__).parent / "library"))
LIBRARY_DIR.mkdir(exist_ok=True)
LIBRARY_DB  = LIBRARY_DIR / "library.db"
JOBS_DIR    = Path("jobs")
JOBS_DIR.mkdir(exist_ok=True)


def _db() -> sqlite3.Connection:
    con = sqlite3.connect(str(LIBRARY_DB))
    con.row_factory = sqlite3.Row
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
    con.commit()
    return con


def library_save(meta: dict, audio_src: Path, fmt: str, bitrate: str) -> None:
    """Copy a converted track into the library folder and record it in the DB."""
    if not meta.get("title") or not meta.get("artist"):
        return
    safe = re.sub(r'[\\/:*?"<>|]', '_', f"{meta['artist']} - {meta['title']}{audio_src.suffix}")
    dest = LIBRARY_DIR / safe
    temporary = dest.with_name(f".{dest.name}.{uuid.uuid4().hex}.tmp")
    try:
        shutil.copy2(audio_src, temporary)
        temporary.replace(dest)
    finally:
        temporary.unlink(missing_ok=True)
    with closing(_db()) as con, con:
        con.execute("""
            INSERT INTO tracks (title, artist, album, cover_url, format, bitrate, filename)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(filename) DO UPDATE SET
                title=excluded.title, artist=excluded.artist, album=excluded.album,
                cover_url=excluded.cover_url, format=excluded.format, bitrate=excluded.bitrate
        """, (meta["title"], meta["artist"], meta.get("album", ""),
               meta.get("cover_url", ""), fmt.upper(), bitrate, safe))

SPOTIFY_HOSTS = {"open.spotify.com", "spotify.com"}
SPOTIFY_PATH = re.compile(r"^/(?:intl-[^/]+/)?(?:playlist|album|track)/[A-Za-z0-9]+/?$")
JOBS: dict[str, dict] = {}
JOBS_LOCK = threading.Lock()
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
        if state in ("complete", "error"):
            p.unlink(missing_ok=True)
            continue
        if job_dir is None or not job_dir.exists():
            p.unlink(missing_ok=True)
            continue
        with JOBS_LOCK:
            JOBS[job_id] = {
                "state":     "interrupted",
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
                "output_dir": job_dir / "tracks",
            }


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
                output_format: str, bitrate: str, link_type: str) -> None:
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
        update_job(job_id, state="metadata", meta_log="Reading Spotify metadata...",
                   meta_count=0, meta_total=0, metadata_loading=True, metadata_errors=[])
        metadata = []
        metadata_errors = []
        active: set[int] = set()
        errors: dict[int, str] = {}
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
                for url_index, url in enumerate(playlist_urls):
                    offset = len(metadata)

                    def on_track(track, count, total):
                        nonlocal conversion_started
                        with progress_lock:
                            index = len(metadata)
                            track["output_subdir"] = f"{index + 1:04d}"
                            metadata.append(track)
                            update_job(job_id, state="processing", metadata=list(metadata),
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

                with progress_lock:
                    with JOBS_LOCK:
                        cancelled = set(JOBS[job_id]["cancelled"])
                    retry_indices = [index for index in sorted(errors) if index not in cancelled]
                    for index in retry_indices:
                        metadata[index]["retry_count"] = 1
                        errors.pop(index, None)
                        phases[index] = {"state": "pending", "message": "Waiting to prepare again",
                                         "progress_pct": 0}
                    if retry_indices:
                        refresh_tracks()
                retry_futures = [pool.submit(convert_one, index, metadata[index]) for index in retry_indices]
                for future in as_completed(retry_futures):
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
        archive_path = job_dir / archive_filename(metadata, link_type)
        with zipfile.ZipFile(archive_path, "w", zipfile.ZIP_STORED) as zf:
            for t in tracks:
                zf.write(t, arcname=t.relative_to(output_dir))

        update_job(job_id, state="complete", archive_path=archive_path,
                   tracks=final_statuses, track_names=track_names, completed=completed,
                   timings={**timings, "packaging_s": round(time.perf_counter() - packaging_started, 3),
                            "total_s": round(time.perf_counter() - started, 3)})
        (JOBS_DIR / f"{job_id}.json").unlink(missing_ok=True)

    except Exception as exc:
        remove_tree(job_dir)
        update_job(job_id, state="error", error=str(exc), metadata_loading=False)
        (JOBS_DIR / f"{job_id}.json").unlink(missing_ok=True)


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
    if fmt not in FORMATS or bitrate_key not in BITRATES:
        return jsonify({"error": "Choose a supported format and bitrate."}), 400

    ffmpeg = find_ffmpeg()
    if ffmpeg is None:
        return jsonify({"error": "FFmpeg not found. Install it and add to PATH."}), 500

    job_id = uuid.uuid4().hex
    link_type = spotify_link_type(urls[0]) if len(urls) == 1 else "playlist"
    with JOBS_LOCK:
        JOBS[job_id] = {
            "state": "metadata", "tracks": [], "total": 0, "completed": 0,
            "cancelled": set(), "started_at": time.monotonic(),
            "format": fmt, "bitrate": bitrate_key,
            "link_type": link_type,
            "urls": urls,
        }
    threading.Thread(
        target=convert_job,
        args=(job_id, urls, ffmpeg, fmt, BITRATES[bitrate_key], link_type),
        daemon=True,
    ).start()
    return jsonify({"job_id": job_id})


@app.get("/convert/<job_id>/events")
def conversion_events(job_id: str):
    def stream():
        while True:
            with JOBS_LOCK:
                job = JOBS.get(job_id)
            if job is None:
                yield f"data: {json.dumps({'type': 'error', 'error': 'Job not found.'})}\n\n"
                return
            state     = job.get("state", "converting")
            tracks    = job.get("tracks", [])
            total     = job.get("total", 0)
            completed = job.get("completed", 0)
            if state == "complete":
                yield f"data: {json.dumps({'type': 'complete', 'state': state, 'tracks': tracks, 'total': total, 'completed': completed, 'timings': job.get('timings', {}), 'cached_tracks': job.get('cached_tracks', 0), 'metadata_errors': job.get('metadata_errors', []), 'archive_name': job.get('archive_name', '')})}\n\n"
                return
            if state == "error":
                yield f"data: {json.dumps({'type': 'error', 'state': state, 'error': job.get('error', 'Conversion failed.'), 'tracks': tracks, 'total': total, 'completed': completed})}\n\n"
                return
            meta_log   = job.get('meta_log', '')
            meta_count = job.get('meta_count', 0)
            meta_total = job.get('meta_total', 0)
            yield f"data: {json.dumps({'type': 'snapshot', 'state': state, 'tracks': tracks, 'total': total, 'completed': completed, 'meta_log': meta_log, 'meta_count': meta_count, 'meta_total': meta_total, 'metadata_loading': job.get('metadata_loading', False), 'archive_name': job.get('archive_name', '')})}\n\n"
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
        out = {k: job[k] for k in ("state", "tracks", "total", "completed", "format", "bitrate", "link_type", "timings", "cached_tracks", "metadata_loading", "meta_count", "meta_total", "metadata_errors", "archive_name") if k in job}
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
    name     = dl_path.name
    mimetype = "audio/*" if is_single else "application/zip"
    resp = send_file(dl_path, as_attachment=True, download_name=name, mimetype=mimetype)
    resp.headers["X-Converted-Tracks"] = json.dumps(track_names)
    resp.headers["X-Download-Name"]    = quote(name)
    resp.call_on_close(lambda: remove_tree(dl_path.parent))
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
    """Return all active/interrupted jobs so the client can reconnect."""
    with JOBS_LOCK:
        out = [
            {
                "job_id":    jid,
                "state":     j.get("state"),
                "link_type": j.get("link_type", ""),
                "format":    j.get("format", ""),
                "bitrate":   j.get("bitrate", ""),
                "total":     j.get("total", 0),
                "completed": j.get("completed", 0),
                "tracks":    j.get("tracks", []),
            }
            for jid, j in JOBS.items()
            if j.get("state") not in ("complete", "error")
        ]
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
    threading.Thread(
        target=convert_job,
        args=(job_id, urls, ffmpeg, fmt, BITRATES.get(bitrate, "160k"), link_type),
        daemon=True,
    ).start()
    return jsonify({"job_id": job_id})


@app.get("/library")
def library_page():
    return render_template("library.html")


@app.get("/library/tracks")
def library_tracks():
    q = request.args.get("q", "").strip().lower()
    with closing(_db()) as con, con:
        if q:
            rows = con.execute("""
                SELECT * FROM tracks
                WHERE lower(title) LIKE ? OR lower(artist) LIKE ? OR lower(album) LIKE ?
                ORDER BY added_at DESC
            """, (f"%{q}%", f"%{q}%", f"%{q}%")).fetchall()
        else:
            rows = con.execute("SELECT * FROM tracks ORDER BY added_at DESC").fetchall()
    return jsonify([dict(r) for r in rows])


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
    job_id = STEM_SERVICE.start(track_id, source, stem, (row["format"] or "mp3").lower(),
                                _library_quality(row), ffmpeg, metadata)
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
        clip = preview_clip(path, ffmpeg)
    except Exception as exc:
        app.logger.warning("Library preview failed for %s: %s", track_id, exc)
        return jsonify({"error": "Preview could not be prepared. Please retry."}), 500
    return send_file(clip, mimetype="audio/mpeg", as_attachment=False, max_age=0)


@app.delete("/library/tracks/<int:track_id>")
def library_delete(track_id: int):
    with closing(_db()) as con, con:
        row = con.execute("SELECT filename FROM tracks WHERE id=?", (track_id,)).fetchone()
        if row is None:
            return jsonify({"error": "Not found."}), 404
        (LIBRARY_DIR / row["filename"]).unlink(missing_ok=True)
        con.execute("DELETE FROM tracks WHERE id=?", (track_id,))
    return jsonify({"ok": True})


if __name__ == "__main__":
    _load_persisted_jobs()
    try:
        from waitress import serve
        print("Starting on http://127.0.0.1:5000")
        serve(app, host="127.0.0.1", port=5000, threads=16)
    except ImportError:
        app.run(debug=False, port=5000, threaded=True)
