'use strict';

// A small, page-independent view of conversion jobs. Jobs run on the server,
// so navigating away from the converter does not stop them.
(() => {
  const activeStates = new Set(['queued', 'metadata', 'processing', 'converting', 'packaging']);
  const labels = { queued: 'Queued', metadata: 'Preparing', processing: 'Preparing', converting: 'Converting', packaging: 'Finishing' };
  const widget = document.createElement('aside');
  widget.className = 'live-progress-widget';
  widget.setAttribute('aria-label', 'Live conversion progress');
  widget.hidden = true;

  const header = document.createElement('div');
  header.className = 'live-progress-header';
  const heading = document.createElement('div');
  heading.className = 'live-progress-heading';
  const title = document.createElement('strong');
  title.textContent = 'Conversion in progress';
  const subtitle = document.createElement('span');
  subtitle.textContent = 'Your work continues while you browse';
  heading.append(title, subtitle);
  const toggle = document.createElement('button');
  toggle.className = 'live-progress-toggle';
  toggle.type = 'button';
  toggle.setAttribute('aria-label', 'Collapse conversion progress');
  toggle.setAttribute('aria-expanded', 'true');
  toggle.textContent = '⌄';
  header.append(heading, toggle);

  const body = document.createElement('div');
  body.className = 'live-progress-body';
  const jobsList = document.createElement('div');
  jobsList.className = 'live-progress-jobs';
  const link = document.createElement('a');
  link.href = '/';
  link.className = 'live-progress-link';
  link.textContent = 'Open converter';
  body.append(jobsList, link);
  widget.append(header, body);
  document.body.append(widget);

  let collapsed = localStorage.getItem('spotibai-live-progress-collapsed') === 'true';
  const streams = new Map();
  const jobs = new Map();
  const setCollapsed = value => {
    collapsed = value;
    widget.classList.toggle('is-collapsed', collapsed);
    body.hidden = collapsed;
    toggle.textContent = collapsed ? '⌃' : '⌄';
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', collapsed ? 'Expand conversion progress' : 'Collapse conversion progress');
    localStorage.setItem('spotibai-live-progress-collapsed', String(collapsed));
  };
  toggle.addEventListener('click', () => setCollapsed(!collapsed));
  setCollapsed(collapsed);

  function render() {
    const active = [...jobs.values()].filter(job => activeStates.has(job.state));
    widget.hidden = active.length === 0;
    if (!active.length) return;
    jobsList.replaceChildren();
    active.slice(0, 3).forEach(job => {
      const card = document.createElement('section');
      card.className = 'live-progress-job';
      const row = document.createElement('div');
      row.className = 'live-progress-job-title';
      const name = document.createElement('strong');
      name.textContent = job.name || 'Spotify collection';
      const status = document.createElement('span');
      status.textContent = labels[job.state] || 'Working';
      row.append(name, status);
      const progress = document.createElement('div');
      progress.className = 'live-progress-track';
      progress.setAttribute('role', 'progressbar');
      progress.setAttribute('aria-valuemin', '0');
      progress.setAttribute('aria-valuemax', '100');
      const bar = document.createElement('span');
      const tracks = Array.isArray(job.tracks) ? job.tracks : [];
      const total = Number(job.total || tracks.length || 0);
      const complete = Number(job.completed || tracks.filter(track => ['converted', 'cancelled', 'error'].includes(track.state)).length || 0);
      const calculated = total ? Math.round(tracks.reduce((sum, track) => sum +
        (['converted', 'cancelled', 'error'].includes(track.state) ? 100 : Number(track.progress_pct || 0)), 0) / total) : 0;
      const pct = job.state === 'complete' ? 100 : Math.min(99, calculated);
      bar.style.width = `${pct}%`;
      progress.setAttribute('aria-valuenow', String(pct));
      progress.append(bar);
      const count = document.createElement('div');
      count.className = 'live-progress-count';
      count.textContent = total ? `${complete} of ${total} tracks` : 'Finding tracks…';
      card.append(row, progress, count);
      if (tracks.length) {
        const list = document.createElement('ul');
        list.className = 'live-progress-track-list';
        tracks.slice(0, 4).forEach(track => {
          const item = document.createElement('li');
          const trackName = document.createElement('span');
          trackName.textContent = [track.artist, track.title].filter(Boolean).join(' — ') || 'Track';
          const trackState = document.createElement('small');
          trackState.textContent = track.state === 'converted' ? 'Done' :
            track.state === 'error' ? 'Failed' : track.state === 'cancelled' ? 'Skipped' :
            track.message || labels[track.state] || 'Queued';
          item.append(trackName, trackState);
          list.append(item);
        });
        if (tracks.length > 4) {
          const more = document.createElement('li');
          more.className = 'live-progress-more';
          more.textContent = `and ${tracks.length - 4} more`;
          list.append(more);
        }
        card.append(list);
      }
      jobsList.append(card);
    });
    if (active.length > 3) {
      const more = document.createElement('p');
      more.className = 'live-progress-more-jobs';
      more.textContent = `${active.length - 3} more collections in queue`;
      jobsList.append(more);
    }
  }

  function accept(jobId, update) {
    const job = { ...(jobs.get(jobId) || {}), ...update, job_id: jobId };
    jobs.set(jobId, job);
    if (!activeStates.has(job.state)) {
      streams.get(jobId)?.close();
      streams.delete(jobId);
    } else if (!streams.has(jobId)) {
      const stream = new EventSource(`/convert/${encodeURIComponent(jobId)}/events`);
      streams.set(jobId, stream);
      stream.onmessage = event => {
        try { accept(jobId, JSON.parse(event.data)); } catch { /* ignore malformed event */ }
      };
      stream.onerror = () => { /* EventSource reconnects automatically. */ };
    }
    render();
  }

  async function refresh() {
    try {
      const response = await fetch('/jobs', { cache: 'no-store' });
      if (!response.ok) return;
      const listed = await response.json();
      if (!Array.isArray(listed)) return;
      const seen = new Set();
      listed.forEach(job => {
        if (!job.job_id) return;
        seen.add(job.job_id);
        accept(job.job_id, job);
      });
      for (const jobId of jobs.keys()) {
        if (!seen.has(jobId)) {
          streams.get(jobId)?.close();
          streams.delete(jobId);
          jobs.delete(jobId);
        }
      }
      render();
    } catch { /* A temporary connection issue should not affect the conversion. */ }
  }

  refresh();
  window.setInterval(refresh, 2500);
})();
