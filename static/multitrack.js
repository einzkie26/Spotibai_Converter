'use strict';

const themeToggle = document.querySelector('#theme-toggle');
const themeIcon = themeToggle.querySelector('.theme-icon');
const themeLabel = themeToggle.querySelector('.theme-label');
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const dark = theme === 'dark';
  themeIcon.textContent = dark ? '☼' : '◐';
  themeLabel.textContent = dark ? 'Light mode' : 'Dark mode';
  themeToggle.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
}
setTheme(localStorage.getItem('spotibai-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
themeToggle.addEventListener('click', () => {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('spotibai-theme', theme);
  setTheme(theme);
});

const trackSelect = document.querySelector('#mt-track-select');
const sourceSelect = document.querySelector('#mt-source-select');
const addButton = document.querySelector('#mt-add-track');
const statusEl = document.querySelector('#mt-status');
const lanesEl = document.querySelector('#mt-lanes');
const emptyEl = document.querySelector('#mt-empty');
const laneCountEl = document.querySelector('#mt-lane-count');
const playButton = document.querySelector('#mt-play');
const stopButton = document.querySelector('#mt-stop');
const seek = document.querySelector('#mt-seek');
const timeLabel = document.querySelector('#mt-time');
const master = document.querySelector('#mt-master');
const exportButton = document.querySelector('#mt-export');
const transitionStyle = document.querySelector('#mt-transition-style');
const crossfade = document.querySelector('#mt-crossfade');
const crossfadeValue = document.querySelector('#mt-crossfade-value');
const arrangeButton = document.querySelector('#mt-arrange-mix');
const mixToggle = document.querySelector('#mt-mix-toggle');
const saveMixButton = document.querySelector('#mt-save-mix');
const loadMixButton = document.querySelector('#mt-load-mix');

const tracks = new Map();
const lanes = [];
let audioContext = null;
let masterGain = null;
let nextLaneId = 1;
let playPosition = 0;
let playbackStartedAt = 0;
let playbackStartPosition = 0;
let isPlaying = false;
let animationFrame = 0;
let isBusy = false;
let sessionLoading = false;
let mixArranged = false;
const gateContexts = new WeakSet();
const SAVED_MIX_KEY = 'spotibai-multitrack-mix-v1';

async function ensureGateProcessor(context) {
  if (!context.audioWorklet) return false;
  if (gateContexts.has(context)) return true;
  try { await context.audioWorklet.addModule('/static/multitrack-gate.js'); gateContexts.add(context); return true; }
  catch { return false; }
}

function stemLabel(stem) {
  return ({ vocals: 'Vocals', drums: 'Drums / Beats', bass: 'Bass', piano: 'Piano', guitar: 'Guitar', other: 'Other instruments', instrumental: 'Instrumental' })[stem] || 'Original';
}

function updateGateSettings(lane) {
  if (!lane.gateNode) return;
  const threshold = lane.voice ? Math.min(-20, -80 + lane.noiseReduction * 0.42 + lane.echoTrim * 0.14) : -80;
  lane.gateNode.parameters.get('threshold').setTargetAtTime(threshold, audioContext.currentTime, 0.02);
  lane.gateNode.parameters.get('release').setTargetAtTime(Math.max(0.035, 0.25 - lane.echoTrim * 0.0018), audioContext.currentTime, 0.02);
}

function laneDuration(lane) { return Math.max(0, lane.trimEnd - lane.trimStart); }

function fft(real, imaginary) {
  const length = real.length;
  for (let i = 1, j = 0; i < length; i++) {
    let bit = length >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imaginary[i], imaginary[j]] = [imaginary[j], imaginary[i]];
    }
  }
  for (let size = 2; size <= length; size <<= 1) {
    const angle = -2 * Math.PI / size;
    const stepReal = Math.cos(angle);
    const stepImaginary = Math.sin(angle);
    for (let start = 0; start < length; start += size) {
      let factorReal = 1, factorImaginary = 0;
      const half = size >> 1;
      for (let offset = 0; offset < half; offset++) {
        const even = start + offset, odd = even + half;
        const productReal = factorReal * real[odd] - factorImaginary * imaginary[odd];
        const productImaginary = factorReal * imaginary[odd] + factorImaginary * real[odd];
        real[odd] = real[even] - productReal;
        imaginary[odd] = imaginary[even] - productImaginary;
        real[even] += productReal;
        imaginary[even] += productImaginary;
        const nextReal = factorReal * stepReal - factorImaginary * stepImaginary;
        factorImaginary = factorReal * stepImaginary + factorImaginary * stepReal;
        factorReal = nextReal;
      }
    }
  }
}

function analyzeAudio(buffer) {
  const sampleRate = buffer.sampleRate;
  const channel = buffer.getChannelData(0);
  const windowSize = Math.max(1, Math.floor(sampleRate / 10));
  const windowCount = Math.min(600, Math.floor(channel.length / windowSize));
  const energy = new Float64Array(windowCount);
  for (let window = 0; window < windowCount; window++) {
    const start = window * windowSize;
    const end = Math.min(channel.length, start + windowSize);
    let sum = 0;
    for (let i = start; i < end; i++) sum += channel[i] * channel[i];
    energy[window] = Math.sqrt(sum / Math.max(1, end - start));
  }
  const onset = energy.map((value, index) => Math.max(0, value - (energy[index - 1] || 0)));
  const mean = onset.reduce((sum, value) => sum + value, 0) / Math.max(1, onset.length);
  const centered = onset.map(value => value - mean);
  let bestLag = 0, bestScore = -Infinity;
  for (let lag = 3; lag <= 20 && lag < centered.length / 2; lag++) {
    let score = 0;
    for (let i = lag; i < centered.length; i++) score += centered[i] * centered[i - lag];
    if (score > bestScore) { bestScore = score; bestLag = lag; }
  }
  const bpm = bestLag ? Math.round(600 / bestLag) : null;

  const chroma = new Float64Array(12);
  const fftSize = 4096;
  const frameCount = Math.min(5, Math.max(1, Math.floor(buffer.duration / 2)));
  for (let frame = 0; frame < frameCount; frame++) {
    const start = Math.max(0, Math.min(channel.length - fftSize,
      Math.floor((frame + 0.5) * channel.length / frameCount) - fftSize / 2));
    const real = new Float64Array(fftSize), imaginary = new Float64Array(fftSize);
    for (let i = 0; i < fftSize; i++) {
      real[i] = (channel[start + i] || 0) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (fftSize - 1)));
    }
    fft(real, imaginary);
    for (let bin = Math.ceil(55 * fftSize / sampleRate); bin < Math.min(fftSize / 2, 1800 * fftSize / sampleRate); bin++) {
      const frequency = bin * sampleRate / fftSize;
      const midi = Math.round(69 + 12 * Math.log2(frequency / 440));
      const magnitude = Math.hypot(real[bin], imaginary[bin]);
      chroma[((midi % 12) + 12) % 12] += magnitude;
    }
  }
  const keys = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
  const profiles = [
    [6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88],
    [6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17],
  ];
  const average = chroma.reduce((sum, value) => sum + value, 0) / 12;
  const centeredChroma = chroma.map(value => value - average);
  const chromaNorm = Math.sqrt(centeredChroma.reduce((sum, value) => sum + value * value, 0));
  let key = 'Unknown', bestCorrelation = -Infinity;
  if (chromaNorm > 0) {
    profiles.forEach((profile, mode) => {
      for (let root = 0; root < 12; root++) {
        const profileMean = profile.reduce((sum, value) => sum + value, 0) / 12;
        let numerator = 0, profileNorm = 0;
        for (let note = 0; note < 12; note++) {
          const weight = profile[(note - root + 12) % 12] - profileMean;
          numerator += centeredChroma[note] * weight;
          profileNorm += weight * weight;
        }
        const correlation = numerator / (chromaNorm * Math.sqrt(profileNorm));
        if (correlation > bestCorrelation) {
          bestCorrelation = correlation;
          key = `${keys[root]} ${mode ? 'Minor' : 'Major'}`;
        }
      }
    });
  }
  return { bpm, key };
}

