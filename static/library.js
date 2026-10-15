'use strict';

// ── theme (mirrors index) ──────────────────────────────────────────────────
const themeToggle = document.querySelector('#theme-toggle');
const themeIcon   = themeToggle.querySelector('.theme-icon');
const themeLabel  = themeToggle.querySelector('.theme-label');

const setTheme = (t) => {
  document.documentElement.dataset.theme = t;
  const dark = t === 'dark';
  themeIcon.textContent  = dark ? '☼' : '◐';
  themeLabel.textContent = dark ? 'Light mode' : 'Dark mode';
  themeToggle.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
};
const saved = localStorage.getItem('spotibai-theme');
setTheme(saved || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
themeToggle.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('spotibai-theme', next);
  setTheme(next);
});

// ── state ──────────────────────────────────────────────────────────────────
const grid        = document.querySelector('#lib-grid');
const empty       = document.querySelector('#lib-empty');
const countEl     = document.querySelector('#lib-count');
const searchInput = document.querySelector('#lib-search');
const selectionBar = document.querySelector('#lib-selection-bar');
const selectionCount = document.querySelector('#lib-selection-count');
const selectAllButton = document.querySelector('#lib-select-all');
const cancelSelectionButton = document.querySelector('#lib-selection-cancel');
const removeSelectedButton = document.querySelector('#lib-remove-selected');
const selectionHint = document.querySelector('#lib-selection-hint');
const selectedTrackIds = new Set();
let selectionMode = false;
let removingTracks = false;
let libraryRequest = 0;

const previewBar      = document.querySelector('#preview-bar');
const previewAudio    = document.querySelector('#preview-audio');
const previewCover    = document.querySelector('#preview-cover');
const previewTitle    = document.querySelector('#preview-title');
const previewArtist   = document.querySelector('#preview-artist');
const previewProgress = document.querySelector('#preview-progress');
const previewTime     = document.querySelector('#preview-time');
const previewClose    = document.querySelector('#preview-close');
const previewToggle   = document.querySelector('#preview-toggle');
const previewSource   = document.querySelector('#preview-source');
const previewStatus   = document.querySelector('#preview-status');

let currentPreviewId = null;
let currentPreviewTrack = null;
let currentPreviewStem = '';
let previewRequest = 0;
let previewController = null;
let previewObjectUrl = null;
let previewLoading = false;
let previewFailed = false;
let openMenuButton = null;
const sourceLabels = { '': 'Original', vocals: 'Vocals', instrumental: 'Instrumental' };

function closeLibraryMenus(restoreFocus = false) {
  document.querySelectorAll('.lib-dl-menu').forEach(menu => { menu.hidden = true; });
  document.querySelectorAll('.lib-card--menu-open').forEach(card => card.classList.remove('lib-card--menu-open'));
  document.querySelectorAll('.lib-menu-toggle').forEach(button => button.setAttribute('aria-expanded', 'false'));
  if (restoreFocus) openMenuButton?.focus();
  openMenuButton = null;
}

function libraryMenu(track, kind) {
  const isPreview = kind === 'preview';
  const wrap = document.createElement('div');
  wrap.className = 'lib-dl-wrap';
  const button = document.createElement('button');
  button.className = `${isPreview ? 'lib-preview-btn' : 'lib-dl-btn'} lib-menu-toggle`;
  button.type = 'button';
  button.dataset.id = track.id;
  button.textContent = isPreview ? '▶ Preview ▾' : 'Download ▾';
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-controls', `lib-${kind}-${track.id}`);
  button.setAttribute('aria-label', `${isPreview ? 'Preview' : 'Download'} ${track.title}`);
  const menu = document.createElement('div');
  menu.id = `lib-${kind}-${track.id}`;
  menu.className = `lib-dl-menu${isPreview ? ' lib-preview-menu' : ''}`;
  menu.hidden = true;
  for (const [stem, label] of Object.entries(sourceLabels)) {
    const option = document.createElement('button');
    option.className = isPreview ? 'lib-dl-option lib-preview-option' : `lib-dl-option${stem ? ' lib-stem-btn' : ''}`;
    option.type = 'button';
    option.dataset.id = track.id;
    option.dataset.stem = stem;
    option.textContent = isPreview ? `▶ ${label}` : label;
    option.setAttribute('aria-label', `${isPreview ? 'Preview' : 'Download'} ${label.toLowerCase()} for ${track.title}`);
    menu.append(option);
  }
  button.addEventListener('click', event => {
    event.stopPropagation();
    const opening = menu.hidden;
    closeLibraryMenus();
    if (opening) {
      menu.hidden = false;
      button.setAttribute('aria-expanded', 'true');
      button.closest('.lib-card').classList.add('lib-card--menu-open');
      openMenuButton = button;
    }
  });
  wrap.append(button, menu);
  return wrap;
}

