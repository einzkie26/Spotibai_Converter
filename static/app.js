'use strict';

// ── DOM refs ───────────────────────────────────────────────────────────────
const form            = document.querySelector('#convert-form');
const urlInput        = document.querySelector('#spotify-url');
const addQueueBtn     = document.querySelector('#add-queue-btn');
const queueList       = document.querySelector('#queue-list');
const button          = document.querySelector('#submit-button');
const message         = document.querySelector('#message');
const formatSelect    = document.querySelector('#format-select');
const bitrateSelect   = document.querySelector('#bitrate-select');
const settingsSummary = document.querySelector('#settings-summary');
const spatialToggle   = document.querySelector('#spatial-toggle');
const spatialLabel    = document.querySelector('#spatial-label');
const themeToggle     = document.querySelector('#theme-toggle');
const themeIcon       = themeToggle.querySelector('.theme-icon');
const themeLabel      = themeToggle.querySelector('.theme-label');
const networkMonitor = NetworkStats.create();
let startingJobs = false;

const panelsContainer = document.querySelector('#panels-container');
const collectionTabs = document.querySelector('#collection-tabs');
const collectionSlides = document.querySelector('#collection-slides');
const carouselNavigation = document.querySelector('#carousel-navigation');
const previousCollection = document.querySelector('#collection-previous');
const nextCollection = document.querySelector('#collection-next');
const collectionPosition = document.querySelector('#collection-position');
const panels = {};
const collectionKeys = [];
let selectedCollection = 0;
const terminalStates = new Set(['complete', 'error']);

function node(tag, className = '', text = '') {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
}

function switchTab(key) {
  const index = collectionKeys.indexOf(key);
  if (index < 0) return;
  selectedCollection = index;
  collectionKeys.forEach(item => {
    panels[item].panel.hidden = item !== key;
    panels[item].tab.classList.toggle('panel-tab--active', item === key);
    panels[item].tab.setAttribute('aria-current', item === key ? 'true' : 'false');
  });
  collectionPosition.textContent = `${index + 1} of ${collectionKeys.length}`;
  previousCollection.disabled = index === 0;
  nextCollection.disabled = index === collectionKeys.length - 1;
}

previousCollection.addEventListener('click', () => switchTab(collectionKeys[selectedCollection - 1]));
nextCollection.addEventListener('click', () => switchTab(collectionKeys[selectedCollection + 1]));