function formatTime(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

function safeMessage(error, fallback) {
  return error?.message || fallback;
}

async function readJson(response, fallback) {
  const body = await response.text();
  let data;
  try { data = JSON.parse(body); }
  catch {
    const detail = body.replace(/\s+/g, ' ').trim().slice(0, 180);
    throw new Error(`${fallback} (HTTP ${response.status})${detail ? `: ${detail}` : '.'}`);
  }
  if (!response.ok) throw new Error(data.error || fallback);
  return data;
}

async function loadLibrary() {
  try {
    const response = await fetch('/library/tracks');
    const items = await readJson(response, 'Could not load Library tracks.');
    trackSelect.replaceChildren(new Option(items.length ? 'Select a track…' : 'Library is empty', ''));
    items.forEach(track => {
      tracks.set(String(track.id), track);
      const label = `${track.artist || 'Unknown artist'} — ${track.title || 'Untitled'}`;
      trackSelect.add(new Option(label, track.id));
    });
    addButton.disabled = !items.length;
    statusEl.textContent = items.length ? `${items.length} track${items.length === 1 ? '' : 's'} available.` : 'Convert audio first, then add it from your Library.';
  } catch (error) {
    trackSelect.replaceChildren(new Option('Library could not be loaded', ''));
    statusEl.textContent = safeMessage(error, 'Could not load Library tracks.');
  }
}

function getAudioContext() {
  if (!audioContext) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    audioContext = new AudioContextClass();
    masterGain = audioContext.createGain();
    masterGain.gain.value = Number(master.value);
    masterGain.connect(audioContext.destination);
  }
  return audioContext;
}

function updateControls() {
  const length = Math.max(0, ...lanes.map(lane => lane.offset + laneDuration(lane)));
  laneCountEl.textContent = `${lanes.length} lane${lanes.length === 1 ? '' : 's'}`;
  emptyEl.hidden = lanes.length > 0;
  playButton.disabled = lanes.length === 0 || isBusy || sessionLoading;
  stopButton.disabled = lanes.length === 0 || isBusy || sessionLoading;
  exportButton.disabled = lanes.length === 0 || isBusy || sessionLoading;
  seek.disabled = lanes.length === 0 || isBusy || sessionLoading;
  seek.max = String(length);
  seek.value = String(Math.min(playPosition, length));
  timeLabel.textContent = `${formatTime(playPosition)} / ${formatTime(length)}`;
  playButton.textContent = isPlaying ? 'Ⅱ' : '▶';
  playButton.setAttribute('aria-label', isPlaying ? 'Pause mix' : 'Play mix');
  addButton.disabled = isBusy || sessionLoading || !tracks.size;
  arrangeButton.disabled = isBusy || sessionLoading || lanes.length < 2;
  mixToggle.disabled = isBusy || sessionLoading || lanes.length < 2;
  mixToggle.textContent = mixArranged ? 'Turn Mix off' : 'Turn Mix on';
  saveMixButton.disabled = isBusy || sessionLoading || lanes.length === 0;
  loadMixButton.disabled = isBusy || sessionLoading || !savedMixAvailable();
}

function savedMixAvailable() {
  try { return Boolean(localStorage.getItem(SAVED_MIX_KEY)); }
  catch { return false; }
}

function laneIsAudible(lane) {
  const soloLanes = lanes.filter(item => item.solo);
  return !lane.muted && (!soloLanes.length || lane.solo);
}

function applyLaneGain(lane) {
  if (lane.gain) lane.gain.gain.setTargetAtTime(laneIsAudible(lane) ? lane.volume : 0, audioContext.currentTime, 0.015);
}

function syncLaneProcessing(lane) {
  if (!lane.bassFilter) return;
  lane.bassFilter.gain.value = lane.eq.bass;
  lane.midFilter.gain.value = lane.eq.mid;
  lane.trebleFilter.gain.value = lane.eq.treble;
  lane.effectFilter.type = lane.effect === 'none' ? 'lowpass' : lane.effect;
  lane.effectFilter.frequency.value = lane.effect === 'none' ? 22000 : lane.effectFrequency;
  if (lane.crispFilter) lane.crispFilter.gain.value = lane.voice ? lane.crispness : 0;
  updateGateSettings(lane);
}

function effectFrequencyAt(lane, localTime) {
  if (lane.effect === 'none') return 22000;
  const clearFrequency = lane.effect === 'lowpass' ? 22000 : 10;
  const selectedFrequency = lane.effectFrequency;
  const length = laneDuration(lane);
  if (lane.fadeIn > 0 && localTime < lane.fadeIn) {
    const progress = Math.max(0, Math.min(1, localTime / lane.fadeIn));
    return selectedFrequency + (clearFrequency - selectedFrequency) * progress;
  }
  const fadeStart = length - lane.fadeOut;
  if (lane.fadeOut > 0 && localTime > fadeStart) {
    const progress = Math.max(0, Math.min(1, (localTime - fadeStart) / lane.fadeOut));
    return clearFrequency + (selectedFrequency - clearFrequency) * progress;
  }
  return selectedFrequency;
}