// ── fetch & render ─────────────────────────────────────────────────────────
async function load(q = '') {
  const generation = ++libraryRequest;
  const url = q ? `/library/tracks?q=${encodeURIComponent(q)}` : '/library/tracks';
  const tracks = await fetch(url).then(r => r.json()).catch(() => []);
  if (generation === libraryRequest) render(tracks);
}

function render(tracks) {
  closeLibraryMenus();
  selectedTrackIds.clear();
  selectionMode = false;
  grid.replaceChildren();
  const count = tracks.length;
  countEl.textContent = count ? `${count} track${count === 1 ? '' : 's'}` : '';
  empty.hidden = count > 0;

  tracks.forEach(t => {
    const card = document.createElement('article');
    card.className = 'lib-card';
    card.dataset.id = t.id;
    card.tabIndex = 0;
    card.setAttribute('role', 'group');
    card.setAttribute('aria-label', `${t.title} by ${t.artist}`);
    card.setAttribute('aria-describedby', 'lib-selection-hint');

    const cover = document.createElement('div');
    cover.className = 'lib-cover';
    if (t.cover_url) {
      const img = document.createElement('img');
      img.src = t.cover_url;
      img.alt = t.album || 'Cover';
      img.loading = 'lazy';
      cover.append(img);
    } else {
      cover.textContent = (t.title || '?')[0].toUpperCase();
    }
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'lib-select-checkbox';
    checkbox.dataset.id = t.id;
    checkbox.setAttribute('aria-label', `Select ${t.title} by ${t.artist} for removal`);
    checkbox.hidden = true;
    cover.append(checkbox);

    const info = document.createElement('div');
    info.className = 'lib-info';
    info.innerHTML = `
      <strong class="lib-title">${esc(t.title)}</strong>
      <span class="lib-artist">${esc(t.artist)}</span>
      <span class="lib-album">${esc(t.album || '')}</span>
      <div class="lib-tags">
        ${t.format ? `<i>${esc(t.format)}</i>` : ''}
        ${t.bitrate ? `<i>${esc(t.bitrate)}</i>` : ''}
        <i>${esc(t.added_at ? t.added_at.slice(0, 10) : '')}</i>
      </div>`;

    const actions = document.createElement('div');
    actions.className = 'lib-actions';

    const previewWrap = libraryMenu(t, 'preview');
    const dlWrap = libraryMenu(t, 'download');

    actions.append(previewWrap, dlWrap);
    card.append(cover, info, actions);
    grid.append(card);

    // store track data on card for preview bar
    card._track = t;
  });
  syncSelection();
  syncPreviewControls();
}

