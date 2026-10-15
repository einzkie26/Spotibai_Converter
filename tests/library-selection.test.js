'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { page } = require('./ui-fixture');
const tick = () => new Promise(resolve => setImmediate(resolve));
const tracks = Array.from({ length: 4 }, (_, index) => ({ id: index + 1, title: `Song ${index + 1}`, artist: 'Artist' }));

async function library(onDelete = () => Response.json({ ok: true })) {
  const fixture = page(['downloads.js', 'library.js'], (url, options) => {
    if (url === '/library/tracks') return Response.json(tracks);
    if (options?.method === 'DELETE') return onDelete(url);
    if (url.includes('/preview')) return new Response('audio');
    if (url.includes('/download')) return new Response('audio');
    throw new Error(`Unexpected request: ${url}`);
  });
  fixture.confirmations = [];
  fixture.context.confirm = message => { fixture.confirmations.push(message); return true; };
  await tick();
  return fixture;
}

const cards = fixture => fixture.body.querySelectorAll('.lib-card');
const checkboxes = fixture => fixture.body.querySelectorAll('.lib-select-checkbox');
const deletes = fixture => fixture.requests.filter(request => request.options?.method === 'DELETE');
const clickCard = (fixture, card) => fixture.elements.get('#lib-grid').listeners.get('click')({ target: card });

test('clicking a card reveals checkboxes, selects that track, and does not remove anything', async () => {
  const fixture = await library();
  assert.ok(checkboxes(fixture).every(checkbox => checkbox.hidden));
  await clickCard(fixture, cards(fixture)[1].querySelector('.lib-cover'));
  assert.ok(checkboxes(fixture).every(checkbox => !checkbox.hidden));
  assert.deepEqual(checkboxes(fixture).map(checkbox => checkbox.checked), [false, true, false, false]);
  assert.ok(cards(fixture)[1].classList.contains('lib-card--selected'));
  assert.equal(fixture.elements.get('#lib-selection-count').textContent, '1 selected');
  assert.equal(fixture.elements.get('#lib-remove-selected').textContent, 'Remove selected (1)');
  assert.equal(deletes(fixture).length, 0);
  await clickCard(fixture, cards(fixture)[1]);
  assert.equal(fixture.elements.get('#lib-remove-selected').disabled, true);
  assert.equal(fixture.elements.get('#lib-selection-bar').hidden, false);
});

test('checkboxes, keyboard selection, select all, and Cancel agree on the selected tracks', async () => {
  const fixture = await library();
  let prevented = false;
  fixture.elements.get('#lib-grid').listeners.get('keydown')({ target: cards(fixture)[0], key: 'Enter', preventDefault() { prevented = true; } });
  assert.ok(prevented);
  const checkbox = checkboxes(fixture)[0];
  checkbox.checked = false;
  await clickCard(fixture, checkbox);
  fixture.elements.get('#lib-grid').listeners.get('change')({ target: checkbox });
  assert.equal(fixture.elements.get('#lib-selection-count').textContent, '0 selected');
  const selectAll = fixture.elements.get('#lib-select-all');
  selectAll.listeners.get('click')();
  assert.ok(checkboxes(fixture).every(item => item.checked));
  assert.equal(selectAll.textContent, 'Deselect all shown');
  selectAll.listeners.get('click')();
  assert.ok(checkboxes(fixture).every(item => !item.checked));
  assert.equal(fixture.elements.get('#lib-remove-selected').disabled, true);
  fixture.elements.get('#lib-selection-cancel').listeners.get('click')();
  assert.ok(checkboxes(fixture).every(item => item.hidden));
  assert.equal(fixture.elements.get('#lib-selection-bar').hidden, true);
});

test('Preview and Download actions leave card selection unchanged', async () => {
  const fixture = await library();
  const first = cards(fixture)[0];
  await clickCard(fixture, first.querySelector('.lib-preview-btn'));
  const preview = first.querySelector('.lib-preview-option');
  await clickCard(fixture, preview);
  const originalDownload = first.querySelectorAll('.lib-dl-option').find(option => !option.classList.contains('lib-preview-option'));
  await clickCard(fixture, originalDownload);
  assert.equal(fixture.elements.get('#lib-selection-bar').hidden, true);
  assert.ok(checkboxes(fixture).every(item => !item.checked && item.hidden));
});