function scheduleEffect(filter, lane, localStart, when, remaining, context) {
  const parameter = filter.frequency;
  parameter.cancelScheduledValues(context.currentTime);
  if (remaining <= 0.02 || (lane.fadeIn <= 0 && lane.fadeOut <= 0)) {
    parameter.setValueAtTime(effectFrequencyAt(lane, localStart), when);
    return;
  }
  const points = new Float32Array(256);
  for (let i = 0; i < points.length; i++) {
    points[i] = effectFrequencyAt(lane, localStart + remaining * i / (points.length - 1));
  }
  parameter.setValueCurveAtTime(points, when, remaining);
}

function envelopeAt(lane, localTime) {
  const length = laneDuration(lane);
  let incoming = lane.fadeIn > 0 ? Math.max(0, Math.min(1, localTime / lane.fadeIn)) : 1;
  let outgoing = lane.fadeOut > 0 ? Math.max(0, Math.min(1, (length - localTime) / lane.fadeOut)) : 1;
  const incomingStyle = lane.fadeInStyle || transitionStyle.value;
  const outgoingStyle = lane.fadeOutStyle || transitionStyle.value;
  if (incomingStyle === 'cut' || outgoingStyle === 'cut') return 1;
  if (incomingStyle === 'rise') incoming *= incoming;
  else if (incomingStyle === 'dissolve') incoming = Math.sin(incoming * Math.PI / 2);
  if (outgoingStyle === 'dissolve') outgoing = Math.sin(outgoing * Math.PI / 2);
  return Math.min(incoming, outgoing);
}

function scheduleEnvelope(gain, lane, localStart, when, remaining, context) {
  const parameter = gain.gain;
  parameter.cancelScheduledValues(context.currentTime);
  if (remaining <= 0.02 || (lane.fadeIn <= 0 && lane.fadeOut <= 0)) {
    parameter.setValueAtTime(envelopeAt(lane, localStart), when);
    return;
  }
  const points = new Float32Array(256);
  for (let i = 0; i < points.length; i++) {
    const localTime = localStart + remaining * i / (points.length - 1);
    points[i] = envelopeAt(lane, localTime);
  }
  points[0] = envelopeAt(lane, localStart);
  points[points.length - 1] = envelopeAt(lane, localStart + remaining);
  parameter.setValueCurveAtTime(points, when, remaining);
}

function waveformPeaks(buffer, count = 360) {
  const channel = buffer.getChannelData(0);
  const block = Math.max(1, Math.floor(channel.length / count));
  const peaks = [];
  for (let i = 0; i < count; i++) {
    let peak = 0;
    const end = Math.min(channel.length, (i + 1) * block);
    for (let j = i * block; j < end; j += 4) peak = Math.max(peak, Math.abs(channel[j]));
    peaks.push(peak);
  }
  return peaks;
}

function drawWaveform(canvas, buffer) {
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(240, canvas.clientWidth);
  const height = 54;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const context = canvas.getContext('2d');
  context.scale(dpr, dpr);
  context.clearRect(0, 0, width, height);
  const peaks = waveformPeaks(buffer, Math.floor(width / 3));
  const barWidth = width / peaks.length;
  context.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--coral').trim() || '#ff765d';
  peaks.forEach((peak, i) => {
    const barHeight = Math.max(2, peak * (height - 5));
    context.globalAlpha = 0.35 + peak * 0.65;
    context.fillRect(i * barWidth, (height - barHeight) / 2, Math.max(1, barWidth * .58), barHeight);
  });
  context.globalAlpha = 1;
}

