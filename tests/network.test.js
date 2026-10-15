'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { page } = require('./ui-fixture');
const tick = () => new Promise(resolve => setImmediate(resolve));
const sample = (sampled_at, bytes_sent, bytes_recv, packet_loss = 0, buffer_overflow = 0) =>
  ({ sampled_at, bytes_sent, bytes_recv, packet_loss, buffer_overflow });

function monitor(samples) {
  const fixture = page(['network.js'], (url, options) => typeof samples === 'function'
    ? samples(url, options) : Response.json(samples.shift()));
  fixture.monitor = fixture.context.NetworkStats.create();
  return fixture;
}

test('network rates use actual elapsed time, show small transfers, and retain received totals', async () => {
  const fixture = monitor([sample(10, 1000, 2000), sample(12, 1200, 6096, 2, 1), sample(13, 1200, 6096, 2, 1)]);
  fixture.monitor.start('Metadata'); await tick();
  assert.equal(fixture.elements.get('#net-recv').textContent, 'Measuring…');
  await fixture.monitor.poll();
  assert.equal(fixture.elements.get('#net-sent').textContent, '100 B/s');
  assert.equal(fixture.elements.get('#net-recv').textContent, '2.0 KB/s');
  assert.equal(fixture.elements.get('#net-total-recv').textContent, '4.0 KB');
  assert.equal(fixture.elements.get('#net-loss').textContent, '2');
  assert.ok(fixture.elements.get('#net-loss-wrap').classList.contains('net-warn'));
  fixture.monitor.start('Converting'); await fixture.monitor.poll();
  assert.equal(fixture.elements.get('#net-status-label').textContent, 'Converting');
  assert.equal(fixture.elements.get('#net-recv').textContent, '0 B/s');
  assert.equal(fixture.elements.get('#net-total-recv').textContent, '4.0 KB');
  assert.match(fixture.elements.get('#net-detail').textContent, /local encoding/);
  assert.ok(!fixture.elements.get('#net-loss-wrap').classList.contains('net-warn'));
  assert.equal(fixture.requests.length, 3, 'Changing phases must reuse the same monitor');
  assert.ok(fixture.requests.every(request => request.options.cache === 'no-store'));
  fixture.monitor.stop();
  assert.equal(fixture.timers.size, 0);
  assert.equal(fixture.elements.get('#net-status-label').textContent, 'Idle');
});

test('unavailable counters show an unavailable state and recover without fabricated zero readings', async () => {
  let count = 0;
  const fixture = monitor(() => ++count === 1 ? Response.json({ error: 'Unavailable' }, { status: 503 })
    : Response.json(sample(count, count * 100, count * 300)));
  fixture.monitor.start('Metadata'); await tick();
  assert.equal(fixture.elements.get('#net-status-label').textContent, 'Stats unavailable');
  assert.equal(fixture.elements.get('#net-recv').textContent, '—');
  await fixture.monitor.poll();
  assert.equal(fixture.elements.get('#net-status-label').textContent, 'Metadata');
  assert.equal(fixture.elements.get('#net-recv').textContent, 'Measuring…');
  await fixture.monitor.poll();
  assert.equal(fixture.elements.get('#net-recv').textContent, '300 B/s');
  fixture.monitor.stop();
});

test('invalid data and adapter counter resets do not produce negative or misleading rates', async () => {
  const fixture = monitor([{ bytes_recv: 100 }, sample(10, 1000, 2000), sample(11, 10, 20), sample(12, 30, 60)]);
  fixture.monitor.start(); await tick();
  assert.equal(fixture.elements.get('#net-recv').textContent, '—');
  await fixture.monitor.poll(); await fixture.monitor.poll();
  assert.equal(fixture.elements.get('#net-recv').textContent, 'Measuring…');
  await fixture.monitor.poll();
  assert.equal(fixture.elements.get('#net-sent').textContent, '20 B/s');
  assert.equal(fixture.elements.get('#net-recv').textContent, '40 B/s');
  assert.equal(fixture.elements.get('#net-total-recv').textContent, '40 B');
  fixture.monitor.stop();
});

test('slow requests never overlap and late responses cannot overwrite a stopped monitor', async () => {
  let release;
  const fixture = monitor(() => new Promise(resolve => { release = resolve; }));
  fixture.monitor.start(); await tick();
  await fixture.monitor.poll(); await fixture.monitor.poll();
  assert.equal(fixture.requests.length, 1);
  fixture.monitor.stop();
  release(Response.json(sample(10, 1000, 2000))); await tick();
  assert.equal(fixture.elements.get('#net-status-label').textContent, 'Idle');
  assert.equal(fixture.elements.get('#net-recv').textContent, '0 B/s');
  assert.equal(fixture.timers.size, 0);
});

test('a stuck request times out and schedules a retry', async () => {
  const fixture = monitor((url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('Timed out')));
  }));
  fixture.monitor.start(); await tick();
  const timeout = [...fixture.timers.values()].find(timer => timer.delay === 5000);
  timeout.callback(); await tick();
  assert.equal(fixture.elements.get('#net-status-label').textContent, 'Stats unavailable');
  assert.ok([...fixture.timers.values()].some(timer => timer.delay === 1000));
  fixture.monitor.stop();
});
