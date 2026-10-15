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
const panelTabBtns    = panelsContainer.querySelectorAll('.panel-tab');

function switchTab(key) {
  const tabKey = key === 'track' ? 'tracks' : 'playlists';
  panelTabBtns.forEach(btn => btn.classList.toggle('panel-tab--active', btn.dataset.panel === tabKey));
  panels.track.panel.hidden    = tabKey !== 'tracks';
  panels.playlist.panel.hidden = tabKey !== 'playlists';
}

panelTabBtns.forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.panel === 'tracks' ? 'track' : 'playlist')));

const panels = {
  track: {
    panel:     document.querySelector('#panel-tracks'),
    label:     document.querySelector('#progress-label-tracks'),
    percent:   document.querySelector('#progress-percent-tracks'),
    bar:       document.querySelector('#progress-bar-tracks'),
    count:     document.querySelector('#track-count-tracks'),
    eta:       document.querySelector('#eta-tracks'),
    list:      document.querySelector('#track-list-tracks'),
    dlBtn:     document.querySelector('#download-tracks'),
    cancelBtn: document.querySelector('#cancel-all-tracks'),
    jobId: null, startedAt: null,
  },
  playlist: {
    panel:     document.querySelector('#panel-playlists'),
    label:     document.querySelector('#progress-label-playlists'),
    percent:   document.querySelector('#progress-percent-playlists'),
    bar:       document.querySelector('#progress-bar-playlists'),
    count:     document.querySelector('#track-count-playlists'),
    eta:       document.querySelector('#eta-playlists'),
    list:      document.querySelector('#track-list-playlists'),
    dlBtn:     document.querySelector('#download-playlists'),
    cancelBtn: document.querySelector('#cancel-all-playlists'),
    jobId: null, startedAt: null,
  },
};

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
    const urlSpan = document.createElement('span');
    urlSpan.className = 'queue-url';
    urlSpan.textContent = item.url;
    const rm = document.createElement('button');
    rm.type = 'button'; rm.className = 'queue-remove';
    rm.dataset.idx = i; rm.textContent = '✕';
    li.append(typeTag, urlSpan, rm);
    queueList.append(li);
  });
  button.disabled = queue.length === 0;
}

addQueueBtn.addEventListener('click', () => {
  const url = urlInput.value.trim();
  if (!isSpotifyUrl(url)) {
    message.className = 'message';
    message.textContent = 'Paste a valid Spotify link first.';
    return;
  }
  if (queue.find(q => q.url === url)) {
    message.className = 'message';
    message.textContent = 'Already in queue.';
    return;
  }
  queue.push({ url, type: spotifyLinkType(url) });
  urlInput.value = '';
  message.textContent = '';
  renderQueue();
});

urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); addQueueBtn.click(); }
});

queueList.addEventListener('click', (e) => {
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
const panelState = {
  track:    { downloaded: new Set(), cancelled: new Set(), es: null },
  playlist: { downloaded: new Set(), cancelled: new Set(), es: null },
};
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
    track.retry_count ? 'Automatic retry' : null,
  ].filter(Boolean)) {
    const tag = document.createElement('i'); tag.textContent = label;
    if (label === 'E') tag.title = 'Explicit';
    if (label === 'Spatial') tag.className = 'tag-spatial';
    tags.append(tag);
  }
  info.append(titleEl, artistEl, albumEl, tags);
  if (isActive && track.message) {
    const step = document.createElement('span');
    step.className = 'track-step';
    step.textContent = track.message;
    info.append(step);
  }

  const badge = document.createElement('b');
  badge.className = 'track-state';
  badge.textContent = track.state === 'preparing' && track.retry_count ? 'Preparing again' : trackStateLabels[track.state] || 'Queued';
  badge.title = track.error || track.message || '';

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
    if (track.retry_count && !['converted', 'cancelled'].includes(track.state) && prevRetry !== String(track.retry_count)) {
      retriesStarted = true;
    }
    if (existing && prevState === track.state && prevSize === (track.size||'') && prevCover === (track.cover_url||'') && prevMessage === (track.message||'') && prevRetry === String(track.retry_count || 0)) {
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

function showMetaLog(msg, count, total, panelKey) {
  const p = panels[panelKey];
  // update progress bar + count during metadata phase
  if (total > 0) {
    const pct = Math.round((count / total) * 100);
    p.bar.style.width     = `${pct}%`;
    p.bar.classList.remove('indeterminate');
    p.percent.textContent = `${pct}%`;
    p.count.textContent   = `${count} of ${total} track${total === 1 ? '' : 's'}`;
  } else {
    p.bar.classList.add('indeterminate');
  }
  // scroll log
  const list = p.list;
  // keep only last 6 log lines to avoid overflow
  const existing = list.querySelectorAll('.meta-log-line');
  if (existing.length >= 6) existing[0].remove();
  const el = document.createElement('p');
  el.className = 'meta-log-line';
  el.textContent = msg;
  list.append(el);
}

// ── apply SSE status to a panel ────────────────────────────────────────────
function applyStatus(status, panelKey) {
  const p          = panels[panelKey];
  p.status = { ...p.status, ...status };
  const { state, tracks = [], total = 0, completed = 0, meta_count, meta_total, metadata_loading, metadata_errors = [], error } = p.status;
  const isComplete = state === 'complete';
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
  p.bar.classList.toggle('indeterminate', !isComplete && total === 0);

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
  }

  if (tracks && tracks.length) {
    panels[panelKey].list.querySelectorAll('.meta-log-line').forEach(el => el.remove());
    renderTracks(tracks, panelKey);
  }

  if (isComplete) {
    p.dlBtn.disabled    = false;
    p.cancelBtn.hidden  = true;
  } else if (state === 'converting' || state === 'processing' || (state === 'metadata' && tracks.length)) {
    p.cancelBtn.hidden = false;
  } else if (state === 'error') {
    p.cancelBtn.hidden = true;
  }
  syncNetworkMonitor();
}