function renderLane(lane) {
  const card = document.createElement('article');
  card.className = 'multitrack-lane';
  card.dataset.id = lane.id;
  const heading = document.createElement('div');
  heading.className = 'multitrack-lane-heading';
  const title = document.createElement('div');
  title.className = 'multitrack-lane-name';
  const strong = document.createElement('strong');
  strong.textContent = lane.title;
  const tag = document.createElement('span');
  tag.textContent = lane.sourceLabel;
  const metadata = document.createElement('small');
  metadata.className = 'multitrack-analysis';
  metadata.textContent = `${lane.bpm ? `~${lane.bpm} BPM` : 'BPM —'} · ${lane.key || 'Key —'}`;
  title.append(strong, tag, metadata);
  const remove = document.createElement('button');
  remove.className = 'multitrack-remove';
  remove.type = 'button';
  remove.textContent = 'Remove';
  remove.addEventListener('click', () => removeLane(lane.id));
  heading.append(title, remove);

  const waveformWrap = document.createElement('div');
  waveformWrap.className = 'multitrack-waveform-wrap';
  const canvas = document.createElement('canvas');
  canvas.className = 'multitrack-waveform';
  canvas.setAttribute('aria-label', `Waveform for ${lane.title}`);
  waveformWrap.append(canvas);

  const controls = document.createElement('div');
  controls.className = 'multitrack-lane-controls';
  const volumeLabel = document.createElement('label');
  volumeLabel.className = 'mt-volume';
  volumeLabel.append(document.createTextNode('Volume'));
  const volume = document.createElement('input');
  volume.type = 'range'; volume.min = '0'; volume.max = '1.5'; volume.step = '0.01'; volume.value = String(lane.volume);
  volume.setAttribute('aria-label', `Volume for ${lane.title}`);
  volume.addEventListener('input', () => { lane.volume = Number(volume.value); applyLaneGain(lane); });
  volumeLabel.append(volume);

  const offsetLabel = document.createElement('label');
  offsetLabel.className = 'mt-number-control mt-position';
  offsetLabel.append(document.createTextNode('Position'));
  const offset = document.createElement('input');
  offset.type = 'number'; offset.min = '0'; offset.step = '0.1'; offset.value = String(lane.offset);
  offset.setAttribute('aria-label', `Timeline position for ${lane.title}`);
  offset.addEventListener('change', () => {
    lane.offset = Math.max(0, Number(offset.value) || 0);
    offset.value = String(lane.offset);
    mixArranged = false;
    lanes.forEach(item => { item.fadeIn = 0; item.fadeOut = 0; });
    if (isPlaying) restartPlayback();
    updateControls();
  });

  const cueInLabel = document.createElement('label');
  cueInLabel.className = 'mt-number-control';
  cueInLabel.append(document.createTextNode('Cue in'));
  const cueIn = document.createElement('input');
  cueIn.type = 'number'; cueIn.min = '0'; cueIn.max = String(lane.buffer.duration); cueIn.step = '0.1'; cueIn.value = String(lane.trimStart);
  cueIn.setAttribute('aria-label', `Cue in point for ${lane.title}`);
  cueInLabel.append(cueIn);
  cueIn.addEventListener('change', () => {
    lane.trimStart = Math.max(0, Math.min(lane.trimEnd - 0.1, Number(cueIn.value) || 0));
    cueIn.value = String(lane.trimStart);
    if (mixArranged) arrangeMix(false);
    else { lanes.forEach(item => { item.fadeIn = 0; item.fadeOut = 0; }); if (isPlaying) restartPlayback(); updateControls(); }
  });

  const cueOutLabel = document.createElement('label');
  cueOutLabel.className = 'mt-number-control';
  cueOutLabel.append(document.createTextNode('Cue out'));
  const cueOut = document.createElement('input');
  cueOut.type = 'number'; cueOut.min = '0.1'; cueOut.max = String(lane.buffer.duration); cueOut.step = '0.1'; cueOut.value = String(lane.trimEnd);
  cueOut.setAttribute('aria-label', `Cue out point for ${lane.title}`);
  cueOutLabel.append(cueOut);
  cueOut.addEventListener('change', () => {
    lane.trimEnd = Math.min(lane.buffer.duration, Math.max(lane.trimStart + 0.1, Number(cueOut.value) || lane.buffer.duration));
    cueOut.value = String(lane.trimEnd);
    if (mixArranged) arrangeMix(false);
    else { lanes.forEach(item => { item.fadeIn = 0; item.fadeOut = 0; }); if (isPlaying) restartPlayback(); updateControls(); }
  });

  const mute = document.createElement('button');
  mute.type = 'button'; mute.textContent = 'Mute'; mute.setAttribute('aria-pressed', 'false');
  mute.addEventListener('click', () => { lane.muted = !lane.muted; mute.setAttribute('aria-pressed', String(lane.muted)); mute.classList.toggle('is-active', lane.muted); applySoloState(); });
  const solo = document.createElement('button');
  solo.type = 'button'; solo.textContent = 'Solo'; solo.setAttribute('aria-pressed', 'false');
  solo.addEventListener('click', () => { lane.solo = !lane.solo; solo.setAttribute('aria-pressed', String(lane.solo)); solo.classList.toggle('is-active', lane.solo); applySoloState(); });

  const moveUp = document.createElement('button');
  moveUp.type = 'button'; moveUp.textContent = '↑'; moveUp.title = 'Move lane earlier'; moveUp.setAttribute('aria-label', `Move ${lane.title} earlier`);
  moveUp.addEventListener('click', () => moveLane(lane.id, -1));
  const moveDown = document.createElement('button');
  moveDown.type = 'button'; moveDown.textContent = '↓'; moveDown.title = 'Move lane later'; moveDown.setAttribute('aria-label', `Move ${lane.title} later`);
  moveDown.addEventListener('click', () => moveLane(lane.id, 1));

  controls.append(volumeLabel, offsetLabel, cueInLabel, cueOutLabel, mute, solo, moveUp, moveDown);
  const processing = document.createElement('details');
  processing.className = 'multitrack-processing';
  const processingSummary = document.createElement('summary');
  processingSummary.textContent = 'EQ & effects';
  const processingControls = document.createElement('div');
  processingControls.className = 'multitrack-processing-controls';
  const makeEqControl = (name, key) => {
    const label = document.createElement('label');
    label.textContent = name;
    const input = document.createElement('input');
    input.type = 'range'; input.min = '-12'; input.max = '12'; input.step = '0.5'; input.value = String(lane.eq[key]);
    input.setAttribute('aria-label', `${name} EQ for ${lane.title}`);
    input.addEventListener('input', () => { lane.eq[key] = Number(input.value); syncLaneProcessing(lane); });
    label.append(input);
    return label;
  };
  processingControls.append(makeEqControl('Low', 'bass'), makeEqControl('Mid', 'mid'), makeEqControl('High', 'treble'));
  const effectLabel = document.createElement('label');
  effectLabel.textContent = 'Filter';
  const effect = document.createElement('select');
  [['none', 'Off'], ['lowpass', 'Low-pass'], ['highpass', 'High-pass']].forEach(([value, label]) => effect.add(new Option(label, value)));
  effect.setAttribute('aria-label', `Filter effect for ${lane.title}`);
    effect.addEventListener('change', () => { lane.effect = effect.value; syncLaneProcessing(lane); if (isPlaying) restartPlayback(); });
  effectLabel.append(effect);
  const frequencyLabel = document.createElement('label');
  frequencyLabel.textContent = 'Cutoff';
  const frequency = document.createElement('input');
  frequency.type = 'range'; frequency.min = '200'; frequency.max = '18000'; frequency.step = '100'; frequency.value = String(lane.effectFrequency);
  frequency.setAttribute('aria-label', `Filter cutoff for ${lane.title}`);
  frequency.addEventListener('input', () => { lane.effectFrequency = Number(frequency.value); syncLaneProcessing(lane); if (isPlaying) restartPlayback(); });
  frequencyLabel.append(frequency);
  processingControls.append(effectLabel, frequencyLabel);
  if (lane.voice) {
    const makeVoiceControl = (name, key, max, description) => {
      const label = document.createElement('label');
      label.title = description;
      label.textContent = name;
      const input = document.createElement('input');
      input.type = 'range'; input.min = '0'; input.max = String(max); input.step = '1'; input.value = String(lane[key]);
      input.setAttribute('aria-label', `${name} for ${lane.title}`);
      input.addEventListener('input', () => { lane[key] = Number(input.value); syncLaneProcessing(lane); });
      label.append(input);
      return label;
    };
    processingSummary.textContent = 'EQ, vocal cleanup & effects';
    processingControls.append(
      makeVoiceControl('Noise reduction', 'noiseReduction', 100, 'Closes the gate on quiet background noise between phrases.'),
      makeVoiceControl('Room tail', 'echoTrim', 100, 'Tightens the gate release to reduce quiet reverb tails between phrases.'),
      makeVoiceControl('Crispness', 'crispness', 12, 'Adds vocal presence around 3.2 kHz.')
    );
  }
  processing.append(processingSummary, processingControls);
  const transitionDetails = document.createElement('details');
  transitionDetails.className = 'multitrack-lane-transition';
  const transitionSummary = document.createElement('summary');
  transitionSummary.textContent = 'Transition from previous track';
  const transitionControls = document.createElement('div');
  transitionControls.className = 'multitrack-transition-controls';
  const transitionLabel = document.createElement('label');
  transitionLabel.textContent = 'Style';
  const transitionSelect = document.createElement('select');
  [['auto','Auto'],['fade','Fade'],['rise','Rise'],['dissolve','Dissolve'],['cut','Cut']]
    .forEach(([value, label]) => transitionSelect.add(new Option(label, value)));
  const transitionAmountLabel = document.createElement('label');
  transitionAmountLabel.textContent = 'Crossfade';
  const transitionAmount = document.createElement('input');
  transitionAmount.type = 'range'; transitionAmount.min = '0'; transitionAmount.max = '12'; transitionAmount.step = '0.5';
  transitionSelect.value = lane.transitionOverride?.style || transitionStyle.value;
  transitionAmount.value = String(lane.transitionOverride?.duration ?? crossfade.value);
  transitionLabel.append(transitionSelect);
  transitionAmountLabel.append(transitionAmount);
  const resetTransition = document.createElement('button');
  resetTransition.type = 'button'; resetTransition.textContent = 'Use mix default';
  const commitTransition = () => {
    lane.transitionOverride = { style: transitionSelect.value, duration: Number(transitionAmount.value) };
    arrangeMix(false);
  };
  transitionSelect.addEventListener('change', commitTransition);
  transitionAmount.addEventListener('change', commitTransition);
  resetTransition.addEventListener('click', () => { lane.transitionOverride = null; refreshTransitionControls(); arrangeMix(false); });
  transitionControls.append(transitionLabel, transitionAmountLabel, resetTransition);
  transitionDetails.append(transitionSummary, transitionControls);
  lane.transitionElements = { details: transitionDetails, style: transitionSelect, duration: transitionAmount };
  card.append(heading, waveformWrap, controls, processing, transitionDetails);
  lanesEl.append(card);
  refreshTransitionControls();
  requestAnimationFrame(() => drawWaveform(canvas, lane.buffer));
  lane.gain = getAudioContext().createGain();
  lane.bassFilter = getAudioContext().createBiquadFilter();
  lane.bassFilter.type = 'lowshelf'; lane.bassFilter.frequency.value = 120;
  lane.midFilter = getAudioContext().createBiquadFilter();
  lane.midFilter.type = 'peaking'; lane.midFilter.frequency.value = 1000; lane.midFilter.Q.value = 0.8;
  lane.trebleFilter = getAudioContext().createBiquadFilter();
  lane.trebleFilter.type = 'highshelf'; lane.trebleFilter.frequency.value = 8000;
  lane.effectFilter = getAudioContext().createBiquadFilter();
  lane.voiceHighpass = getAudioContext().createBiquadFilter();
  lane.voiceHighpass.type = 'highpass'; lane.voiceHighpass.frequency.value = lane.voice ? 80 : 35; lane.voiceHighpass.Q.value = 0.707;
  lane.crispFilter = getAudioContext().createBiquadFilter();
  lane.crispFilter.type = 'peaking'; lane.crispFilter.frequency.value = 3200; lane.crispFilter.Q.value = 0.9;
  lane.envelope = getAudioContext().createGain();
  if (lane.gateAvailable) lane.gateNode = new AudioWorkletNode(getAudioContext(), 'multitrack-noise-gate');
  const chain = [lane.gain, lane.bassFilter, lane.midFilter, lane.trebleFilter, lane.voiceHighpass, lane.crispFilter];
  if (lane.gateNode) chain.push(lane.gateNode);
  chain.push(lane.effectFilter, lane.envelope, masterGain);
  chain.reduce((previous, current) => previous.connect(current));
  syncLaneProcessing(lane);
  applyLaneGain(lane);
}

