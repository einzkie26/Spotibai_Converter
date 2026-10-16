'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Element {
  constructor() {
    this.dataset = {};
    this.style = {};
    this.listeners = new Map();
    this.children = [];
    this.textContent = '';
    this.value = '';
    this.className = '';
    const change = (name, enabled) => {
      const classes = new Set(this.className.split(' ').filter(Boolean));
      enabled ? classes.add(name) : classes.delete(name);
      this.className = [...classes].join(' ');
    };
    this.classList = {
      toggle: change, add: name => change(name, true), remove: name => change(name, false),
      contains: name => this.className.split(' ').includes(name),
    };
  }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  matches(selector) {
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    const attribute = selector.match(/^\[data-track-index(?:="(\d+)")?\]$/);
    if (attribute) return this.dataset.trackIndex != null &&
      (attribute[1] == null || String(this.dataset.trackIndex) === attribute[1]);
    return selector === 'span' && this.tagName === 'span';
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  closest(selector) { return this.matches(selector) ? this : this.parent?.closest(selector) || null; }
  append(...children) { for (const child of children) { child.remove(); child.parent = this; this.children.push(child); } }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
  replaceChildren(...children) { this.children.forEach(child => { child.parent = null; }); this.children = []; this.append(...children); }
  insertBefore(child, before) { child.remove(); child.parent = this; const index = this.children.indexOf(before); this.children.splice(index < 0 ? this.children.length : index, 0, child); }
  replaceChild(child, previous) { this.insertBefore(child, previous); previous.remove(); }
  setAttribute() {}
  removeAttribute() {}
}

function page(settings = {}) {
  const elements = new Map();
  const rendered = [];
  const requests = [];
  const streams = [];
  const network = { active: false, phase: null, stops: 0,
    start(phase) { this.active = true; this.phase = phase; },
    stop() { if (this.active) this.stops++; this.active = false; } };
  const documentListeners = new Map();
  const actions = [];
  const downloads = [];
  const confirmations = [];
  const document = {
    documentElement: new Element(),
    querySelector(selector) {
      if (!elements.has(selector)) {
        const element = new Element();
        if (selector === '#theme-toggle') {
          for (const name of ['theme-icon', 'theme-label']) { const child = new Element(); child.className = name; element.append(child); }
        }
        if (selector === '#submit-button') { const child = new Element(); child.tagName = 'span'; element.append(child); }
        elements.set(selector, element);
      }
      return elements.get(selector);
    },
    createElement(tag) { const element = new Element(); element.tagName = tag; return element; },
    addEventListener(name, callback) { documentListeners.set(name, callback); },
  };
  const context = vm.createContext({
    document, URL, performance, console, NetworkStats: { create: () => network },
    AbortController, setTimeout, clearTimeout,
    confirm(message) { confirmations.push(message); return settings.confirm !== false; },
    Downloads: { createToast: title => ({ title }), download: async (url, options) => { downloads.push({ url, options }); } },
    localStorage: { getItem() { return null; }, setItem() {} },
    matchMedia: () => ({ matches: false }),
    MutationObserver: class { observe() {} },
    setInterval: () => 1, clearInterval() {},
    EventSource: class {
      constructor(url) { this.url = url; this.closed = false; streams.push(this); }
      close() { this.closed = true; }
    },
    async fetch(url, options) {
      if (url === '/jobs') return { json: async () => settings.jobs || [] };
      if (url === '/convert') {
        const body = JSON.parse(options.body);
        requests.push(body);
        if (settings.submitError) return { ok: false, json: async () => ({ error: settings.submitError }) };
        const jobs = body.urls.map((url, index) => ({ job_id: `job-${index + 1}`, urls: [url], state: 'queued',
          name: body.collections?.[index]?.name, link_type: body.collections?.[index]?.type }));
        return { ok: true, json: async () => ({ job_id: jobs[0].job_id, jobs }) };
      }
      if (url === '/collections/preview') {
        const link = JSON.parse(options.body).url;
        const data = settings.preview ? await settings.preview(link) : { name: 'Verified album', total: 14 };
        return { ok: !data.error, json: async () => data };
      }
      actions.push({ url, options });
      return { ok: true, json: async () => ({}) };
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'static', 'app.js'), 'utf8') +
    '\nglobalThis.api = { panels, queue, startJob, spotifyLinkType, isSpotifyUrl, buildCard, doZipDownload, previewLink, retryFailed, collectionKeys, switchTab };', context);
  if (!settings.realRendering) context.renderTracks = (tracks, panel) => rendered.push({ tracks, panel });
  elements.get('#format-select').value = 'mp3';
  elements.get('#bitrate-select').value = '160';
  return { ...context.api, elements, rendered, requests, streams, network, documentListeners, actions, downloads, confirmations };
}

