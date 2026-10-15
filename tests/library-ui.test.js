'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { page } = require('./ui-fixture');
const tick = () => new Promise(resolve => setImmediate(resolve));

function library(previewHandler = () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'audio/mpeg' } })) {
  return page(['downloads.js', 'library.js'], (url, options) => {
    if (url === '/library/tracks') return Response.json([]);
    if (url.endsWith('/separate')) return Response.json({ sep_id: 'shared-job' }, { status: 202 });
    if (url.endsWith('/status')) return Response.json({ state: 'error', msg: 'Separation unavailable' });
    if (url.includes('/preview')) return previewHandler(url, options);
    if (url.includes('/download')) return new Response(new Uint8Array([1, 2, 3, 4]), {
      headers: { 'Content-Length': '4', 'Content-Disposition': 'attachment; filename="Song (Vocals).mp3"' },
    });
    throw new Error(`Unexpected request: ${url}`);
  });
}

test('a failed separation stops before requesting any audio', async () => {
  const fixture = library();
  const job = fixture.context.downloadWithToast('1', 'vocals', true, 'Vocals', 'Song');
  await tick();
  fixture.events[0].onmessage({ data: JSON.stringify({ state: 'error', msg: 'Model failed', pct: 20 }) });
  assert.equal(await job, false);
  assert.equal(fixture.clicks.length, 0);
  assert.equal(fixture.requests.filter(request => request.url.includes('/download')).length, 0);
  assert.ok(fixture.find('.sep-toast').classList.contains('sep-toast--error'));
});

test('duplicate clicks share one preparation, notification, and transfer', async () => {
  const fixture = library();
  const first = fixture.context.downloadWithToast('1', 'vocals', true, 'Vocals', 'Song');
  const second = fixture.context.downloadWithToast('1', 'vocals', true, 'Vocals', 'Song');
  assert.equal(first, second);
  await tick();
  fixture.events[0].onmessage({ data: JSON.stringify({ state: 'running', msg: 'Separating', pct: 50 }) });
  assert.equal(fixture.clicks.length, 0);
  fixture.events[0].onmessage({ data: JSON.stringify({ state: 'done', msg: 'Ready', pct: 100 }) });
  assert.equal(await first, true);
  assert.equal(fixture.clicks.length, 1);
  assert.equal(fixture.requests.filter(request => request.url.endsWith('/separate')).length, 1);
  assert.equal(fixture.requests.filter(request => request.options?.method === 'HEAD').length, 0);
  assert.equal(fixture.find('.sep-toast-progress').style.width, '100%');
});

test('lost progress connections fall back to status without downloading a failed stem', async () => {
  const fixture = library();
  const job = fixture.context.downloadWithToast('1', 'instrumental', true, 'Instrumental', 'Song');
  await tick(); fixture.events[0].onerror();
  assert.equal(await job, false);
  assert.ok(fixture.requests.some(request => request.url.endsWith('/status')));
  assert.equal(fixture.clicks.length, 0);
});

test('original library downloads skip separation entirely', async () => {
  const fixture = library();
  assert.equal(await fixture.context.downloadWithToast('1', '', false, 'Original', 'Song'), true);
  assert.equal(fixture.events.length, 0);
  assert.equal(fixture.requests.filter(request => request.url.endsWith('/separate')).length, 0);
  assert.equal(fixture.clicks.length, 1);
});

const track = { id: 1, title: 'Song', artist: 'Artist' };

test('library menus elevate only the open card and restore focus on Escape', async () => {
  const fixture = library(); await tick();
  fixture.context.render([track, { ...track, id: 2 }]);
  const cards = fixture.body.querySelectorAll('.lib-card');
  const click = { stopPropagation() {} };
  const first = cards[0].querySelector('.lib-dl-btn');
  first.listeners.get('click')(click);
  assert.ok(cards[0].classList.contains('lib-card--menu-open'));
  assert.equal(first.getAttribute('aria-expanded'), 'true');
  const second = cards[1].querySelector('.lib-preview-btn');
  second.listeners.get('click')(click);
  assert.equal(first.getAttribute('aria-expanded'), 'false');
  assert.ok(!cards[0].classList.contains('lib-card--menu-open'));
  assert.ok(cards[1].classList.contains('lib-card--menu-open'));
  assert.equal(fixture.body.querySelectorAll('.lib-dl-menu').filter(menu => !menu.hidden).length, 1);
  fixture.documentListeners.get('keydown')({ key: 'Escape' });
  assert.ok(second.focused);
  assert.equal(fixture.body.querySelectorAll('.lib-card--menu-open').length, 0);
  first.listeners.get('click')(click);
  fixture.documentListeners.get('click')({ target: fixture.body });
  assert.equal(first.getAttribute('aria-expanded'), 'false');
  assert.equal(fixture.body.querySelectorAll('.lib-card--menu-open').length, 0);
});

