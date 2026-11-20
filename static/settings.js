'use strict';

// ── Settings panel (shared by converter and library pages) ─────────────────
const settingsBtn     = document.querySelector('#settings-btn');
const settingsPanel   = document.querySelector('#settings-panel');
const settingsOverlay = document.querySelector('#settings-overlay');
const settingsClose   = document.querySelector('#settings-close');

function openSettings() {
  settingsPanel.hidden = false;
  settingsOverlay.hidden = false;
  document.body.style.overflow = 'hidden';
  settingsClose?.focus();
  // Refresh readiness state when panel opens
  if (typeof refreshReadiness === 'function') refreshReadiness();
}
function closeSettings() {
  settingsPanel.hidden = true;
  settingsOverlay.hidden = true;
  document.body.style.overflow = '';
  settingsBtn?.focus();
}

settingsBtn?.addEventListener('click', openSettings);
settingsClose?.addEventListener('click', closeSettings);
settingsOverlay?.addEventListener('click', closeSettings);
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !settingsPanel?.hidden) closeSettings(); });

// ── Destination folder ─────────────────────────────────────────────────────
const destInput   = document.querySelector('#dest-folder-input');
const destClear   = document.querySelector('#dest-folder-clear');
const destStatus  = document.querySelector('#dest-folder-status');

const DEST_KEY = 'spotibai-dest-folder';
const NETWORK_KEY = 'spotibai-network-preferences';
const networkDownloadToggle = document.querySelector('#network-show-download');
const networkUploadToggle = document.querySelector('#network-show-upload');
const networkUseAllToggle = document.querySelector('#network-use-all');
const networkLimitInput = document.querySelector('#network-limit');
const networkLimitUnit = document.querySelector('#network-limit-unit');
const networkSettingsStatus = document.querySelector('#network-settings-status');

function readNetworkPreferences() {
  const defaults = { showDownload: true, showUpload: true, useAllBandwidth: true, limit: '', unit: 'kbps' };
  try { return { ...defaults, ...JSON.parse(localStorage.getItem(NETWORK_KEY) || '{}') }; }
  catch { return defaults; }
}

function applyNetworkPreferences() {
  if (!networkDownloadToggle) return;
  const prefs = readNetworkPreferences();
  networkDownloadToggle.checked = prefs.showDownload !== false;
  networkUploadToggle.checked = prefs.showUpload !== false;
  if (!networkDownloadToggle.checked && !networkUploadToggle.checked) networkDownloadToggle.checked = true;
  networkUseAllToggle.checked = prefs.useAllBandwidth !== false;
  networkLimitInput.value = prefs.limit || '';
  networkLimitUnit.value = prefs.unit === 'mbps' ? 'mbps' : 'kbps';
  networkLimitInput.disabled = networkLimitUnit.disabled = networkUseAllToggle.checked;
  window.NetworkStats?.setDirections({ download: networkDownloadToggle.checked, upload: networkUploadToggle.checked });
  updateNetworkSettingsStatus();
}

function saveNetworkPreferences() {
  const prefs = {
    showDownload: networkDownloadToggle.checked,
    showUpload: networkUploadToggle.checked,
    useAllBandwidth: networkUseAllToggle.checked,
    limit: networkLimitInput.value.trim(),
    unit: networkLimitUnit.value,
  };
  localStorage.setItem(NETWORK_KEY, JSON.stringify(prefs));
  networkLimitInput.disabled = networkLimitUnit.disabled = prefs.useAllBandwidth;
  window.NetworkStats?.setDirections({ download: prefs.showDownload, upload: prefs.showUpload });
  updateNetworkSettingsStatus();
}

function updateNetworkSettingsStatus() {
  if (!networkSettingsStatus || !networkUseAllToggle) return;
  const value = Number(networkLimitInput.value);
  if (networkUseAllToggle.checked || !Number.isFinite(value) || value <= 0) {
    networkSettingsStatus.textContent = 'No limit; conversions can use all available bandwidth.';
  } else {
    networkSettingsStatus.textContent = `Incoming audio downloads are capped at ${value} ${networkLimitUnit.value === 'mbps' ? 'MB/s' : 'KB/s'} per conversion.`;
  }
}

networkDownloadToggle?.addEventListener('change', () => {
  if (!networkDownloadToggle.checked && !networkUploadToggle.checked) networkUploadToggle.checked = true;
  saveNetworkPreferences();
});
networkUploadToggle?.addEventListener('change', () => {
  if (!networkUploadToggle.checked && !networkDownloadToggle.checked) networkDownloadToggle.checked = true;
  saveNetworkPreferences();
});
networkUseAllToggle?.addEventListener('change', saveNetworkPreferences);
networkLimitInput?.addEventListener('input', () => {
  if (networkLimitInput.value.trim()) networkUseAllToggle.checked = false;
  saveNetworkPreferences();
});
networkLimitUnit?.addEventListener('change', saveNetworkPreferences);
applyNetworkPreferences();