function applySoloState() { lanes.forEach(applyLaneGain); }

function stopSources() {
  lanes.forEach(lane => {
    if (lane.source) {
      try { lane.source.stop(); } catch {}
      lane.source.disconnect();
      lane.source = null;
    }
  });
}

function startSources() {
  const context = getAudioContext();
  const now = context.currentTime;
  lanes.forEach(lane => {
    const elapsed = playPosition - lane.offset;
    const length = laneDuration(lane);
    if (elapsed >= length) return;
    const source = context.createBufferSource();
    source.buffer = lane.buffer;
    source.connect(lane.gain);
    lane.source = source;
    const delay = Math.max(0, -elapsed);
    const localStart = Math.max(0, elapsed);
    const remaining = length - localStart;
    scheduleEnvelope(lane.envelope, lane, localStart, now + delay, remaining, context);
    scheduleEffect(lane.effectFilter, lane, localStart, now + delay, remaining, context);
    source.start(now + delay, lane.trimStart + localStart, remaining);
    source.onended = () => { if (lane.source === source) lane.source = null; };
  });
  playbackStartedAt = context.currentTime;
  playbackStartPosition = playPosition;
  isPlaying = true;
  updateControls();
  cancelAnimationFrame(animationFrame);
  animationFrame = requestAnimationFrame(tickPlayback);
}

function restartPlayback() {
  if (!isPlaying) return;
  playPosition = Math.max(0, audioContext.currentTime - playbackStartedAt + playbackStartPosition);
  stopSources();
  startSources();
}

function tickPlayback() {
  if (!isPlaying) return;
  playPosition = audioContext.currentTime - playbackStartedAt + playbackStartPosition;
  const end = Math.max(0, ...lanes.map(lane => lane.offset + laneDuration(lane)));
  if (playPosition >= end) {
    playPosition = end;
    stopSources();
    isPlaying = false;
    updateControls();
    return;
  }
  updateControls();
  animationFrame = requestAnimationFrame(tickPlayback);
}

function pausePlayback() {
  if (!isPlaying) return;
  playPosition = audioContext.currentTime - playbackStartedAt + playbackStartPosition;
  stopSources();
  isPlaying = false;
  cancelAnimationFrame(animationFrame);
  updateControls();
}

