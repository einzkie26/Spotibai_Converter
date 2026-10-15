'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { page } = require('./ui-fixture');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('download notification follows received bytes and completes only after the full file', async () => {
  let controller;
  const response = new Response(new ReadableStream({ start(value) { controller = value; } }), {
    headers: { 'Content-Length': '4', 'Content-Disposition': "attachment; filename*=UTF-8''%E6%AD%8C.mp3" },
  });
  const fixture = page(['downloads.js'], () => response);
  const job = fixture.context.Downloads.download('/library/tracks/1/download');
  await tick(); controller.enqueue(new Uint8Array([1, 2])); await tick();
  const bar = fixture.find('.sep-toast-progress');
  assert.ok(parseFloat(bar.style.width) > 0 && parseFloat(bar.style.width) < 100);
  assert.equal(fixture.clicks.length, 0);
  controller.enqueue(new Uint8Array([3, 4])); controller.close();
  assert.equal(await job, '歌.mp3');
  assert.equal(bar.style.width, '100%');
  assert.equal(fixture.clicks.length, 1);
  assert.equal(fixture.clicks[0].download, '歌.mp3');
  assert.equal(fixture.find('.sep-toast-progress-wrap').getAttribute('aria-valuenow'), '100');
  assert.equal(fixture.revoked.length, 0, 'The browser must have time to open the Blob URL');
});

test('unknown-length transfers show an indeterminate bar until complete', async () => {
  let controller;
  const fixture = page(['downloads.js'], () => new Response(new ReadableStream({ start(value) { controller = value; } })));
  const job = fixture.context.Downloads.download('/file', { fallbackName: 'audio.mp3' });
  await tick();
  assert.ok(fixture.find('.sep-toast-progress').classList.contains('sep-toast-progress--indeterminate'));
  controller.enqueue(new Uint8Array([1, 2])); controller.close(); await job;
  assert.equal(fixture.find('.sep-toast-progress').style.width, '100%');
});

test('failed and truncated transfers never trigger a file download', async () => {
  for (const response of [Response.json({ error: 'File unavailable' }, { status: 503 }),
    new Response(new Uint8Array([1, 2]), { headers: { 'Content-Length': '9' } })]) {
    const fixture = page(['downloads.js'], () => response);
    await assert.rejects(fixture.context.Downloads.download('/file'));
    assert.equal(fixture.clicks.length, 0);
    assert.ok(fixture.find('.sep-toast').classList.contains('sep-toast--error'));
    assert.notEqual(fixture.find('.sep-toast-progress').style.width, '100%');
  }
});

test('dismissing a notification clears its elapsed timer', () => {
  const fixture = page(['downloads.js'], () => null);
  fixture.context.Downloads.createToast('Audio');
  assert.ok([...fixture.timers.values()].some(timer => timer.type === 'interval'));
  fixture.find('.sep-toast-close').listeners.get('click')();
  assert.equal([...fixture.timers.values()].filter(timer => timer.type === 'interval').length, 0);
});