const tracks = [1, 2, 3].map(number => ({ title: `Song ${number}`, artist: 'Artist',
  album: 'Album', state: 'pending', size: 'Pending' }));

test('metadata snapshots remain visible when conversion starts', () => {
  const fixture = page();
  fixture.startJob('album-job', 'playlist');
  const stream = fixture.streams[0];
  stream.onmessage({ data: JSON.stringify({ type: 'snapshot', state: 'metadata', tracks, total: 3, completed: 0 }) });
  assert.equal(fixture.rendered.at(-1).tracks.length, 3);
  assert.equal(fixture.panels.playlist.count.textContent, '3 tracks found');
  stream.onmessage({ data: JSON.stringify({ type: 'state', state: 'converting' }) });
  assert.equal(fixture.rendered.at(-1).tracks.length, 3);
  assert.equal(fixture.panels.playlist.count.textContent, '0 of 3 tracks');
  assert.equal(fixture.panels.playlist.label.textContent, 'Converting with FFmpeg...');
});

test('network monitoring survives form re-enabling and follows all active jobs through completion', async () => {
  const fixture = page();
  fixture.queue.push({ url: 'https://open.spotify.com/album/Album123', type: 'album' });
  await fixture.elements.get('#convert-form').listeners.get('submit')({ preventDefault() {} });
  assert.equal(fixture.elements.get('#submit-button').disabled, true, 'A running batch cannot be submitted twice');
  assert.equal(fixture.elements.get('#spotify-url').disabled, false);
  assert.equal(fixture.network.active, true, 'A posted job is still running after the form is re-enabled');
  fixture.streams[0].onmessage({ data: JSON.stringify({ type: 'snapshot', state: 'metadata', tracks: [] }) });
  assert.equal(fixture.network.phase, 'Metadata');
  fixture.startJob('second-job', 'track');
  fixture.streams[0].onmessage({ data: JSON.stringify({ type: 'tracks', state: 'processing', tracks: [{ state: 'downloading' }] }) });
  assert.equal(fixture.network.phase, 'Downloading');
  fixture.streams[0].onmessage({ data: JSON.stringify({ type: 'state', state: 'packaging', tracks: [] }) });
  assert.equal(fixture.network.active, true);
  fixture.streams[0].onmessage({ data: JSON.stringify({ type: 'complete', tracks: [], total: 0, completed: 0 }) });
  assert.equal(fixture.network.active, true, 'The second job is still reading metadata');
  fixture.streams[1].onmessage({ data: JSON.stringify({ type: 'tracks', state: 'converting', tracks: [{ state: 'converting' }] }) });
  assert.equal(fixture.network.phase, 'Converting');
  fixture.streams[1].onmessage({ data: JSON.stringify({ type: 'error', error: 'Source failed' }) });
  assert.equal(fixture.network.active, false);
  assert.equal(fixture.network.stops, 1);
});