function stopPlayback() {
  stopSources();
  isPlaying = false;
  playPosition = 0;
  cancelAnimationFrame(animationFrame);
  updateControls();
}

playButton.addEventListener('click', async () => {
  if (isPlaying) { pausePlayback(); return; }
  if (!lanes.length) return;
  try {
    const context = getAudioContext();
    if (context.state === 'suspended') await context.resume();
    const end = Math.max(...lanes.map(lane => lane.offset + laneDuration(lane)));
    if (playPosition >= end) playPosition = 0;
    startSources();
  } catch (error) { statusEl.textContent = safeMessage(error, 'Audio playback could not start.'); }
});
stopButton.addEventListener('click', stopPlayback);
seek.addEventListener('input', () => {
  playPosition = Number(seek.value) || 0;
  if (isPlaying) { stopSources(); startSources(); }
  else updateControls();
});
master.addEventListener('input', () => {
  if (masterGain) masterGain.gain.setTargetAtTime(Number(master.value), audioContext.currentTime, 0.015);
});

function removeLane(id) {
  const index = lanes.findIndex(lane => lane.id === id);
  if (index < 0) return;
  if (isPlaying) pausePlayback();
  const [lane] = lanes.splice(index, 1);
  lane.source?.disconnect();
  lane.gain?.disconnect();
  lane.bassFilter?.disconnect(); lane.midFilter?.disconnect(); lane.trebleFilter?.disconnect();
  lane.voiceHighpass?.disconnect(); lane.crispFilter?.disconnect(); lane.gateNode?.disconnect();
  lane.effectFilter?.disconnect(); lane.envelope?.disconnect();
  lanesEl.querySelector(`[data-id="${id}"]`)?.remove();
  refreshTransitionControls();
  applySoloState();
  if (mixArranged && lanes.length > 1) arrangeMix(false);
  else if (lanes.length < 2) {
    mixArranged = false;
    lanes.forEach(item => { item.fadeIn = 0; item.fadeOut = 0; });
  }
  updateControls();
}

function moveLane(id, direction) {
  const index = lanes.findIndex(lane => lane.id === id);
  const nextIndex = index + direction;
  if (index < 0 || nextIndex < 0 || nextIndex >= lanes.length) return;
  const wasPlaying = isPlaying;
  if (wasPlaying) pausePlayback();
  const [lane] = lanes.splice(index, 1);
  lanes.splice(nextIndex, 0, lane);
  lanes.forEach(item => lanesEl.appendChild(lanesEl.querySelector(`[data-id="${item.id}"]`)));
  refreshTransitionControls();
  if (mixArranged) arrangeMix(false);
  else updateControls();
  if (wasPlaying) startSources();
}

function areKeysRelated(first, second) {
  if (!first || !second || first === 'Unknown' || second === 'Unknown') return false;
  const notes = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
  const parse = key => {
    const [note, mode] = key.split(' ');
    return { root: notes.indexOf(note), minor: mode === 'Minor' };
  };
  const a = parse(first), b = parse(second);
  if (a.root < 0 || b.root < 0) return false;
  const distance = (a.root - b.root + 12) % 12;
  return distance === 0 || (a.minor !== b.minor && (distance === 3 || distance === 9));
}

function autoTransition(previous, current) {
  if (!previous.bpm || !current.bpm) return 'fade';
  const tempoGap = Math.abs(previous.bpm - current.bpm) / Math.max(previous.bpm, current.bpm);
  return tempoGap <= 0.06 && areKeysRelated(previous.key, current.key) ? 'dissolve' : 'fade';
}

function refreshTransitionControls() {
  lanes.forEach((lane, index) => {
    const elements = lane.transitionElements;
    if (!elements) return;
    elements.details.hidden = index === 0;
    if (!lane.transitionOverride) {
      elements.style.value = transitionStyle.value;
      elements.duration.value = crossfade.value;
    }
  });
}

function arrangeMix(showStatus = true) {
  if (lanes.length < 2) return;
  const wasPlaying = isPlaying;
  if (wasPlaying) pausePlayback();
  lanes.forEach(lane => { lane.fadeIn = 0; lane.fadeOut = 0; lane.fadeInStyle = ''; lane.fadeOutStyle = ''; });
  lanes[0].offset = 0;
  const transitionTypes = [];
  for (let i = 1; i < lanes.length; i++) {
    const previous = lanes[i - 1];
    const current = lanes[i];
    const override = current.transitionOverride;
    const edgeStyle = override?.style || transitionStyle.value;
    const edgeDuration = edgeStyle === 'cut' ? 0 : Number(override?.duration ?? crossfade.value);
    const overlap = Math.min(edgeDuration, laneDuration(previous) * 0.45, laneDuration(current) * 0.45);
    const type = edgeStyle === 'auto' ? autoTransition(previous, current) : edgeStyle;
    previous.fadeOut = overlap;
    current.fadeIn = overlap;
    previous.fadeOutStyle = type;
    current.fadeInStyle = type;
    current.offset = previous.offset + laneDuration(previous) - overlap;
    transitionTypes.push(type);
  }
  lanes.forEach(lane => {
    const position = lanesEl.querySelector(`[data-id="${lane.id}"] .mt-position input`);
    if (position) position.value = lane.offset.toFixed(1);
  });
  refreshTransitionControls();
  mixArranged = true;
  if (showStatus) {
    const description = transitionStyle.value === 'auto'
      ? `Auto selected ${transitionTypes.join(', ') || 'fade'} from the approximate tempo and key matches.`
      : `Arranged ${lanes.length} lanes with ${transitionStyle.options[transitionStyle.selectedIndex].text.toLowerCase()} transitions.`;
    statusEl.textContent = description;
  }
  updateControls();
  if (wasPlaying) startSources();
}

arrangeButton.addEventListener('click', () => arrangeMix());
mixToggle.addEventListener('click', () => {
  if (!mixArranged) { arrangeMix(); return; }
  const wasPlaying = isPlaying;
  if (wasPlaying) pausePlayback();
  mixArranged = false;
  let cursor = 0;
  lanes.forEach(lane => {
    lane.offset = cursor;
    lane.fadeIn = 0; lane.fadeOut = 0; lane.fadeInStyle = ''; lane.fadeOutStyle = '';
    cursor += laneDuration(lane);
    const position = lanesEl.querySelector(`[data-id="${lane.id}"] .mt-position input`);
    if (position) position.value = lane.offset.toFixed(1);
  });
  statusEl.textContent = 'Mix transitions are off. The lanes play in order without overlap.';
  updateControls();
  if (wasPlaying) startSources();
});
crossfade.addEventListener('input', () => {
  crossfadeValue.textContent = `${crossfade.value} sec`;
  refreshTransitionControls();
});
crossfade.addEventListener('change', () => { if (mixArranged) arrangeMix(false); });
transitionStyle.addEventListener('change', () => {
  refreshTransitionControls();
  if (mixArranged) arrangeMix(false);
});

