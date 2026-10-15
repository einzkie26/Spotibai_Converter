'use strict';

const express = require('express');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const { v4: uuidv4 } = require('uuid');
const archiver = require('archiver');

const app = express();
app.use(express.json({ limit: '4kb' }));
app.use('/static', express.static(path.join(__dirname, 'static')));

const JOBS = new Map();
const FORMATS = new Set(['mp3', 'wav', 'aac', 'flac', 'alac']);
const BITRATES = { '96': '96k', '160': '160k', '320': '320k', '1411': '1411k' };
const SPOTIFY_PATH = /^\/(?:intl-[^/]+\/)?(?:playlist|album|track)\/[A-Za-z0-9]+\/?$/;

// ── helpers ────────────────────────────────────────────────────────────────

function isSpotifyUrl(url) {
  try {
    const u = new URL(url.trim());
    return u.protocol === 'https:' &&
      (u.hostname === 'open.spotify.com' || u.hostname === 'spotify.com') &&
      SPOTIFY_PATH.test(u.pathname);
  } catch { return false; }
}

function linkType(url) {
  try {
    const m = new URL(url.trim()).pathname.match(/\/(playlist|album|track)\/[A-Za-z0-9]+\/?$/);
    return m ? m[1] : '';
  } catch { return ''; }
}

function canonicalSpotifyUrl(url) {
  const parts = new URL(url.trim()).pathname.replace(/\/$/, '').split('/');
  return `https://open.spotify.com/${parts.at(-2)}/${parts.at(-1)}`;
}

function archiveFilename(metadata, type) {
  const names = [...new Set(metadata.map(track => (track.collection_name || '').trim()).filter(Boolean))];
  const fallback = `Spotify ${['album', 'playlist'].includes(type) ? type : 'collection'}`;
  const title = (names.join(' + ') || fallback).replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '_').replace(/^[ .]+|[ .]+$/g, '');
  let safe = '';
  for (const character of Array.from(title).slice(0, 150)) {
    if (Buffer.byteLength(safe + character, 'utf8') > 180) break;
    safe += character;
  }
  safe = safe.replace(/[ .]+$/g, '');
  if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(safe)) safe = '_' + safe;
  return (safe || 'Spotify collection') + '.zip';
}

