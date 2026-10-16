'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const albumUrl = 'https://open.spotify.com/intl-en/album/Album123?si=shared';
const songs = [
  { name: 'First Song', artist: 'Artist', album_name: 'Album', url: 'https://open.spotify.com/track/Track1' },
  { name: 'First Song', artist: 'Artist', album_name: 'Album', url: 'https://open.spotify.com/track/Track2' },
  { name: '最后一首歌', artist: '歌手', album_name: 'Album', url: 'https://open.spotify.com/track/Track3' },
];

function backend(t, options = {}) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'convotify-node-test-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const handlers = new Map();
  const app = { use() {}, listen() {},
    get(route, handler) { handlers.set(`GET ${route}`, handler); },
    delete(route, handler) { handlers.set(`DELETE ${route}`, handler); },
    post(route, handler) { handlers.set(`POST ${route}`, handler); } };
  const express = () => app;
  express.json = express.static = () => () => {};
  const downloads = [];
  const attemptSnapshots = [];
  const processes = [];
  const visibleCounts = [];
  const observedStates = [];
  const statsRequests = [];
  let metadataRequests = 0;
  let context;
  const child = {
    execSync: () => process.execPath,
    execFileSync: command => ['where', 'which'].includes(command) ? process.execPath : 'Python test runner',
    execFile(command, args, settings, callback) {
      if (args.includes('save') && ++metadataRequests === 2 && options.beforeSecondAlbum) {
        options.beforeSecondAlbum(downloads);
      }
      setImmediate(() => {
        if (args.includes('save')) {
          if (options.failSecondAlbum && metadataRequests === 2) {
            callback(new Error('This album is unavailable'));
            return;
          }
          const metadata = options.songs ?? songs;
          fs.writeFileSync(args[args.indexOf('--save-file') + 1], JSON.stringify(metadata));
        } else if (args.includes('-i')) {
          fs.copyFileSync(args[args.indexOf('-i') + 1], args.at(-1));
        }
        callback(null, '', '');
      });
    },
    spawn(command, args) {
      processes.push(args);
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stdout.setEncoding = () => {};
      proc.stderr = new EventEmitter();
      proc.stdin = new EventEmitter();
      proc.stdin.destroy = () => {};
      proc.kill = () => {};
      proc.stdin.write = line => {
        const request = JSON.parse(line);
        if (args.some(arg => arg.endsWith('library_bridge.py'))) {
          statsRequests.push(request);
          setImmediate(() => {
            if (options.statsError) { proc.emit('error', new Error('Network reader unavailable')); return; }
            proc.stdout.emit('data', JSON.stringify({ id: request.id, status: 200,
              data: options.bridgeData || { bytes_sent: 123, bytes_recv: 4567, sampled_at: 12.5, scope: 'computer' } }) + '\n');
          });
          return true;
        }
        const url = request.track.source_url;
        downloads.push(url);
        const job = [...context.api.JOBS.values()].find(job => job.state === 'processing');
        attemptSnapshots.push({ url, metadata_loading: job.metadata_loading,
          tracks: JSON.parse(JSON.stringify(job.tracks)) });
        visibleCounts.push(job.tracks.length);
        setImmediate(() => {
          if (options.spawnError) return;
          for (const state of ['preparing', 'downloading', 'converting']) {
            proc.stdout.emit('data', JSON.stringify({ type: 'progress', index: request.index, state,
              message: `${state} track`, progress_pct: 50 }) + '\n');
            observedStates.push(job.tracks[request.index].state);
          }
          let event;
          if (options.failUrl === url || (options.failOnceUrl === url && downloads.filter(value => value === url).length === 1)) {
            event = { index: request.index, success: false, error: 'Audio source unavailable' };
          } else {
            if (!options.missingFiles) {
              const song = (options.songs || songs).find(item => item.url === url);
              const file = path.join(request.output_dir, `${song.artist} - ${song.name}.${args[args.indexOf('--format') + 1]}`);
              fs.writeFileSync(file, Buffer.from(url));
            }
            event = { index: request.index, success: true, cached: false };
          }
          proc.stdout.emit('data', JSON.stringify(event) + '\n');
          if (!event.success && options.cancelFailedUrl === url) {
            handlers.get('POST /convert/:jobId/tracks/:index/cancel')({
              params: { jobId: 'test-album', index: String(request.index) },
            }, { json() {} });
          }
        });
        return true;
      };
      proc.stdin.end = () => setImmediate(() => proc.emit('close', 0));
      if (options.spawnError) {
        setImmediate(() => {
          proc.emit('error', new Error('Python executable could not start'));
          proc.emit('close', -1);
        });
      }
      return proc;
    },
  };
  context = vm.createContext({
    require(name) {
      if (name === 'express') return express;
      if (name === 'child_process') return child;
      if (name === 'os') return { ...os, tmpdir: () => temporary };
      return require(name);
    },
    __dirname: root, process, console, Buffer, URL, setTimeout, clearTimeout,
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'server.js'), 'utf8') +
    '\nglobalThis.api = { JOBS, runJob, loadMetadata, linkType, archiveFilename };', context);
  const job = { state: 'metadata', tracks: [], total: 0, completed: 0, format: 'mp3',
    bitrate: '160', sseClients: new Set(), link_type: 'album' };
  context.api.JOBS.set('test-album', job);
  return { ...context.api, job, temporary, handlers, downloads, attemptSnapshots, visibleCounts, processes, observedStates, statsRequests };
}

