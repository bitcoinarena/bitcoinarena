// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE NODE'S UPTIME (kanban #756): the four figures off the node's own record (uptime.js) - a fresh node, a gap, a record younger than the
// window ("since"), the 24 h test the draw reads from protocol 22 below and above the line, a restart of seconds that is no outage - and
// GET /uptime, the one door the owner page, the node dashboard and the health page read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import { upWithin, uptimeFigures, inclusionByUptime, createUptime, UPTIME_SLOT_MS, UPTIME_GAP_MS } from '../src/uptime.js';
import { joinedWithLock } from './lock-fixture.js';

const H = 3600000, D = 24 * H, M = 60000;
const NOW = Date.UTC(2026, 9, 28, 12, 0);
const by = (f) => Object.fromEntries(f.windows.map((w) => [w.key, w]));

test('a fresh node: nothing kept, no share, the 24 h not reached - and reached 15 min after its run started', () => {
  const f = uptimeFigures([], NOW);
  assert.equal(f.sinceMs, null);
  for (const w of f.windows) { assert.equal(w.share, null, w.key); assert.equal(w.upMs, 0); assert.equal(w.partial, false); }
  const i = inclusionByUptime([], NOW);
  assert.deepEqual([i.met, i.metAgainAtMs, i.lastMetMs], [false, null, null]);
  // started 5 min ago and running: below the line, reached 10 min from now
  const run = [{ startMs: NOW - 5 * M, endMs: NOW }];
  const j = inclusionByUptime(run, NOW, { runningSinceMs: NOW - 5 * M });
  assert.deepEqual([j.met, j.metAgainAtMs], [false, NOW + 10 * M]);
  const g = by(uptimeFigures(run, NOW));
  assert.equal(g['24h'].share, 1, 'up all the 5 min it kept');
  assert.equal(g['24h'].partial, true); assert.equal(g['24h'].readFromMs, NOW - 5 * M);
  assert.equal(g.all.share, 1); assert.equal(g.all.partial, false);
});

test('a gap: 30 days kept, down 6 h yesterday and 2 days last week - each window its own share', () => {
  const spans = [{ startMs: NOW - 30 * D, endMs: NOW - 6 * D }, { startMs: NOW - 4 * D, endMs: NOW - 20 * H }, { startMs: NOW - 14 * H, endMs: NOW }];
  const f = by(uptimeFigures(spans, NOW));
  assert.equal(f['24h'].upMs, 4 * H + 14 * H); assert.equal(f['24h'].share, 18 / 24); assert.equal(f['24h'].partial, false);
  assert.equal(f['7d'].upMs, 1 * D + (4 * D - 20 * H) + 14 * H); assert.equal(f['7d'].share, f['7d'].upMs / (7 * D));
  assert.equal(f['30d'].share, (24 * D + 90 * H) / (30 * D));
  assert.equal(f.all.ofMs, 30 * D); assert.equal(f.all.share, f['30d'].share);
  assert.equal(upWithin(spans, NOW - D, NOW), 18 * H);
  assert.equal(inclusionByUptime(spans, NOW).met, true, 'ran 14 h without a break today: above the line');
});

test('a record younger than the window: read from its first span, said as "since"', () => {
  const spans = [{ startMs: NOW - 3 * D, endMs: NOW - 2 * D }, { startMs: NOW - D, endMs: NOW }];
  const f = by(uptimeFigures(spans, NOW));
  assert.equal(f['24h'].partial, false); assert.equal(f['24h'].share, 1);
  for (const k of ['7d', '30d']) { assert.equal(f[k].partial, true, k); assert.equal(f[k].readFromMs, NOW - 3 * D); assert.equal(f[k].share, 2 / 3); }
  assert.equal(uptimeFigures(spans, NOW).sinceMs, NOW - 3 * D);
});

