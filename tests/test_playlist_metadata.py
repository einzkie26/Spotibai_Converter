import copy
import io
import json
import os
import shutil
import struct
import subprocess
import tempfile
import threading
import time
import unittest
import zipfile
import zlib
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import conversion_engine as engine
import app as converter
from mutagen import File as MutagenFile
from mutagen.mp3 import MP3
from mutagen.mp4 import MP4Cover
from metadata_enrichment import METADATA_VERSION, album_details, enrich_playlist


PLAYLIST = "https://open.spotify.com/playlist/Playlist123"


def song(number, **extra):
    return {"name": f"Song {number}", "artist": "Artist", "album_name": None,
            "cover_url": None, "url": f"https://open.spotify.com/track/Track{number}",
            "list_name": "My playlist", "list_position": number, **extra}


def track(number):
    return {"id": f"Track{number}", "album": {
        "id": f"Album{number}", "name": f"Original Album {number}",
        "artists": [{"name": f"Album Artist {number}"}], "release_date": "1998-05-01",
        "images": [{"url": f"https://example.com/{number}-small.jpg", "width": 64, "height": 64},
                   {"url": f"https://example.com/{number}.jpg", "width": 640, "height": 640}],
    }}


def cover_image(rgb):
    def chunk(kind, data):
        return struct.pack('!I', len(data)) + kind + data + struct.pack('!I', zlib.crc32(kind + data))
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!2I5B', 1, 1, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(b'\x00' + bytes(rgb))) + chunk(b'IEND', b''))


COVERS = [cover_image((255, 0, 0)), cover_image((0, 0, 255))]


class PlaylistMetadataTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="playlist-metadata-")
        self.root = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def test_missing_album_and_artwork_are_recovered_once_per_unique_track_in_playlist_order(self):
        rows = [song(1), song(2), song(1, list_position=3), song(4, album_name="Already complete", cover_url="https://example.com/kept.jpg")]
        original = copy.deepcopy(rows)
        lookup = Mock(side_effect=lambda url: track(int(url[-1])))
        result = enrich_playlist(rows, self.root, lookup)
        self.assertEqual(lookup.call_count, 2)
        self.assertEqual([row["url"] for row in result], [row["url"] for row in rows])
        self.assertEqual([row["album_name"] for row in result], ["Original Album 1", "Original Album 2", "Original Album 1", "Already complete"])
        self.assertEqual(result[2]["list_position"], 3)
        self.assertEqual(result[0]["list_name"], "My playlist")
        self.assertEqual(result[1]["cover_url"], "https://example.com/2.jpg")
        self.assertEqual(rows, original)
        lookup.reset_mock()
        self.assertEqual(enrich_playlist(rows, self.root, lookup), result)
        lookup.assert_not_called()

    def test_nested_metadata_and_null_image_dimensions_do_not_require_an_extra_lookup(self):
        row = song(1, album_name="Unknown Album", album=track(1)["album"])
        row["album"]["images"].append({"url": "https://example.com/no-size.jpg", "width": None, "height": None})
        lookup = Mock()
        result = enrich_playlist([row], self.root, lookup)[0]
        self.assertEqual(result["album_name"], "Original Album 1")
        self.assertEqual(result["cover_url"], "https://example.com/1.jpg")
        lookup.assert_not_called()

    def test_an_album_actually_named_unknown_is_preserved(self):
        row = song(1, album_name="Unknown", cover_url="https://example.com/real-cover.jpg")
        lookup = Mock()
        self.assertEqual(enrich_playlist([row], self.root, lookup)[0]["album_name"], "Unknown")
        lookup.assert_not_called()

    def test_public_track_shape_restores_album_name_artwork_and_album_artist(self):
        raw = {"albumOfTrack": {"name": "Public Album", "uri": "spotify:album:Album1",
            "coverArt": {"sources": [{"url": "https://example.com/cover.jpg", "width": None, "height": None}]},
            "date": {"isoString": "2001-02-03T00:00:00Z"},
            "artists": {"items": [{"profile": {"name": "Album Artist"}}]}}}
        details = album_details(raw)
        self.assertEqual(details["album_id"], "Album1")
        self.assertEqual(details["album_name"], "Public Album")
        self.assertEqual(details["album_artist"], "Album Artist")
        self.assertEqual(details["cover_url"], "https://example.com/cover.jpg")
        self.assertEqual(details["date"], "2001-02-03")

    def test_a_failed_lookup_keeps_the_track_and_other_tracks_metadata(self):
        def lookup(url):
            if url.endswith("2"):
                raise RuntimeError("Track is temporarily unavailable")
            return track(1)
        with self.assertLogs("metadata_enrichment", level="WARNING"):
            result = enrich_playlist([song(1), song(2)], self.root, lookup)
        self.assertEqual(len(result), 2)
        self.assertEqual(result[0]["album_name"], "Original Album 1")
        self.assertIsNone(result[1]["album_name"])
        self.assertEqual(result[1]["url"], song(2)["url"])

    def test_concurrent_playlists_share_recovered_track_details(self):
        count = 0
        lock = threading.Lock()
        def lookup(url):
            nonlocal count
            with lock:
                count += 1
            time.sleep(.03)
            return track(1)
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: enrich_playlist([song(1)], self.root, lookup), range(2)))
        self.assertEqual(count, 1)
        self.assertEqual(results[0], results[1])

    def test_fresh_legacy_playlist_cache_is_repaired_without_refetching_the_playlist(self):
        root = self.root / "metadata"
        root.mkdir()
        path = root / (engine._key([engine.ENGINE_VERSION, PLAYLIST]) + ".json")
        path.write_text(json.dumps({"created": time.time(), "songs": [song(1)]}), encoding="utf-8")
        lookup = Mock(return_value=track(1))
        with patch.object(engine, "_fetch_metadata") as fetch, patch.object(engine, "_enrich_playlist",
                side_effect=lambda rows, cache: enrich_playlist(rows, cache, lookup)):
            first, cached = engine.read_metadata(PLAYLIST, self.root)
            self.assertFalse(cached)
            self.assertEqual(first[0]["album_name"], "Original Album 1")
            self.assertEqual(first[0]["cover_url"], "https://example.com/1.jpg")
            self.assertTrue(engine.read_metadata(PLAYLIST, self.root)[1])
        fetch.assert_not_called()
        lookup.assert_called_once()
        self.assertEqual(json.loads(path.read_text())["metadata_version"], METADATA_VERSION)

    def test_incomplete_results_retry_after_a_minute_without_reloading_playlist_membership(self):
        with patch.object(engine, "_fetch_metadata", return_value=[song(1)]) as fetch, \
             patch.object(engine, "_enrich_playlist", side_effect=[[song(1)],
                [song(1, album_name="Recovered", cover_url="https://example.com/cover.jpg")]]) as repair:
            self.assertFalse(engine.read_metadata(PLAYLIST, self.root)[1])
            self.assertTrue(engine.read_metadata(PLAYLIST, self.root)[1])
            path = next((self.root / "metadata").glob("*.json"))
            cached = json.loads(path.read_text())
            cached["enriched_at"] = 0
            path.write_text(json.dumps(cached))
            rows, was_cached = engine.read_metadata(PLAYLIST, self.root)
        self.assertFalse(was_cached)
        self.assertEqual(rows[0]["album_name"], "Recovered")
        self.assertEqual(repair.call_count, 2)
        fetch.assert_called_once()

    def test_corrupt_track_cache_is_rebuilt(self):
        lookup = Mock(return_value=track(1))
        enrich_playlist([song(1)], self.root, lookup)
        path = next((self.root / "track-metadata").glob("*.json"))
        path.write_text(json.dumps({"created": time.time(), "details": []}))
        self.assertEqual(enrich_playlist([song(1)], self.root, lookup)[0]["album_name"], "Original Album 1")
        self.assertEqual(lookup.call_count, 2)

    def test_public_sdk_sessions_are_reused_by_bounded_workers_and_closed(self):
        from SpotipyFree import Spotify as FreeSpotify
        sessions = []
        readers = []
        def http(*args, **kwargs):
            client = SimpleNamespace(timeout=0, close=Mock())
            sessions.append(client)
            return client
        class Reader:
            def __init__(self, client):
                readers.append(self)
            def get_track_info(self, track_id):
                time.sleep(.01)
                raw = {"albumOfTrack": {"name": track_id, "coverArt": {"sources": [{"url": "https://example.com/cover.jpg"}]}}}
                return {"data": {"trackUnion": raw}}
        with patch.object(engine, "_spotdl_settings", return_value={}), \
             patch("spotdl.utils.spotify.SpotifyClient", return_value=FreeSpotify()), \
             patch("spotapi.Song", Reader), patch("spotapi.http.request.TLSClient", side_effect=http):
            result = engine._enrich_playlist([song(i) for i in range(1, 9)], self.root)
        self.assertEqual(len(result), 8)
        self.assertLessEqual(len(readers), 4)
        self.assertTrue(all(row["album_name"] == f"Track{i}" for i, row in enumerate(result, 1)))
        self.assertTrue(all(client.timeout == 15 for client in sessions))
        for client in sessions:
            client.close.assert_called_once()