test('Node reads timed network counters through the shared Python service', async t => {
  const fixture = backend(t);
  const response = { statusCode: 200, headers: {},
    status(value) { this.statusCode = value; return this; },
    setHeader(name, value) { this.headers[name] = value; },
    json(value) { this.body = value; return this; } };
  await fixture.handlers.get('GET /net-stats')({ method: 'GET', originalUrl: '/net-stats' }, response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.bytes_recv, 4567);
  assert.equal(response.body.sampled_at, 12.5);
  assert.equal(response.headers['Cache-Control'], 'no-store');
  assert.equal(fixture.statsRequests[0].path, '/net-stats');
});

test('Node playlist tracks preserve their individual album names and cover art from the shared engine', async t => {
  const metadata = songs.map((song, index) => ({ ...song, album_name: `Original Album ${index + 1}`,
    cover_url: `https://example.com/album-${index + 1}.jpg`, album_artist: `Album Artist ${index + 1}` }));
  const fixture = backend(t, { songs: metadata });
  const tracks = await fixture.loadMetadata('https://open.spotify.com/playlist/Playlist123',
    path.join(fixture.temporary, 'playlist.spotdl'), process.env, 'mp3', '160k');
  assert.deepEqual(Array.from(tracks, track => track.album), metadata.map(song => song.album_name));
  assert.deepEqual(Array.from(tracks, track => track.cover_url), metadata.map(song => song.cover_url));
  assert.deepEqual(Array.from(tracks, track => track.spotdl_data.album_name), metadata.map(song => song.album_name));
  assert.equal(tracks[0].collection_url, 'https://open.spotify.com/playlist/Playlist123');
  assert.equal(tracks[0].collection_kind, 'playlist');
  assert.deepEqual(Array.from(tracks, track => track.collection_position), [1, 2, 3]);
  assert.equal(tracks[0].collection_total, 3);
  assert.equal(tracks[2].title, '最后一首歌');
});

test('Node network reader failures do not become successful zero counters', async t => {
  const fixture = backend(t, { statsError: true });
  const response = { statusCode: 200, status(value) { this.statusCode = value; return this; },
    setHeader() {}, json(value) { this.body = value; return this; } };
  await fixture.handlers.get('GET /net-stats')({ method: 'GET', originalUrl: '/net-stats' }, response);
  assert.equal(response.statusCode, 503);
  assert.match(response.body.error, /unavailable/);
  assert.equal(response.body.bytes_recv, undefined);
});

test('Node queues tracks individually and keeps duplicate titles separate', async t => {
  const fixture = backend(t);
  await fixture.runJob('test-album', [albumUrl], 'mp3', '160k', 'album');
  assert.equal(fixture.job.state, 'complete', fixture.job.error);
  assert.equal(fixture.job.total, 3);
  assert.equal(fixture.job.completed, 3);
  assert.deepEqual(fixture.visibleCounts, [1, 2, 3]);
  assert.ok(['preparing', 'downloading', 'converting'].every(state => fixture.observedStates.includes(state)));
  assert.equal(new Set(fixture.job.tracks.map(track => track.filePath)).size, 3);
  assert.ok(fs.statSync(fixture.job.archivePath).size > 0);
  assert.equal(fixture.linkType(albumUrl), 'album');
  assert.equal(fixture.processes.length, 1, 'The whole album must reuse one Python process');
});

test('Node rejects empty albums instead of hanging on an empty queue', async t => {
  const fixture = backend(t, { songs: [] });
  await fixture.runJob('test-album', albumUrl, 'mp3', '160k', 'album');
  assert.equal(fixture.job.state, 'error');
  assert.match(fixture.job.error, /No tracks found/);
  assert.equal(fixture.downloads.length, 0);
});

