# Spotibai

A small local Flask app that accepts a Spotify playlist or album URL, uses spotDL and FFmpeg to create MP3 files, and returns one ZIP archive.

Albums and playlists add their tracks to a shared queue as the album metadata is parsed. Each song shows Queued, Preparing, Downloading, Converting, and Done, with separate retry and finishing states. Four workers run in parallel, so ready tracks can continue while others prepare or another queued album loads. Multiple albums stay together in the album panel.

After all initial attempts finish, failed tracks automatically get one final preparation and conversion attempt using the same parallel workers. These tracks move above the completed cards, the panel scrolls to the top once, and an **Automatic retry** label identifies them. Successful tracks are kept and skipped tracks stay skipped. A track that still fails is reported while successful downloads remain available.

The ZIP uses the Spotify playlist or album title, including Unicode names. Multiple collections in one job combine their distinct titles with ` + `. Characters unsupported in filenames are replaced and long names are shortened. Each song retains its original album name in its tags and Library entry.

Use this only for audio you own or are authorized to download. Spotify links are used for metadata; the app does not bypass Spotify access controls.

## Setup

1. Use Python 3.13 (Python 3.11-3.13 is supported), or install [uv](https://docs.astral.sh/uv/getting-started/installation/) to obtain it automatically.
2. From the project folder, run:

   ```powershell
   .\install.cmd
   ```

   The setup script preserves a broken environment in `.venv-backup-*`, creates `.venv`, installs `requirements.txt`, and installs Node dependencies when Node is available. It installs FFmpeg and FFprobe into `.venv\Scripts` from the [Windows build provider linked by FFmpeg](https://ffmpeg.org/download.html); the app detects them automatically.

3. Start the app without activating the environment:

   ```powershell
   .\.venv\Scripts\python.exe app.py
   ```

4. Open http://127.0.0.1:5000.

To use the Node backend, run `node server.js`; it uses the same `.venv` and bundled FFmpeg. Run one backend at a time because both use port 5000.

For a manual Python installation, create `.venv` with Python 3.13 and run `.\.venv\Scripts\python.exe -m pip install -r requirements.txt`. The Python requirements include a fallback FFmpeg binary; install FFprobe as well for ALAC stem separation, or use the setup script to install both tools. Demucs supplies its compatible PyTorch dependency; its current inference runtime uses the included `sphn` audio library. No separate TorchAudio installation is required.

### If pip reports no matching spotDL distribution

Check the interpreter shown by `pip --version`. Python 3.15 cannot install spotDL 4.5, which requires Python below 3.15. Run `.\install.cmd` to install with the project environment, or use the existing environment directly:

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe app.py
```

The `.python-version` file is used by uv; it does not change which interpreter a plain `pip` command uses.

The conversion endpoint runs locally and cleans its temporary files after the ZIP response closes.

## Conversion speed

Both backends use `conversion_engine.py`. Album metadata is fetched in bulk, then reused for downloads. Four workers reuse their spotDL sessions, and normalization runs during the first encode. Lyrics lookups and ZIP recompression are skipped. Album artwork is fetched once and reused. AAC packaging copies the encoded stream instead of encoding it again.

Simplified playlist responses can omit the original album and cover image. Missing details are recovered from each unique track, using up to four reusable metadata sessions, while retaining playlist order and repeated tracks. Complete entries skip this lookup. Recovered track details are cached for a day and shared across playlists; incomplete results can retry after a minute. Existing playlist caches are repaired automatically on use. Each song keeps its original album name and cover. A failed artwork refresh preserves an image already embedded in the audio, and PNG images retain the correct tag type in MP3, FLAC, and M4A files.

The initial album list must arrive from Spotify before its tracks can be shown. After that, each track reports its own source lookup, download, and encoding progress. An unavailable source triggers an alternate-source attempt while the other workers continue. Any remaining failures get one final pass after the first queue settles; this pass clears a saved source URL to start preparation again. Socket waits and retries are bounded, and the ZIP includes successful tracks after all queued work settles. Preparation and conversion overlap; the phase durations in `/convert/<job_id>/status` are not additive when `timings.overlapped` is true.

The network display follows active jobs through metadata, downloads, encoding, and packaging, including jobs restored after a page reload. Both backends read the same computer-wide network counters. Rates use elapsed sample time and show small transfers in bytes per second; the received total retains short bursts even when current traffic falls to zero. Dropped packets and interface errors are shown separately. Unavailable counters show a retry state. Cached metadata and local encoding can correctly use no network, and other applications' traffic is included in these computer-wide measurements.

Metadata and completed audio are cached in `.cache/conversion`. Albums and tracks refresh after one hour; playlists refresh after five minutes. The audio cache keeps up to 512 MiB, evicts older entries, and reuses a file only when the track, format, bitrate, and processing filter match. Concurrent requests for the same encode share one download. Corrupt entries are downloaded again. Removing this cache while the app is stopped forces fresh downloads.

The default is four workers per job. To experiment with another limit, set `$env:CONVOTIFY_WORKERS = "6"` before starting either backend; values are limited to 1–8. More workers can help when downloads are waiting on the network, but can slow a busy CPU or trigger provider limits. Use MP3 at 160 kbps for smaller output files. Lossless output and stem separation require more processing and storage.

## Library downloads and playback

Open **Library → Download** to choose Original, Vocals, or Instrumental. Conversion panels offer the original track and album ZIP downloads. Vocal and instrumental preparation and downloads are available only through the library, in both server modes.

The Library also includes **Multitrack editing — Coming soon**. Expand **Explore the concept** to read about planned vocal editing, chorus and backing-vocal layers, instrument separation, and sound effects, with a proposed separate → arrange → mix → preview/export workflow. This section describes planned editing tools.

Use each track's **Preview → Original / Vocals / Instrumental** menu to listen before downloading. The player offers pause, replay, and a source selector for comparing the three versions. Previews last up to seven seconds, starting at 30 seconds for longer tracks and at the beginning for short tracks. A stem that is not prepared yet shows progress in the right-edge notification; playback then uses the same prepared file as downloads. Closing the player or choosing another source prevents a late preparation result from interrupting the new selection.

Preview clips are cached alongside the selected audio under `.preview-cache`; replaying a valid clip skips encoding. Changing the source file invalidates its preview. Library menus rise above neighboring cards and close on an outside click or Escape.

Click a track card to reveal selection checkboxes, then choose the tracks to remove. **Remove selected** shows the count and asks for confirmation before deletion. **Select all shown** selects the current results; **Cancel** hides the checkboxes and clears the selection. Searching also clears the selection. You can focus a card and press Enter or Space to select it. Preview and Download controls do not change selection. Tracks that fail to delete stay visible and selected for retry.

Notifications stack along the right edge. They show separation progress, then file-transfer progress based on received bytes. Unknown-size transfers use an indeterminate bar. A notification reaches 100% when the full file has arrived and is handed to the browser; errors do not start a download. Progress connections can fall back to status polling without restarting separation.

One Demucs inference prepares vocals and instrumental together. The model stays loaded between songs, simultaneous requests for the same song share a job, and different songs queue to avoid running multiple large models at once. Both outputs are encoded directly from the separated samples, without intermediate WAV files, and saved under `library/.stem-cache`. Valid files from the earlier library layout remain usable. Source changes invalidate the prepared cache. The default model, shift count, and overlap are preserved; CUDA is selected when the installed PyTorch build supports it.

The first separation may download model weights. CPU separation of long tracks still takes time; choosing the other prepared stem or downloading it again skips inference. `CONVOTIFY_LIBRARY_DIR` can select a different library directory before either server is started.

## Tests

With the Python dependencies installed, run `.\.venv\Scripts\python.exe -m unittest discover -s tests -v`.
For the Node backend and frontend regression checks, run `npm.cmd test` on Windows or `npm test` on other platforms.
These tests simulate Spotify and audio download services; they do not download music.
