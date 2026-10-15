"""Recover album details omitted by simplified Spotify playlist responses."""
from __future__ import annotations

import hashlib
import json
import logging
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from filelock import FileLock

METADATA_VERSION = 2
_UNKNOWN = {"unknown album"}


def _missing(value):
    return not value or (isinstance(value, str) and (not value.strip() or value.strip().lower() in _UNKNOWN))


def _cover(images):
    def area(image):
        try:
            return int(image.get("width") or 0) * int(image.get("height") or 0)
        except (TypeError, ValueError):
            return 0
    choices = [image for image in images if isinstance(image, dict)
               and isinstance(image.get("url"), str) and image["url"].startswith(("https://", "http://"))]
    return max(choices, key=area)["url"] if choices else None


def album_details(track):
    """Accept the standard Spotify response and the public SDK's track response."""
    if not isinstance(track, dict):
        return {}
    album = track.get("album") or track.get("albumOfTrack") or {}
    if not isinstance(album, dict):
        album = {}
    images = album.get("images") or (album.get("coverArt") or {}).get("sources") or []
    artists = album.get("artists") or []
    if isinstance(artists, dict):
        artists = artists.get("items") or []
    artist = artists[0] if artists else {}
    if not isinstance(artist, dict):
        artist = {}
    date = album.get("release_date") or (album.get("date") or {}).get("isoString") or ""
    date = date.split("T")[0]
    album_id = album.get("id") or str(album.get("uri") or "").removeprefix("spotify:album:")
    return {
        "album_name": album.get("name"), "album_id": album_id,
        "album_artist": artist.get("name") or (artist.get("profile") or {}).get("name"),
        "album_type": album.get("album_type"), "cover_url": _cover(images),
        "date": date, "year": date[:4] if date and not date.startswith("0000") else None,
        "tracks_count": album.get("total_tracks"),
    }


def _merge(row, details):
    result = dict(row)
    for field, value in details.items():
        if _missing(result.get(field)) and not _missing(value):
            result[field] = value
    return result


def metadata_complete(row):
    return not _missing(row.get("album_name")) and not _missing(row.get("cover_url"))


def enrich_playlist(rows, cache_dir: Path, lookup, workers=4):
    """Look up only incomplete unique tracks; keep collection order and duplicates."""
    rows = [_merge(row, album_details(row)) for row in rows]
    known = {}
    for row in rows:
        known[row["url"]] = _merge(known.get(row["url"], {}), row)
    rows = [_merge(row, known[row["url"]]) for row in rows]
    missing = list(dict.fromkeys(row["url"] for row in rows if not metadata_complete(row)))
    if not missing:
        return rows
    root = cache_dir / "track-metadata"
    root.mkdir(parents=True, exist_ok=True)

    def recover(url):
        path = root / (hashlib.sha256(url.encode()).hexdigest() + ".json")
        try:
            with FileLock(str(path) + ".lock", timeout=45):
                try:
                    cached = json.loads(path.read_text(encoding="utf-8"))
                    details = cached["details"]
                    if not isinstance(details, dict):
                        raise ValueError("Invalid cached album details")
                    ttl = 86400 if metadata_complete(details) else 60
                    if 0 <= time.time() - cached["created"] < ttl:
                        return details
                except (OSError, ValueError, KeyError, TypeError):
                    pass
                details = album_details(lookup(url))
                if _missing(details.get("album_name")) and _missing(details.get("cover_url")):
                    raise ValueError("The track response has no album details.")
                temporary = path.with_suffix(f".{uuid.uuid4().hex}.tmp")
                try:
                    temporary.write_text(json.dumps({"created": time.time(), "details": details}), encoding="utf-8")
                    temporary.replace(path)
                finally:
                    temporary.unlink(missing_ok=True)
                return details
        except Exception as exc:
            logging.getLogger(__name__).warning("Album metadata unavailable for %s: %s", url, exc)
            return {}

    with ThreadPoolExecutor(max_workers=max(1, min(4, workers))) as pool:
        details_by_url = dict(zip(missing, pool.map(recover, missing)))
    return [_merge(row, details_by_url.get(row["url"], {})) for row in rows]