test('Node keeps the real album count when one song fails', async t => {
  const fixture = backend(t, { failUrl: songs[1].url });
  await fixture.runJob('test-album', albumUrl, 'mp3', '160k', 'album');
  assert.equal(fixture.job.state, 'complete', fixture.job.error);
  assert.equal(fixture.job.total, 3);
  assert.equal(fixture.job.completed, 2);
  assert.equal(fixture.job.tracks[1].state, 'error');
  assert.match(fixture.job.tracks[1].error, /Audio source unavailable/);
  assert.equal(fixture.job.tracks[1].retry_count, 0);
  assert.deepEqual(fixture.downloads, songs.map(song => song.url));
});

test('Node keeps failures until manual retry and preserves successful tracks', async t => {
  const fixture = backend(t, { failOnceUrl: songs[1].url });
  await fixture.runJob('test-album', albumUrl, 'mp3', '160k', 'album');
  assert.equal(fixture.job.state, 'complete', fixture.job.error);
  assert.equal(fixture.job.completed, 2);
  assert.deepEqual(fixture.downloads, songs.map(song => song.url));
  fixture.job.urls = [albumUrl];
  const response = { status(code) { this.code = code; return this; }, json(data) { this.data = data; } };
  fixture.handlers.get('POST /convert/:jobId/retry')({ params: { jobId: 'test-album' }, body: {} }, response);
  assert.equal(response.code, 202);
  const duplicate = { ...response, code: 200 };
  fixture.handlers.get('POST /convert/:jobId/retry')({ params: { jobId: 'test-album' }, body: {} }, duplicate);
  assert.equal(duplicate.code, 409);
  const deadline = Date.now() + 5000;
  while (!['complete', 'error'].includes(fixture.job.state)) {
    assert.ok(Date.now() < deadline);
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(fixture.job.completed, 3);
  assert.deepEqual(fixture.downloads, [...songs.map(song => song.url), songs[1].url]);
  const retry = fixture.attemptSnapshots[3];
  assert.equal(retry.metadata_loading, false);
  assert.deepEqual(retry.tracks.map(track => track.state), ['converted', 'preparing', 'converted']);
  assert.equal(retry.tracks[1].retry_count, 1);
  assert.equal(retry.tracks[1].error, undefined);
  assert.equal(retry.tracks[1].progress_pct, 0);
  assert.match(retry.tracks[1].message, /again/);
  assert.equal(fixture.processes.length, 2, 'A manual retry starts one reusable worker for the failed songs');
  assert.deepEqual(Array.from(fixture.job.tracks, track => track.index), [0, 1, 2]);
});

test('Node excludes cancelled failures from manual retry', async t => {
  const fixture = backend(t, { failUrl: songs[1].url, cancelFailedUrl: songs[1].url });
  await fixture.runJob('test-album', albumUrl, 'mp3', '160k', 'album');
  assert.equal(fixture.job.state, 'complete', fixture.job.error);
  assert.equal(fixture.job.completed, 2);
  assert.equal(fixture.job.tracks[1].state, 'cancelled');
  assert.equal(fixture.job.tracks[1].retry_count, 0);
  assert.equal(fixture.downloads.length, 3);
});

test('Node names album and playlist ZIPs after the collection and preserves Unicode headers', async t => {
  for (const type of ['album', 'playlist']) {
    const title = '周末 Playlist 🎵';
    const fixture = backend(t, { songs: songs.map(song => ({ ...song, list_name: title })) });
    fixture.job.link_type = type;
    await fixture.runJob('test-album', `https://open.spotify.com/${type}/Collection123`, 'mp3', '160k', type);
    assert.equal(fixture.job.state, 'complete', fixture.job.error);
    assert.equal(path.basename(fixture.job.archivePath), title + '.zip');
    assert.deepEqual(Array.from(fixture.job.tracks, track => track.album), ['Album', 'Album', 'Album']);
    const headers = {};
    let download;
    fixture.handlers.get('GET /convert/:jobId/download')({ params: { jobId: 'test-album' } }, {
      setHeader(name, value) {
        assert.ok([...value].every(char => char.charCodeAt(0) < 128));
        headers[name] = value;
      },
      download(file, name) { download = { file, name }; },
    });
    assert.equal(download.name, title + '.zip');
    assert.equal(decodeURIComponent(headers['X-Download-Name']), title + '.zip');
    assert.equal(download.file, fixture.job.archivePath);
  }
});

test('Node archive names are safe, bounded, and combine distinct collection titles', t => {
  const fixture = backend(t);
  assert.equal(fixture.archiveFilename([{ collection_name: 'CON' }], 'album'), '_CON.zip');
  assert.equal(fixture.archiveFilename(['First', 'Second', 'First'].map(collection_name => ({ collection_name })),
    'playlist'), 'First + Second.zip');
  for (const collection_name of ['../../CON : 周末?/Music\x00', ' . ', '🎵'.repeat(300)]) {
    const name = fixture.archiveFilename([{ collection_name }], 'album');
    assert.equal(path.basename(name), name);
    assert.doesNotMatch(name, /[<>:"/\\|?*\x00-\x1f\x7f]/);
    assert.ok(Buffer.byteLength(name, 'utf8') <= 185);
  }
  assert.equal(fixture.archiveFilename([], 'playlist'), 'Spotify playlist.zip');
});

test('Node does not claim conversion succeeded when no audio file exists', async t => {
  const fixture = backend(t, { missingFiles: true });
  await fixture.runJob('test-album', albumUrl, 'mp3', '160k', 'album');
  assert.equal(fixture.job.state, 'error');
  assert.equal(fixture.job.completed, 0);
  assert.ok(fixture.job.tracks.every(track => track.state === 'error'));
});

test('Node handles worker startup errors without settling a track twice', async t => {
  const fixture = backend(t, { spawnError: true });
  await fixture.runJob('test-album', albumUrl, 'mp3', '160k', 'album');
  assert.equal(fixture.job.state, 'error');
  assert.match(fixture.job.error, /Python executable could not start/);
  assert.equal(fixture.job.total, 3);
});

test('Node accepts the queued urls payload sent by the page', async t => {
  const fixture = backend(t);
  fixture.JOBS.clear();
  let payload;
  const response = { status() { return this; }, json(value) { payload = value; } };
  fixture.handlers.get('POST /convert')({ body: { urls: [albumUrl], format: 'mp3', bitrate: '160' } }, response);
  assert.ok(payload.job_id);
  const job = fixture.JOBS.get(payload.job_id);
  assert.equal(job.link_type, 'album');
  const deadline = Date.now() + 5000;
  while (!['complete', 'error'].includes(job.state)) {
    assert.ok(Date.now() < deadline, 'Album job did not finish');
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(job.state, 'complete', job.error);
  assert.equal(job.total, 3);
});

test('Node splits queued collections and does not prepare the next one before the first finishes', async t => {
  let fixture;
  let firstFinished = false;
  fixture = backend(t, { beforeSecondAlbum(downloads) {
    const jobs = [...fixture.JOBS.values()];
    firstFinished = jobs[0].state === 'complete' && downloads.length === 3;
  } });
  fixture.JOBS.clear();
  const response = { status(code) { this.code = code; return this; }, json(data) { this.data = data; } };
  const urls = [albumUrl, 'https://open.spotify.com/playlist/Playlist456'];
  fixture.handlers.get('POST /convert')({ body: { urls, collections: urls.map((url, index) => ({ url, name: `Collection ${index + 1}` })) } }, response);
  assert.equal(response.data.jobs.length, 2);
  assert.deepEqual(Array.from(response.data.jobs, job => job.batch_position), [0, 1]);
  assert.equal(response.data.jobs[1].state, 'queued');
  const deadline = Date.now() + 5000;
  while ([...fixture.JOBS.values()].some(job => !['complete', 'error'].includes(job.state))) {
    assert.ok(Date.now() < deadline);
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(firstFinished, true);
  assert.ok([...fixture.JOBS.values()].every(job => job.total === 3 && job.completed === 3));
  assert.equal(fixture.processes.length, 2);
});

test('Node rejects more than five links and equivalent duplicate share URLs', t => {
  const fixture = backend(t);
  const response = { status(code) { this.code = code; return this; }, json(data) { this.data = data; } };
  const submit = fixture.handlers.get('POST /convert');
  submit({ body: { urls: Array.from({ length: 6 }, (_, index) => `https://open.spotify.com/album/Album${index}`) } }, response);
  assert.equal(response.code, 400);
  assert.match(response.data.error, /5/);
  submit({ body: { urls: [albumUrl, 'https://open.spotify.com/album/Album123?si=other'] } }, response);
  assert.equal(response.code, 400);
  assert.equal(fixture.processes.length, 0);
});

test('Node forwards preview and Library cache cleanup through the shared service', async t => {
  const fixture = backend(t, { bridgeData: { name: 'Verified collection', total: 200, removed_files: 4 } });
  const response = { status(code) { this.code = code; return this; }, json(data) { this.data = data; } };
  await fixture.handlers.get('POST /collections/preview')({ method: 'POST', originalUrl: '/collections/preview',
    body: { url: albumUrl } }, response);
  assert.equal(response.data.name, 'Verified collection');
  assert.equal(fixture.statsRequests[0].body.url, albumUrl);
  await fixture.handlers.get('DELETE /library/cache')({ method: 'DELETE', originalUrl: '/library/cache' }, response);
  assert.equal(response.data.removed_files, 4);
  assert.equal(fixture.statsRequests[1].path, '/library/cache');
});

test('Node loads all queued albums into one job instead of replacing the list', async t => {
  const fixture = backend(t);
  await fixture.runJob('test-album', [albumUrl, 'https://open.spotify.com/album/Album456'], 'mp3', '160k', 'album');
  assert.equal(fixture.job.state, 'complete', fixture.job.error);
  assert.equal(fixture.job.total, 6);
  assert.equal(fixture.job.completed, 6);
  assert.ok(fixture.visibleCounts.every(count => count <= 6));
  assert.equal(fixture.visibleCounts[0], 1);
});

test('Node starts the first album before fetching metadata for the next album', async t => {
  let firstAlbumStarted = false;
  const fixture = backend(t, { beforeSecondAlbum(downloads) { firstAlbumStarted = downloads.length > 0; } });
  await fixture.runJob('test-album', [albumUrl, 'https://open.spotify.com/album/Album456'], 'mp3', '160k', 'album');
  assert.equal(fixture.job.state, 'complete', fixture.job.error);
  assert.equal(firstAlbumStarted, true);
  assert.equal(fixture.job.completed, 6);
  assert.equal(fixture.job.metadata_loading, false);
});

test('Node preserves finished tracks if a later album cannot be read', async t => {
  const fixture = backend(t, { failSecondAlbum: true });
  await fixture.runJob('test-album', [albumUrl, 'https://open.spotify.com/album/Album456'], 'mp3', '160k', 'album');
  assert.equal(fixture.job.state, 'complete', fixture.job.error);
  assert.equal(fixture.job.completed, 3);
  assert.equal(fixture.job.metadata_errors.length, 1);
  assert.match(fixture.job.metadata_errors[0].error, /unavailable/);
  assert.ok(fs.statSync(fixture.job.archivePath).size > 0);
});

test('Node conversion panels cannot start or download separated audio', t => {
  const fixture = backend(t);
  const response = { status(value) { this.code = value; return this; }, json(value) { this.data = value; } };
  fixture.handlers.get('POST /convert/:jobId/tracks/:index/separate')({}, response);
  assert.equal(response.code, 410);
  assert.equal(response.data.library_url, '/library');
  fixture.handlers.get('GET /convert/:jobId/tracks/:index/download')({
    params: { jobId: 'test-album', index: '0' }, query: { stem: 'vocals' },
  }, response);
  assert.equal(response.code, 410);
  assert.equal(fixture.processes.length, 0);
});

test('Node download headers safely preserve non-Latin track names', async t => {
  const fixture = backend(t);
  await fixture.runJob('test-album', albumUrl, 'mp3', '160k', 'album');
  const headers = {};
  fixture.handlers.get('GET /convert/:jobId/download')({ params: { jobId: 'test-album' } }, {
    setHeader(name, value) {
      assert.ok([...value].every(char => char.charCodeAt(0) < 128));
      headers[name] = value;
    },
    download() {},
  });
  assert.ok(JSON.parse(headers['X-Converted-Tracks']).some(name => name.includes('最后一首歌')));
});


test('Node forwards collection shelves and all hardware test actions', async t => {
  const fixture = backend(t, { bridgeData: { state: 'idle', collections: [] } });
  for (const [method, url] of [['GET','/library/collections'], ['GET','/library/readiness'], ['POST','/library/readiness'], ['DELETE','/library/readiness']]) {
    const response = { statusCode: 200, status(value) { this.statusCode=value; return this; }, setHeader() {}, json(value) { this.body=value; return this; } };
    await fixture.handlers.get(`${method} ${url}`)({ method, originalUrl: url }, response);
    assert.equal(response.statusCode, 200);
    assert.equal(fixture.statsRequests.at(-1).path, url);
    assert.equal(fixture.statsRequests.at(-1).method, method);
  }
});