function createPanel(entry, key = entry.job_id) {
  if (panels[key]) return panels[key];
  const p = { jobId: entry.job_id, name: entry.name || 'Spotify collection', type: entry.link_type || entry.type,
    startedAt: performance.now(), status: { state: 'queued', tracks: [], total: 0, completed: 0 },
    panel: node('section', 'conversion-panel collection-slide'), label: node('span'), percent: node('strong'),
    bar: node('div', 'progress-bar'), count: node('span'), eta: node('span'), list: node('div', 'track-list'),
    dlBtn: node('button', 'download-button', 'Download ZIP'), cancelBtn: node('button', 'cancel-all-btn', 'Skip remaining'),
    retryBtn: node('button', 'retry-failed-button', 'Retry failed'), resumeBtn: node('button', 'retry-failed-button', 'Resume'),
    title: node('h2', 'panel-label'), tab: node('button', 'panel-tab'),
  };
  p.panel.dataset.jobId = p.jobId;
  p.panel.setAttribute('aria-label', p.name);
  p.title.textContent = p.name;
  p.tab.textContent = p.name;
  p.tab.title = p.name;
  p.tab.type = 'button';
  p.tab.addEventListener('click', () => switchTab(key));
  const header = node('div', 'panel-header');
  const actions = node('div', 'panel-header-actions');
  for (const control of [p.cancelBtn, p.retryBtn, p.resumeBtn, p.dlBtn]) control.type = 'button';
  p.dlBtn.disabled = true;
  p.cancelBtn.hidden = p.retryBtn.hidden = p.resumeBtn.hidden = true;
  p.dlBtn.addEventListener('click', () => doZipDownload(key));
  p.retryBtn.addEventListener('click', () => retryFailed(key));
  p.cancelBtn.addEventListener('click', () => cancelRemaining(key));
  p.resumeBtn.addEventListener('click', async () => {
    p.resumeBtn.disabled = true;
    try {
      const response = await fetch(`/convert/${p.jobId}/resume`, { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not resume this collection.');
      applyStatus({ state: 'queued' }, key);
      connectEvents(key);
    } catch (error) { p.label.textContent = error.message; }
    finally { p.resumeBtn.disabled = false; }
  });
  actions.append(p.cancelBtn, p.retryBtn, p.resumeBtn, p.dlBtn);
  header.append(p.title, actions);
  const progress = node('div', 'progress-meta');
  progress.append(p.label, p.percent);
  const track = node('div', 'progress-track');
  p.bar.setAttribute('role', 'progressbar');
  p.bar.setAttribute('aria-valuemin', '0'); p.bar.setAttribute('aria-valuemax', '100');
  track.append(p.bar);
  const eta = node('div', 'eta'); eta.append(p.count, p.eta);
  p.panel.append(header, progress, track, eta, p.list);
  panels[key] = p;
  panelState[key] = { downloaded: new Set(), cancelled: new Set(), es: null };
  collectionKeys.push(key);
  collectionTabs.append(p.tab); collectionSlides.append(p.panel);
  collectionTabs.hidden = carouselNavigation.hidden = collectionKeys.length < 2;
  panelsContainer.hidden = false;
  switchTab(collectionKeys[selectedCollection]);
  return p;
}

// ── theme ──────────────────────────────────────────────────────────────────
const setTheme = (t) => {
  document.documentElement.dataset.theme = t;
  const dark = t === 'dark';
  themeIcon.textContent  = dark ? '☼' : '◐';
  themeLabel.textContent = dark ? 'Light mode' : 'Dark mode';
  themeToggle.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
};
setTheme(localStorage.getItem('spotibai-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
themeToggle.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('spotibai-theme', next);
  setTheme(next);
});

// ── queue ──────────────────────────────────────────────────────────────────
const queue = [];
const previewBox = document.querySelector('#link-preview');
const previewName = document.querySelector('#link-preview-name');
const previewDetail = document.querySelector('#link-preview-detail');
const previewWarning = document.querySelector('#link-preview-warning');
const queueCount = document.querySelector('#queue-count');
let currentPreview = null;
let previewGeneration = 0;
let previewTimer;
let previewAbort;
let previewLoading = false;

function canonicalLink(url) {
  const parts = new URL(url.trim()).pathname.replace(/\/$/, '').split('/');
  return `https://open.spotify.com/${parts.at(-2)}/${parts.at(-1)}`;
}

function hasRunningJobs() {
  return Object.values(panels).some(panel => ['queued', 'metadata', 'processing', 'converting', 'packaging'].includes(panel.status.state));
}

function updateQueueControls() {
  queueCount.textContent = `${queue.length} / 5 links`;
  addQueueBtn.disabled = startingJobs || previewLoading || !currentPreview || queue.length >= 5;
  button.disabled = startingJobs || !queue.length || hasRunningJobs();
}

async function previewLink() {
  const url = urlInput.value.trim();
  const generation = ++previewGeneration;
  previewAbort?.abort();
  currentPreview = null;
  previewLoading = false;
  if (!isSpotifyUrl(url)) { previewBox.hidden = true; updateQueueControls(); syncNetworkMonitor(); return; }
  previewAbort = new AbortController();
  previewLoading = true;
  previewBox.hidden = false;
  previewName.textContent = 'Checking this link…';
  previewDetail.textContent = 'Reading the collection name and track count';
  previewWarning.hidden = true;
  updateQueueControls();
  syncNetworkMonitor();
  try {
    const response = await fetch('/collections/preview', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }), signal: previewAbort.signal });
    const data = await response.json();
    if (generation !== previewGeneration) return;
    if (!response.ok || !data.name || !Number.isInteger(data.total) || data.total < 1) {
      throw new Error(data.error || 'This collection could not be verified.');
    }
    if (canonicalLink(urlInput.value) !== canonicalLink(url)) return;
    currentPreview = { ...data, url: canonicalLink(url), type: spotifyLinkType(url) };
    previewName.textContent = data.name;
    previewDetail.textContent = `${currentPreview.type} · ${data.total} track${data.total === 1 ? '' : 's'}`;
    previewWarning.hidden = !(currentPreview.type === 'playlist' && data.total >= 200);
    previewWarning.textContent = 'Large playlist: 200 or more tracks. Preparation and conversion will take longer; some audio sources may be unavailable.';
  } catch (error) {
    if (generation !== previewGeneration || error.name === 'AbortError') return;
    previewName.textContent = 'Could not verify this link';
    previewDetail.textContent = error.message;
  } finally {
    if (generation === previewGeneration) { previewLoading = false; updateQueueControls(); syncNetworkMonitor(); }
  }
}

urlInput.addEventListener('input', () => {
  previewGeneration++;
  previewAbort?.abort();
  currentPreview = null;
  previewLoading = false;
  previewBox.hidden = true;
  clearTimeout(previewTimer);
  updateQueueControls();
  syncNetworkMonitor();
  if (isSpotifyUrl(urlInput.value.trim())) previewTimer = setTimeout(previewLink, 450);
});
urlInput.addEventListener('change', () => { clearTimeout(previewTimer); previewLink(); });

