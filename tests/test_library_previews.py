import array
import io
import math
import os
import subprocess
import tempfile
import unittest
import wave
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

import app
import preview_engine
from mutagen.mp3 import MP3
from stem_engine import stem_path


def tone(path, frequency, seconds=1):
    samples = array.array("h", (int(12000 * math.sin(2 * math.pi * frequency * i / 8000))
                                for i in range(int(seconds * 8000))))
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(8000)
        output.writeframes(samples.tobytes())


class LibraryPreviewTests(unittest.TestCase):
    def setUp(self):
        self.ffmpeg = app.find_ffmpeg()
        if self.ffmpeg is None:
            self.skipTest("FFmpeg is required for real preview validation")
        self.temporary = tempfile.TemporaryDirectory(prefix="library-preview-test-")
        self.root = Path(self.temporary.name)
        self.patches = [patch.object(app, "LIBRARY_DIR", self.root),
                        patch.object(app, "LIBRARY_DB", self.root / "library.db")]
        for item in self.patches:
            item.start()
        source = self.root / "fixture.wav"
        tone(source, 220)
        app.library_save({"title": "Song", "artist": "Artist"}, source, "wav", "160k")
        with closing(app._db()) as db:
            row = db.execute("SELECT * FROM tracks").fetchone()
        self.source = self.root / row["filename"]
        self.url = f"/library/tracks/{row['id']}/preview"
        self.client = app.app.test_client()

    def tearDown(self):
        for item in reversed(getattr(self, "patches", [])):
            item.stop()
        if hasattr(self, "temporary"):
            self.temporary.cleanup()

    def get(self, query="", **kwargs):
        with self.client.get(self.url + query, **kwargs) as response:
            return response.status_code, response.data, dict(response.headers)

    def frequency(self, mp3):
        result = subprocess.run([
            str(self.ffmpeg), "-nostdin", "-hide_banner", "-loglevel", "error",
            "-i", "pipe:0", "-ac", "1", "-ar", "8000", "-f", "s16le", "pipe:1",
        ], input=mp3, capture_output=True, check=True, timeout=10)
        samples = array.array("h", result.stdout)
        # Skip encoder padding at the edges when counting upward zero crossings.
        samples = samples[400:-400]
        crossings = sum(a <= 0 < b for a, b in zip(samples, samples[1:]))
        return crossings * 8000 / len(samples)

    def test_original_and_each_stem_preview_contain_the_selected_audio_and_reuse_clips(self):
        for stem, frequency in (("vocals", 440), ("instrumental", 880)):
            tone(self.root / stem_path(self.source, stem, "wav").name, frequency)
        with patch.object(preview_engine.subprocess, "run", wraps=subprocess.run) as encode:
            clips = []
            for query in ("", "?stem=vocals", "?stem=instrumental"):
                status, data, headers = self.get(query)
                self.assertEqual(status, 200)
                self.assertEqual(headers["Content-Type"], "audio/mpeg")
                self.assertTrue(headers["Content-Disposition"].startswith("inline;"))
                self.assertGreater(MP3(io.BytesIO(data)).info.length, 0)
                self.assertEqual(self.get(query)[1], data)
                clips.append(data)
            self.assertEqual(encode.call_count, 3, "Replays must not run FFmpeg again")
        for data, expected in zip(clips, (220, 440, 880)):
            self.assertAlmostEqual(self.frequency(data), expected, delta=5)

    def test_short_tracks_play_and_browser_revalidation_can_reuse_the_clip(self):
        status, data, headers = self.get()
        self.assertEqual(status, 200)
        self.assertLess(MP3(io.BytesIO(data)).info.length, 2)
        status, data, _ = self.get(headers={"If-None-Match": headers["ETag"]})
        self.assertEqual(status, 304)
        self.assertEqual(data, b"")

    def test_long_tracks_preview_seven_seconds_from_the_same_thirty_second_offset(self):
        tone(self.source, 220, seconds=30)
        with wave.open(str(self.source), "rb") as first:
            samples = first.readframes(first.getnframes())
        tail = self.root / "tail.wav"
        tone(tail, 880, seconds=8)
        with wave.open(str(tail), "rb") as second:
            samples += second.readframes(second.getnframes())
        with wave.open(str(self.source), "wb") as output:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(8000)
            output.writeframes(samples)
        status, data, _ = self.get()
        self.assertEqual(status, 200)
        self.assertAlmostEqual(MP3(io.BytesIO(data)).info.length, 7, delta=.25)
        self.assertAlmostEqual(self.frequency(data), 880, delta=5)

    def test_changed_source_invalidates_the_preview_cache_and_legacy_stem(self):
        tone(self.root / stem_path(self.source, "vocals", "wav").name, 440)
        _, first, _ = self.get()
        old = self.source.stat()
        tone(self.source, 660)
        os.utime(self.source, ns=(old.st_atime_ns, old.st_mtime_ns + 1_000_000_000))
        status, second, _ = self.get()
        self.assertEqual(status, 200)
        self.assertNotEqual(first, second)
        self.assertAlmostEqual(self.frequency(second), 660, delta=5)
        self.assertEqual(self.get("?stem=vocals")[0], 409)

    def test_unprepared_invalid_and_missing_sources_return_useful_errors_without_running_ffmpeg(self):
        with patch.object(preview_engine.subprocess, "run") as encode:
            status, data, _ = self.get("?stem=vocals")
            self.assertEqual(status, 409)
            self.assertIn(b'"needs_preparation":true', data)
            self.assertEqual(self.get("?stem=drums")[0], 400)
            with self.client.get("/library/tracks/999/preview") as missing:
                self.assertEqual(missing.status_code, 404)
            self.source.unlink()
            self.assertEqual(self.get()[0], 404)
            encode.assert_not_called()


if __name__ == "__main__":
    unittest.main()