test('removal deletes only selected tracks and retains failed tracks for retry', async () => {
  let fail = true;
  const fixture = await library(url => {
    if (fail && url.endsWith('/3')) return Response.json({ error: 'File is busy' }, { status: 500 });
    if (fail && url.endsWith('/4')) throw new Error('Connection lost');
    return Response.json({ ok: true });
  });
  for (const id of [1, 3, 4]) fixture.context.selectTrack(id);
  assert.equal(await fixture.context.removeSelectedTracks(), false);
  assert.deepEqual(deletes(fixture).map(request => request.url).sort(), ['/library/tracks/1', '/library/tracks/3', '/library/tracks/4']);
  assert.deepEqual(cards(fixture).map(card => Number(card.dataset.id)), [2, 3, 4]);
  assert.deepEqual(checkboxes(fixture).map(item => item.checked), [false, true, true]);
  assert.equal(fixture.elements.get('#lib-selection-count').textContent, '2 selected');
  assert.ok(fixture.find('.sep-toast').classList.contains('sep-toast--error'));
  fail = false;
  assert.equal(await fixture.context.removeSelectedTracks(), true);
  assert.deepEqual(deletes(fixture).slice(3).map(request => request.url).sort(), ['/library/tracks/3', '/library/tracks/4']);
  assert.deepEqual(cards(fixture).map(card => Number(card.dataset.id)), [2]);
  assert.equal(fixture.elements.get('#lib-selection-bar').hidden, true);
});

test('removal waits for server success, blocks duplicate submission, and preserves a cancelled selection', async () => {
  let release;
  const fixture = await library(() => new Promise(resolve => { release = resolve; }));
  fixture.context.selectTrack(1);
  fixture.context.confirm = () => false;
  assert.equal(await fixture.context.removeSelectedTracks(), false);
  assert.equal(deletes(fixture).length, 0);
  assert.equal(checkboxes(fixture)[0].checked, true);
  fixture.context.confirm = () => true;
  const removal = fixture.context.removeSelectedTracks(); await tick();
  assert.equal(cards(fixture).length, 4);
  assert.equal(fixture.elements.get('#lib-remove-selected').disabled, true);
  assert.equal(fixture.elements.get('#lib-search').disabled, true);
  fixture.context.selectTrack(2);
  assert.equal(checkboxes(fixture)[1].checked, false);
  assert.equal(await fixture.context.removeSelectedTracks(), false);
  assert.equal(deletes(fixture).length, 1);
  release(Response.json({ ok: true }));
  assert.equal(await removal, true);
  assert.equal(cards(fixture).length, 3);
  assert.equal(fixture.elements.get('#lib-search').disabled, false);
});

test('removing a playing track stops its preview and removing the last tracks shows the empty library', async () => {
  const fixture = await library();
  await fixture.context.playPreview(1, tracks[0], '');
  const audio = fixture.elements.get('#preview-audio');
  fixture.context.selectTrack(2);
  assert.equal(await fixture.context.removeSelectedTracks(), true);
  assert.equal(audio.paused, false, 'Deleting a different track must preserve playback');
  fixture.context.selectTrack(1);
  fixture.elements.get('#lib-select-all').listeners.get('click')();
  assert.equal(await fixture.context.removeSelectedTracks(), true);
  assert.equal(audio.paused, true);
  assert.equal(audio.src, '');
  assert.equal(fixture.elements.get('#preview-bar').hidden, true);
  assert.equal(cards(fixture).length, 0);
  assert.equal(fixture.elements.get('#lib-count').textContent, '');
  assert.equal(fixture.elements.get('#lib-empty').hidden, false);
  assert.equal(fixture.elements.get('#lib-selection-hint').hidden, true);
});

test('search clears selection so tracks outside the results cannot be removed accidentally', async () => {
  const fixture = await library();
  fixture.context.selectTrack(1);
  fixture.elements.get('#lib-search').listeners.get('input')();
  assert.equal(fixture.elements.get('#lib-selection-bar').hidden, true);
  assert.ok(checkboxes(fixture).every(item => !item.checked && item.hidden));
  fixture.context.render([tracks[2], tracks[3]]);
  await clickCard(fixture, cards(fixture)[0]);
  fixture.elements.get('#lib-select-all').listeners.get('click')();
  assert.equal(await fixture.context.removeSelectedTracks(), true);
  assert.deepEqual(deletes(fixture).map(request => request.url).sort(), ['/library/tracks/3', '/library/tracks/4']);
});
