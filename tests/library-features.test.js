'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { page } = require('./ui-fixture');
const tick = () => new Promise(resolve => setImmediate(resolve));
const shelves = { total_tracks: 3, unfiled_tracks: 1, collections: [
  { id: 9, name: 'Weekend playlist', kind: 'playlist', saved_entries: 2, expected_total: 3, saved_tracks: 2 },
  { id: 10, name: 'Complete album', kind: 'album', complete: true, saved_entries: 1, expected_total: 1, saved_tracks: 1 },
] };

test('collection shelves select their tracks and keep search within that collection', async () => {
  const fixture = page(['downloads.js', 'library.js'], url => {
    if (url === '/library/collections') return Response.json(shelves);
    if (url === '/library/readiness') return Response.json({ state: 'idle' });
    return Response.json([{ id: 1, title: 'Song', artist: 'Artist' }]);
  });
  await tick();
  const buttons = fixture.find('.lib-shelf').parent.children;
  assert.equal(buttons.length, 4);
  assert.match(buttons[2].children.at(-1).textContent, /2 of 3 entries saved/);
  assert.match(buttons[3].children.at(-1).textContent, /Complete/);
  await buttons[2].listeners.get('click')();
  await tick();
  assert.equal(fixture.elements.get('#lib-shelf-title').textContent, 'Weekend playlist');
  assert.equal(buttons[2].getAttribute('aria-pressed'), 'true');
  assert.ok(fixture.requests.some(r => r.url === '/library/tracks?collection_id=9'));
  await fixture.context.load('Song');
  assert.equal(fixture.requests.at(-1).url, '/library/tracks?q=Song&collection_id=9');
});

test('the hardware trial polls while running and releases its timer when it finishes', async () => {
  let state = { state: 'running', pct: null, msg: 'Testing CPU' };
  const fixture = page(['downloads.js', 'library.js'], url => {
    if (url === '/library/collections') return Response.json({ total_tracks: 0, collections: [] });
    if (url === '/library/readiness') return Response.json(state);
    return Response.json([]);
  });
  await tick();
  assert.equal(fixture.elements.get('#readiness-run').disabled, true);
  assert.equal(fixture.elements.get('#readiness-cancel').hidden, false);
  const timer = [...fixture.timers.values()].find(t => t.delay === 1000);
  assert.ok(timer);
  state = { state: 'limited', ready: true, msg: 'Test passed; slower CPU', hardware: { physical_cores: 2, total_ram_gb: 8, available_ram_gb: 3 },
    measurement: { wall_seconds: 50, cpu_seconds: 90, peak_ram_gb: 1.2, seconds_per_minute: 375 } };
  await timer.callback();
  assert.equal(fixture.elements.get('#readiness-run').disabled, false);
  assert.equal(fixture.elements.get('#readiness-cancel').hidden, true);
  assert.match(fixture.elements.get('#readiness-result').textContent, /1.20 GB/);
  assert.equal([...fixture.timers.values()].filter(t => t.delay === 1000).length, 0);
});

test('a required readiness test explains the blocked stem and never downloads audio', async () => {
  const fixture = page(['downloads.js', 'library.js'], url => {
    if (url === '/library/collections') return Response.json({ total_tracks: 0, collections: [] });
    if (url === '/library/readiness') return Response.json({ state: 'idle' });
    if (url.endsWith('/separate')) return Response.json({ error: 'Run CPU & RAM test first', readiness_required: true }, { status: 428 });
    return Response.json([]);
  });
  assert.equal(await fixture.context.downloadWithToast('1', 'vocals', true, 'Vocals', 'Song'), false);
  assert.equal(fixture.elements.get('#readiness-run').focused, true);
  assert.equal(fixture.requests.filter(r => r.url.includes('/download')).length, 0);
});

test('a busy test response stays visible and can be retried', async () => {
  const fixture = page(['downloads.js', 'library.js'], (url, options) => {
    if (url === '/library/collections') return Response.json({ total_tracks: 0, collections: [] });
    if (url === '/library/readiness') return options?.method === 'POST'
      ? Response.json({ error: 'Wait for stem preparation to finish' }, { status: 409 }) : Response.json({ state: 'idle' });
    return Response.json([]);
  });
  await tick();
  await fixture.context.readinessAction('POST');
  assert.match(fixture.elements.get('#readiness-status').textContent, /Wait for stem/);
  assert.equal(fixture.elements.get('#readiness-run').disabled, false);
});