function trackKey(s) {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function displaySize(bytes) {
  if (bytes == null) return 'Pending';
  return bytes < 1_048_576
    ? `${(bytes / 1024).toFixed(1)} KB`
    : `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function findFfmpeg() {
  const which = process.platform === 'win32' ? 'where' : 'which';
  try {
    const r = require('child_process').execFileSync(which, ['ffmpeg'], { encoding: 'utf8', stdio: 'pipe' });
    const p = r.trim().split('\n')[0].trim();
    if (p && fs.existsSync(p)) return p;
  } catch {}
  const localFfmpeg = path.join(path.dirname(PYTHON), process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  if (fs.existsSync(localFfmpeg)) return localFfmpeg;
  try {
    const bundled = require('child_process').execFileSync(PYTHON,
      ['-c', 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())'],
      { encoding: 'utf8', stdio: 'pipe' }).trim();
    if (bundled && fs.existsSync(bundled)) return bundled;
  } catch {}
  // WinGet fallback
  const local = process.env.LOCALAPPDATA;
  if (local) {
    const base = path.join(local, 'Microsoft', 'WinGet', 'Packages');
    if (fs.existsSync(base)) {
      for (const dir of fs.readdirSync(base)) {
        if (dir.startsWith('Gyan.FFmpeg')) {
          const bin = path.join(base, dir);
          for (const sub of fs.readdirSync(bin)) {
            const exe = path.join(bin, sub, 'bin', 'ffmpeg.exe');
            if (fs.existsSync(exe)) return exe;
          }
        }
      }
    }
  }
  return null;
}

function findAudioFiles(dir) {
  const exts = new Set(['.mp3', '.wav', '.aac', '.flac', '.m4a']);
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) return entry.name.startsWith('.') ? [] : findAudioFiles(file);
      const ext = path.extname(entry.name).toLowerCase();
      return entry.isFile() && exts.has(ext) &&
        !entry.name.includes('(Vocals)') && !entry.name.includes('(Instrumental)') ? [file] : [];
    }).sort();
  } catch { return []; }
}

function getPython() {
  const localPython = path.join(__dirname, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  for (const cmd of [process.env.SPOTIBAI_PYTHON, localPython, 'python', 'python3'].filter(Boolean)) {
    try {
      require('child_process').execFileSync(cmd, ['--version'], { encoding: 'utf8', stdio: 'pipe' });
      return cmd;
    } catch {}
  }
  return 'python';
}

// ── resolve python + ffmpeg once at startup ──────────────────────────────

const PYTHON = getPython();
const FFMPEG = findFfmpeg();
const ENGINE = path.join(__dirname, 'conversion_engine.py');
const WORKERS = Math.max(1, Math.min(8, Number(process.env.CONVOTIFY_WORKERS) || 4));

// ── SSE broadcast ──────────────────────────────────────────────────────────

function broadcast(jobId, data) {
  const job = JOBS.get(jobId);
  if (!job) return;
  const msg = `data: ${JSON.stringify({ state: job.state, archive_name: job.archive_name, ...data })}\n\n`;
  for (const res of job.sseClients) {
    try { res.write(msg); } catch {}
  }
}

// ── conversion job ─────────────────────────────────────────────────────────

async function runJob(jobId, playlistUrl, format, bitrate, type_) {
  const started = Date.now();
  const job = JOBS.get(jobId);
  const jobDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'convotify-'));
  const outputDir = path.join(jobDir, 'tracks');
  await fsp.mkdir(outputDir);
  const env = { ...process.env, PATH: `${path.dirname(FFMPEG)}${path.delimiter}${process.env.PATH}` };

  job.jobDir = jobDir;
  job.outputDir = outputDir;

  try {
    // Bulk metadata and one reusable Python worker process per job.
    await runWithNodeWorker(jobId, playlistUrl, outputDir, format, bitrate, env);
    const packagingStarted = Date.now();

    // stamp spatial flag on all tracks for frontend display
    if (job.spatial) job.tracks.forEach(t => { t.spatial = true; });

    const finalFiles = job.tracks.filter(track => track.state === 'converted' && track.filePath)
      .map(track => track.filePath).filter(file => fs.existsSync(file));
    if (!finalFiles.length) throw new Error(job.tracks.find(track => track.state === 'error')?.error ||
      `No ${format.toUpperCase()} files produced. The audio source may be unavailable.`);

    const trackNames = finalFiles.map(f => path.basename(f));

    if (type_ === 'track') {
      job.state = 'complete';
      job.filePath = finalFiles[0];
      job.trackNames = trackNames;
      job.timings = { ...job.timings, packaging_s: 0, total_s: (Date.now() - started) / 1000 };
      broadcast(jobId, { type: 'complete', link_type: 'track', tracks: job.tracks, total: job.total, completed: job.completed, timings: job.timings, metadata_errors: job.metadata_errors });
      return;
    }

    // 3. zip
    job.state = 'packaging';
    broadcast(jobId, { type: 'state', state: 'packaging' });
    const zipPath = path.join(jobDir, job.archive_name);
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(zipPath);
      const arc = archiver('zip', { store: true });
      arc.on('error', reject);
      out.on('close', resolve);
      arc.pipe(out);
      for (const f of finalFiles) arc.file(f, { name: path.relative(outputDir, f) });
      arc.finalize();
    });

    job.state = 'complete';
    job.archivePath = zipPath;
    job.trackNames = trackNames;
    job.timings = { ...job.timings, packaging_s: (Date.now() - packagingStarted) / 1000,
      total_s: (Date.now() - started) / 1000 };
    broadcast(jobId, { type: 'complete', link_type: type_, tracks: job.tracks, total: job.total, completed: job.completed, timings: job.timings, metadata_errors: job.metadata_errors });

  } catch (err) {
    job.state = 'error';
    job.metadata_loading = false;
    job.error = err.message;
    broadcast(jobId, { type: 'error', error: err.message });
    try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch {}
  }
}

// ── metadata via spotdl save + embed enrichment ──────────────────────────

async function loadMetadata(playlistUrl, metaPath, env, format, bitrate, onTrack) {
  await fsp.rm(metaPath, { force: true });
  try {
    await execFileAsync(PYTHON, [
      ENGINE, 'save', canonicalSpotifyUrl(playlistUrl), '--save-file', metaPath,
    ], { env, timeout: 180000, maxBuffer: 1024 * 1024, encoding: 'utf8' });
  } catch (err) {
    throw new Error(err.killed ? 'Reading Spotify tracks timed out. Please try again.' :
      (err.stderr || err.stdout || err.message).trim().split('\n').filter(Boolean).at(-1));
  }

  let raw;
  try {
    raw = JSON.parse(await fsp.readFile(metaPath, 'utf8'));
  } catch {
    throw new Error('Spotify track metadata could not be read. Please try again.');
  }
  if (!Array.isArray(raw) || !raw.length) {
    throw new Error('No tracks found. Check that the Spotify album or playlist is available.');
  }
  return raw.map((item, i) => {
    const sourceUrl = item && (item.url || (linkType(playlistUrl) === 'track' ? playlistUrl : ''));
    if (!sourceUrl || !isSpotifyUrl(sourceUrl) || linkType(sourceUrl) !== 'track') {
      throw new Error('Spotify returned incomplete track metadata. Please try again.');
    }
    const track = {
      index: i,
      title: item.name || 'Unknown',
      artist: item.artist || (Array.isArray(item.artists) ? item.artists.join(', ') : '') || 'Unknown',
      album: item.album_name || '',
      collection_name: item.list_name || (linkType(playlistUrl) === 'album' ? item.album_name : '') || '',
      album_artist: item.album_artist || '',
      cover_url: item.cover_url || '',
      track_number: item.track_number || i + 1,
      tracks_count: item.tracks_count || 0,
      duration: (item.duration || 0) * 1000,   // spotdl gives seconds, convert to ms
      year: item.year || '',
      date: item.date || '',
      explicit: item.explicit || false,
      publisher: item.publisher || '',
      source_url: canonicalSpotifyUrl(sourceUrl),
      spotdl_data: item,
      state: 'pending',
      retry_count: 0,
      size: 'Pending',
      format: format.toUpperCase(),
      quality: bitrate.replace('k', ' kbps'),
    };
    if (onTrack) onTrack(track, i + 1, raw.length);
    return track;
  });
}

async function runWithNodeWorker(jobId, playlistUrl, outputDir, format, bitrate, env) {
  const started = Date.now();
  const job = JOBS.get(jobId);
  const metaPath = path.join(path.dirname(outputDir), 'metadata.spotdl');

  job.state = 'metadata';
  broadcast(jobId, { type: 'state', state: 'metadata' });

  const urls = Array.isArray(playlistUrl) ? playlistUrl : [playlistUrl];
  const metadata = [];
  job.tracks = metadata;
  job.metadata_loading = true;
  job.metadata_errors = [];
  const queue = [];
  let discoveryDone = false;
  let conversionStarted;
  let workerPromise;
  let workerError;
  let wakeWorker = () => {};
  let abortWorker = () => {};
  function startWorker() {
    conversionStarted = Date.now();
    return new Promise((resolve, reject) => {
      let settled = 0;
      let running = 0;
      let closing = false;
      let retryPassStarted = false;
      let stopped = false;
      let buffer = '';
      let diagnostics = '';
      const inFlight = new Set();
      const audioFilter = 'highpass=f=40,loudnorm=I=-14:TP=-1:LRA=11' +
        (job.spatial ? ',extrastereo=m=2.2,aecho=0.6:0.6:20|40:0.25|0.15' : '');
      const proc = spawn(PYTHON, [ENGINE, 'serve', '--ffmpeg', FFMPEG,
        '--format', format, '--bitrate', bitrate, '--filter', audioFilter],
      { env, stdio: ['pipe', 'pipe', 'pipe'] });
      let watchdog;
      function pulse() {
        clearTimeout(watchdog);
        watchdog = setTimeout(() => fail(new Error('Track processing timed out. Please try again.')), 660000);
      }
      pulse();

      function fail(error) {
        if (stopped) return;
        stopped = true;
        workerError = error;
        clearTimeout(watchdog);
        proc.stdin.destroy();
        proc.kill();
        for (const track of metadata) {
          if (!['converted', 'cancelled', 'error'].includes(track.state)) {
            track.state = 'error';
            track.error = error.message;
          }
        }
        broadcast(jobId, { type: 'tracks', tracks: job.tracks, completed: job.completed, total: job.total });
        reject(error);
      }
      abortWorker = fail;

      function progress(event) {
        const track = metadata[event.index];
        if (stopped || !track || !inFlight.has(event.index) || track.state === 'cancelled') return;
        if (!['preparing', 'downloading', 'converting', 'finishing', 'retrying'].includes(event.state)) return;
        track.state = event.state;
        track.message = event.message || '';
        track.progress_pct = event.progress_pct || 0;
        track.elapsed_s = (Date.now() - track.startedAt) / 1000;
        broadcast(jobId, { type: 'tracks', tracks: job.tracks, completed: job.completed, total: job.total,
          metadata_loading: job.metadata_loading });
      }

      function finish(event) {
        const track = metadata[event.index];
        if (!track || !inFlight.delete(event.index) || stopped) return;
        pulse();
        running--;
        const trackDir = path.join(outputDir, String(track.index + 1).padStart(4, '0'));
        const newFile = findAudioFiles(trackDir)[0];
        const size = newFile ? fs.statSync(newFile).size : 0;
        if (track.state !== 'cancelled') {
          if (event.success && size > 0) {
            track.state = 'converted';
            track.filePath = newFile;
            track.size = displaySize(size);
            track.cached = !!event.cached;
            track.progress_pct = 100;
            track.message = 'Ready to download';
          } else {
            track.state = 'error';
            track.error = event.error || 'No audio file was produced for this track.';
            track.message = track.error;
          }
        }
        track.elapsed_s = (Date.now() - track.startedAt) / 1000;
        job.completed = metadata.filter(t => t.state === 'converted').length;
        job.cached_tracks = metadata.filter(t => t.cached).length;
        broadcast(jobId, { type: 'tracks', tracks: job.tracks, completed: job.completed, total: job.total });
        settled++;
        next();
      }

      proc.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-16000); });
      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', chunk => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          try {
            const event = JSON.parse(line);
            if (event.type === 'progress') progress(event);
            else finish(event);
          } catch (error) { fail(new Error(`Conversion worker returned an invalid result: ${error.message}`)); }
        }
      });
      proc.stdin.on('error', fail);
      proc.once('error', fail);
      proc.once('close', code => {
        if (stopped) return;
        clearTimeout(watchdog);
        if (code === 0 && discoveryDone && settled === metadata.length) { stopped = true; resolve(); }
        else fail(new Error(diagnostics.trim().split('\n').filter(Boolean).at(-1) || 'Conversion worker stopped before finishing the album.'));
      });

      function next() {
        if (stopped) return;
        while (queue.length && running < WORKERS) {
          const track = queue.shift();
          if (track.state === 'cancelled') {
            settled++;
            continue;
          }
          const trackDir = path.join(outputDir, String(track.index + 1).padStart(4, '0'));
          fs.mkdirSync(trackDir, { recursive: true });
          running++;
          inFlight.add(track.index);
          track.state = 'preparing';
          delete track.error;
          track.progress_pct = 0;
          track.message = track.retry_count ? 'Preparing this track again' : 'Preparing this track';
          track.startedAt = Date.now();
          track.elapsed_s = 0;
          broadcast(jobId, { type: 'tracks', tracks: job.tracks, completed: job.completed, total: job.total });

          proc.stdin.write(JSON.stringify({ index: track.index, track, output_dir: trackDir, save_library: true }) + '\n');
        }
        if (discoveryDone && settled === metadata.length && !closing) {
          if (!retryPassStarted) {
            retryPassStarted = true;
            const failed = metadata.filter(track => track.state === 'error');
            if (failed.length) {
              for (const track of failed) {
                track.state = 'pending';
                track.retry_count = 1;
                track.progress_pct = 0;
                track.elapsed_s = 0;
                track.message = 'Waiting to prepare again';
                delete track.error;
                queue.push(track);
              }
              settled -= failed.length;
              broadcast(jobId, { type: 'tracks', tracks: job.tracks, completed: job.completed, total: job.total });
              next();
              return;
            }
          }
          closing = true;
          proc.stdin.end();
        }
      }
      wakeWorker = next;
      next();
    });
  }

  try {
    for (const url of urls) {
      const offset = metadata.length;
      const loading = loadMetadata(url, metaPath, env, format, bitrate, (track, count, total) => {
        if (workerError) throw workerError;
        track.index = metadata.length;
        metadata.push(track);
        queue.push(track);
        job.total = offset + total;
        job.meta_count = offset + count;
        job.meta_total = offset + total;
        job.state = 'processing';
        broadcast(jobId, { type: 'tracks', tracks: job.tracks, completed: job.completed, total: job.total,
          metadata_loading: true, meta_count: job.meta_count, meta_total: job.meta_total });
        if (!workerPromise) {
          workerPromise = startWorker();
          workerPromise.catch(() => {});
        } else wakeWorker();
      });
      try {
        if (workerPromise) await Promise.race([loading, workerPromise]);
        else await loading;
      } catch (error) {
        if (workerError) throw workerError;
        job.metadata_errors.push({ url, error: error.message });
      }
    }
    if (!metadata.length) throw new Error(job.metadata_errors[0]?.error || 'No tracks found.');
    discoveryDone = true;
    job.metadata_loading = false;
    job.total = metadata.length;
    job.archive_name = archiveFilename(metadata, job.link_type);
    job.timings = { metadata_s: (Date.now() - started) / 1000, overlapped: true };
    broadcast(jobId, { type: 'tracks', tracks: job.tracks, completed: job.completed, total: job.total,
      metadata_loading: false });
    wakeWorker();
    await workerPromise;
  } catch (error) {
    abortWorker(error);
    if (workerPromise) await workerPromise.catch(() => {});
    throw error;
  }
  job.timings.conversion_s = (Date.now() - conversionStarted) / 1000;
}

// ── routes ─────────────────────────────────────────────────────────────────

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'templates', 'index.html')));

app.get('/net-stats', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  return forwardLibrary(req, res);
});

app.post('/convert', (req, res) => {
  const { url = '', urls: rawUrls, format = 'mp3', bitrate = '160', spatial = false } = req.body || {};
  const urls = typeof rawUrls === 'string' ? [rawUrls] : (rawUrls || [url]);
  if (!Array.isArray(urls) || !urls.length || !urls.every(value => typeof value === 'string' && isSpotifyUrl(value))) {
    return res.status(400).json({ error: 'Paste a valid Spotify playlist, album, or track link.' });
  }
  if (!FORMATS.has(format) || !BITRATES[bitrate]) return res.status(400).json({ error: 'Choose a supported file format and bitrate.' });
  if (!FFMPEG) return res.status(500).json({ error: 'FFmpeg is required. Install it and add it to PATH.' });

  const jobId = uuidv4().replace(/-/g, '');
  const type = urls.length === 1 ? linkType(urls[0]) : 'playlist';
  JOBS.set(jobId, {
    state: 'converting', tracks: [], total: 0, completed: 0,
    format, bitrate, spatial: !!spatial, link_type: type, sseClients: new Set(),
    jobDir: null, outputDir: null, filePath: null, archivePath: null, trackNames: [],
  });

  runJob(jobId, urls.map(value => value.trim()), format, BITRATES[bitrate], type);
  res.json({ job_id: jobId });
});

// SSE status stream
app.get('/convert/:jobId/events', (req, res) => {
  const job = JOBS.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found.' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // send current state immediately
  res.write(`data: ${JSON.stringify({ type: 'snapshot', state: job.state, tracks: job.tracks, total: job.total, completed: job.completed, link_type: job.link_type, error: job.error, timings: job.timings, cached_tracks: job.cached_tracks, metadata_loading: job.metadata_loading, metadata_errors: job.metadata_errors, archive_name: job.archive_name })}\n\n`);

  job.sseClients.add(res);
  req.on('close', () => job.sseClients.delete(res));
});

// polling fallback
app.get('/convert/:jobId/status', (req, res) => {
  const job = JOBS.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  res.json({ state: job.state, tracks: job.tracks, total: job.total, completed: job.completed, error: job.error, link_type: job.link_type, timings: job.timings, cached_tracks: job.cached_tracks, metadata_loading: job.metadata_loading, metadata_errors: job.metadata_errors, archive_name: job.archive_name });
});

app.get('/jobs', (req, res) => {
  res.json([...JOBS.entries()].filter(([, job]) => !['complete', 'error'].includes(job.state))
    .map(([job_id, job]) => ({ job_id, state: job.state, tracks: job.tracks,
      total: job.total, completed: job.completed, link_type: job.link_type })));
});

app.post('/convert/:jobId/tracks/:index/cancel', (req, res) => {
  const job = JOBS.get(req.params.jobId);
  const idx = parseInt(req.params.index, 10);
  if (!job || idx < 0 || idx >= job.total) return res.status(404).json({ error: 'Track not found.' });
  if (job.tracks[idx]) job.tracks[idx].state = 'cancelled';
  broadcast(req.params.jobId, { type: 'tracks', tracks: job.tracks, completed: job.completed, total: job.total });
  res.json({ ok: true });
});

app.get('/convert/:jobId/download', (req, res) => {
  const job = JOBS.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  if (job.state !== 'complete') return res.status(409).json({ error: 'Not ready yet.' });

  const filePath = job.filePath || job.archivePath;
  const name = path.basename(filePath);
  const mime = job.filePath ? 'audio/*' : 'application/zip';

  res.setHeader('X-Download-Name', encodeURIComponent(name));
  res.setHeader('X-Converted-Tracks', JSON.stringify(job.trackNames).replace(/[\u007f-\uffff]/g,
    char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0')));
  res.download(filePath, name, { headers: { 'Content-Type': mime } }, () => {
    try { fs.rmSync(job.jobDir, { recursive: true, force: true }); } catch {}
    JOBS.delete(req.params.jobId);
  });
});

app.get('/convert/:jobId/tracks/:index/download', (req, res) => {
  const job = JOBS.get(req.params.jobId);
  const idx = parseInt(req.params.index, 10);
  const stem = (req.query.stem || '').toLowerCase();
  if (stem) return res.status(410).json({ error: 'Vocal and instrumental downloads are available in the library.', library_url: '/library' });
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  if (!job.outputDir || idx < 0 || idx >= job.tracks.length) return res.status(404).json({ error: 'Track not found.' });

  const track = job.tracks[idx];
  if (track.state !== 'converted') return res.status(409).json({ error: 'Track not ready.' });

  let file = track.filePath && fs.existsSync(track.filePath) ? track.filePath : null;
  if (!file) {
    const ekey = trackKey(`${track.artist}${track.title}`);
    file = findAudioFiles(job.outputDir).find(f => {
      const base = trackKey(path.basename(f, path.extname(f)));
      return base === ekey || base.includes(ekey) || ekey.includes(base);
    });
  }
  if (!file) return res.status(404).json({ error: 'File not found.' });


  res.setHeader('X-Download-Name', encodeURIComponent(path.basename(file)));
  res.download(file, path.basename(file));
});

app.post('/convert/:jobId/tracks/:index/separate', (req, res) => {
  res.status(410).json({ error: 'Vocal and instrumental downloads are available in the library.', library_url: '/library' });
});

let libraryWorker;
let librarySequence = 0;
const libraryRequests = new Map();
function libraryRpc(method, requestPath, body) {
  if (!libraryWorker) {
    const worker = spawn(PYTHON, [path.join(__dirname, 'library_bridge.py')],
      { cwd: __dirname, env: process.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    libraryWorker = worker;
    let buffer = '';
    let diagnostics = '';
    function fail(error) {
      if (libraryWorker !== worker) return;
      libraryWorker = null;
      worker.stdin.destroy();
      worker.kill();
      for (const item of libraryRequests.values()) { clearTimeout(item.timer); item.reject(error); }
      libraryRequests.clear();
    }
    worker.stdout.setEncoding('utf8');
    worker.stdout.on('data', chunk => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const result = JSON.parse(line);
          const item = libraryRequests.get(result.id);
          if (item) { libraryRequests.delete(result.id); clearTimeout(item.timer); item.resolve(result); }
        } catch { fail(new Error('The library service returned an invalid response.')); }
      }
    });
    worker.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-8000); });
    worker.stdin.on('error', fail);
    worker.once('error', fail);
    worker.once('close', () => fail(new Error(diagnostics.trim().split('\n').at(-1) || 'The library service stopped.')));
  }
  return new Promise((resolve, reject) => {
    const id = ++librarySequence;
    const timer = setTimeout(() => { libraryRequests.delete(id); reject(new Error('The library request timed out.')); }, 30000);
    libraryRequests.set(id, { resolve, reject, timer });
    libraryWorker.stdin.write(JSON.stringify({ id, method, path: requestPath, body }) + '\n');
  });
}

async function forwardLibrary(req, res) {
  try {
    const result = await libraryRpc(req.method, req.originalUrl, req.body);
    res.status(result.status);
    if (result.data !== undefined) return res.json(result.data);
    for (const name of ['Content-Type', 'Content-Disposition', 'Cache-Control']) {
      if (result.headers?.[name]) res.setHeader(name, result.headers[name]);
    }
    if (result.file) return res.sendFile(result.file);
    res.send(Buffer.from(result.body || '', 'base64'));
  } catch (error) { res.status(503).json({ error: error.message }); }
}

app.get('/library', (req, res) => res.sendFile(path.join(__dirname, 'templates', 'library.html')));
app.get('/library/tracks', forwardLibrary);
app.post('/library/tracks/:trackId/separate', forwardLibrary);
app.get('/library/tracks/:trackId/separate/:sepId/status', forwardLibrary);
app.get('/library/tracks/:trackId/download', forwardLibrary);
app.get('/library/tracks/:trackId/preview', forwardLibrary);
app.delete('/library/tracks/:trackId', forwardLibrary);
app.get('/library/tracks/:trackId/separate/:sepId/events', async (req, res) => {
  let closed = false;
  let timer;
  let revision;
  let heartbeat = Date.now();
  res.on('close', () => { closed = true; clearTimeout(timer); });
  async function poll() {
    if (closed) return;
    try {
      const result = await libraryRpc('GET', `/library/tracks/${req.params.trackId}/separate/${req.params.sepId}/status`);
      if (closed) return;
      if (!res.headersSent) {
        if (result.status !== 200) return res.status(result.status).json(result.data);
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();
      }
      const job = result.data;
      if (job.revision !== revision || result.status !== 200) {
        res.write(`data: ${JSON.stringify(job)}\n\n`);
        revision = job.revision;
        heartbeat = Date.now();
      } else if (Date.now() - heartbeat > 15000) {
        res.write(': keepalive\n\n'); heartbeat = Date.now();
      }
      if (result.status !== 200 || ['done', 'error'].includes(job.state)) { res.end(); return; }
      timer = setTimeout(poll, 250);
    } catch (error) {
      if (closed) return;
      if (!res.headersSent) res.status(503).json({ error: error.message });
      else { res.write(`data: ${JSON.stringify({ state: 'error', msg: error.message })}\n\n`); res.end(); }
    }
  }
  await poll();
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Spotibai running at http://127.0.0.1:${PORT}`));
