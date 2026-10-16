import sqlite3
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

import app


class CollectionShelfTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="library-shelves-test-")
        self.root = Path(self.temp.name)
        self.source = self.root / "source.mp3"
        self.source.write_bytes(b"test audio")
        self.library = self.root / "library"
        self.library.mkdir()
        self.patches = [patch.object(app, "LIBRARY_DIR", self.library), patch.object(app, "LIBRARY_DB", self.library / "library.db")]
        for item in self.patches:
            item.start()
        self.client = app.app.test_client()

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.temp.cleanup()

    def save(self, track="Track1", collection="Playlist1", position=1, **fields):
        meta = {"title": "Song", "artist": "Artist", "album": "Original Album",
                "source_url": f"https://open.spotify.com/track/{track}",
                "collection_url": f"https://open.spotify.com/playlist/{collection}",
                "collection_name": collection, "collection_position": position, "collection_total": 2, **fields}
        app.library_save(meta, self.source, "mp3", "160k")

    def shelves(self):
        return self.client.get("/library/collections").json

    def test_shared_song_belongs_to_two_shelves_without_duplicate_audio(self):
        self.save()
        self.save(collection="Playlist2")
        data = self.shelves()
        self.assertEqual(data["total_tracks"], 1)
        self.assertEqual(len(data["collections"]), 2)
        for shelf in data["collections"]:
            tracks = self.client.get(f"/library/tracks?collection_id={shelf['id']}").json
            self.assertEqual([track["album"] for track in tracks], ["Original Album"])
            self.assertEqual(shelf["saved_entries"], 1)
            self.assertFalse(shelf["complete"])

    def test_duplicate_titles_with_different_spotify_ids_keep_both_files(self):
        self.save()
        self.source.write_bytes(b"second audio")
        self.save(track="Track2", position=2)
        tracks = self.client.get("/library/tracks").json
        self.assertEqual(len(tracks), 2)
        self.assertEqual(len({track["filename"] for track in tracks}), 2)
        self.assertEqual({(self.library / track["filename"]).read_bytes() for track in tracks}, {b"test audio", b"second audio"})
        shelf = self.shelves()["collections"][0]
        self.assertTrue(shelf["complete"])

    def test_playlist_repeated_song_counts_entries_and_renders_one_card(self):
        self.save(position=2)
        self.save(position=1)
        shelf = self.shelves()["collections"][0]
        self.assertEqual((shelf["saved_entries"], shelf["saved_tracks"]), (2, 1))
        self.assertTrue(shelf["complete"])
        self.assertEqual(len(self.client.get(f"/library/tracks?collection_id={shelf['id']}").json), 1)

    def test_migration_preserves_older_downloads_without_inventing_a_playlist(self):
        with closing(sqlite3.connect(app.LIBRARY_DB)) as db, db:
            db.execute("""CREATE TABLE tracks(id INTEGER PRIMARY KEY, title TEXT NOT NULL, artist TEXT NOT NULL,
                album TEXT NOT NULL,cover_url TEXT,format TEXT,bitrate TEXT,filename TEXT UNIQUE NOT NULL,
                added_at TEXT DEFAULT CURRENT_TIMESTAMP)""")
            db.execute("INSERT INTO tracks(title,artist,album,filename,format) VALUES('Song','Artist','Original Album','Artist - Song.mp3','MP3')")
        (self.library / "Artist - Song.mp3").write_bytes(b"legacy")
        self.assertEqual(self.shelves()["unfiled_tracks"], 1)
        self.assertEqual(len(self.client.get("/library/tracks?collection_id=unfiled").json), 1)
        self.save()
        self.assertEqual(self.shelves()["unfiled_tracks"], 0)
        self.assertEqual(self.shelves()["total_tracks"], 1)
        self.assertEqual(self.client.get("/library/tracks").json[0]["id"], 1)

    def test_collection_order_search_and_deletion_update_membership(self):
        self.save(position=2)
        self.save(track="Track2", position=1, title="Earlier song")
        shelf = self.shelves()["collections"][0]
        tracks = self.client.get(f"/library/tracks?collection_id={shelf['id']}").json
        self.assertEqual([t["title"] for t in tracks], ["Earlier song", "Song"])
        results = self.client.get(f"/library/tracks?collection_id={shelf['id']}&q=earlier").json
        self.assertEqual(len(results), 1)
        self.assertEqual(self.client.delete(f"/library/tracks/{results[0]['id']}").status_code, 200)
        self.assertEqual(self.shelves()["collections"][0]["saved_tracks"], 1)
        self.assertFalse(self.shelves()["collections"][0]["complete"])
        self.assertEqual(self.client.get("/library/tracks?collection_id=bad").status_code, 400)

    def test_parallel_saves_do_not_overwrite_songs_with_identical_titles(self):
        with ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(lambda index: self.save(track=f"Track{index}", position=index, collection_total=4), range(1, 5)))
        with closing(app._db()) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM tracks").fetchone()[0], 4)
        self.assertTrue(self.shelves()["collections"][0]["complete"])

    def test_changed_playlist_rebuilds_membership_without_claiming_old_entries_are_complete(self):
        self.save(collection_revision="first")
        self.save(track="Track2", position=2, collection_revision="first")
        self.assertTrue(self.shelves()["collections"][0]["complete"])
        self.save(track="Track3", position=1, collection_revision="changed")
        shelf = self.shelves()["collections"][0]
        self.assertEqual(shelf["saved_entries"], 1)
        self.assertFalse(shelf["complete"])
        self.assertEqual(self.shelves()["total_tracks"], 3)
        self.assertEqual(self.shelves()["unfiled_tracks"], 2)

    def test_same_source_in_two_formats_keeps_both_audio_files(self):
        meta = {"title": "Song", "artist": "Artist", "album": "Album", "source_url": "https://open.spotify.com/track/One"}
        source = self.source.with_suffix(".m4a")
        source.write_bytes(b"aac")
        app.library_save(meta, source, "aac", "160k")
        source.write_bytes(b"alac")
        app.library_save(meta, source, "alac", "160k")
        tracks = self.client.get("/library/tracks").json
        self.assertEqual(len(tracks), 2)
        self.assertEqual({(self.library / t["filename"]).read_bytes() for t in tracks}, {b"aac", b"alac"})
