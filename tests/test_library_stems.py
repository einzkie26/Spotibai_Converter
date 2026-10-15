import json
import tempfile
import threading
import time
import unittest
import wave
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

import app
from stem_engine import StemService, ready_stem, stem_path


def audio_file(path, frames=800):
    with wave.open(str(path), "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(8000)
        audio.writeframes(b"\x01\x00" * frames)


class LibraryStemTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="library-stems-test-")
        self.root = Path(self.temporary.name)
        self.library = self.root / "library"
        self.library.mkdir()
        self.service = StemService()
        self.gate = threading.Event()
        self.gate.set()
        self.patches = [patch.object(app, "LIBRARY_DIR", self.library),
                        patch.object(app, "LIBRARY_DB", self.library / "library.db"),
                        patch.object(app, "STEM_SERVICE", self.service),
                        patch.object(app, "find_ffmpeg", return_value=Path("ffmpeg")),
                        patch.object(self.service, "_infer", side_effect=self.infer),
                        patch.object(self.service, "_encode", side_effect=self.encode)]
        self.mocks = [item.start() for item in self.patches]
        self.source = self.root / "source.wav"
        audio_file(self.source)
        app.library_save({"title": "Song", "artist": "Artist", "album": "Album", "cover_url": ""}, self.source, "wav", "160k")
        with closing(app._db()) as db:
            row = db.execute("SELECT * FROM tracks").fetchone()
        self.track_id = row["id"]
        self.source = self.library / row["filename"]

    def tearDown(self):
        self.gate.set()
        self.service.close()
        for item in reversed(self.patches):
            item.stop()
        self.temporary.cleanup()

    def infer(self, source, progress, ffmpeg):
        if not self.gate.wait(5):
            raise RuntimeError("Test separation stalled")
        progress(50, "Separating audio")
        return {"vocals": None, "instrumental": None}, 8000

    def encode(self, samples, samplerate, target, fmt, bitrate, ffmpeg):
        audio_file(target)

    def wait(self, job_id):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            job = self.service.snapshot(job_id, self.track_id)
            if job["state"] in {"done", "error"}:
                return job
            time.sleep(.01)
        self.fail("Separation did not finish")

    def start(self, stem="vocals"):
        with app.app.test_client() as client:
            response = client.post(f"/library/tracks/{self.track_id}/separate", json={"stem": stem})
        self.assertEqual(response.status_code, 202)
        return response.json["sep_id"]

    def test_conversion_routes_cannot_generate_or_download_stems(self):
        with app.app.test_client() as client:
            self.assertEqual(client.post("/convert/old/tracks/0/separate", json={"stem": "vocals"}).status_code, 410)
            self.assertEqual(client.get("/convert/old/tracks/0/download?stem=instrumental").status_code, 410)
        self.mocks[4].assert_not_called()

    def test_parallel_vocal_and_instrumental_requests_share_work(self):
        self.gate.clear()
        first = self.start("vocals")
        second = self.start("instrumental")
        self.assertEqual(first, second)
        self.gate.set()
        self.assertEqual(self.wait(first)["state"], "done")
        self.assertEqual(self.mocks[4].call_count, 1)
        self.assertEqual(self.mocks[5].call_count, 2)
        self.assertIsNotNone(ready_stem(self.source, "vocals", "wav", "160k"))
        self.assertIsNotNone(ready_stem(self.source, "instrumental", "wav", "160k"))

    def test_prepared_other_stem_skips_inference_and_reencoding(self):
        self.assertEqual(self.wait(self.start())["state"], "done")
        job = self.service.snapshot(self.start("instrumental"), self.track_id)
        self.assertEqual(job["state"], "done")
        self.assertTrue(job["cached"])
        self.assertEqual(self.mocks[4].call_count, 1)
        self.assertEqual(self.mocks[5].call_count, 2)

    def test_existing_library_stems_remain_available_without_loading_a_model(self):
        legacy = self.source.parent / stem_path(self.source, "vocals", "wav").name
        audio_file(legacy)
        job_id = self.start()
        self.assertTrue(self.service.snapshot(job_id, self.track_id)["cached"])
        self.mocks[4].assert_not_called()

    def test_formats_with_the_same_output_extension_have_separate_cache_paths(self):
        self.assertNotEqual(stem_path(self.source.with_suffix(".aac"), "vocals", "aac"),
                            stem_path(self.source.with_suffix(".m4a"), "vocals", "alac"))

    def test_preparing_missing_legacy_stem_keeps_both_stems_available(self):
        legacy = self.source.parent / stem_path(self.source, "vocals", "wav").name
        audio_file(legacy)
        self.assertEqual(self.wait(self.start("instrumental"))["state"], "done")
        self.assertEqual(self.mocks[4].call_count, 1)
        self.assertEqual(self.mocks[5].call_count, 1)
        for stem in ("vocals", "instrumental"):
            self.assertIsNotNone(ready_stem(self.source, stem, "wav", "160k"))
        self.assertTrue(legacy.exists())

    def test_finished_progress_can_be_read_twice_and_is_bound_to_track(self):
        job_id = self.start()
        self.wait(job_id)
        with app.app.test_client() as client:
            path = f"/library/tracks/{self.track_id}/separate/{job_id}/events"
            for _ in range(2):
                event = json.loads(client.get(path).data.decode().strip().removeprefix("data: "))
                self.assertEqual(event["state"], "done")
            self.assertEqual(client.get(f"/library/tracks/999/separate/{job_id}/status").status_code, 404)
            self.assertEqual(client.get(f"/library/tracks/999/separate/{job_id}/events").status_code, 404)

    def test_changed_source_invalidates_prepared_stems(self):
        self.wait(self.start())
        audio_file(self.source, frames=1600)
        self.assertIsNone(ready_stem(self.source, "vocals", "wav", "160k"))
        self.assertEqual(self.wait(self.start())["state"], "done")
        self.assertEqual(self.mocks[4].call_count, 2)

    def test_failed_separation_is_reported_without_a_downloadable_partial_file(self):
        self.mocks[4].side_effect = RuntimeError("Source separation failed")
        job_id = self.start()
        job = self.wait(job_id)
        self.assertEqual(job["state"], "error")
        self.assertIn("failed", job["msg"])
        self.assertFalse(stem_path(self.source, "vocals", "wav").exists())
        with app.app.test_client() as client:
            self.assertEqual(client.get(f"/library/tracks/{self.track_id}/download?stem=vocals").status_code, 409)

    def test_original_and_prepared_downloads_are_available_in_library(self):
        self.wait(self.start())
        with app.app.test_client() as client:
            for query in ("", "?stem=vocals", "?stem=instrumental"):
                response = client.get(f"/library/tracks/{self.track_id}/download{query}")
                self.assertEqual(response.status_code, 200)
                self.assertGreater(len(response.data), 0)
                response.close()


if __name__ == "__main__":
    unittest.main()
