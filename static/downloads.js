'use strict';

// Shared notifications for library files, converted tracks, and ZIP downloads.
globalThis.Downloads = (() => {
  function createToast(titleText) {
    let container = document.querySelector('#sep-toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'sep-toast-container';
      container.setAttribute('aria-live', 'polite');
      document.body.append(container);
    }
    const toast = document.createElement('div');
    toast.className = 'sep-toast';
    const header = document.createElement('div');
    header.className = 'sep-toast-header';
    const dot = document.createElement('span');
    dot.className = 'sep-toast-dot sep-toast-dot--running';
    const title = document.createElement('span');
    title.className = 'sep-toast-title';
    title.textContent = titleText;
    title.title = titleText;
    const elapsed = document.createElement('span');
    elapsed.className = 'sep-toast-elapsed';
    elapsed.textContent = '0s';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'sep-toast-close';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Dismiss notification');
    header.append(dot, title, elapsed, close);
    const progress = document.createElement('div');
    progress.className = 'sep-toast-progress-wrap';
    progress.setAttribute('role', 'progressbar');
    progress.setAttribute('aria-label', titleText);
    progress.setAttribute('aria-valuemin', '0');
    progress.setAttribute('aria-valuemax', '100');
    const bar = document.createElement('div');
    bar.className = 'sep-toast-progress';
    progress.append(bar);
    const details = document.createElement('div');
    details.className = 'sep-toast-detail';
    const percent = document.createElement('span');
    percent.className = 'sep-toast-percent';
    const status = document.createElement('span');
    status.className = 'sep-toast-status';
    details.append(status, percent);
    const log = document.createElement('div');
    log.className = 'sep-toast-log';
    toast.append(header, details, progress, log);
    container.append(toast);
    const started = Date.now();
    const timer = setInterval(() => { elapsed.textContent = `${Math.floor((Date.now() - started) / 1000)}s`; }, 1000);
    let terminal = false;
    let current = 0;
    let lastMessage = '';
    close.addEventListener('click', () => { clearInterval(timer); toast.remove(); });

    function setProgress(value) {
      const unknown = value == null;
      bar.classList.toggle('sep-toast-progress--indeterminate', unknown);
      if (unknown) {
        progress.removeAttribute('aria-valuenow');
        progress.setAttribute('aria-valuetext', 'In progress');
        percent.textContent = '';
      } else {
        current = Math.max(current, Math.min(100, Math.max(0, Number(value) || 0)));
        bar.style.width = `${current}%`;
        percent.textContent = `${Math.floor(current)}%`;
        progress.setAttribute('aria-valuenow', String(Math.floor(current)));
        progress.removeAttribute('aria-valuetext');
      }
    }
    function setStatus(message) {
      status.textContent = message;
      if (!message || message === lastMessage) return;
      lastMessage = message;
      const line = document.createElement('div');
      line.className = 'sep-toast-line';
      line.textContent = message;
      log.append(line);
      while (log.children.length > 5) log.children[0].remove();
      log.scrollTop = log.scrollHeight;
    }
    function finish(ok, message) {
      if (terminal) return;
      terminal = true;
      clearInterval(timer);
      dot.className = `sep-toast-dot sep-toast-dot--${ok ? 'done' : 'error'}`;
      toast.classList.add(ok ? 'sep-toast--done' : 'sep-toast--error');
      if (ok) setProgress(100);
      else bar.classList.remove('sep-toast-progress--indeterminate');
      setStatus(message);
      setTimeout(() => toast.remove(), ok ? 6000 : 12000);
    }
    setProgress(null);
    return { element: toast, setProgress, setStatus, finish };
  }

  function filename(headers, fallback) {
    const custom = headers.get('X-Download-Name');
    const disposition = headers.get('Content-Disposition') || '';
    const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
    const quoted = disposition.match(/filename="([^"]+)"/i)?.[1];
    const plain = disposition.match(/filename=([^;]+)/i)?.[1];
    const value = custom || encoded || quoted || plain || fallback;
    if (custom || encoded) {
      try { return decodeURIComponent(value); } catch {}
    }
    return value.trim();
  }

  async function download(url, { toast = createToast('Download'), start = 0, fallbackName = 'track' } = {}) {
    try {
      toast.setStatus('Downloading file');
      const response = await fetch(url);
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error || 'The download could not be started.');
      }
      const total = Number(response.headers.get('Content-Length')) || 0;
      const reader = response.body?.getReader?.();
      let blob;
      if (reader) {
        const chunks = [];
        let received = 0;
        let lastPercent = -1;
        toast.setProgress(total ? start : null);
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            received += value.byteLength;
            if (total) {
              const pct = Math.min(99, Math.floor(start + received / total * (99 - start)));
              if (pct !== lastPercent) { toast.setProgress(pct); lastPercent = pct; }
            }
          }
          if (total && !response.headers.get('Content-Encoding') && received !== total) {
            throw new Error('The file transfer was interrupted. Please try again.');
          }
          blob = new Blob(chunks, { type: response.headers.get('Content-Type') || 'application/octet-stream' });
        } catch (error) {
          await reader.cancel().catch(() => {});
          throw error;
        } finally { reader.releaseLock(); }
      } else {
        toast.setProgress(null);
        blob = await response.blob();
      }
      if (!blob.size) throw new Error('The downloaded file was empty.');
      const name = filename(response.headers, fallbackName);
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = name;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 5000);
      toast.finish(true, `Download ready: ${name}`);
      return name;
    } catch (error) {
      toast.finish(false, error.message || 'Download failed.');
      throw error;
    }
  }
  return { createToast, download, filename };
})();