test('a library preview option plays the selected prepared stem without downloading or separating it', async () => {
  const fixture = library(); await tick(); fixture.context.render([track]);
  const vocalOption = fixture.body.querySelectorAll('.lib-preview-option').find(option => option.dataset.stem === 'vocals');
  await fixture.elements.get('#lib-grid').listeners.get('click')({ target: vocalOption });
  const audio = fixture.elements.get('#preview-audio');
  assert.equal(audio.paused, false);
  assert.equal(fixture.elements.get('#preview-source').value, 'vocals');
  assert.equal(fixture.elements.get('#preview-toggle').getAttribute('aria-label'), 'Pause preview');
  assert.ok(fixture.requests.some(request => request.url === '/library/tracks/1/preview?stem=vocals'));
  assert.equal(fixture.events.length, 0);
  assert.equal(fixture.clicks.length, 0);
  await fixture.context.playPreview(1, track, 'vocals');
  assert.equal(audio.paused, true);
  assert.equal(fixture.elements.get('#preview-toggle').getAttribute('aria-label'), 'Play preview');
  await fixture.context.playPreview(1, track, 'vocals');
  assert.equal(audio.paused, false);
  assert.equal(fixture.requests.filter(request => request.url.includes('/preview')).length, 1);
  await fixture.context.playPreview(1, track, 'instrumental');
  assert.ok(fixture.requests.some(request => request.url === '/library/tracks/1/preview?stem=instrumental'));
  assert.equal(fixture.revoked.length, 1);
  fixture.context.stopPreview();
  assert.equal(audio.paused, true);
  assert.equal(audio.src, '');
  assert.equal(fixture.revoked.length, 2);
});

test('an unprepared preview shows progress, then plays only after its stem is ready', async () => {
  let prepared = false;
  const fixture = library(() => prepared ? new Response('audio') : Response.json({ needs_preparation: true }, { status: 409 }));
  const job = fixture.context.playPreview(1, track, 'instrumental'); await tick();
  const audio = fixture.elements.get('#preview-audio');
  assert.equal(audio.playedSources.length, 0);
  assert.equal(fixture.elements.get('#preview-toggle').disabled, true);
  fixture.events[0].onmessage({ data: JSON.stringify({ state: 'running', pct: 50, msg: 'Separating' }) });
  assert.equal(fixture.find('.sep-toast-progress').style.width, '45%');
  prepared = true;
  fixture.events[0].onmessage({ data: JSON.stringify({ state: 'done', pct: 100, msg: 'Ready' }) });
  assert.equal(await job, true);
  assert.equal(audio.playedSources.length, 1);
  assert.equal(fixture.clicks.length, 0);
  assert.equal(fixture.find('.sep-toast-progress').style.width, '100%');
});

test('switching away from a preparing stem prevents its late completion from interrupting playback', async () => {
  const fixture = library(url => url.includes('vocals') ? Response.json({}, { status: 409 }) : new Response('instrumental'));
  const old = fixture.context.playPreview(1, track, 'vocals'); await tick();
  await fixture.context.playPreview(1, track, 'instrumental');
  const audio = fixture.elements.get('#preview-audio'); const selected = audio.src;
  fixture.events[0].onmessage({ data: JSON.stringify({ state: 'done', pct: 100 }) });
  assert.equal(await old, false);
  assert.equal(audio.src, selected);
  assert.equal(audio.playedSources.length, 1);
  assert.equal(fixture.elements.get('#preview-source').value, 'instrumental');
  assert.equal(fixture.requests.filter(request => request.url.includes('/preview?stem=vocals')).length, 1);
});

test('closing a preparing preview prevents late autoplay', async () => {
  const fixture = library(() => Response.json({}, { status: 409 }));
  const job = fixture.context.playPreview(1, track, 'vocals'); await tick(); fixture.context.stopPreview();
  fixture.events[0].onmessage({ data: JSON.stringify({ state: 'done', pct: 100 }) });
  assert.equal(await job, false);
  assert.equal(fixture.elements.get('#preview-audio').playedSources.length, 0);
  assert.equal(fixture.elements.get('#preview-bar').hidden, true);
});

test('a failed preview stays retryable and a blocked autoplay keeps the prepared audio ready for Play', async () => {
  let available = false;
  const fixture = library(() => available ? new Response('audio') : Response.json({ error: 'Preview unavailable' }, { status: 500 }));
  assert.equal(await fixture.context.playPreview(1, track, 'vocals'), false);
  assert.equal(fixture.elements.get('#preview-toggle').getAttribute('aria-label'), 'Retry preview');
  available = true;
  const audio = fixture.elements.get('#preview-audio');
  const play = audio.play.bind(audio);
  audio.play = async () => { const error = new Error('User gesture required'); error.name = 'NotAllowedError'; throw error; };
  assert.equal(await fixture.context.playPreview(1, track, 'vocals'), false);
  assert.equal(fixture.elements.get('#preview-status').textContent, 'Ready — press Play');
  assert.equal(fixture.elements.get('#preview-toggle').getAttribute('aria-label'), 'Play preview');
  audio.play = play;
  assert.equal(await fixture.context.playPreview(1, track, 'vocals'), true);
  assert.equal(fixture.requests.filter(request => request.url.includes('/preview')).length, 2);
});

test('preview and download for the same unprepared stem share one preparation request', async () => {
  let prepared = false;
  const fixture = library(() => prepared ? new Response('audio') : Response.json({}, { status: 409 }));
  const preview = fixture.context.playPreview(1, track, 'vocals'); await tick();
  const download = fixture.context.downloadWithToast('1', 'vocals', true, 'Vocals', 'Song'); await tick();
  assert.equal(fixture.events.length, 1);
  assert.equal(fixture.requests.filter(request => request.url.endsWith('/separate')).length, 1);
  prepared = true;
  fixture.events[0].onmessage({ data: JSON.stringify({ state: 'done', pct: 100 }) });
  assert.equal(await preview, true);
  assert.equal(await download, true);
  assert.equal(fixture.clicks.length, 1);
});