// ── start one job and wire SSE ─────────────────────────────────────────────
function startJob(jobId, panelKey) {
  const p  = panels[panelKey];
  const ps = panelState[panelKey];
  p.jobId     = jobId;
  p.startedAt = performance.now();
  p.status = { state: 'metadata', tracks: [], total: 0, completed: 0 };
  syncNetworkMonitor();
  panelsContainer.hidden = false;
  switchTab(panelKey);
  p.dlBtn.disabled = true;
  p.dlBtn.textContent = 'Download ZIP';
  p.cancelBtn.hidden  = true;
  p.list.replaceChildren();
  p.bar.style.width     = '0%';
  p.percent.textContent = '0%';
  p.count.textContent   = 'Preparing...';
  p.label.textContent   = phaseMsg('metadata', 0, 0);
  p.eta.textContent     = '';
  ps.downloaded.clear();
  ps.cancelled.clear();
  cardTimers.forEach((id, k) => { if (k.startsWith(panelKey+':')) { clearInterval(id); cardTimers.delete(k); } });

  if (ps.es) { ps.es.close(); ps.es = null; }
  const es = new EventSource(`/convert/${jobId}/events`);
  ps.es = es;
  es.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    if (ev.type === 'snapshot' || ev.type === 'tracks' || ev.type === 'state') {
      applyStatus(ev, panelKey);
      if (ev.meta_log && !ev.tracks?.length) showMetaLog(ev.meta_log, ev.meta_count, ev.meta_total, panelKey);
    } else if (ev.type === 'complete') {
      applyStatus({ ...ev, state:'complete', tracks: ev.tracks||[], total: ev.total||0, completed: ev.completed||0 }, panelKey);
      es.close(); ps.es = null;
    } else if (ev.type === 'error') {
      applyStatus({ ...ev, state: 'error' }, panelKey);
      es.close(); ps.es = null;
    }
    if (ev.state === 'complete' || ev.state === 'error') { es.close(); ps.es = null; }
  };
  es.onerror = () => { es.close(); ps.es = null; p.label.textContent = 'Connection lost.'; };
}

// ── form submit ────────────────────────────────────────────────────────────
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (queue.length === 0) return;

  button.disabled = true;
  button.querySelector('span').textContent = 'Building...';
  message.className   = 'message busy';
  message.textContent = 'Starting conversion...';
  setConverting(true);
  startingJobs = true;
  syncNetworkMonitor();

  const fmt_val     = formatSelect.value;
  const bitrate_val = bitrateSelect.value;
  const spatial_val = spatialToggle.checked;

  // Each panel owns one job, including every URL queued for that panel.
  const queuedItems = queue.splice(0);
  const jobs = ['track', 'playlist'].map(panelKey => ({
    panelKey,
    urls: queuedItems.filter(item => (item.type === 'track' ? 'track' : 'playlist') === panelKey)
      .map(item => item.url),
  })).filter(job => job.urls.length);
  renderQueue();

  await Promise.allSettled(jobs.map(async ({ panelKey, urls }) => {
    try {
      const res = await fetch('/convert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls, format: fmt_val, bitrate: bitrate_val, spatial: spatial_val }),
      });
      if (!res.ok) {
        const err = await res.json();
        panels[panelKey].label.textContent = err.error || 'Failed to start.';
        panelsContainer.hidden = false;
        switchTab(panelKey);
        return;
      }
      const { job_id } = await res.json();
      startJob(job_id, panelKey);
    } catch (e) {
      panels[panelKey].label.textContent = e.message;
      panelsContainer.hidden = false;
      switchTab(panelKey);
    }
  }));

  message.className   = 'message';
  message.textContent = '';
  button.disabled = false;
  button.querySelector('span').textContent = 'Build ZIP';
  setConverting(false);
  startingJobs = false;
  syncNetworkMonitor();
});

