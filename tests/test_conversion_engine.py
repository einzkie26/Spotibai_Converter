import asyncio
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
import wave
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import conversion_engine as engine


URL = "https://open.spotify.com/album/Album123"
SONG = {"name": "First Song", "artist": "Artist", "artists": ["Artist"],
        "url": "https://open.spotify.com/track/Track1", "album_name": "Album",
        "track_number": 1, "genres": None, "isrc": None, "cover_url": ""}
ITEM = {"spotdl_data": SONG, "source_url": SONG["url"]}


def write_audio(path):
    with wave.open(str(path), "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(8000)
        audio.writeframes(b"\x01\x00" * 800)


class CacheTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="convotify-engine-test-")
        self.root = Path(self.temporary.name)
        self.session = engine.DownloadSession("ffmpeg", "wav", "160k", cache_dir=self.root / "cache")

    def tearDown(self):
        self.session.close()
        self.temporary.cleanup()

    def produce(self, item, output_dir):
        path = output_dir / "audio.wav"
        write_audio(path)
        return path

    def test_metadata_cache_canonicalizes_links_and_preserves_order(self):
        songs = [SONG, {**SONG, "name": "Second", "url": "https://open.spotify.com/track/Track2"}]
        with patch.object(engine, "_fetch_metadata", return_value=songs) as fetch:
            first, cached = engine.read_metadata(URL + "?si=one", self.root)
            self.assertFalse(cached)
            second, cached = engine.read_metadata(URL.replace("/album/", "/intl-en/album/") + "?si=two", self.root)
            self.assertTrue(cached)
        fetch.assert_called_once_with(URL)
        self.assertEqual(first, second)
        self.assertEqual([row["name"] for row in second], ["First Song", "Second"])

    def test_corrupt_and_expired_metadata_are_refetched(self):
        with patch.object(engine, "_fetch_metadata", return_value=[SONG]) as fetch:
            engine.read_metadata(URL, self.root)
            path = next((self.root / "metadata").glob("*.json"))
            path.write_text("broken")
            self.assertFalse(engine.read_metadata(URL, self.root)[1])
            data = json.loads(path.read_text())
            data["created"] = 0
            path.write_text(json.dumps(data))
            self.assertFalse(engine.read_metadata(URL, self.root)[1])
        self.assertEqual(fetch.call_count, 3)

    def test_empty_metadata_is_never_cached(self):
        with patch.object(engine, "_fetch_metadata", return_value=[]):
            with self.assertRaisesRegex(RuntimeError, "No tracks found"):
                engine.read_metadata(URL, self.root)
        self.assertFalse(list(self.root.rglob("*.json")))

    def test_duplicate_requests_share_one_download_and_keep_separate_files(self):
        with patch.object(self.session, "_produce", side_effect=self.produce) as produce:
            with ThreadPoolExecutor(max_workers=4) as pool:
                results = list(pool.map(lambda index: self.session.download(ITEM, self.root / str(index)), range(8)))
        self.assertEqual(produce.call_count, 1)
        self.assertEqual(sum(result["cached"] for result in results), 7)
        self.assertEqual(len({result["path"] for result in results}), 8)
        self.assertTrue(all(engine.usable_audio(Path(result["path"])) for result in results))

    def test_corrupt_cached_audio_is_downloaded_again(self):
        with patch.object(self.session, "_produce", side_effect=self.produce) as produce:
            self.session.download(ITEM, self.root / "first")
            next((self.root / "cache" / "audio").glob("*.wav")).write_bytes(b"partial download")
            result = self.session.download(ITEM, self.root / "second")
        self.assertEqual(produce.call_count, 2)
        self.assertFalse(result["cached"])
        self.assertTrue(engine.usable_audio(Path(result["path"])))

    def test_processing_options_never_share_an_encode(self):
        other = engine.DownloadSession("ffmpeg", "wav", "320k", audio_filter="anull", cache_dir=self.root / "cache")
        try:
            with patch.object(self.session, "_produce", side_effect=self.produce) as first:
                self.session.download(ITEM, self.root / "first")
            with patch.object(other, "_produce", side_effect=self.produce) as second:
                result = other.download(ITEM, self.root / "second")
            self.assertFalse(result["cached"])
            self.assertEqual(first.call_count + second.call_count, 2)
        finally:
            other.close()