test('the 24 h test: short runs only (each under 15 min) are below the line; one unbroken 15 min is enough; it lapses a day later', () => {
  const blips = Array.from({ length: 20 }, (_, k) => ({ startMs: NOW - 20 * H + k * H, endMs: NOW - 20 * H + k * H + 10 * M }));
  const f = by(uptimeFigures(blips, NOW));
  assert.ok(f['24h'].upMs === 200 * M);
  const i = inclusionByUptime(blips, NOW);
  assert.deepEqual([i.met, i.longestRunMs], [false, 10 * M], '200 min up in the day, never 15 in a row: seen at no heartbeat');
  const once = [...blips, { startMs: NOW - 23 * H, endMs: NOW - 23 * H + UPTIME_SLOT_MS }];
  const j = inclusionByUptime(once, NOW);
  assert.deepEqual([j.met, j.lastMetMs, j.lapsesAtMs], [true, NOW - 23 * H + UPTIME_SLOT_MS, NOW + H + UPTIME_SLOT_MS]);
  // a run that ended 25 h ago is outside the window: below again
  assert.equal(inclusionByUptime([{ startMs: NOW - 30 * H, endMs: NOW - 25 * H }], NOW).met, false);
  // a run that started before the window counts only inside it
  assert.equal(inclusionByUptime([{ startMs: NOW - 30 * H, endMs: NOW - D + 10 * M }], NOW).met, false);
});

test('the record in the store: a restart of seconds continues the run, a later start is a new one; ticks move the end', () => {
  const store = openStore(':memory:');
  let now = NOW - 2 * H;
  const u = createUptime({ db: store, nowMs: () => now, tickMs: 0 }).start();
  now += 30 * M; u.tick();
  assert.deepEqual(u.spans(), [{ startMs: NOW - 2 * H, endMs: NOW - 90 * M }]);
  u.stop();
  now += UPTIME_GAP_MS - M;                       // back 2 min later: the same run
  const v = createUptime({ db: store, nowMs: () => now, tickMs: 0 }).start();
  assert.equal(v.spans().length, 1);
  now += 20 * M; v.tick(); v.stop();
  now += H;                                       // down an hour: a new run
  const w = createUptime({ db: store, nowMs: () => now, tickMs: 0, inForce: true, rule: 'r' }).start();
  assert.equal(w.spans().length, 2);
  now += 5 * M;
  const f = w.figures();
  assert.equal(f.runningSinceMs, now - 5 * M, 'the running span counted to now');
  const k = by(f);
  assert.equal(k['24h'].upMs, 52 * M + 5 * M, 'the first run 52 min (a 2-min restart inside it), the second 5 min so far');
  assert.equal(f.inclusion.met, true, 'the first run lasted 50 min unbroken');
  assert.equal(f.inclusion.inForce, true); assert.equal(f.inclusion.rule, 'r');
  // a presence certificate listing the node counts as seen whatever the uptime says
  const fresh = createUptime({ db: openStore(':memory:'), nowMs: () => now, tickMs: 0 }).start();
  assert.equal(fresh.figures().inclusion.met, false);
  assert.equal(fresh.figures().inclusion.metAgainAtMs, now + UPTIME_SLOT_MS);
  assert.equal(fresh.figures({ seen: true }).inclusion.met, true);
  assert.equal(fresh.figures({ seen: true }).inclusion.metAgainAtMs, null);
});

test('GET /uptime: the node\'s key, the four windows, the 24 h test; public, as /dashboard.json is', async () => {
  const s = await joinedWithLock({});
  try {
    const r = await fetch(`http://127.0.0.1:${s.d.port}/uptime`);
    assert.equal(r.status, 200);
    const u = await r.json();
    assert.match(u.node, /^[0-9a-f]{64}$/);
    assert.deepEqual(u.windows.map((w) => w.key), ['24h', '7d', '30d', 'all']);
    assert.ok(u.sinceMs > 0 && u.sinceMs <= Date.now());
    assert.equal(u.windows[0].share, 1, 'up since it started');
    assert.equal(u.inclusion.met, false, 'a node started a moment ago has not run 15 min yet');
    assert.ok(u.inclusion.metAgainAtMs >= u.sinceMs + UPTIME_SLOT_MS - 1000);
    assert.equal(typeof u.inclusion.inForce, 'boolean');
  } finally { await s.d.close(); }
});