function syncSelection() {
  const cards = grid.querySelectorAll('.lib-card');
  selectionBar.hidden = !selectionMode;
  selectionHint.hidden = cards.length === 0;
  selectionCount.textContent = `${selectedTrackIds.size} selected`;
  removeSelectedButton.textContent = removingTracks ? 'Removing…' : `Remove selected${selectedTrackIds.size ? ` (${selectedTrackIds.size})` : ''}`;
  removeSelectedButton.disabled = removingTracks || selectedTrackIds.size === 0;
  cancelSelectionButton.disabled = removingTracks;
  selectAllButton.disabled = removingTracks || cards.length === 0;
  selectAllButton.textContent = cards.length > 0 && selectedTrackIds.size === cards.length ? 'Deselect all shown' : 'Select all shown';
  searchInput.disabled = removingTracks;
  grid.setAttribute('aria-busy', String(removingTracks));
  cards.forEach(card => {
    const selected = selectedTrackIds.has(String(card.dataset.id));
    card.classList.toggle('lib-card--selected', selected);
    const checkbox = card.querySelector('.lib-select-checkbox');
    checkbox.checked = selected;
    checkbox.hidden = !selectionMode;
    checkbox.disabled = removingTracks;
  });
}

function selectTrack(id, selected = !selectedTrackIds.has(String(id))) {
  if (removingTracks) return;
  selectionMode = true;
  if (selected) selectedTrackIds.add(String(id));
  else selectedTrackIds.delete(String(id));
  syncSelection();
}

function clearSelection() {
  if (removingTracks) return;
  selectedTrackIds.clear();
  selectionMode = false;
  syncSelection();
}

cancelSelectionButton.addEventListener('click', clearSelection);
selectAllButton.addEventListener('click', () => {
  if (removingTracks) return;
  const cards = grid.querySelectorAll('.lib-card');
  const deselect = selectedTrackIds.size === cards.length;
  selectedTrackIds.clear();
  if (!deselect) cards.forEach(card => selectedTrackIds.add(String(card.dataset.id)));
  syncSelection();
});

async function removeSelectedTracks() {
  if (removingTracks || selectedTrackIds.size === 0) return false;
  const ids = [...selectedTrackIds];
  if (!confirm(`Remove ${ids.length} selected track${ids.length === 1 ? '' : 's'} from your library?`)) return false;
  removingTracks = true;
  libraryRequest++;
  clearTimeout(debounceTimer);
  closeLibraryMenus();
  syncSelection();
  const toast = Downloads.createToast('Removing selected tracks');
  const cards = new Map([...grid.querySelectorAll('.lib-card')].map(card => [String(card.dataset.id), card]));
  const pending = [...ids];
  let completed = 0;
  let removed = 0;
  let lastError = '';
  toast.setProgress(0);
  toast.setStatus(`Removing ${ids.length} selected track${ids.length === 1 ? '' : 's'}`);
  try {
    await Promise.all(Array.from({ length: Math.min(4, ids.length) }, async () => {
      while (pending.length) {
        const id = pending.shift();
        try {
          const response = await fetch(`/library/tracks/${id}`, { method: 'DELETE' });
          if (!response.ok && response.status !== 404) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.error || 'The server could not remove this track.');
          }
          cards.get(id)?.remove();
          selectedTrackIds.delete(id);
          if (currentPreviewId === Number(id)) stopPreview();
          removed++;
        } catch (error) {
          lastError = error.message || 'Connection lost.';
        } finally {
          completed++;
          toast.setProgress(Math.min(99, completed / ids.length * 100));
          toast.setStatus(`Processed ${completed} of ${ids.length}`);
        }
      }
    }));
    const failed = selectedTrackIds.size;
    toast.finish(!failed, failed
      ? `Removed ${removed}; ${failed} could not be removed. ${lastError}`
      : `Removed ${removed} track${removed === 1 ? '' : 's'} from your library`);
    return failed === 0;
  } finally {
    removingTracks = false;
    selectionMode = selectedTrackIds.size > 0;
    const remaining = grid.querySelectorAll('.lib-card').length;
    countEl.textContent = remaining ? `${remaining} track${remaining === 1 ? '' : 's'}` : '';
    empty.hidden = remaining > 0;
    syncSelection();
  }
}

removeSelectedButton.addEventListener('click', removeSelectedTracks);

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── close dropdown on outside click ──────────────────────────────────────
document.addEventListener('click', event => {
  if (!event.target.closest('.lib-dl-wrap')) closeLibraryMenus();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeLibraryMenus(true);
});

