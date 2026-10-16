import queue
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

import app
import conversion_engine as engine


class CollectionQueueTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="collection-queue-test-")
        self.root = Path(self.temporary.name)
        self.patches = [patch.object(app, "JOBS", {}), patch.object(app, "JOBS_DIR", self.root),
                        patch.object(app, "find_ffmpeg", return_value=Path("ffmpeg"))]
        for item in self.patches:
            item.start()

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.temporary.cleanup()

    def test_preview_verifies_title_and_warns_at_200_without_enriching_songs(self):
        for count in (199, 200, 201):
            url = f"https://open.spotify.com/playlist/List{count}"
            rows = [{"name": f"Song {i}", "url": f"https://open.spotify.com/track/Track{i}",
                     "list_name": "周末 Playlist"} for i in range(count)]
            with patch.object(engine, "_fetch_metadata", return_value=rows) as fetch:
                with patch.object(engine, "_enrich_playlist", return_value=rows) as enrich:
                    preview = engine.inspect_collection(url, self.root)
                    self.assertEqual(preview["name"], "周末 Playlist")
                    self.assertEqual(preview["large_playlist"], count >= 200)
                    enrich.assert_not_called()
                    engine.read_metadata(url, self.root)
                    enrich.assert_called_once()
                    fetch.assert_called_once()

    def test_preview_route_validates_links_and_reports_lookup_errors(self):
        with app.app.test_client() as client:
            self.assertEqual(client.post("/collections/preview", json={"url": "https://example.com/album/a"}).status_code, 400)
            with patch.object(app, "inspect_collection", return_value={"name": "Album", "total": 14}):
                self.assertEqual(client.post("/collections/preview", json={"url": "https://open.spotify.com/album/Abc"}).json["name"], "Album")
            with patch.object(app, "inspect_collection", side_effect=RuntimeError("Album unavailable")):
                self.assertEqual(client.post("/collections/preview", json={"url": "https://open.spotify.com/album/Abc"}).status_code, 502)

    def test_five_links_become_separate_ordered_jobs_and_six_are_rejected(self):
        urls = [f"https://open.spotify.com/album/Album{i}" for i in range(6)]
        with app.app.test_client() as client, patch.object(app, "enqueue_conversions") as enqueue:
            self.assertEqual(client.post("/convert", json={"urls": urls}).status_code, 400)
            enqueue.assert_not_called()
            response = client.post("/convert", json={"urls": urls[:5], "collections": [
                {"url": url, "name": f"Collection {i}"} for i, url in enumerate(urls[:5])]})
            self.assertEqual(response.status_code, 200)
            jobs = response.json["jobs"]
            self.assertEqual(len(jobs), 5)
            self.assertEqual([job["batch_position"] for job in jobs], list(range(5)))
            self.assertEqual([job["urls"] for job in jobs], [[url] for url in urls[:5]])
            self.assertTrue(all(job["state"] == "queued" for job in jobs))
            self.assertEqual(len(enqueue.call_args.args[0]), 5)
            duplicates = [urls[0], urls[0].replace('/album/', '/intl-en/album/') + '?si=share']
            self.assertEqual(client.post("/convert", json={"urls": duplicates}).status_code, 400)

    def test_dispatch_waits_for_previous_collection_and_continues_after_failure(self):
        requests = queue.Queue()
        entered = threading.Event()
        release = threading.Event()
        finished = threading.Event()
        order = []
        app.JOBS.update({name: {"urls": [name], "format": "mp3", "bitrate": "160", "link_type": "album", "state": "queued"}
                         for name in ("first", "second")})

        def convert(job_id, *args):
            order.append(job_id)
            if job_id == "first":
                entered.set()
                if not release.wait(3):
                    raise RuntimeError("Test queue stalled")
                raise RuntimeError("Source unavailable")
            finished.set()

        with patch.object(app, "CONVERSION_QUEUE", requests), patch.object(app, "QUEUE_WORKER", None):
            with patch.object(app, "convert_job", side_effect=convert):
                app.enqueue_conversions([("first", Path("ffmpeg"), None), ("second", Path("ffmpeg"), None)])
                try:
                    self.assertTrue(entered.wait(2))
                    self.assertEqual(order, ["first"])
                    self.assertEqual(app.JOBS["second"]["state"], "queued")
                    release.set()
                    self.assertTrue(finished.wait(2))
                    self.assertEqual(order, ["first", "second"])
                    self.assertEqual(app.JOBS["first"]["state"], "error")
                finally:
                    release.set()
                    requests.put(None)
                    app.QUEUE_WORKER.join(timeout=3)