class PlaylistOutputTests(unittest.TestCase):
    def setUp(self):
        self.ffmpeg = converter.find_ffmpeg()
        if self.ffmpeg is None:
            self.skipTest("FFmpeg is required for audio metadata validation")
        self.temporary = tempfile.TemporaryDirectory(prefix="playlist-output-")
        self.root = Path(self.temporary.name)
        self.cache = self.root / "cache"
        self.library = self.root / "library"
        self.library.mkdir()
        self.job_id = "playlist-artwork-test"
        self.patches = [patch.object(converter, "LIBRARY_DIR", self.library),
                        patch.object(converter, "LIBRARY_DB", self.library / "library.db"),
                        patch.object(converter, "JOBS_DIR", self.root / "jobs"),
                        patch.object(engine, "CACHE_DIR", self.cache),
                        patch.dict(os.environ, {"CONVOTIFY_CACHE_DIR": str(self.cache)})]
        (self.root / "jobs").mkdir()
        for item in self.patches:
            item.start()

    def tearDown(self):
        converter.JOBS.pop(getattr(self, "job_id", ""), None)
        for item in reversed(getattr(self, "patches", [])):
            item.stop()
        if hasattr(self, "temporary"):
            self.temporary.cleanup()

    def audio(self, extension, codec):
        target = self.root / f"fixture.{extension}"
        subprocess.run([str(self.ffmpeg), "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
                        "-f", "lavfi", "-i", "sine=frequency=440:duration=0.2", "-c:a", codec, str(target)],
                       capture_output=True, check=True, timeout=15)
        return target

    def read_tags(self, path):
        audio = MutagenFile(path)
        if path.suffix == ".mp3":
            return str(audio.tags["TALB"]), audio.tags.getall("APIC")[0].data, audio.tags.getall("APIC")[0].mime
        if path.suffix == ".flac":
            return audio["album"][0], audio.pictures[0].data, audio.pictures[0].mime
        return audio["\xa9alb"][0], bytes(audio["covr"][0]), audio["covr"][0].imageformat

    def test_missing_new_artwork_does_not_erase_an_embedded_cover(self):
        for extension, codec in (("mp3", "libmp3lame"), ("flac", "flac"), ("m4a", "alac")):
            with self.subTest(extension=extension):
                path = self.audio(extension, codec)
                engine._add_cover(path, COVERS[0])
                converter.embed_tags(path, {"title": "Song", "artist": "Artist", "album": "Recovered Album"}, None)
                album, image, _ = self.read_tags(path)
                self.assertEqual(album, "Recovered Album")
                self.assertEqual(image, COVERS[0])

    def test_recovered_png_artwork_is_embedded_with_the_correct_image_type(self):
        for extension, codec in (("mp3", "libmp3lame"), ("flac", "flac"), ("m4a", "alac")):
            with self.subTest(extension=extension):
                path = self.audio(extension, codec)
                converter.embed_tags(path, {"title": "Song", "artist": "Artist", "album": "Recovered Album"}, COVERS[1])
                album, image, image_type = self.read_tags(path)
                self.assertEqual(album, "Recovered Album")
                self.assertEqual(image, COVERS[1])
                self.assertEqual(image_type, MP4Cover.FORMAT_PNG if extension == "m4a" else "image/png")

    def test_repaired_playlist_metadata_reaches_cards_library_and_audio_in_the_zip(self):
        rows = [song(1), song(2)]
        recovered = enrich_playlist(rows, self.cache, lambda url: track(int(url[-1])))
        metadata_root = self.cache / "metadata"
        metadata_root.mkdir()
        metadata_path = metadata_root / (engine._key([engine.ENGINE_VERSION, PLAYLIST]) + ".json")
        metadata_path.write_text(json.dumps({"created": time.time(), "songs": rows}), encoding="utf-8")
        covers = self.cache / "covers"
        covers.mkdir()
        for row, image in zip(recovered, COVERS):
            (covers / (engine._key(row["cover_url"]) + ".image")).write_bytes(image)
        template = self.audio("mp3", "libmp3lame")
        job_dir = self.root / "job"
        job_dir.mkdir()
        converter.JOBS[self.job_id] = {"state": "metadata", "cancelled": set(), "format": "mp3",
                                      "bitrate": "160", "tracks": [], "total": 0, "completed": 0,
                                      "job_dir": job_dir}
        def download(item, output_dir, on_progress=None):
            target = output_dir / f"{item['artist']} - {item['title']}.mp3"
            shutil.copy2(template, target)
            return {"path": str(target), "cached": False}
        with patch.object(converter.DownloadSession, "download", side_effect=download):
            converter.convert_job(self.job_id, PLAYLIST, self.ffmpeg, "mp3", "160k", "playlist")
        job = converter.JOBS[self.job_id]
        self.assertEqual(job["state"], "complete", job.get("error"))
        self.assertEqual([row["album"] for row in job["tracks"]], ["Original Album 1", "Original Album 2"])
        self.assertEqual([row["cover_url"] for row in job["tracks"]], [row["cover_url"] for row in recovered])
        with zipfile.ZipFile(job["archive_path"]) as archive:
            for name in archive.namelist():
                tags = MP3(io.BytesIO(archive.read(name))).tags
                number = int(str(tags["TIT2"])[-1])
                self.assertEqual(str(tags["TALB"]), f"Original Album {number}")
                self.assertEqual(tags.getall("APIC")[0].data, COVERS[number - 1])
        with closing(converter._db()) as db:
            library_rows = db.execute("SELECT title, album, cover_url FROM tracks ORDER BY title").fetchall()
        self.assertEqual([row["album"] for row in library_rows], ["Original Album 1", "Original Album 2"])
        self.assertEqual([row["cover_url"] for row in library_rows], [row["cover_url"] for row in recovered])