// ── search (debounced) ─────────────────────────────────────────────────────
let debounceTimer;
searchInput.addEventListener('input', () => {
  if (removingTracks) return;
  clearSelection();
  libraryRequest++;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => load(searchInput.value.trim()), 280);
});

// ── grid click delegation ──────────────────────────────────────────────────
grid.addEventListener('click', async (e) => {
  if (e.target.closest('.lib-select-checkbox')) return;
  // preview
  const previewBtn = e.target.closest('.lib-preview-option');
  if (previewBtn) {
    closeLibraryMenus();
    const id = Number(previewBtn.dataset.id);
    const card = previewBtn.closest('.lib-card');
    const t = card._track;
    await playPreview(id, t, previewBtn.dataset.stem);
    return;
  }

  // download option (original or stem)
  const dlOption = e.target.closest('.lib-dl-option');
  if (dlOption) {
    closeLibraryMenus();
    const id     = dlOption.dataset.id;
    const stem   = dlOption.dataset.stem;
    const isStem = stem === 'vocals' || stem === 'instrumental';
    const card   = dlOption.closest('.lib-card');
    const track  = card?._track || {};
    const label  = sourceLabels[stem];
    dlOption.disabled = true;
    dlOption.textContent = isStem ? 'Separating…' : '…';
    await downloadWithToast(id, stem, isStem, label, track.title || `Track ${id}`);
    dlOption.disabled = false;
    dlOption.textContent = label;
    return;
  }

  const card = e.target.closest('.lib-card');
  if (card && !e.target.closest('.lib-actions')) selectTrack(card.dataset.id);
});

grid.addEventListener('change', event => {
  const checkbox = event.target.closest('.lib-select-checkbox');
  if (checkbox) selectTrack(checkbox.dataset.id, checkbox.checked);
});
grid.addEventListener('keydown', event => {
  const card = event.target.closest('.lib-card');
  if (event.target === card && (event.key === 'Enter' || event.key === ' ')) {
    event.preventDefault();
    selectTrack(card.dataset.id);
  }
});

// ── separation toast ─────────────────────────────────────────────────────
const activeDownloads = new Map();
const activePreparations = new Map();