function spotifyLinkType(url) {
  try {
    const m = new URL(url).pathname.match(/^\/(?:intl-[^/]+\/)?(playlist|album|track)\/[A-Za-z0-9]+\/?$/);
    return m ? m[1] : '';
  } catch { return ''; }
}
function isSpotifyUrl(url) {
  try {
    const p = new URL(url);
    return p.protocol === 'https:' &&
      (p.hostname === 'open.spotify.com' || p.hostname === 'spotify.com') && !!spotifyLinkType(url);
  } catch { return false; }
}

function renderQueue() {
  queueList.hidden = queue.length === 0;
  queueList.replaceChildren();
  queue.forEach((item, i) => {
    const li = document.createElement('li');
    li.className = 'queue-item';
    const typeTag = document.createElement('span');
    typeTag.className = `queue-type queue-type--${item.type}`;
    typeTag.textContent = item.type;
    const urlSpan = node('div', 'queue-collection');
    const name = node('strong', 'queue-name', item.name || item.url);
    const detail = node('span', 'queue-url', `${item.total || 1} track${item.total === 1 ? '' : 's'} · ${item.url}`);
    urlSpan.append(name, detail);
    const rm = document.createElement('button');
    rm.type = 'button'; rm.className = 'queue-remove';
    rm.dataset.idx = i; rm.textContent = '✕';
    li.append(typeTag, urlSpan, rm);
    queueList.append(li);
  });
  updateQueueControls();
}

addQueueBtn.addEventListener('click', () => {
  if (startingJobs) return;
  if (queue.length >= 5) { message.textContent = 'The queue is full. You can add up to 5 links.'; return; }
  const url = urlInput.value.trim();
  if (!isSpotifyUrl(url)) {
    message.className = 'message';
    message.textContent = 'Paste a valid Spotify link first.';
    return;
  }
  if (!currentPreview || currentPreview.url !== canonicalLink(url)) {
    clearTimeout(previewTimer); previewLink();
    message.textContent = 'Review the collection name, then click Add to Queue.';
    return;
  }
  if (queue.find(q => q.url === canonicalLink(url))) {
    message.className = 'message';
    message.textContent = 'Already in queue.';
    return;
  }
  if (currentPreview.type === 'playlist' && currentPreview.total >= 200 && !confirm(
    `“${currentPreview.name}” contains ${currentPreview.total} tracks. Large playlists take longer and may include unavailable audio sources. Add it to the queue?`)) return;
  queue.push({ ...currentPreview });
  urlInput.value = '';
  currentPreview = null;
  previewBox.hidden = true;
  message.textContent = '';
  renderQueue();
});

urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); addQueueBtn.click(); }
});

queueList.addEventListener('click', (e) => {
  if (startingJobs) return;
  const rm = e.target.closest('.queue-remove');
  if (!rm) return;
  queue.splice(Number(rm.dataset.idx), 1);
  renderQueue();
});