test('jobs restored on page load also start network monitoring', async () => {
  const fixture = page({ jobs: [{ job_id: 'restored', state: 'processing', link_type: 'album', tracks: [], total: 14, completed: 2 }] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture.network.active, true);
  assert.equal(fixture.streams[0].url, '/convert/restored/events');
  fixture.streams[0].onmessage({ data: JSON.stringify({ type: 'complete', tracks: [], total: 14, completed: 14 }) });
  assert.equal(fixture.network.active, false);
});

test('mixed preparation and conversion states are shown while metadata still loads', () => {
  const fixture = page();
  fixture.startJob('album-job', 'playlist');
  const mixed = tracks.map((track, index) => ({ ...track,
    state: ['preparing', 'downloading', 'converting'][index], progress_pct: 50 }));
  fixture.streams[0].onmessage({ data: JSON.stringify({ type: 'tracks', state: 'processing',
    tracks: mixed, total: 14, completed: 0, metadata_loading: true }) });
  assert.equal(fixture.rendered.at(-1).tracks.length, 3);
  assert.equal(fixture.panels.playlist.label.textContent, '1 preparing · 1 downloading · 1 converting');
  assert.equal(fixture.panels.playlist.count.textContent, '0 of 14 tracks');
  assert.equal(fixture.panels.playlist.eta.textContent, 'Reading remaining tracks...');
  assert.equal(fixture.panels.playlist.cancelBtn.hidden, false);
  assert.equal(fixture.panels.playlist.dlBtn.disabled, true);
});

test('each active track has a stage label, detail, timer, and skip control', () => {
  const fixture = page();
  fixture.startJob('album-job', 'playlist');
  const labels = { preparing: 'Preparing', downloading: 'Downloading', converting: 'Converting',
    retrying: 'Retrying source', finishing: 'Finishing' };
  for (const [state, label] of Object.entries(labels)) {
    const card = fixture.buildCard({ ...tracks[0], state, message: 'Track stage details', elapsed_s: 5 }, 0, 'playlist');
    assert.equal(card.children.find(child => child.className === 'track-state').textContent, label);
    assert.ok(card.children.find(child => child.className === 'cancel-cb-wrap').children.length);
    const info = card.children.find(child => child.className === 'track-info');
    assert.equal(info.children.find(child => child.className === 'track-step').textContent, 'Track stage details');
    assert.equal(card.children.find(child => child.className === 'track-elapsed').textContent, '00:05');
  }
});

test('converted cards expose only the original download in both panels', () => {
  const fixture = page();
  for (const panel of ['track', 'playlist']) {
    fixture.startJob('album-job', panel);
    const card = fixture.buildCard({ ...tracks[0], state: 'converted' }, 0, panel);
    const nodes = [];
    function visit(element) { nodes.push(element); element.children.forEach(visit); }
    visit(card);
    assert.equal(nodes.filter(node => (node.className || '').startsWith('download-track')).length, 1);
    assert.equal(nodes.filter(node => node.dataset.stem).length, 0);
  }
});

test('a completed initial snapshot displays tracks and enables the archive download', () => {
  const fixture = page();
  fixture.startJob('album-job', 'playlist');
  const stream = fixture.streams[0];
  stream.onmessage({ data: JSON.stringify({ type: 'snapshot', state: 'complete',
    tracks: tracks.map(track => ({ ...track, state: 'converted' })), total: 3, completed: 3 }) });
  assert.equal(fixture.rendered.at(-1).tracks.length, 3);
  assert.equal(fixture.panels.playlist.dlBtn.disabled, false);
  assert.equal(stream.closed, true);
});

test('metadata failures explain the empty album panel and stop the loading indicator', () => {
  const fixture = page();
  fixture.startJob('album-job', 'playlist');
  const stream = fixture.streams[0];
  stream.onmessage({ data: JSON.stringify({ type: 'error', error: 'No tracks found' }) });
  assert.equal(fixture.panels.playlist.label.textContent, 'No tracks found');
  assert.equal(fixture.panels.playlist.count.textContent, 'No tracks loaded');
  assert.equal(fixture.panels.playlist.bar.classList.contains('indeterminate'), false);
  assert.equal(stream.closed, true);
});

test('a partial album explains the failed song and retains the real total', () => {
  const fixture = page();
  fixture.startJob('album-job', 'playlist');
  fixture.streams[0].onmessage({ data: JSON.stringify({ type: 'complete', total: 3, completed: 2,
    tracks: tracks.map((track, index) => ({ ...track, state: index === 1 ? 'error' : 'converted' })) }) });
  assert.equal(fixture.panels.playlist.label.textContent, 'Converted 2 of 3 tracks; 1 failed.');
  assert.equal(fixture.panels.playlist.count.textContent, '2 of 3 tracks');
});

test('manually retried tracks move above finished cards without changing download identities', async () => {
  const fixture = page({ realRendering: true });
  fixture.startJob('album-job', 'playlist');
  const update = tracks => fixture.streams[0].onmessage({ data: JSON.stringify({
    type: 'tracks', state: 'processing', tracks, total: 3, completed: 2,
  }) });
  const initial = tracks.map((track, index) => ({ ...track, state: index === 1 ? 'error' : 'converted' }));
  update(initial);
  const list = fixture.panels.playlist.list;
  const firstDone = list.children[0];
  const lastDone = list.children[2];
  fixture.panels.playlist.panel.scrollTop = 200;
  const retrying = initial.map((track, index) => index === 1 ? { ...track,
    state: 'preparing', retry_count: 1, message: 'Preparing this track again', progress_pct: 0 } : track);
  update(retrying);
  assert.deepEqual(list.children.map(card => Number(card.dataset.trackIndex)), [1, 0, 2]);
  assert.equal(list.children[1], firstDone);
  assert.equal(list.children[2], lastDone);
  assert.equal(list.children[0].querySelector('.track-state').textContent, 'Preparing again');
  assert.equal(fixture.panels.playlist.panel.scrollTop, 0);
  assert.match(fixture.panels.playlist.label.textContent, /Retrying 1 failed track/);
  assert.equal(fixture.panels.playlist.dlBtn.disabled, true);
  fixture.panels.playlist.panel.scrollTop = 100;
  update(retrying);
  assert.equal(fixture.panels.playlist.panel.scrollTop, 100, 'Repeated progress must not force scrolling');

  update(retrying.map(track => ({ ...track, state: 'converted' })));
  assert.deepEqual(list.children.map(card => Number(card.dataset.trackIndex)), [0, 1, 2]);
  const button = list.children[1].querySelector('.download-track');
  await fixture.documentListeners.get('click')({ target: button });
  assert.equal(fixture.downloads[0].url, '/convert/album-job/tracks/1/download');
});

test('queued retries remain ordered and skip controls still cancel their original tracks', async () => {
  const fixture = page({ realRendering: true });
  fixture.startJob('album-job', 'playlist');
  fixture.streams[0].onmessage({ data: JSON.stringify({ type: 'tracks', state: 'processing', total: 3,
    completed: 1, tracks: tracks.map((track, index) => ({ ...track, retry_count: index ? 1 : 0,
      state: index ? 'pending' : 'converted', message: index ? 'Waiting to prepare again' : '' })) }) });
  const list = fixture.panels.playlist.list;
  assert.deepEqual(list.children.map(card => Number(card.dataset.trackIndex)), [1, 2, 0]);
  const checkbox = list.children[1].querySelector('.cancel-checkbox');
  checkbox.checked = true;
  await fixture.documentListeners.get('change')({ target: checkbox });
  assert.equal(fixture.actions[0].url, '/convert/album-job/tracks/2/cancel');
  assert.equal(list.children[1].querySelector('.track-state').textContent, 'Skipped');
});

test('ZIP downloads use the collection filename supplied by the completed job', async () => {
  const fixture = page();
  fixture.startJob('album-job', 'playlist');
  fixture.streams[0].onmessage({ data: JSON.stringify({ type: 'complete', total: 3, completed: 3,
    tracks: tracks.map(track => ({ ...track, state: 'converted' })), archive_name: '周末 Mix.zip' }) });
  await fixture.doZipDownload('playlist');
  assert.equal(fixture.downloads[0].options.fallbackName, '周末 Mix.zip');
});

test('an unreadable album is reported without disabling successful downloads', () => {
  const fixture = page();
  fixture.startJob('album-job', 'playlist');
  fixture.streams[0].onmessage({ data: JSON.stringify({ type: 'complete', total: 3, completed: 3,
    tracks: tracks.map(track => ({ ...track, state: 'converted' })),
    metadata_errors: [{ error: 'Album unavailable' }] }) });
  assert.match(fixture.panels.playlist.label.textContent, /1 link could not be read/);
  assert.equal(fixture.panels.playlist.dlBtn.disabled, false);
});

test('completion shows the measured duration when the backend provides it', () => {
  const fixture = page();
  fixture.startJob('album-job', 'playlist');
  fixture.streams[0].onmessage({ data: JSON.stringify({ type: 'complete', total: 3, completed: 3,
    tracks: tracks.map(track => ({ ...track, state: 'converted' })), timings: { total_s: 42 } }) });
  assert.match(fixture.panels.playlist.eta.textContent, /Finished in/);
  assert.match(fixture.panels.playlist.eta.textContent, /42/);
});

test('queued links get separate named carousel panels in their original order', async () => {
  const fixture = page();
  const albumUrls = ['https://open.spotify.com/album/Album1', 'https://open.spotify.com/album/Album2'];
  fixture.queue.push(...albumUrls.map(url => ({ url, type: 'album' })),
    { url: 'https://open.spotify.com/track/Track1', type: 'track' });
  await fixture.elements.get('#convert-form').listeners.get('submit')({ preventDefault() {} });
  assert.equal(fixture.requests.length, 1);
  assert.deepEqual(fixture.requests[0].urls, [...albumUrls, 'https://open.spotify.com/track/Track1']);
  assert.equal(fixture.streams.length, 3);
  assert.equal(fixture.collectionKeys.length, 3);
  assert.equal(fixture.panels['job-1'].panel.hidden, false);
  assert.equal(fixture.panels['job-2'].panel.hidden, true);
  assert.match(fixture.panels['job-2'].label.textContent, /Waiting/);
  fixture.elements.get('#collection-next').listeners.get('click')();
  assert.equal(fixture.panels['job-2'].panel.hidden, false);
  assert.equal(fixture.panels['job-1'].panel.hidden, true);
  assert.equal(fixture.elements.get('#collection-position').textContent, '2 of 3');
  assert.equal(fixture.queue.length, 0);
});

test('verified collection names appear before adding and queues stop at five links', async () => {
  const fixture = page();
  for (let i = 0; i < 5; i++) {
    fixture.elements.get('#spotify-url').value = `https://open.spotify.com/album/Album${i}?si=shared`;
    await fixture.previewLink();
    assert.equal(fixture.elements.get('#link-preview-name').textContent, 'Verified album');
    fixture.elements.get('#add-queue-btn').listeners.get('click')();
  }
  assert.equal(fixture.queue.length, 5);
  assert.equal(fixture.elements.get('#queue-count').textContent, '5 / 5 links');
  assert.equal(fixture.elements.get('#add-queue-btn').disabled, true);
  fixture.elements.get('#add-queue-btn').listeners.get('click')();
  assert.equal(fixture.queue.length, 5);
  assert.match(fixture.elements.get('#message').textContent, /up to 5/);
  assert.ok(fixture.queue.every(item => item.name === 'Verified album' && !item.url.includes('?')));
});

test('a playlist with 200 tracks warns before adding and respects cancellation', async () => {
  const settings = { confirm: false, preview: async () => ({ name: 'Big playlist', total: 200 }) };
  const fixture = page(settings);
  fixture.elements.get('#spotify-url').value = 'https://open.spotify.com/playlist/Large123';
  await fixture.previewLink();
  assert.equal(fixture.elements.get('#link-preview-warning').hidden, false);
  fixture.elements.get('#add-queue-btn').listeners.get('click')();
  assert.equal(fixture.queue.length, 0);
  assert.match(fixture.confirmations[0], /200 tracks/);
  settings.confirm = true;
  fixture.elements.get('#add-queue-btn').listeners.get('click')();
  assert.equal(fixture.queue.length, 1);
});

test('a late preview cannot add the wrong collection and duplicate share links are rejected', async () => {
  const pending = new Map();
  const fixture = page({ preview: link => new Promise(resolve => pending.set(link, resolve)) });
  const first = 'https://open.spotify.com/album/First';
  const second = 'https://open.spotify.com/album/Second';
  fixture.elements.get('#spotify-url').value = first;
  const readFirst = fixture.previewLink();
  fixture.elements.get('#spotify-url').value = second;
  const readSecond = fixture.previewLink();
  pending.get(second)({ name: 'Second album', total: 3 }); await readSecond;
  pending.get(first)({ name: 'Wrong old album', total: 2 }); await readFirst;
  assert.equal(fixture.elements.get('#link-preview-name').textContent, 'Second album');
  fixture.elements.get('#add-queue-btn').listeners.get('click')();
  assert.equal(fixture.queue[0].url, second);
  fixture.elements.get('#spotify-url').value = second + '?si=anotherShare';
  const duplicate = fixture.previewLink();
  pending.get(second + '?si=anotherShare')({ name: 'Second album', total: 3 }); await duplicate;
  fixture.elements.get('#add-queue-btn').listeners.get('click')();
  assert.equal(fixture.queue.length, 1);
});

test('failed tracks wait for a manual click after all tracks settle', async () => {
  const fixture = page({ realRendering: true });
  fixture.startJob('album-job', 'album-job', { name: 'Album one', link_type: 'album' });
  const failed = tracks.map((track, index) => ({ ...track, state: index === 1 ? 'error' : 'converted', error: index === 1 ? 'Source unavailable' : '' }));
  fixture.streams[0].onmessage({ data: JSON.stringify({ type: 'tracks', state: 'processing', total: 3, completed: 2, tracks: failed }) });
  const p = fixture.panels['album-job'];
  assert.equal(p.retryBtn.disabled, true);
  assert.equal(p.list.querySelector('.retry-track').disabled, true);
  assert.equal(fixture.actions.length, 0);
  fixture.streams[0].onmessage({ data: JSON.stringify({ type: 'complete', total: 3, completed: 2, tracks: failed }) });
  assert.equal(p.retryBtn.disabled, false);
  const retry = p.list.querySelector('.retry-track');
  assert.equal(retry.disabled, false);
  await fixture.documentListeners.get('click')({ target: retry });
  assert.equal(fixture.actions[0].url, '/convert/album-job/retry');
  assert.deepEqual(JSON.parse(fixture.actions[0].options.body).indices, [1]);
  assert.equal(p.status.state, 'queued');
  assert.equal(fixture.streams.length, 2);
});

test('a failed submission preserves all verified queue entries', async () => {
  const fixture = page({ submitError: 'Server unavailable' });
  fixture.queue.push({ url: 'https://open.spotify.com/album/Album1', type: 'album', name: 'Album one', total: 14 });
  await fixture.elements.get('#convert-form').listeners.get('submit')({ preventDefault() {} });
  assert.equal(fixture.queue.length, 1);
  assert.equal(fixture.elements.get('#message').textContent, 'Server unavailable');
  assert.equal(fixture.elements.get('#submit-button').disabled, false);
});

test('shared album links retain their type and invalid album paths are rejected', () => {
  const fixture = page();
  const url = 'https://open.spotify.com/intl-en/album/Album123?si=shared';
  assert.equal(fixture.spotifyLinkType(url), 'album');
  assert.equal(fixture.isSpotifyUrl(url), true);
  assert.equal(fixture.isSpotifyUrl('https://open.spotify.com/album/'), false);
});