function prepareStem(id, stem, onProgress) {
  const key = `${id}:${stem}`;
  let preparation = activePreparations.get(key);
  if (!preparation) {
    preparation = { listeners: new Set(), status: null };
    const notify = status => {
      preparation.status = status;
      preparation.listeners.forEach(listener => listener(status));
    };
    preparation.promise = (async () => {
      const response = await fetch(`/library/tracks/${id}/separate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stem }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Separation could not be started.');
      await waitForSeparation(id, data.sep_id, notify);
    })().finally(() => activePreparations.delete(key));
    activePreparations.set(key, preparation);
  }
  preparation.listeners.add(onProgress);
  if (preparation.status) onProgress(preparation.status);
  return preparation.promise.finally(() => preparation.listeners.delete(onProgress));
}

function waitForSeparation(id, jobId, onProgress) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let polling = false;
    let stream;
    const settle = (error) => {
      if (settled) return;
      settled = true;
      stream?.close();
      error ? reject(error) : resolve();
    };
    const consume = data => {
      if (settled) return;
      onProgress(data);
      if (data.state === 'done') settle();
      else if (data.state === 'error') settle(new Error(data.msg || 'Separation failed.'));
    };
    async function poll() {
      if (polling || settled) return;
      polling = true;
      stream?.close();
      let failures = 0;
      while (!settled) {
        try {
          const response = await fetch(`/library/tracks/${id}/separate/${jobId}/status`);
          const data = await response.json();
          if (!response.ok) { settle(new Error(data.error || 'Progress is unavailable.')); return; }
          failures = 0;
          consume(data);
        } catch (error) {
          if (++failures >= 3) { settle(new Error('Connection lost. Reopen the library to retry.')); return; }
        }
        if (!settled) await new Promise(done => setTimeout(done, 1000));
      }
    }
    try {
      stream = new EventSource(`/library/tracks/${id}/separate/${jobId}/events`);
      stream.onmessage = event => {
        try { consume(JSON.parse(event.data)); } catch (error) { settle(error); }
      };
      stream.onerror = poll;
    } catch { poll(); }
  });
}

function downloadWithToast(id, stem, isStem, label, trackTitle) {
  const key = `${id}:${stem}`;
  if (activeDownloads.has(key)) return activeDownloads.get(key);
  const task = (async () => {
    const toast = Downloads.createToast(isStem ? `${label} - ${trackTitle}` : trackTitle);
    try {
      if (isStem) {
        toast.setStatus('Preparing separated audio');
        await prepareStem(id, stem, status => {
          if (status.pct != null) toast.setProgress(Math.min(85, status.pct * 0.85));
          if (status.msg) toast.setStatus(status.msg);
        });
      }
      await Downloads.download(`/library/tracks/${id}/download${stem ? `?stem=${stem}` : ''}`, {
        toast, start: isStem ? 85 : 0, fallbackName: `${trackTitle}${stem ? ` (${stem})` : ''}`,
      });
      return true;
    } catch (error) {
      toast.finish(false, error.message || 'Download failed.');
      return false;
    }
  })();
  activeDownloads.set(key, task);
  task.finally(() => activeDownloads.delete(key));
  return task;
}

// Preview player. A request generation prevents late preparation from playing an old selection.
function syncPreviewControls() {
  const playing = currentPreviewId !== null && !previewLoading && !previewAudio.paused && !previewAudio.ended;
  previewToggle.disabled = previewLoading;
  previewToggle.textContent = previewLoading ? '…' : playing ? '⏸' : '▶';
  previewToggle.setAttribute('aria-label', previewFailed ? 'Retry preview' : playing ? 'Pause preview' : 'Play preview');
  previewBar.setAttribute('aria-busy', String(previewLoading));
  grid.querySelectorAll('.lib-preview-btn').forEach(button => {
    button.textContent = playing && Number(button.dataset.id) === currentPreviewId ? '⏸ Preview ▾' : '▶ Preview ▾';
  });
}

async function resumePreview(generation = previewRequest) {
  if (currentPreviewId === null || previewLoading) return false;
  if (previewAudio.ended) previewAudio.currentTime = 0;
  try {
    await previewAudio.play();
    if (generation !== previewRequest) return false;
    previewStatus.textContent = `${sourceLabels[currentPreviewStem]} · 7-second preview`;
    syncPreviewControls();
    return true;
  } catch (error) {
    if (generation !== previewRequest) return false;
    // Preparation may outlast the browser's user gesture. Keep Play available.
    if (error.name === 'NotAllowedError') {
      previewStatus.textContent = 'Ready — press Play';
    } else if (error.name !== 'AbortError') {
      previewFailed = true;
      previewStatus.textContent = 'Playback failed — retry';
      Downloads.createToast('Audio preview').finish(false, error.message || 'Preview could not play.');
    }
    syncPreviewControls();
    return false;
  }
}

async function playPreview(id, track, stem = '') {
  if (!Object.hasOwn(sourceLabels, stem)) return false;
  if (currentPreviewId === id && currentPreviewStem === stem && !previewFailed) {
    if (previewLoading) return false;
    if (previewAudio.paused || previewAudio.ended) return resumePreview();
    previewAudio.pause();
    previewStatus.textContent = `${sourceLabels[stem]} · Paused`;
    syncPreviewControls();
    return true;
  }
  stopPreview();
  const generation = previewRequest;
  const controller = new AbortController();
  const isCurrent = () => generation === previewRequest;
  previewController = controller;
  currentPreviewId = id;
  currentPreviewTrack = track;
  currentPreviewStem = stem;
  previewLoading = true;
  previewCover.src = track.cover_url || '';
  previewCover.style.display = track.cover_url ? '' : 'none';
  previewTitle.textContent = track.title;
  previewArtist.textContent = track.artist;
  previewSource.value = stem;
  previewProgress.style.width = '0%';
  previewTime.textContent = '0:07';
  previewStatus.textContent = `Loading ${sourceLabels[stem].toLowerCase()}…`;
  previewBar.hidden = false;
  syncPreviewControls();
  const url = `/library/tracks/${id}/preview${stem ? `?stem=${stem}` : ''}`;
  let toast;
  let prepared = false;
  try {
    let response = await fetch(url, { signal: controller.signal });
    if (!isCurrent()) return false;
    if (response.status === 409 && stem) {
      toast = Downloads.createToast(`Preview ${sourceLabels[stem]} - ${track.title}`);
      previewStatus.textContent = `Preparing ${sourceLabels[stem].toLowerCase()}…`;
      toast.setStatus('Preparing separated audio for playback');
      await prepareStem(id, stem, status => {
        if (status.pct != null) toast.setProgress(Math.min(90, status.pct * 0.9));
        if (status.msg) toast.setStatus(status.msg);
      });
      prepared = true;
      if (!isCurrent()) {
        toast.finish(true, `${sourceLabels[stem]} ready in the library`);
        return false;
      }
      toast.setStatus('Loading preview');
      response = await fetch(url, { signal: controller.signal });
    }
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || 'Preview could not be loaded.');
    }
    const clip = await response.blob();
    if (!clip.size) throw new Error('The preview is empty. Please retry.');
    if (!isCurrent()) {
      toast?.finish(true, `${sourceLabels[stem]} ready in the library`);
      return false;
    }
    previewObjectUrl = URL.createObjectURL(clip);
    previewAudio.src = previewObjectUrl;
    previewLoading = false;
    toast?.finish(true, `${sourceLabels[stem]} preview ready`);
    syncPreviewControls();
    return await resumePreview(generation);
  } catch (error) {
    if (error.name === 'AbortError' || !isCurrent()) {
      if (prepared) toast?.finish(true, `${sourceLabels[stem]} ready in the library`);
      else if (toast) toast.finish(false, error.message || 'Preparation failed.');
      return false;
    }
    previewLoading = false;
    previewFailed = true;
    previewStatus.textContent = 'Preview unavailable — retry';
    (toast || Downloads.createToast(`Preview - ${track.title}`)).finish(false, error.message || 'Preview failed.');
    syncPreviewControls();
    return false;
  }
}

function stopPreview() {
  previewRequest++;
  previewController?.abort();
  previewController = null;
  currentPreviewId = null;
  currentPreviewTrack = null;
  currentPreviewStem = '';
  previewLoading = false;
  previewFailed = false;
  previewAudio.pause();
  previewAudio.removeAttribute('src');
  previewAudio.load();
  if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
  previewObjectUrl = null;
  previewBar.hidden = true;
  syncPreviewControls();
}

previewSource.addEventListener('change', () => {
  if (currentPreviewId !== null) playPreview(currentPreviewId, currentPreviewTrack, previewSource.value);
});
previewToggle.addEventListener('click', () => {
  if (currentPreviewId !== null) playPreview(currentPreviewId, currentPreviewTrack, currentPreviewStem);
});
previewAudio.addEventListener('play', syncPreviewControls);
previewAudio.addEventListener('pause', syncPreviewControls);

previewAudio.addEventListener('timeupdate', () => {
  const dur = previewAudio.duration || 7;
  const pct = Math.min(100, (previewAudio.currentTime / dur) * 100);
  previewProgress.style.width = `${pct}%`;
  const rem = Math.max(0, Math.ceil(dur - previewAudio.currentTime));
  previewTime.textContent = `0:${String(rem).padStart(2, '0')}`;
});

previewAudio.addEventListener('ended', () => {
  previewProgress.style.width = '100%';
  previewTime.textContent = '0:00';
  previewStatus.textContent = `${sourceLabels[currentPreviewStem]} · Preview finished`;
  syncPreviewControls();
});

previewClose.addEventListener('click', stopPreview);

// ── init ───────────────────────────────────────────────────────────────────
load();