// ── checkbox cancel (delegated on document) ────────────────────────────────
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
document.querySelector('#cancel-all-tracks').addEventListener('click', async () => {
  const p  = panels.track;
  const ps = panelState.track;
  if (!p.jobId) return;
  p.list.querySelectorAll('.cancel-checkbox:not(:checked)').forEach(cb => { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); });
});
document.querySelector('#cancel-all-playlists').addEventListener('click', async () => {
  const p  = panels.playlist;
  if (!p.jobId) return;
  p.list.querySelectorAll('.cancel-checkbox:not(:checked)').forEach(cb => { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); });
});

// ── individual track downloads ─────────────────────────
document.addEventListener('click', async (e) => {
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
      toast: Downloads.createToast(panelKey === 'track' ? 'Track download' : 'Album ZIP download'),
      fallbackName: p.status.archive_name || 'Spotify collection.zip',
    });
    p.dlBtn.textContent = 'Downloaded';
  } catch (error) {
    p.dlBtn.disabled = false; p.dlBtn.textContent = 'Try Again'; p.dlBtn.title = error.message;
  }
}
document.querySelector('#download-tracks').addEventListener('click', () => doZipDownload('track'));
document.querySelector('#download-playlists').addEventListener('click', () => doZipDownload('playlist'));

// Monitoring follows server jobs, independently of the form's disabled state.
function syncNetworkMonitor() {
  const active = Object.values(panels).filter(panel => panel.jobId &&
    ['metadata', 'processing', 'converting', 'packaging'].includes(panel.status?.state));
  if (!startingJobs && !active.length) { networkMonitor.stop(); return; }
  const tracks = active.flatMap(panel => panel.status.tracks || []);
  let phase = 'Preparing';
  if (tracks.some(track => track.state === 'downloading')) phase = 'Downloading';
  else if (tracks.some(track => track.state === 'converting')) phase = 'Converting';
  else if (startingJobs || active.some(panel => panel.status.state === 'metadata' || panel.status.metadata_loading)) phase = 'Metadata';
  else if (tracks.some(track => ['preparing', 'retrying'].includes(track.state))) phase = 'Preparing';
  else if (active.some(panel => panel.status.state === 'packaging')) phase = 'Packaging';
  else if (tracks.some(track => track.state === 'finishing')) phase = 'Finishing';
  else if (active.some(panel => panel.status.state === 'converting')) phase = 'Converting';
  networkMonitor.start(phase);
}

// ── resume interrupted jobs on page load ─────────────────────────────────────────
(async () => {
  let jobs;
  try { jobs = await fetch('/jobs').then(r => r.json()); } catch { return; }
  const resumable = jobs.filter(j => j.state === 'interrupted');
  const active    = jobs.filter(j => j.state !== 'interrupted');

  // reconnect SSE for jobs that were already running when page loaded
  active.forEach(j => {
    const panelKey = j.link_type === 'track' ? 'track' : 'playlist';
    panelsContainer.hidden = false;
    switchTab(panelKey);
    panels[panelKey].jobId     = j.job_id;
    panels[panelKey].startedAt = performance.now();
    applyStatus({ state: j.state, tracks: j.tracks, total: j.total, completed: j.completed }, panelKey);
    startJob(j.job_id, panelKey);
  });

  if (!resumable.length) return;

  const banner = document.createElement('div');
  banner.className = 'resume-banner';
  banner.innerHTML = resumable.map(j => {
    const label = j.link_type === 'track' ? 'Track' : 'Playlist/Album';
    const pct   = j.total ? Math.round((j.completed / j.total) * 100) : 0;
    return `<span>${label} &mdash; ${j.completed}/${j.total} tracks (${pct}% done)</span>
            <button class="resume-btn" data-job="${j.job_id}" data-panel="${j.link_type === 'track' ? 'track' : 'playlist'}" type="button">Resume</button>
            <button class="resume-dismiss" data-job="${j.job_id}" type="button">&times;</button>`;
  }).join('');
  document.querySelector('.hero').prepend(banner);

  banner.addEventListener('click', async (e) => {
    const btn = e.target.closest('.resume-btn');
    const dis = e.target.closest('.resume-dismiss');
    if (dis) {
      banner.remove();
      await fetch(`/convert/${dis.dataset.job}/resume`, { method: 'POST' }).catch(() => {});
      return;
    }
    if (!btn) return;
    btn.disabled = true; btn.textContent = 'Resuming…';
    const res = await fetch(`/convert/${btn.dataset.job}/resume`, { method: 'POST' });
    if (!res.ok) { btn.disabled = false; btn.textContent = 'Retry'; return; }
    const { job_id } = await res.json();
    banner.remove();
    startJob(job_id, btn.dataset.panel);
  });
})();