// ── helpers ────────────────────────────────────────────────────────────────
const fmt = (ms) => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2,'0')}:${String(s % 60).padStart(2,'0')}`;
};
const fmtSec = (s) => {
  s = Math.floor(s);
  return `${String(Math.floor(s / 60)).padStart(2,'0')}:${String(s % 60).padStart(2,'0')}`;
};
const etaStr = (startedAt, done, total) => {
  if (!done || !total) return 'Waiting for the first track';
  if (done >= total) return 'Almost done';
  const rem = ((performance.now() - startedAt) / done) * (total - done);
  return `~${fmt(rem)} remaining`;
};
const phaseMsg = (state, metaCount, metaTotal) => {
  if (state === 'queued') return 'Waiting for the previous collection to finish';
  if (state === 'interrupted') return 'Conversion interrupted. Click Resume to continue.';
  if (state === 'metadata') {
    return metaTotal > 0
      ? `Reading Spotify metadata... (${metaCount}/${metaTotal})`
      : 'Reading Spotify metadata...';
  }
  return ({
    converting: 'Converting with FFmpeg...',
    packaging:  'Building ZIP...',
  }[state] || 'Preparing...');
};

const updateSettingsSummary = () => {
  settingsSummary.textContent = `${formatSelect.value.toUpperCase()} / ${Number(bitrateSelect.value).toLocaleString()} kbps`;
};
const setSettingsDisabled = (d) => {
  formatSelect.disabled  = d;
  bitrateSelect.disabled = d;
  spatialToggle.disabled = d;
  spatialLabel.style.opacity       = d ? '.5' : '';
  spatialLabel.style.pointerEvents = d ? 'none' : '';
  addQueueBtn.disabled = d;
  urlInput.disabled    = d;
  queueList.querySelectorAll('.queue-remove').forEach(control => { control.disabled = d; });
};
const navLibrary = document.querySelector('.nav-library');
function setConverting(on) {
  setSettingsDisabled(on);
  navLibrary.classList.toggle('nav-library--disabled', on);
  if (on) navLibrary.setAttribute('aria-disabled', 'true');
  else navLibrary.removeAttribute('aria-disabled');
}
formatSelect.addEventListener('change', updateSettingsSummary);
bitrateSelect.addEventListener('change', updateSettingsSummary);
updateSettingsSummary();

// ── per-card elapsed timers ────────────────────────────────────────────────
const cardTimers = new Map();

function startCardTimer(panelKey, index, initSec, el) {
  const key = `${panelKey}:${index}`;
  stopCardTimer(panelKey, index);
  let sec = initSec;
  const id = setInterval(() => {
    sec++;
    const target = el || panels[panelKey].list.querySelector(`.track-elapsed[data-idx="${index}"]`);
    if (target) target.textContent = fmtSec(sec);
  }, 1000);
  cardTimers.set(key, id);
}
function stopCardTimer(panelKey, index) {
  const key = `${panelKey}:${index}`;
  if (cardTimers.has(key)) { clearInterval(cardTimers.get(key)); cardTimers.delete(key); }
}

// ── per-panel state ────────────────────────────────────────────────────────
const panelState = {};
const activeTrackStates = new Set(['preparing', 'downloading', 'converting', 'finishing', 'retrying']);
const trackStateLabels = { pending: 'Queued', preparing: 'Preparing', downloading: 'Downloading',
  converting: 'Converting', finishing: 'Finishing', retrying: 'Retrying source',
  converted: 'Done', cancelled: 'Skipped', error: 'Failed' };

function workSummary(tracks) {
  return ['preparing', 'downloading', 'converting', 'retrying', 'finishing'].map(state => {
    const count = tracks.filter(track => track.state === state).length;
    return count ? `${count} ${state}` : '';
  }).filter(Boolean).join(' · ') || 'Preparing tracks...';
}
const tkey = (t) => `${t.artist}|${t.title}`;

// ── cover ──────────────────────────────────────────────────────────────────
function makeCover(track, index) {
  if (track.cover_url) {
    const img = document.createElement('img');
    img.src = track.cover_url; img.alt = track.album || '';
    img.loading = 'lazy'; img.className = 'track-cover';
    return img;
  }
  const span = document.createElement('span');
  span.className = 'track-cover';
  span.textContent = String(track.track_number || index + 1).padStart(2,'0');
  return span;
}

// ── build card ─────────────────────────────────────────────────────────────
function buildCard(track, index, panelKey) {
  const ps   = panelState[panelKey];
  const p    = panels[panelKey];
  const card = document.createElement('article');
  const isCancelled = track.state === 'cancelled';
  const isConverted = track.state === 'converted';
  const isActive    = track.state === 'pending' || activeTrackStates.has(track.state);
  if (!isActive) stopCardTimer(panelKey, index);
  card.className = `track-card${isConverted ? ' converted' : ''}${isCancelled ? ' track-cancelled' : ''}`;
  card.dataset.trackIndex = index;

  // Keep the skip control available throughout active work.
  const cbWrap = document.createElement('label');
  cbWrap.className = 'cancel-cb-wrap';
  if (isActive) {
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.className = 'cancel-checkbox';
    cb.dataset.trackIndex = index; cb.dataset.panel = panelKey;
    cb.checked = ps.cancelled.has(index);
    cbWrap.append(cb);
    cbWrap.title = 'Skip this track';
  }

  const cover = makeCover(track, index);

  const info = document.createElement('div');
  info.className = 'track-info';
  const titleEl  = document.createElement('strong');
  titleEl.className = 'track-title'; titleEl.textContent = track.title || 'Unknown';
  const artistEl = document.createElement('span');
  artistEl.className = 'track-artist'; artistEl.textContent = track.artist || '';
  const albumEl  = document.createElement('span');
  albumEl.className = 'track-album'; albumEl.textContent = track.album || '';
  const tags = document.createElement('div'); tags.className = 'track-tags';
  for (const label of [
    track.format || 'MP3', track.quality || '160 kbps',
    track.spatial ? 'Spatial' : null, track.size || 'Pending',
    track.explicit ? 'E' : null,
    track.retry_count ? `Manual retry ${track.retry_count}` : null,
  ].filter(Boolean)) {
    const tag = document.createElement('i'); tag.textContent = label;
    if (label === 'E') tag.title = 'Explicit';
    if (label === 'Spatial') tag.className = 'tag-spatial';
    tags.append(tag);
  }
  info.append(titleEl, artistEl, albumEl, tags);
  if ((isActive && track.message) || (track.state === 'error' && track.error)) {
    const step = document.createElement('span');
    step.className = 'track-step';
    step.textContent = track.state === 'error' ? track.error : track.message;
    info.append(step);
  }

  const badge = document.createElement('b');
  badge.className = 'track-state';
  badge.textContent = track.state === 'preparing' && track.retry_count ? 'Preparing again' : trackStateLabels[track.state] || 'Queued';
  badge.title = track.error || track.message || '';

  if (track.state === 'error') {
    const retry = node('button', 'retry-track', 'Retry');
    retry.type = 'button'; retry.dataset.panel = panelKey; retry.dataset.trackIndex = index;
    retry.disabled = !terminalStates.has(p.status.state);
    retry.title = retry.disabled ? 'Available after all tracks finish converting' : 'Prepare and convert this failed track again';
    card.append(cbWrap, cover, info, retry, badge);
    return card;
  }

  if (isConverted && p.jobId) {
    stopCardTimer(panelKey, index);
    const key   = tkey(track);
    const wasDl = ps.downloaded.has(key);
    const dlBtn = document.createElement('button');
    dlBtn.className = `download-track${wasDl ? ' track-redownload' : ''}`;
    dlBtn.type = 'button'; dlBtn.dataset.trackIndex = index; dlBtn.dataset.panel = panelKey;
    dlBtn.textContent = wasDl ? 'Downloaded ↓' : 'Download';
    card.append(cbWrap, cover, info, dlBtn, badge);
    return card;
  }

  if (isActive) {
    const elapsedEl = document.createElement('span');
    elapsedEl.className = 'track-elapsed'; elapsedEl.dataset.idx = index;
    if (activeTrackStates.has(track.state) && track.elapsed_s != null) {
      elapsedEl.textContent = fmtSec(track.elapsed_s);
      startCardTimer(panelKey, index, track.elapsed_s, elapsedEl);
    }
    card.append(cbWrap, cover, info, elapsedEl, badge);
    return card;
  }

  card.append(cbWrap, cover, info, badge);
  return card;
}

// ── render tracks into a panel ─────────────────────────────────────────────
function renderTracks(tracks, panelKey) {
  const list = panels[panelKey].list;
  let retriesStarted = false;
  tracks.forEach((track, index) => {
    const existing  = list.querySelector(`[data-track-index="${index}"]`);
    const prevState = existing?.dataset.trackState;
    const prevSize  = existing?.dataset.trackSize;
    const prevCover = existing?.dataset.trackCover;
    const prevMessage = existing?.dataset.trackMessage;
    const prevRetry = existing?.dataset.trackRetry;
    const retryAllowed = String(terminalStates.has(panels[panelKey].status.state));
    if (track.retry_count && !['converted', 'cancelled'].includes(track.state) && prevRetry !== String(track.retry_count)) {
      retriesStarted = true;
    }
    if (existing && prevState === track.state && prevSize === (track.size||'') && prevCover === (track.cover_url||'') && prevMessage === (track.message||'') && prevRetry === String(track.retry_count || 0) && (track.state !== 'error' || existing.dataset.retryAllowed === retryAllowed)) {
      if (activeTrackStates.has(track.state) && track.elapsed_s != null && !cardTimers.has(`${panelKey}:${index}`)) {
        const el = existing.querySelector('.track-elapsed');
        if (el) startCardTimer(panelKey, index, track.elapsed_s, el);
      }
      return;
    }
    const card = buildCard(track, index, panelKey);
    card.dataset.trackState = track.state;
    card.dataset.trackSize  = track.size || '';
    card.dataset.trackCover = track.cover_url || '';
    card.dataset.trackMessage = track.message || '';
    card.dataset.trackRetry = String(track.retry_count || 0);
    card.dataset.retryAllowed = retryAllowed;
    if (existing) list.replaceChild(card, existing);
    else list.append(card);
  });
  list.querySelectorAll('[data-track-index]').forEach(el => {
    if (parseInt(el.dataset.trackIndex, 10) >= tracks.length) el.remove();
  });
  // Move existing cards without changing their download/cancel indices or timers.
  const ordered = tracks.map((track, index) => ({ index,
    priority: track.retry_count && !['converted', 'cancelled'].includes(track.state) ? 0 : 1,
  })).sort((a, b) => a.priority - b.priority || a.index - b.index);
  ordered.forEach(({ index }, position) => {
    const card = list.querySelector(`[data-track-index="${index}"]`);
    if (card && list.children[position] !== card) list.insertBefore(card, list.children[position] || null);
  });
  if (retriesStarted) panels[panelKey].panel.scrollTop = 0;
}

function applyStatus(status, panelKey) {
  const p          = panels[panelKey];
  p.status = { ...p.status, ...status };
  const { state, tracks = [], total = 0, completed = 0, meta_count, meta_total, metadata_loading, metadata_errors = [], error } = p.status;
  const isComplete = state === 'complete';
  if (p.status.name) p.name = p.status.name;
  p.title.textContent = p.name;
  p.panel.setAttribute('aria-label', p.name);
  const processed = tracks.reduce((sum, track) => sum +
    (['converted', 'cancelled', 'error'].includes(track.state) ? 100 : (track.progress_pct || 0)), 0);
  const pct = isComplete ? 100 : (total > 0 ? Math.min(99, Math.round(processed / total)) : 0);

  p.label.textContent   = isComplete ? 'Conversion complete' : phaseMsg(state, meta_count || 0, meta_total || 0);
  if (state === 'processing' || (state === 'converting' && tracks.some(track => activeTrackStates.has(track.state)))) {
    p.label.textContent = workSummary(tracks);
    const retrying = tracks.filter(track => track.retry_count &&
      (track.state === 'pending' || activeTrackStates.has(track.state))).length;
    if (retrying) p.label.textContent = `Retrying ${retrying} failed track${retrying === 1 ? '' : 's'} · ${p.label.textContent}`;
  }
  const failed = tracks.filter(track => track.state === 'error').length;
  if (isComplete && failed) p.label.textContent = `Converted ${completed} of ${total} tracks; ${failed} failed.`;
  if (isComplete && metadata_errors.length) {
    p.label.textContent += ` ${metadata_errors.length} link${metadata_errors.length === 1 ? '' : 's'} could not be read.`;
  }
  p.label.title = metadata_errors.map(item => item.error).join('\n');
  if (state === 'error') p.label.textContent = error || 'Conversion failed.';
  p.percent.textContent = `${pct}%`;
  p.bar.style.width     = `${pct}%`;
  p.bar.setAttribute('aria-valuenow', String(pct));
  p.bar.setAttribute('aria-label', `${p.name}: ${pct}%`);
  p.bar.classList.toggle('indeterminate', ['metadata', 'processing'].includes(state) && total === 0);

  if (total > 0) {
    p.count.textContent = state === 'metadata'
      ? `${total} track${total===1?'':'s'} found`
      : `${completed} of ${total} track${total===1?'':'s'}`;
    p.eta.textContent   = state === 'error' ? '' : isComplete
      ? (p.status.timings?.total_s != null ? `Finished in ${fmtSec(p.status.timings.total_s)}` : '')
      : metadata_loading ? 'Reading remaining tracks...' : etaStr(p.startedAt, completed, total);
  } else if (state === 'error') {
    p.count.textContent = 'No tracks loaded';
    p.bar.classList.remove('indeterminate');
  } else {
    p.count.textContent = state === 'queued' ? 'Queued' : 'Preparing…';
    p.eta.textContent = '';
  }
  if (state === 'queued') p.eta.textContent = 'Collections prepare and convert one at a time';

  if (tracks && tracks.length) {
    panels[panelKey].list.querySelectorAll('.meta-log-line').forEach(el => el.remove());
    renderTracks(tracks, panelKey);
  }

  p.dlBtn.disabled = !isComplete || completed === 0;
  p.dlBtn.textContent = p.type === 'track' ? 'Download track' : 'Download ZIP';
  p.cancelBtn.hidden = !['converting', 'processing', 'metadata'].includes(state) || !tracks.length;
  p.retryBtn.hidden = failed === 0;
  p.retryBtn.disabled = !terminalStates.has(state);
  p.retryBtn.textContent = `Retry failed (${failed})`;
  p.resumeBtn.hidden = state !== 'interrupted';
  const label = state === 'queued' ? 'Waiting' : state === 'complete' ? (failed ? `Done · ${failed} failed` : 'Done')
    : state === 'error' ? 'Failed' : state === 'metadata' ? 'Preparing' : state === 'interrupted' ? 'Interrupted' : 'Converting';
  p.tab.textContent = `${p.name} · ${label}`;
  p.tab.title = `${p.name} — ${label}`;
  updateQueueControls();
  syncNetworkMonitor();
}

// ── start one job and wire SSE ─────────────────────────────────────────────
function startJob(jobId, panelKey = jobId, entry = {}) {
  createPanel({ ...entry, job_id: jobId }, panelKey);
  applyStatus({ state: 'metadata', ...entry }, panelKey);
  if (!terminalStates.has(panels[panelKey].status.state) && panels[panelKey].status.state !== 'interrupted') connectEvents(panelKey);
}

function connectEvents(panelKey) {
  const p = panels[panelKey];
  const ps = panelState[panelKey];
  if (ps.es) { ps.es.close(); ps.es = null; }
  const es = new EventSource(`/convert/${p.jobId}/events`);
  ps.es = es;
  es.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    if (ev.type === 'snapshot' || ev.type === 'tracks' || ev.type === 'state') {
      applyStatus(ev, panelKey);
    } else if (ev.type === 'complete') {
      applyStatus({ ...ev, state:'complete', tracks: ev.tracks||[], total: ev.total||0, completed: ev.completed||0 }, panelKey);
      es.close(); ps.es = null;
    } else if (ev.type === 'error') {
      applyStatus({ ...ev, state: 'error' }, panelKey);
      es.close(); ps.es = null;
    }
    if (ev.state === 'complete' || ev.state === 'error') { es.close(); ps.es = null; }
  };
  es.onerror = () => { p.label.textContent = 'Reconnecting to conversion progress…'; };
}

async function retryFailed(panelKey, indices) {
  const p = panels[panelKey];
  if (!terminalStates.has(p.status.state) || p.retryPending) return false;
  p.retryPending = true;
  p.retryBtn.disabled = true;
  try {
    const response = await fetch(`/convert/${p.jobId}/retry`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(indices ? { indices } : {}) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not retry the failed tracks.');
    p.startedAt = performance.now();
    applyStatus({ state: 'queued', error: '' }, panelKey);
    connectEvents(panelKey);
    return true;
  } catch (error) { p.label.textContent = error.message; p.retryBtn.disabled = false; return false; }
  finally { p.retryPending = false; }
}

// ── form submit ────────────────────────────────────────────────────────────
// Submit all links in order; the server runs one collection at a time.
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (!queue.length || startingJobs || hasRunningJobs()) return;
  startingJobs = true;
  setConverting(true);
  updateQueueControls();
  syncNetworkMonitor();
  message.textContent = 'Starting your collection queue...';
  const submitted = [...queue];
  try {
    const response = await fetch('/convert', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls: submitted.map(item => item.url), collections: submitted,
        format: formatSelect.value, bitrate: bitrateSelect.value, spatial: !!spatialToggle.checked }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'The conversion queue could not be started.');
    const accepted = data.jobs || [{ job_id: data.job_id, state: 'queued', ...submitted[0] }];
    if (!accepted.length || accepted.some(job => !job.job_id)) throw new Error('The server did not return the queued collections.');
    for (const key of collectionKeys) { panelState[key].es?.close(); delete panels[key]; delete panelState[key]; }
    cardTimers.forEach(timer => clearInterval(timer)); cardTimers.clear();
    collectionKeys.splice(0); selectedCollection = 0;
    collectionTabs.replaceChildren(); collectionSlides.replaceChildren();
    accepted.forEach((job, index) => startJob(job.job_id, job.job_id, {
      ...submitted[index], ...job, name: job.name || submitted[index]?.name || 'Spotify collection',
      link_type: job.link_type || submitted[index]?.type,
    }));
    queue.splice(0, submitted.length);
    message.textContent = 'Each collection will prepare and convert after the previous one finishes.';
  } catch (error) { message.textContent = error.message; }
  finally {
    startingJobs = false;
    setConverting(false);
    renderQueue();
    syncNetworkMonitor();
  }
});

document.addEventListener('change', async (e) => {
  const cb = e.target.closest('.cancel-checkbox');
  if (!cb) return;
  const idx      = Number(cb.dataset.trackIndex);
  const panelKey = cb.dataset.panel;
  const p        = panels[panelKey];
  const ps       = panelState[panelKey];
  if (!p.jobId) return;
  if (cb.checked) {
    ps.cancelled.add(idx);
    await fetch(`/convert/${p.jobId}/tracks/${idx}/cancel`, { method: 'POST' });
    const card = cb.closest('.track-card');
    if (card) {
      card.classList.add('track-cancelled');
      const badge = card.querySelector('.track-state');
      if (badge) badge.textContent = 'Skipped';
      stopCardTimer(panelKey, idx);
    }
  } else {
    ps.cancelled.delete(idx);
  }
});

// ── cancel-all buttons ─────────────────────────────────────────────────────
async function cancelRemaining(panelKey) {
  const p = panels[panelKey];
  const indices = p.status.tracks.flatMap((track, index) =>
    track.state === 'pending' || activeTrackStates.has(track.state) ? [index] : []);
  p.cancelBtn.disabled = true;
  try {
    await Promise.all(indices.map(async index => {
      const response = await fetch(`/convert/${p.jobId}/tracks/${index}/cancel`, { method: 'POST' });
      if (!response.ok) throw new Error('Some tracks could not be skipped. Try again.');
      panelState[panelKey].cancelled.add(index);
    }));
  } catch (error) { p.label.textContent = error.message; }
  finally { p.cancelBtn.disabled = false; }
}

document.addEventListener('click', async (e) => {
  const retry = e.target.closest('.retry-track');
  if (retry) { if (!retry.disabled) await retryFailed(retry.dataset.panel, [Number(retry.dataset.trackIndex)]); return; }
  // per-track download
  const dlBtn = e.target.closest('.download-track');
  if (dlBtn) {
    const panelKey = dlBtn.dataset.panel;
    const p        = panels[panelKey];
    const ps       = panelState[panelKey];
    if (!p.jobId) return;
    dlBtn.disabled = true; dlBtn.textContent = 'Preparing';
    const card = dlBtn.closest('.track-card');
    try {
      await Downloads.download(`/convert/${p.jobId}/tracks/${dlBtn.dataset.trackIndex}/download`, {
        toast: Downloads.createToast(card.querySelector('.track-title')?.textContent || 'Track download'),
      });
      const key = `${card.querySelector('.track-artist')?.textContent}|${card.querySelector('.track-title')?.textContent}`;
      ps.downloaded.add(key);
      dlBtn.textContent = 'Downloaded ↓';
      dlBtn.classList.add('track-redownload');
    } catch (error) { dlBtn.textContent = 'Retry'; dlBtn.title = error.message; }
    finally { dlBtn.disabled = false; }
    return;
  }
});

// ── zip download buttons ───────────────────────────────────────────────────
async function doZipDownload(panelKey) {
  const p = panels[panelKey];
  if (!p.jobId) return;
  p.dlBtn.disabled = true; p.dlBtn.textContent = 'Preparing...';
  try {
    await Downloads.download(`/convert/${p.jobId}/download`, {
      toast: Downloads.createToast(p.type === 'track' ? 'Track download' : `${p.name} ZIP`),
      fallbackName: p.status.archive_name || 'Spotify collection.zip',
    });
    p.dlBtn.textContent = 'Downloaded';
  } catch (error) {
    p.dlBtn.disabled = false; p.dlBtn.textContent = 'Try Again'; p.dlBtn.title = error.message;
  }
}

// Monitoring follows server jobs, independently of the form's disabled state.
function syncNetworkMonitor() {
  const active = Object.values(panels).filter(panel => panel.jobId &&
    ['queued', 'metadata', 'processing', 'converting', 'packaging'].includes(panel.status?.state));
  if (!startingJobs && !previewLoading && !active.length) { networkMonitor.stop(); return; }
  const tracks = active.flatMap(panel => panel.status.tracks || []);
  let phase = 'Preparing';
  if (tracks.some(track => track.state === 'downloading')) phase = 'Downloading';
  else if (tracks.some(track => track.state === 'converting')) phase = 'Converting';
  else if (startingJobs || previewLoading || active.some(panel => panel.status.state === 'metadata' || panel.status.metadata_loading)) phase = 'Metadata';
  else if (tracks.some(track => ['preparing', 'retrying'].includes(track.state))) phase = 'Preparing';
  else if (active.some(panel => panel.status.state === 'packaging')) phase = 'Packaging';
  else if (tracks.some(track => track.state === 'finishing')) phase = 'Finishing';
  else if (active.some(panel => panel.status.state === 'converting')) phase = 'Converting';
  networkMonitor.start(phase);
}

// ── resume interrupted jobs on page load ─────────────────────────────────────────
// Restore collections, including failed tracks waiting for a manual retry.
(async () => {
  try {
    const jobs = await fetch('/jobs').then(response => response.json());
    if (!Array.isArray(jobs) || !jobs.length || collectionKeys.length) return;
    const active = jobs.find(job => ['queued', 'metadata', 'processing', 'converting', 'packaging'].includes(job.state));
    const batch = active?.batch_id || jobs.at(-1).batch_id;
    const restored = batch ? jobs.filter(job => job.batch_id === batch) : jobs.slice(-5);
    restored.sort((a, b) => (a.batch_position || 0) - (b.batch_position || 0));
    restored.forEach(job => startJob(job.job_id, job.job_id, job));
    const running = restored.find(job => ['metadata', 'processing', 'converting', 'packaging'].includes(job.state));
    if (running) switchTab(running.job_id);
  } catch { message.textContent = 'Previous conversion progress could not be restored. Refresh to try again.'; }
})();
updateQueueControls();