class EncodingTests(unittest.TestCase):
    def test_worker_reuses_downloader_and_fills_optional_tag_fields(self):
        instances = []

        class Downloader:
            def __init__(self, settings):
                self.settings, self.errors = settings, []
                self.loop = asyncio.new_event_loop()
                self.songs = []
                self.progress_handler = SimpleNamespace(update_callback=None)
                instances.append(self)

            async def async_search_and_download(self, song):
                self.songs.append(song)
                for message in ("Searching for song", "Getting audio meta", "Downloading", "Converting", "Embedding metadata"):
                    self.progress_handler.update_callback(SimpleNamespace(progress=50), message)
                path = Path(self.settings["output"]).parent / "audio.wav"
                write_audio(path)
                return song, path

        with tempfile.TemporaryDirectory(prefix="convotify-session-test-") as folder:
            session = engine.DownloadSession("ffmpeg", "wav", "160k", cache_dir=Path(folder) / "cache")
            progress = []
            try:
                with patch.object(engine, "_spotdl_settings", return_value={}):
                    with patch("spotdl.download.downloader.Downloader", Downloader):
                        session.download(ITEM, Path(folder) / "one", on_progress=progress.append)
                        second = {"retry_count": 1, "spotdl_data": {**SONG,
                                  "url": "https://open.spotify.com/track/Track2",
                                  "download_url": "https://example.com/unavailable-source"}}
                        session.download(second, Path(folder) / "two")
                self.assertEqual(len(instances), 1)
                self.assertEqual(len(instances[0].songs), 2)
                self.assertEqual(instances[0].songs[0].genres, [])
                self.assertEqual(instances[0].songs[0].isrc, "")
                self.assertIsNone(instances[0].songs[1].download_url)
                self.assertEqual(second["spotdl_data"]["download_url"], "https://example.com/unavailable-source")
                self.assertEqual(instances[0].settings["lyrics_providers"], [])
                self.assertIn("loudnorm", instances[0].settings["ffmpeg_args"])
                self.assertNotEqual(instances[0].settings["bitrate"], "disable")
                self.assertTrue({"preparing", "downloading", "converting", "finishing"}.issubset({event["state"] for event in progress}))
            finally:
                session.close()

    def test_source_failure_uses_alternate_provider_and_restores_session(self):
        attempts = []
        instances = []

        class Downloader:
            def __init__(self, settings):
                self.settings, self.errors = settings, []
                self.audio_providers = ["music", "youtube"]
                self.loop = asyncio.new_event_loop()
                instances.append(self)

            async def async_search_and_download(self, song):
                attempts.append(list(self.audio_providers))
                if len(self.audio_providers) == 2:
                    self.errors.append("AudioProviderError: source unavailable")
                    return song, None
                path = Path(self.settings["output"]).parent / "audio.wav"
                write_audio(path)
                return song, path

        with tempfile.TemporaryDirectory(prefix="convotify-fallback-test-") as folder:
            session = engine.DownloadSession("ffmpeg", "wav", "160k", cache_dir=Path(folder) / "cache")
            try:
                with patch.object(engine, "_spotdl_settings", return_value={}):
                    with patch("spotdl.download.downloader.Downloader", Downloader):
                        result = session.download(ITEM, Path(folder) / "audio")
                self.assertTrue(engine.usable_audio(Path(result["path"])))
                self.assertEqual(attempts, [["music", "youtube"], ["youtube"]])
                self.assertEqual(instances[0].audio_providers, ["music", "youtube"])
            finally:
                session.close()

    def test_real_bridge_reuses_cached_audio_and_handles_unicode(self):
        with tempfile.TemporaryDirectory(prefix="convotify-bridge-test-") as folder:
            root = Path(folder)
            session = engine.DownloadSession("ffmpeg", "wav", "160k", cache_dir=root / "cache")
            item = {"spotdl_data": {**SONG, "name": "最后一首歌"}, "source_url": SONG["url"],
                    "title": "最后一首歌", "artist": "Artist", "album": "Album", "cover_url": ""}

            def produce(track, output_dir):
                path = output_dir / "audio.wav"
                write_audio(path)
                return path

            try:
                with patch.object(session, "_produce", side_effect=produce):
                    session.download(item, root / "seed")
                requests = [{"index": i, "track": item, "output_dir": str(root / str(i)), "save_library": True} for i in range(6)]
                result = subprocess.run([sys.executable, str(Path(engine.__file__)), "serve",
                                         "--ffmpeg", "ffmpeg", "--format", "wav", "--bitrate", "160k"],
                                        input="".join(json.dumps(row, ensure_ascii=False) + "\n" for row in requests),
                                        capture_output=True, text=True, encoding="utf-8", timeout=20,
                                        env={**os.environ, "CONVOTIFY_CACHE_DIR": str(root / "cache"),
                                             "CONVOTIFY_LIBRARY_DIR": str(root / "library")})
                self.assertEqual(result.returncode, 0, result.stderr)
                messages = [json.loads(line) for line in result.stdout.splitlines()]
                events = [event for event in messages if event["type"] == "result"]
                self.assertTrue(any(event["type"] == "progress" and event["state"] == "preparing" for event in messages))
                self.assertEqual(len(events), 6)
                self.assertTrue(all(row["success"] and row["cached"] for row in events))
                self.assertTrue(all(engine.usable_audio(Path(row["path"])) for row in events))
                self.assertTrue(all("最后一首歌" in row["path"] for row in events))
                with sqlite3.connect(root / "library" / "library.db") as database:
                    self.assertEqual(database.execute("SELECT count(*) FROM tracks").fetchone()[0], 1)
                database.close()
                self.assertTrue(engine.usable_audio(root / "library" / "Artist - 最后一首歌.wav"))
            finally:
                session.close()

    def test_real_ffmpeg_encodes_all_formats_with_one_filter_pass(self):
        local = Path(__file__).resolve().parents[1] / ".venv" / "Scripts" / "ffmpeg.exe"
        ffmpeg = str(local) if local.is_file() else shutil.which("ffmpeg")
        if not ffmpeg:
            self.skipTest("FFmpeg is not installed")
        from spotdl.utils.ffmpeg import convert

        with tempfile.TemporaryDirectory(prefix="convotify-formats-test-") as folder:
            root = Path(folder)
            source = root / "source.wav"
            subprocess.run([ffmpeg, "-v", "error", "-y", "-f", "lavfi", "-i",
                            "sine=frequency=440:duration=0.4:sample_rate=44100", str(source)], check=True)
            for fmt in ("mp3", "wav", "flac", "alac", "aac"):
                with self.subTest(fmt=fmt):
                    sdk_format = "m4a" if fmt in {"aac", "alac"} else fmt
                    target = root / f"output-{fmt}.{sdk_format}"
                    ok, error = convert(source, target, ffmpeg=ffmpeg, output_format=sdk_format,
                                        bitrate="160k", ffmpeg_args=engine.ffmpeg_arguments(fmt, engine.NORMAL_FILTER))
                    self.assertTrue(ok, error)
                    self.assertTrue(engine.usable_audio(target))
                    probe = str(Path(ffmpeg).with_name("ffprobe.exe")) if local.is_file() else shutil.which("ffprobe")
                    if probe:
                        codec = subprocess.check_output([probe, "-v", "error", "-select_streams", "a:0",
                                                         "-show_entries", "stream=codec_name", "-of", "csv=p=0", str(target)], text=True).strip()
                        self.assertEqual(codec, {"mp3": "mp3", "wav": "pcm_s16le", "flac": "flac", "aac": "aac", "alac": "alac"}[fmt])
                    if fmt == "aac":
                        adts = target.with_suffix(".aac")
                        subprocess.run([ffmpeg, "-v", "error", "-y", "-i", str(target), "-c:a", "copy", "-f", "adts", str(adts)], check=True)
                        self.assertTrue(engine.usable_audio(adts))


if __name__ == "__main__":
    unittest.main()
