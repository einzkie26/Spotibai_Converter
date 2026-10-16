# Technical reference

[Back to the illustrated guide](../README.md)

Installation details, queue behavior, performance, stem processing, and packaging notes for Spotibai.

## Contents

- [Collection queues and retries](#collection-queues-and-retries)
- [Installation details](#installation-details)
- [Build a Windows executable](#build-a-windows-executable)
- [Conversion speed](#conversion-speed)
- [Library downloads and playback](#library-downloads-and-playback)
- [Tests](#tests)

## Collection queues and retries

Paste a Spotify link to verify its playlist, album, or track name and track count before adding it. A queue accepts up to five distinct links. Playlists with 200 or more tracks show a warning and ask for confirmation before being added. Shared and localized versions of the same link count as duplicates.

Each collection has its own named carousel panel, progress, and download. Use the collection tabs or previous/next buttons to view it. Collections prepare and convert one at a time in queue order; later collections show Waiting. Within the current collection, four workers process individual songs in parallel, with separate Preparing, Downloading, Converting, and Finishing states.

Failed tracks wait for a manual **Retry failed** or per-track **Retry** click, available after every track in that collection finishes. A manual retry processes only the selected failures, keeps successful audio and skipped tracks, and refreshes the collection ZIP. Retrying tracks move to the top and show a **Manual retry** label. If another collection is running, a requested retry waits in the same server queue. Downloading a partial ZIP preserves the failed tracks for retry. Flask also preserves recoverable failed jobs across a server restart while their temporary files remain; the Node backend keeps jobs for its current server session.

Each ZIP uses its own Spotify playlist or album title, including Unicode names. Characters unsupported in filenames are replaced and long names are shortened. Each song retains its original album name in its tags and Library entry.

Use this only for audio you own or are authorized to download. Spotify links are used for metadata; the app does not bypass Spotify access controls.

## Installation details

On Windows, double-click **Start Spotibai.cmd**. The desktop window guides you through Python, installing `requirements.txt` and audio tools, and starting the local app. **Start app** opens the browser when the server is ready. **Open app** returns to it; **Stop app** stops work started by that window. You can expand setup details if installation fails. Updating requirements is disabled while the app is running.

If compatible Python or its desktop tools are missing, the welcome window offers to install Python 3.13.16 for your Windows account. It downloads the [official 64-bit installer](https://www.python.org/downloads/release/python-31316/), verifies its published SHA-256 and Python Software Foundation signature, and includes pip and Tkinter. Installation starts only when you click **Install Python**. The [Python Windows installer documentation](https://docs.python.org/3.13/using/windows.html#installing-without-ui) describes the current-user options used here. The guided launcher uses Flask, so Node is optional.

The launcher recognizes an app already running on port 5000 and lets you open it without taking ownership. If another program uses that port, it selects an available local port. Closing while this window's app is running offers to stop it or minimize the window and keep working. Python server ports can also be selected with `CONVOTIFY_PORT`.

For terminal setup:

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

The conversion endpoint runs locally and cleans successful jobs after the ZIP response closes. Partial jobs keep their files so failed tracks can be retried.

## Build a Windows executable

Run this on 64-bit Windows with Python 3.11-3.13 available:

```powershell
.\build-exe.cmd
```

The script creates a separate packaging environment under `.cache/packaging-venv`, installs `requirements-build.txt`, and builds the desktop UI with [PyInstaller](https://pyinstaller.org/en/stable/operating-mode.html#bundling-to-one-folder). It produces a new `dist/Spotibai-<timestamp>/Spotibai.exe` and a shareable `dist/Spotibai-Windows-<timestamp>.zip`. `dist/latest-build.json` records the exact output paths. Each build uses a fresh folder to preserve earlier folders and their data.

To use or share the app, extract the **entire ZIP** to a writable folder, open **Spotibai.exe**, and follow **Python → Install or repair requirements → Start app**. Keep `_internal`, the Python app files, `templates`, and `static` beside the executable. The setup UI includes its own Python and Tk runtime, so it opens without Python preinstalled; the audio engine still installs its separate Python environment and requirements on first use. Internet is needed for this initial installation and online audio services. Node is optional in the source project and is not needed in the executable package.

Libraries, caches, and the audio environment are created in the extracted folder. The build includes app files and assets from an explicit list; it excludes existing music, the Library database, `.env`, conversion jobs, caches, and development environments. Share the clean generated ZIP rather than re-zipping a folder you have used. Keep your existing project Library separate, or copy its `library` folder into the extracted app while both apps are stopped. Install requirements again if you move the audio environment to another path or computer.

Every build runs a packaged UI diagnostic before creating the ZIP. For a support report without downloading or installing anything:

```powershell
.\Spotibai.exe --diagnose .\setup-report.json
```

Once the audio requirements are installed, add `--check-server` to also start and stop an isolated local test server without using your Library. This [packaging setup handles PyInstaller's executable paths](https://pyinstaller.org/en/stable/runtime-information.html) and [cleans the bundled runtime settings before starting external Python and audio tools](https://pyinstaller.org/en/stable/common-issues-and-pitfalls.html#launching-external-programs-from-the-frozen-application).

## Conversion speed

Both backends use `conversion_engine.py`. Album metadata is fetched in bulk, then reused for downloads. Four workers reuse their spotDL sessions, and normalization runs during the first encode. Lyrics lookups and ZIP recompression are skipped. Album artwork is fetched once and reused. AAC packaging copies the encoded stream instead of encoding it again.

Simplified playlist responses can omit the original album and cover image. Missing details are recovered from each unique track, using up to four reusable metadata sessions, while retaining playlist order and repeated tracks. Complete entries skip this lookup. Recovered track details are cached for a day and shared across playlists; incomplete results can retry after a minute. Existing playlist caches are repaired automatically on use. Each song keeps its original album name and cover. A failed artwork refresh preserves an image already embedded in the audio, and PNG images retain the correct tag type in MP3, FLAC, and M4A files.

The title preview reuses the bulk collection list without fetching every song's missing artwork. Conversion then enriches any incomplete playlist metadata. Each track reports its own source lookup, download, and encoding progress. An unavailable source can try an alternate provider within its attempt; a track that ultimately fails waits for a manual retry. A manual retry clears the saved source URL and starts preparation again. Socket waits and provider attempts are bounded. Preparation and conversion overlap within the current collection; later queued collections wait. Phase durations in `/convert/<job_id>/status` are not additive when `timings.overlapped` is true.

The network display follows active jobs through metadata, downloads, encoding, and packaging, including jobs restored after a page reload. Both backends read the same computer-wide network counters. Rates use elapsed sample time and show small transfers in bytes per second; the received total retains short bursts even when current traffic falls to zero. Dropped packets and interface errors are shown separately. Unavailable counters show a retry state. Cached metadata and local encoding can correctly use no network, and other applications' traffic is included in these computer-wide measurements.

Metadata and completed audio are cached in `.cache/conversion`. Albums and tracks refresh after one hour; playlists refresh after five minutes. The audio cache keeps up to 512 MiB, evicts older entries, and reuses a file only when the track, format, bitrate, and processing filter match. Concurrent requests for the same encode share one download. Corrupt entries are downloaded again. Removing this cache while the app is stopped forces fresh downloads.

The default is four workers per job. To experiment with another limit, set `$env:CONVOTIFY_WORKERS = "6"` before starting either backend; values are limited to 1–8. More workers can help when downloads are waiting on the network, but can slow a busy CPU or trigger provider limits. Use MP3 at 160 kbps for smaller output files. Lossless output and stem separation require more processing and storage.

## Library downloads and playback

**Collection shelves** preserve each converted playlist or album's name, type, source link, saved entry count, and completion state. Select a shelf to see its tracks in collection order; search stays within that shelf. A song shared by several playlists belongs to each shelf while using one saved audio file per format. Repeated playlist entries count toward completion but share one Library card. Distinct Spotify tracks with the same artist and title keep separate files. Removing a track updates all affected shelves. Collection names stay separate from each song's original album tags.

Older downloads remain in **All tracks** and **Earlier downloads** because their original collection was not recorded. Convert the original playlist or album again to build its shelf; matching legacy tracks are adopted without changing their Library IDs. Shelves appear as tracks are saved, show partial results, and switch to **Complete** when all collection entries are saved.

Before preparing a new vocal or instrumental file, run **Stem readiness → Run CPU & RAM test** in Library. It actually separates an 8-second generated stereo sample on CPU with the normal `htdemucs` preset, measures elapsed time, CPU time, and peak RAM across its worker process tree, and gives a rough per-minute estimate. CPU time means processor seconds, not hardware clock cycles. A slower CPU can pass with a slower-speed label. [Demucs documents](https://github.com/facebookresearch/demucs) the model and inference controls; the app uses one separation at a time to limit memory use.

The app requires 2 GiB of available RAM to begin this trial; that is a conservative application policy, not an official Demucs hardware minimum. The trial can be cancelled, stops if memory becomes scarce, and times out after five minutes. Its first run may download model weights. Passing enables new stems for seven days on the same hardware and software preset; each song also checks current free RAM against the measured process peak and its audio buffers. Closing other apps can help. Original audio and already-prepared stems remain usable without another trial. The test report lives in `.cache/readiness`; it does not use or modify your music. An estimate from a short sample cannot guarantee full-song processing time.

Open **Library → Download** to choose Original, Vocals, or Instrumental. Conversion panels offer the original track and album ZIP downloads. Vocal and instrumental preparation and downloads are available only through the library, in both server modes.

**Clear stem & preview cache** shows a confirmation explaining that originals stay in the Library and stems will need to be prepared again. It removes generated vocals, instrumentals, and preview clips, including older stem files beside originals. Registered originals are protected even if their title contains “Vocals” or “Instrumental”. Cleanup waits for active separation and reports files that are still in use. Removing a library track also removes its associated prepared stems and previews.

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
