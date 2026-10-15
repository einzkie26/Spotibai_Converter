import json
import shutil
import subprocess
import tempfile
import threading
import unittest
import wave
import zipfile
from collections import Counter
from contextlib import closing
from copy import deepcopy
from pathlib import Path
from urllib.parse import unquote
from unittest.mock import patch

import app as converter


ALBUM_URL = "https://open.spotify.com/intl-en/album/Album123?si=shared"
SONGS = [
    {"name": "First Song", "artist": "Artist", "album_name": "Album",
     "url": "https://open.spotify.com/track/Track1", "track_number": 1,
     "cover_url": "https://example.com/cover.jpg"},
    {"name": "First Song", "artist": "Artist", "album_name": "Album",
     "url": "https://open.spotify.com/track/Track2", "track_number": 2,
     "cover_url": "https://example.com/cover.jpg"},
    {"name": "最后一首歌", "artist": "歌手", "album_name": "Album",
     "url": "https://open.spotify.com/track/Track3", "track_number": 3,
     "cover_url": "https://example.com/cover.jpg"},
]


class AlbumTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="convotify-test-")
        self.root = Path(self.temporary.name)
        self.job_dir = self.root / "job"
        self.job_dir.mkdir()
        self.library = self.root / "library"
        self.library.mkdir()
        self.jobs = self.root / "jobs"
        self.jobs.mkdir()
        self.patches = [
            patch.object(converter, "JOBS_DIR", self.jobs),
            patch.object(converter, "LIBRARY_DIR", self.library),
            patch.object(converter, "LIBRARY_DB", self.library / "library.db"),
            patch.object(converter, "fetch_cover", return_value=None),
            patch.object(converter.DownloadSession, "download", side_effect=self.fake_download),
        ]
        for item in self.patches:
            item.start()
        self.job_id = "album-regression-test"
        converter.JOBS[self.job_id] = {
            "job_dir": self.job_dir, "cancelled": set(), "format": "wav",
            "bitrate": "160", "link_type": "album", "urls": [ALBUM_URL],
            "state": "metadata", "tracks": [], "total": 0, "completed": 0,
        }
        self.downloads = []
        self.observed_track_lists = []
        self.failed_urls = set()
        self.record_lock = threading.Lock()

    def tearDown(self):
        converter.JOBS.pop(self.job_id, None)
        for item in reversed(self.patches):
            item.stop()
        self.temporary.cleanup()

    def fake_subprocess(self, command, **kwargs):
        if "save" in command:
            save_path = Path(command[command.index("--save-file") + 1])
            save_path.write_text(json.dumps(SONGS), encoding="utf-8")
        elif "download" in command:
            url = command[command.index("download") + 1]
            with self.record_lock:
                self.downloads.append(url)
                self.observed_track_lists.append(list(converter.JOBS[self.job_id]["tracks"]))
            if url in self.failed_urls:
                return subprocess.CompletedProcess(command, 1, "", "Audio source unavailable")
            song = next(song for song in SONGS if song["url"] == url)
            output = command[command.index("--output") + 1]
            output = output.replace("{artist}", song["artist"]).replace("{title}", song["name"])
            output = output.replace("{output-ext}", "wav")
            with wave.open(output, "wb") as audio:
                audio.setnchannels(1)
                audio.setsampwidth(2)
                audio.setframerate(8000)
                audio.writeframes(bytes([song["track_number"], 0]) * 800)
        else:
            source = command[command.index("-i") + 1]
            shutil.copy2(source, command[-1])
        return subprocess.CompletedProcess(command, 0, "", "")

    def fake_download(self, item, output_dir, on_progress=None):
        if on_progress:
            for state in ("preparing", "downloading", "converting"):
                on_progress({"state": state, "message": state, "progress_pct": 50})
        command = ["download", item["source_url"], "--output",
                   str(output_dir / "{artist} - {title}.{output-ext}")]
        result = converter.subprocess.run(command)
        if result.returncode:
            raise RuntimeError(result.stderr)
        return {"path": str(next(output_dir.glob("*.wav"))), "cached": False}

    def run_job(self, link_type="album", urls=None):
        with patch.object(converter.subprocess, "run", side_effect=self.fake_subprocess):
            converter.convert_job(self.job_id, urls or [ALBUM_URL], Path("ffmpeg"),
                                  "wav", "160k", link_type)
        return converter.JOBS[self.job_id]

    def test_album_metadata_is_loaded_without_downloading_audio(self):
        progress = []
        with patch.object(converter.subprocess, "run", side_effect=self.fake_subprocess) as runner:
            metadata = converter.load_metadata(ALBUM_URL, self.job_dir / "meta.spotdl",
                                               on_item=lambda *args: progress.append(args))
        self.assertEqual(len(metadata), 3)
        self.assertEqual(metadata[2]["title"], "最后一首歌")
        self.assertEqual(metadata[0]["album"], "Album")
        self.assertEqual([item[:2] for item in progress], [(1, 3), (2, 3), (3, 3)])
        command = runner.call_args.args[0]
        self.assertIn("save", command)
        self.assertNotIn("download", command)
        self.assertIn("https://open.spotify.com/album/Album123", command)

    def test_album_tracks_are_published_as_they_are_discovered_and_zipped(self):
        job = self.run_job()
        self.assertEqual(job["state"], "complete", job.get("error"))
        self.assertEqual((job["completed"], job["total"]), (3, 3))
        self.assertTrue(all(1 <= len(tracks) <= 3 for tracks in self.observed_track_lists))
        self.assertEqual([track["state"] for track in job["tracks"]], ["converted"] * 3)
        with zipfile.ZipFile(job["archive_path"]) as archive:
            self.assertEqual(len(archive.namelist()), 3)
            self.assertEqual(len(set(archive.namelist())), 3)
        with converter.app.test_client() as client:
            first = client.get(f"/convert/{self.job_id}/tracks/0/download")
            second = client.get(f"/convert/{self.job_id}/tracks/1/download")
            self.assertEqual(first.status_code, 200)
            self.assertEqual(second.status_code, 200)
            self.assertNotEqual(first.data, second.data)
            first.close()
            second.close()
        with closing(converter._db()) as database:
            self.assertEqual(database.execute("SELECT count(*) FROM tracks").fetchone()[0], 2)

    def test_first_track_starts_while_other_metadata_is_still_loading(self):
        with patch.object(converter.subprocess, "run", side_effect=self.fake_subprocess):
            rows = converter.load_metadata(ALBUM_URL, self.job_dir / "fixture.spotdl")
        first_download = threading.Event()
        seen_states = []

        def load(url, save_path, env, on_track):
            for count, row in enumerate(rows, 1):
                on_track(row, count, len(rows))
                if count == 1:
                    self.assertTrue(first_download.wait(5), "The first track waited for all metadata")

        def download(item, output_dir, on_progress=None):
            first_download.set()
            result = self.fake_download(item, output_dir, on_progress)
            seen_states.append(converter.JOBS[self.job_id]["tracks"][0]["state"])
            return result

        with patch.object(converter, "load_metadata", side_effect=load):
            with patch.object(converter.DownloadSession, "download", side_effect=download):
                job = self.run_job()
        self.assertEqual(job["state"], "complete", job.get("error"))
        self.assertEqual(job["completed"], 3)
        self.assertEqual(len(self.observed_track_lists[0]), 1)
        self.assertIn("converting", seen_states)
        self.assertTrue(job["timings"]["overlapped"])
        self.assertFalse(job["metadata_loading"])

    def test_empty_metadata_reports_a_clear_error(self):
        def empty(command, **kwargs):
            Path(command[command.index("--save-file") + 1]).write_text("[]", encoding="utf-8")
            return subprocess.CompletedProcess(command, 0, "", "")
        with patch.object(converter.subprocess, "run", side_effect=empty):
            with self.assertRaisesRegex(RuntimeError, "No tracks found"):
                converter.load_metadata(ALBUM_URL, self.job_dir / "meta.spotdl")

    def test_unreadable_later_album_preserves_successful_tracks(self):
        def run(command, **kwargs):
            if "save" in command and "Album456" in command[command.index("save") + 1]:
                return subprocess.CompletedProcess(command, 1, "", "This album is unavailable")
            return self.fake_subprocess(command, **kwargs)

        with patch.object(converter.subprocess, "run", side_effect=run):
            converter.convert_job(self.job_id, [ALBUM_URL, "https://open.spotify.com/album/Album456"],
                                  Path("ffmpeg"), "wav", "160k", "album")
        job = converter.JOBS[self.job_id]
        self.assertEqual(job["state"], "complete", job.get("error"))
        self.assertEqual((job["completed"], job["total"]), (3, 3))
        self.assertIn("unavailable", job["metadata_errors"][0]["error"])
        with zipfile.ZipFile(job["archive_path"]) as archive:
            self.assertEqual(len(archive.namelist()), 3)

    def test_metadata_timeout_does_not_leave_the_job_loading(self):
        with patch.object(converter.subprocess, "run",
                          side_effect=subprocess.TimeoutExpired("spotdl", 180)):
            converter.convert_job(self.job_id, [ALBUM_URL], Path("ffmpeg"), "wav", "160k", "album")
        job = converter.JOBS[self.job_id]
        self.assertEqual(job["state"], "error")
        self.assertIn("timed out", job["error"])

    def test_failed_downloads_keep_album_tracks_and_explain_the_failure(self):
        self.failed_urls = {song["url"] for song in SONGS}
        job = self.run_job()
        self.assertEqual(job["state"], "error")
        self.assertIn("Audio source unavailable", job["error"])
        self.assertEqual([track["state"] for track in job["tracks"]], ["error"] * 3)
        with converter.app.test_client() as client:
            response = client.get(f"/convert/{self.job_id}/events")
            event = json.loads(response.data.decode().strip().removeprefix("data: "))
            self.assertEqual(len(event["tracks"]), 3)
            self.assertEqual(event["state"], "error")

    def test_partial_album_keeps_total_count_and_only_packages_successes(self):
        self.failed_urls = {SONGS[1]["url"]}
        job = self.run_job()
        self.assertEqual(job["state"], "complete")
        self.assertEqual((job["completed"], job["total"]), (2, 3))
        self.assertEqual(job["tracks"][1]["state"], "error")
        self.assertEqual(Counter(self.downloads), {SONGS[0]["url"]: 1, SONGS[1]["url"]: 2,
                                                  SONGS[2]["url"]: 1})
        self.assertEqual(job["tracks"][1]["retry_count"], 1)
        with zipfile.ZipFile(job["archive_path"]) as archive:
            self.assertEqual(len(archive.namelist()), 2)

    def test_failed_track_prepares_again_only_after_all_initial_attempts_finish(self):
        attempts = Counter()
        retries = []
        snapshots = []
        update = converter.update_job

        def observe(job_id, **fields):
            update(job_id, **fields)
            if "tracks" in fields:
                snapshots.append(deepcopy(fields["tracks"]))

        def transient(item, output_dir, on_progress=None):
            url = item["source_url"]
            with self.record_lock:
                attempts[url] += 1
                attempt = attempts[url]
            if url == SONGS[1]["url"] and attempt == 1:
                # An invalid file must not become a completed track while queued for retry.
                (output_dir / "Artist - First Song.wav").write_bytes(b"incomplete")
                raise RuntimeError("Temporary source failure")
            if attempt == 2:
                job = converter.JOBS[self.job_id]
                retries.append((deepcopy(job["tracks"]), job["metadata_loading"]))
            return self.fake_download(item, output_dir, on_progress)

        with patch.object(converter, "update_job", side_effect=observe):
            with patch.object(converter.DownloadSession, "download", side_effect=transient):
                job = self.run_job()
        self.assertEqual(job["state"], "complete", job.get("error"))
        self.assertEqual((job["completed"], job["total"]), (3, 3))
        self.assertEqual(attempts, {SONGS[0]["url"]: 1, SONGS[1]["url"]: 2, SONGS[2]["url"]: 1})
        retry_tracks, metadata_loading = retries[0]
        self.assertFalse(metadata_loading)
        self.assertEqual([track["state"] for track in retry_tracks], ["converted", "preparing", "converted"])
        self.assertEqual(retry_tracks[1]["error"], "")
        self.assertEqual(retry_tracks[1]["progress_pct"], 0)
        self.assertIn("again", retry_tracks[1]["message"])
        queued = [tracks for tracks in snapshots if len(tracks) == 3 and
                  tracks[1]["retry_count"] and tracks[1]["state"] == "pending"]
        self.assertTrue(queued)
        self.assertEqual(sum(track["state"] == "converted" for track in queued[0]), 2)
        with zipfile.ZipFile(job["archive_path"]) as archive:
            self.assertEqual(len(archive.namelist()), 3)

    def test_user_cancelled_failure_is_excluded_from_final_retry(self):
        def cancel_failure(item, output_dir, on_progress=None):
            if item["source_url"] == SONGS[1]["url"]:
                with converter.app.test_client() as client:
                    response = client.post(f"/convert/{self.job_id}/tracks/1/cancel")
                    self.assertEqual(response.status_code, 200)
                raise RuntimeError("Source unavailable")
            return self.fake_download(item, output_dir, on_progress)

        with patch.object(converter.DownloadSession, "download", side_effect=cancel_failure) as download:
            job = self.run_job()
        self.assertEqual(job["tracks"][1]["state"], "cancelled")
        self.assertEqual(job["tracks"][1]["retry_count"], 0)
        self.assertEqual(download.call_count, 3)
        self.assertEqual(job["completed"], 2)

    def test_zip_uses_collection_title_including_unicode_and_download_headers(self):
        title = "周末 Playlist 🎵"
        for link_type, url in (("album", ALBUM_URL), ("playlist", "https://open.spotify.com/playlist/List123")):
            with self.subTest(link_type=link_type):
                payload = [{**song, "list_name": title} for song in SONGS]

                def named(command, **kwargs):
                    result = self.fake_subprocess(command, **kwargs)
                    if "save" in command:
                        Path(command[command.index("--save-file") + 1]).write_text(json.dumps(payload), encoding="utf-8")
                    return result

                with patch.object(converter.subprocess, "run", side_effect=named):
                    converter.convert_job(self.job_id, [url], Path("ffmpeg"), "wav", "160k", link_type)
                job = converter.JOBS[self.job_id]
                self.assertEqual(job["archive_path"].name, title + ".zip")
                self.assertEqual([track["album"] for track in job["tracks"]], ["Album"] * 3)
                with converter.app.test_client() as client:
                    status = client.get(f"/convert/{self.job_id}/status").json
                    self.assertEqual(status["archive_name"], title + ".zip")
                    events = client.get(f"/convert/{self.job_id}/events")
                    self.assertIn(title + ".zip", json.loads(events.data.decode().strip().removeprefix("data: "))["archive_name"])
                    response = client.get(f"/convert/{self.job_id}/download")
                    self.assertEqual(response.status_code, 200)
                    self.assertEqual(unquote(response.headers["X-Download-Name"]), title + ".zip")
                    self.assertIn("filename*=UTF-8''", response.headers["Content-Disposition"])
                    response.close()
                converter.JOBS[self.job_id] = {"job_dir": self.job_dir, "cancelled": set()}

    def test_archive_names_are_safe_and_keep_distinct_collection_titles(self):
        self.assertEqual(converter.archive_filename([{"collection_name": "CON"}], "album"), "_CON.zip")
        self.assertEqual(converter.archive_filename([{"collection_name": name} for name in ("First", "Second", "First")],
                                                    "playlist"), "First + Second.zip")
        for title in ("../../CON : 周末?/Music\x00", " . ", "🎵" * 300):
            name = converter.archive_filename([{"collection_name": title}], "album")
            self.assertEqual(Path(name).name, name)
            self.assertNotRegex(name, r'[<>:"/\\|?*\x00-\x1f\x7f]')
            self.assertLessEqual(len(name.encode("utf-8")), 185)
        self.assertEqual(converter.archive_filename([], "playlist"), "Spotify playlist.zip")

    def test_skipped_tracks_are_not_downloaded_or_packaged(self):
        converter.JOBS[self.job_id]["cancelled"] = {0}
        job = self.run_job()
        self.assertEqual(job["state"], "complete")
        self.assertNotIn(SONGS[0]["url"], self.downloads)
        self.assertEqual(job["tracks"][0]["state"], "cancelled")
        self.assertEqual(job["completed"], 2)

    def test_cached_stems_and_incomplete_encodings_cannot_replace_album_audio(self):
        job = self.run_job()
        item = job["tracks"][0]
        original = converter.find_track_audio(item, job["output_dir"])
        cached = original.parent / ".stems_cached" / "vocals.wav"
        cached.parent.mkdir()
        shutil.copy2(original, cached)
        shutil.copy2(original, original.with_name(original.stem + ".norm.wav"))
        self.assertEqual(converter.find_track_audio(item, job["output_dir"]), original)
        self.assertEqual(len(converter.find_audio_files(job["output_dir"])), 3)

    def test_invalid_audio_is_reported_as_a_failed_track(self):
        def broken(command, **kwargs):
            result = self.fake_subprocess(command, **kwargs)
            if "download" in command:
                output_dir = Path(command[command.index("--output") + 1]).parent
                for audio in output_dir.glob("*.wav"):
                    audio.write_bytes(b"incomplete audio")
            return result
        with patch.object(converter.subprocess, "run", side_effect=broken):
            converter.convert_job(self.job_id, [ALBUM_URL], Path("ffmpeg"), "wav", "160k", "album")
        job = converter.JOBS[self.job_id]
        self.assertEqual(job["state"], "error")
        self.assertEqual(job["completed"], 0)
        self.assertTrue(all(track["state"] == "error" for track in job["tracks"]))

    def test_single_track_still_downloads_a_single_audio_file(self):
        def single(command, **kwargs):
            if "save" in command:
                Path(command[command.index("--save-file") + 1]).write_text(
                    json.dumps([SONGS[0]]), encoding="utf-8")
                return subprocess.CompletedProcess(command, 0, "", "")
            return self.fake_subprocess(command, **kwargs)
        with patch.object(converter.subprocess, "run", side_effect=single):
            converter.convert_job(self.job_id, [SONGS[0]["url"]], Path("ffmpeg"), "wav", "160k", "track")
        job = converter.JOBS[self.job_id]
        self.assertEqual(job["state"], "complete", job.get("error"))
        self.assertEqual(job["total"], 1)
        self.assertTrue(job["file_path"].is_file())
        self.assertNotIn("archive_path", job)


if __name__ == "__main__":
    unittest.main()