async function prepareStem(trackId, stem) {
  statusEl.textContent = `Preparing ${stem} layer…`;
  const response = await fetch(`/library/tracks/${trackId}/separate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stem }),
  });
  const job = await readJson(response, `Could not prepare ${stem}.`);
  for (;;) {
    const progressResponse = await fetch(`/library/tracks/${trackId}/separate/${job.sep_id}/status`);
    const progress = await readJson(progressResponse, 'Separation progress is unavailable.');
    statusEl.textContent = progress.msg || `Preparing ${stem}…`;
    if (progress.state === 'done') return;
    if (progress.state === 'error') throw new Error(progress.msg || 'Audio separation failed.');
    await new Promise(resolve => window.setTimeout(resolve, 900));
  }
}

async function addLane(trackIdOverride = null, sourceOverride = null, settings = null) {
  const track = tracks.get(String(trackIdOverride ?? trackSelect.value));
  if (!track || isBusy || (sessionLoading && !settings)) return;
  if (lanes.length >= 12) { statusEl.textContent = 'This session is limited to 12 lanes to protect memory.'; return; }
  const stem = sourceOverride ?? sourceSelect.value;
  const sourceLabel = stemLabel(stem);
  isBusy = true;
  updateControls();
  addButton.disabled = true;
  try {
    if (stem) await prepareStem(track.id, stem);
    const gateAvailable = stem === 'vocals' ? await ensureGateProcessor(getAudioContext()) : false;
    statusEl.textContent = `Loading ${sourceLabel.toLowerCase()} audio into the editor…`;
    const response = await fetch(`/library/tracks/${track.id}/download${stem ? `?stem=${encodeURIComponent(stem)}` : ''}`);
    if (!response.ok) await readJson(response, 'The audio file could not be loaded.');
    const data = await response.arrayBuffer();
    const buffer = await getAudioContext().decodeAudioData(data);
    statusEl.textContent = 'Estimating tempo and key…';
    const analysis = analyzeAudio(buffer);
    const trimStart = Math.max(0, Math.min(buffer.duration - 0.1, Number(settings?.trimStart) || 0));
    const trimEnd = Math.min(buffer.duration, Math.max(trimStart + 0.1, Number(settings?.trimEnd) || buffer.duration));
    const savedEq = settings?.eq || {};
    const lane = {
      id: nextLaneId++, trackId: track.id, title: `${track.title || 'Untitled'} — ${track.artist || 'Unknown artist'}`,
      sourceLabel, sourceStem: stem || '', voice: stem === 'vocals', gateAvailable, buffer, offset: Math.max(0, Number(settings?.offset) || 0), trimStart, trimEnd,
      fadeIn: 0, fadeOut: 0, fadeInStyle: '', fadeOutStyle: '', bpm: analysis.bpm, key: analysis.key,
      volume: Math.max(0, Math.min(1.5, Number(settings?.volume ?? 1))),
      eq: { bass: Number(savedEq.bass) || 0, mid: Number(savedEq.mid) || 0, treble: Number(savedEq.treble) || 0 },
      effect: ['none', 'lowpass', 'highpass'].includes(settings?.effect) ? settings.effect : 'none',
      effectFrequency: Math.max(200, Math.min(18000, Number(settings?.effectFrequency) || 6000)),
      noiseReduction: Math.max(0, Math.min(100, Number(settings?.noiseReduction) || 0)),
      echoTrim: Math.max(0, Math.min(100, Number(settings?.echoTrim) || 0)),
      crispness: Math.max(0, Math.min(12, Number(settings?.crispness) || 0)),
      transitionOverride: settings?.transitionOverride || null,
      muted: Boolean(settings?.muted), solo: Boolean(settings?.solo), source: null, gain: null, envelope: null,
    };
    lanes.push(lane);
    renderLane(lane);
    if (mixArranged && lanes.length > 1) arrangeMix(false);
    statusEl.textContent = `${sourceLabel} added. All lanes start at the same timeline position.`;
  } catch (error) {
    const message = safeMessage(error, 'Could not add this layer.');
    statusEl.textContent = message.includes('CPU') || message.includes('RAM') || message.includes('readiness')
      ? `${message} Open Converter → Settings to run the CPU & RAM test.` : message;
  } finally {
    isBusy = false;
    updateControls();
  }
}
addButton.addEventListener('click', () => addLane());

saveMixButton.addEventListener('click', () => {
  try {
    const saved = {
      version: 1,
      transitionStyle: transitionStyle.value,
      crossfade: Number(crossfade.value),
      mixArranged,
      lanes: lanes.map(lane => ({
        trackId: lane.trackId,
        source: lane.sourceStem,
        offset: lane.offset,
        trimStart: lane.trimStart,
        trimEnd: lane.trimEnd,
        volume: lane.volume,
        eq: lane.eq,
        effect: lane.effect,
        effectFrequency: lane.effectFrequency,
        noiseReduction: lane.noiseReduction,
        echoTrim: lane.echoTrim,
        crispness: lane.crispness,
        transitionOverride: lane.transitionOverride,
        muted: lane.muted,
        solo: lane.solo,
      })),
    };
    localStorage.setItem(SAVED_MIX_KEY, JSON.stringify(saved));
    statusEl.textContent = 'Mix session saved in this browser. Use Load saved mix to reopen it.';
  } catch (error) { statusEl.textContent = safeMessage(error, 'The mix could not be saved in browser storage.'); }
  updateControls();
});

loadMixButton.addEventListener('click', async () => {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(SAVED_MIX_KEY) || 'null'); }
  catch { statusEl.textContent = 'The saved mix file is invalid. Save the current mix to replace it.'; return; }
  if (!saved?.lanes?.length) return;
  sessionLoading = true;
  stopPlayback();
  lanes.forEach(lane => {
    lane.source?.disconnect(); lane.gain?.disconnect(); lane.envelope?.disconnect();
    lane.bassFilter?.disconnect(); lane.midFilter?.disconnect(); lane.trebleFilter?.disconnect();
    lane.voiceHighpass?.disconnect(); lane.crispFilter?.disconnect(); lane.gateNode?.disconnect(); lane.effectFilter?.disconnect();
  });
  lanes.length = 0;
  lanesEl.replaceChildren();
  transitionStyle.value = ['auto', 'fade', 'rise', 'dissolve', 'cut'].includes(saved.transitionStyle) ? saved.transitionStyle : 'auto';
  crossfade.value = String(Math.max(0, Math.min(12, Number(saved.crossfade) || 0)));
  crossfadeValue.textContent = `${crossfade.value} sec`;
  mixArranged = false;
  updateControls();
  try {
    for (const lane of saved.lanes.slice(0, 12)) {
      const source = ['vocals', 'drums', 'bass', 'piano', 'guitar', 'other', 'instrumental'].includes(lane.source)
        ? lane.source : ({ Vocals: 'vocals', Instrumental: 'instrumental', 'Drums / Beats': 'drums' })[lane.source] || '';
      await addLane(lane.trackId, source, lane);
    }
    if (saved.mixArranged && lanes.length > 1) arrangeMix(false);
    statusEl.textContent = `Loaded ${lanes.length} saved lane${lanes.length === 1 ? '' : 's'}.`;
  } catch (error) { statusEl.textContent = safeMessage(error, 'The saved mix could not be loaded.'); }
  finally { sessionLoading = false; updateControls(); }
});

function encodeWav(audioBuffer) {
  const channels = Math.min(2, audioBuffer.numberOfChannels);
  const frames = audioBuffer.length;
  const bytes = 44 + frames * channels * 2;
  const out = new ArrayBuffer(bytes);
  const view = new DataView(out);
  const writeText = (offset, value) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  writeText(0, 'RIFF'); view.setUint32(4, bytes - 8, true); writeText(8, 'WAVE');
  writeText(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, channels, true); view.setUint32(24, audioBuffer.sampleRate, true);
  view.setUint32(28, audioBuffer.sampleRate * channels * 2, true); view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true); writeText(36, 'data'); view.setUint32(40, bytes - 44, true);
  const channelData = Array.from({ length: channels }, (_, channel) => audioBuffer.getChannelData(channel));
  let offset = 44;
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < channels; channel++) {
      const sample = Math.max(-1, Math.min(1, channelData[channel][frame]));
      view.setInt16(offset, sample < 0 ? sample * 32768 : sample * 32767, true);
      offset += 2;
    }
  }
  return new Blob([out], { type: 'audio/wav' });
}

exportButton.addEventListener('click', async () => {
  if (!lanes.length || isBusy) return;
  if (isPlaying) pausePlayback();
  isBusy = true;
  updateControls();
  statusEl.textContent = 'Rendering the mix to WAV…';
  try {
    const sampleRate = 44100;
    const lengthSeconds = Math.max(...lanes.map(lane => lane.offset + laneDuration(lane)));
    if (lengthSeconds > 900) throw new Error('WAV export is limited to 15 minutes per session.');
    const offline = new OfflineAudioContext(2, Math.ceil(lengthSeconds * sampleRate), sampleRate);
    const offlineGateAvailable = await ensureGateProcessor(offline);
    const offlineMaster = offline.createGain();
    offlineMaster.gain.value = Number(master.value);
    offlineMaster.connect(offline.destination);
    lanes.forEach(lane => {
      if (!laneIsAudible(lane)) return;
      const source = offline.createBufferSource();
      const gain = offline.createGain();
      const bass = offline.createBiquadFilter(); bass.type = 'lowshelf'; bass.frequency.value = 120; bass.gain.value = lane.eq.bass;
      const mid = offline.createBiquadFilter(); mid.type = 'peaking'; mid.frequency.value = 1000; mid.Q.value = 0.8; mid.gain.value = lane.eq.mid;
      const treble = offline.createBiquadFilter(); treble.type = 'highshelf'; treble.frequency.value = 8000; treble.gain.value = lane.eq.treble;
      const effect = offline.createBiquadFilter();
      effect.type = lane.effect === 'none' ? 'lowpass' : lane.effect;
      effect.frequency.value = lane.effect === 'none' ? 22000 : lane.effectFrequency;
      const voiceHighpass = offline.createBiquadFilter(); voiceHighpass.type = 'highpass'; voiceHighpass.frequency.value = lane.voice ? 80 : 35;
      const crisp = offline.createBiquadFilter(); crisp.type = 'peaking'; crisp.frequency.value = 3200; crisp.Q.value = 0.9; crisp.gain.value = lane.voice ? lane.crispness : 0;
      const gate = lane.voice && lane.gateAvailable && offlineGateAvailable
        ? new AudioWorkletNode(offline, 'multitrack-noise-gate') : null;
      if (gate) {
        gate.parameters.get('threshold').value = Math.min(-20, -80 + lane.noiseReduction * 0.42 + lane.echoTrim * 0.14);
        gate.parameters.get('release').value = Math.max(0.035, 0.25 - lane.echoTrim * 0.0018);
      }
      const envelope = offline.createGain();
      source.buffer = lane.buffer;
      gain.gain.value = lane.volume;
      const chain = [source, gain, bass, mid, treble, voiceHighpass, crisp];
      if (gate) chain.push(gate);
      chain.push(effect, envelope, offlineMaster);
      chain.reduce((previous, current) => previous.connect(current));
      scheduleEnvelope(envelope, lane, 0, lane.offset, laneDuration(lane), offline);
      scheduleEffect(effect, lane, 0, lane.offset, laneDuration(lane), offline);
      source.start(lane.offset, lane.trimStart, laneDuration(lane));
    });
    const rendered = await offline.startRendering();
    const blob = encodeWav(rendered);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'spotibai-multitrack-mix.wav';
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 2000);
    statusEl.textContent = 'Mix exported as a 16-bit stereo WAV file.';
  } catch (error) { statusEl.textContent = safeMessage(error, 'WAV export failed.'); }
  finally { isBusy = false; updateControls(); }
});

window.addEventListener('resize', () => {
  lanesEl.querySelectorAll('.multitrack-waveform').forEach((canvas, index) => {
    const lane = lanes.find(item => item.id === Number(canvas.closest('.multitrack-lane')?.dataset.id));
    if (lane) drawWaveform(canvas, lane.buffer);
  });
});

updateControls();
loadLibrary();