async function loadDestFolder() {
  if (!destInput) return;
  let saved = localStorage.getItem(DEST_KEY);
  if (saved === null) {
    try {
      const res = await fetch('/settings/downloads-folder');
      if (res.ok) {
        const data = await res.json();
        saved = data.path || '';
        if (saved) localStorage.setItem(DEST_KEY, saved);
      }
    } catch { /* ignore */ }
    saved = saved || '';
  }
  destInput.value = saved;
  updateDestStatus(saved);
}

function updateDestStatus(val) {
  if (!destStatus) return;
  destStatus.textContent = val.trim() ? `Tracks will be saved to: ${val.trim()}` : 'Using default ZIP download.';
}

destInput?.addEventListener('input', () => {
  const val = destInput.value.trim();
  localStorage.setItem(DEST_KEY, val);
  updateDestStatus(val);
});

destClear?.addEventListener('click', () => {
  if (!destInput) return;
  destInput.value = '';
  localStorage.removeItem(DEST_KEY);
  updateDestStatus('');
  destInput.focus();
});

loadDestFolder();

// ── Expose helpers for app.js / library.js ────────────────────────────────
window.Settings = {
  getDestFolder: () => (localStorage.getItem(DEST_KEY) || '').trim(),
  getNetworkPreferences: () => {
    const prefs = readNetworkPreferences();
    const value = Number(prefs.limit);
    const limit = !prefs.useAllBandwidth && Number.isFinite(value) && value > 0
      ? value * (prefs.unit === 'mbps' ? 1024 : 1) : null;
    return { showDownload: prefs.showDownload !== false, showUpload: prefs.showUpload !== false,
      maxDownloadKbps: limit };
  },
};

// ── Readiness wiring (works on both pages) ────────────────────────────────
let readinessTimer;
let readinessBusy = false;

function showReadiness(data) {
  const run = document.querySelector('#readiness-run');
  if (!run) return;
  const running = data.state === 'running';
  run.disabled = running || readinessBusy;
  run.textContent = data.ready ? 'Run test again' : 'Run CPU & RAM test';
  const cancelBtn = document.querySelector('#readiness-cancel');
  if (cancelBtn) cancelBtn.hidden = !running;
  const progress = document.querySelector('#readiness-progress');
  if (progress) {
    progress.hidden = !running;
    if (data.pct == null) progress.removeAttribute('value'); else progress.value = data.pct;
  }
  const statusEl = document.querySelector('#readiness-status');
  if (statusEl) statusEl.textContent = data.msg || 'Run the test before preparing new vocals or instrumentals.';
  const hw = data.hardware || {};
  const hwEl = document.querySelector('#readiness-hardware');
  if (hwEl) hwEl.textContent = hw.total_ram_gb == null ? '' :
    `${hw.physical_cores} CPU cores · ${hw.total_ram_gb.toFixed(1)} GB RAM · ${hw.available_ram_gb.toFixed(1)} GB available now`;
  const result = data.measurement;
  const resultEl = document.querySelector('#readiness-result');
  if (resultEl) resultEl.textContent = result ?
    `8-second sample: ${result.wall_seconds.toFixed(1)}s elapsed, ${result.cpu_seconds.toFixed(1)} CPU seconds, ${result.peak_ram_gb.toFixed(2)} GB peak process RAM. Rough estimate per minute of audio: ${Math.round(result.seconds_per_minute * 0.7)}–${Math.round(result.seconds_per_minute * 1.6)} seconds, plus loading/export. Song complexity and other apps affect the result.` : '';
  clearTimeout(readinessTimer);
  if (running) readinessTimer = setTimeout(refreshReadiness, 1000);
}

async function refreshReadiness() {
  if (!document.querySelector('#readiness-run')) return;
  try {
    const response = await fetch('/library/readiness');
    if (!response.ok) throw new Error();
    showReadiness(await response.json());
  } catch {
    const statusEl = document.querySelector('#readiness-status');
    if (statusEl) statusEl.textContent = 'Hardware test unavailable. Check that the app is running, then try again.';
    const run = document.querySelector('#readiness-run');
    if (run) run.disabled = false;
  }
}

async function readinessAction(method) {
  if (readinessBusy) return;
  readinessBusy = true;
  const run = document.querySelector('#readiness-run');
  if (run) run.disabled = true;
  let success = false;
  try {
    const response = await fetch('/library/readiness', { method });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'The test could not be started.');
    success = true;
    showReadiness(data);
  } catch (error) {
    const statusEl = document.querySelector('#readiness-status');
    if (statusEl) statusEl.textContent = error.message;
  } finally {
    readinessBusy = false;
    if (success) await refreshReadiness(); else if (run) run.disabled = false;
  }
}

document.querySelector('#readiness-run')?.addEventListener('click', () => readinessAction('POST'));
document.querySelector('#readiness-cancel')?.addEventListener('click', () => readinessAction('DELETE'));

// Auto-refresh readiness on page load (library page only needs it; converter page has it in settings panel)
refreshReadiness();
