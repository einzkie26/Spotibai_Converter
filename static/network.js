'use strict';

globalThis.NetworkStats = (() => {
  let activeMonitor = null;
  function size(bytes) {
    if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(2)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${Math.round(bytes)} B`;
  }

  function create() {
    const bar = document.querySelector('#net-stats-bar');
    const label = document.querySelector('#net-status-label');
    const dot = document.querySelector('#net-status-dot');
    const sent = document.querySelector('#net-sent');
    const received = document.querySelector('#net-recv');
    const loss = document.querySelector('#net-loss');
    const errors = document.querySelector('#net-overflow');
    const lossWrap = document.querySelector('#net-loss-wrap');
    const errorsWrap = document.querySelector('#net-overflow-wrap');
    const total = document.querySelector('#net-total-recv');
    const detail = document.querySelector('#net-detail');
    const activityMeter = document.querySelector('#net-activity-meter');
    const activityLabel = document.querySelector('#net-activity-level');
    let active = false;
    let generation = 0;
    let timer = null;
    let pending = null;
    let previous = null;
    let totalReceived = 0;
    let phase = 'Metadata';
    let unavailable = false;
    let issue = false;
    const directions = { download: true, upload: true };

    function setDirections(next = {}) {
      directions.download = next.download !== false;
      directions.upload = next.upload !== false;
      if (!directions.download && !directions.upload) directions.download = true;
      bar.dataset.showDownload = String(directions.download);
      bar.dataset.showUpload = String(directions.upload);
    }

    function setActivityLevel(bytesPerSecond) {
      const level = bytesPerSecond == null ? 'measuring'
        : bytesPerSecond >= 1_048_576 ? 'high'
        : bytesPerSecond >= 131_072 ? 'medium' : 'low';
      const labelText = level === 'measuring' ? 'MEASURING' : level.toUpperCase();
      activityLabel.textContent = labelText;
      activityMeter.dataset.level = level;
      activityMeter.setAttribute('aria-label', `Network activity level: ${labelText.toLowerCase()}`);
    }

    function showPhase() {
      label.textContent = unavailable ? 'Stats unavailable' : phase;
      dot.className = `net-dot ${unavailable || issue ? 'net-dot--warn' : 'net-dot--active'}`;
    }

    async function poll() {
      if (!active || pending) return;
      clearTimeout(timer);
      const request = { generation, controller: new AbortController() };
      pending = request;
      const timeout = setTimeout(() => request.controller.abort(), 5000);
      try {
        const response = await fetch('/net-stats', { cache: 'no-store', signal: request.controller.signal });
        if (!response.ok) throw new Error('Network statistics are unavailable.');
        const sample = await response.json();
        if (!active || request.generation !== generation) return;
        if (![sample.bytes_sent, sample.bytes_recv, sample.sampled_at].every(value =>
          typeof value === 'number' && Number.isFinite(value) && value >= 0)) {
          throw new Error('Invalid network statistics.');
        }
        unavailable = false;
        const seconds = previous ? sample.sampled_at - previous.sampled_at : 0;
        if (!previous || seconds <= 0 || sample.bytes_sent < previous.bytes_sent || sample.bytes_recv < previous.bytes_recv) {
          sent.textContent = received.textContent = 'Measuring…';
          setActivityLevel(null);
          loss.textContent = errors.textContent = '—';
          issue = false;
          lossWrap.classList.remove('net-warn');
          errorsWrap.classList.remove('net-warn');
          detail.textContent = 'Measuring activity on this computer';
        } else {
          const sentBytes = sample.bytes_sent - previous.bytes_sent;
          const receivedBytes = sample.bytes_recv - previous.bytes_recv;
          const dropped = Math.max(0, (sample.packet_loss || 0) - (previous.packet_loss || 0));
          const failed = Math.max(0, (sample.buffer_overflow || 0) - (previous.buffer_overflow || 0));
          totalReceived += receivedBytes;
          sent.textContent = `${size(sentBytes / seconds)}/s`;
          received.textContent = `${size(receivedBytes / seconds)}/s`;
          const selectedBytes = (directions.upload ? sentBytes : 0) + (directions.download ? receivedBytes : 0);
          setActivityLevel(selectedBytes / seconds);
          loss.textContent = String(dropped);
          errors.textContent = String(failed);
          issue = dropped > 0 || failed > 0;
          lossWrap.classList.toggle('net-warn', dropped > 0);
          errorsWrap.classList.toggle('net-warn', failed > 0);
          total.textContent = size(totalReceived);
          detail.textContent = issue ? 'Dropped packets or interface errors detected'
            : sentBytes + receivedBytes > 0 ? 'Live activity on this computer'
            : 'No traffic right now; cached work and local encoding may use no network';
        }
        previous = sample;
        showPhase();
      } catch (error) {
        if (!active || request.generation !== generation) return;
        previous = null;
        unavailable = true;
        sent.textContent = received.textContent = loss.textContent = errors.textContent = '—';
        setActivityLevel(null);
        activityLabel.textContent = 'UNAVAILABLE';
        activityMeter.dataset.level = 'unavailable';
        activityMeter.setAttribute('aria-label', 'Network activity level unavailable');
        lossWrap.classList.remove('net-warn');
        errorsWrap.classList.remove('net-warn');
        detail.textContent = 'Retrying network measurement…';
        showPhase();
      } finally {
        clearTimeout(timeout);
        if (pending === request) pending = null;
        if (active && request.generation === generation) timer = setTimeout(poll, 1000);
      }
    }

    function start(nextPhase = 'Metadata') {
      phase = nextPhase;
      if (active) { showPhase(); return; }
      active = true;
      generation++;
      previous = null;
      totalReceived = 0;
      unavailable = issue = false;
      bar.hidden = false;
      sent.textContent = received.textContent = 'Measuring…';
      setActivityLevel(null);
      loss.textContent = errors.textContent = '—';
      lossWrap.classList.remove('net-warn');
      errorsWrap.classList.remove('net-warn');
      total.textContent = '0 B';
      detail.textContent = 'Measuring activity on this computer';
      showPhase();
      void poll();
    }

    function stop() {
      if (!active) return;
      active = false;
      generation++;
      clearTimeout(timer);
      pending?.controller.abort();
      pending = null;
      previous = null;
      sent.textContent = received.textContent = '0 B/s';
      setActivityLevel(0);
      label.textContent = 'Idle';
      dot.className = 'net-dot';
      detail.textContent = 'No conversion is running';
    }

    const monitor = { start, stop, poll, setDirections };
    activeMonitor = monitor;
    setDirections();
    return monitor;
  }
  return { create, setDirections: directions => activeMonitor?.setDirections(directions) };
})();
