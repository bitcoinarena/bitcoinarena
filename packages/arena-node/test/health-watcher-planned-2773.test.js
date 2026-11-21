// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2773 (the owner 2026-11-21): planned downtime - a seat roll or restart we do ourselves - is logged "planned: ...", never
// alerted; still down past the window (and its grace) it alerts as usual; an outage nobody planned alerts as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config, pass } from '../tools/health-watcher.mjs';

const T = Date.UTC(2026, 10, 21, 20, 3, 30);   // :03 of a quarter: a seat restart would be allowed
const HOST = 'http://127.0.0.1:31241', MAC2 = 'http://192.0.2.226:6231', MAC3 = 'http://192.0.2.226:6241';
const env = { HW_STATE: '/nonexistent/hw.json', HW_HOST_SEATS: HOST, HW_BEELINK_SEATS: HOST, HW_MAC_SEATS: `${MAC2},${MAC3}`, HW_SEAT_DOWN_ALERT_MIN: '0',
  HW_LIST_SEATS: HOST, HW_DUTY_SEATS: HOST, HW_PENDING_SEATS: HOST };

function watcher({ down = [], planned = [], rolls = [] } = {}) {
  const cfg = config(env, []);
  const w = { now: T, posts: [], planned, rolls, down };
  w.io = { now: () => w.now, loadavg: async () => [1, 1, 1], get: async () => ({ ok: false, why: 'HTTP 404' }),
    identity: async (b) => (w.down.includes(b) ? { ok: false, why: 'no answer in 8 s' } : { ok: true, key: 'ab'.repeat(32) }),
    units: async (us) => Object.fromEntries(us.map((u) => [u, { active: 'active', sub: 'running', nRestarts: 0 }])),
    post: async (t) => { w.posts.push(t); }, restartUnit: async () => { throw new Error('the watcher restarted a planned seat'); },
    planned: async () => w.planned, rolls: async () => w.rolls };
  w.pass = async () => { w.r = await pass(w.io, cfg, w.r ? w.r.state : {}); w.now += 180000; return w.r; };
  return w;
}
const prob = (r, key) => r.problems.find((p) => p.key === key);

test('#2773 an announced seat window: "planned: ..." in the log, no alert; still down past the window + grace: alerted', async () => {
  const w = watcher({ down: [MAC2], planned: [{ what: 'fed2 seat 2', fromMs: T - 60000, untilMs: T + 9 * 60000, why: 'roll #2986' }] });
  for (let i = 0; i < 3; i++) await w.pass();
  const p = prob(w.r, `seat-down:${MAC2}`);
  assert.ok(p, 'the seat is still seen down');
  assert.equal(p.alert, false);
  assert.match(p.title, /^planned: .* \(fed2 seat 2, roll #2986, until 20:12 UTC\)$/);
  assert.equal(w.posts.filter((t) => t.includes('6231') || /seat 2 not answering/.test(t)).length, 0);
  // 20:12 + 5 min grace: the passes after 20:17 alert as usual
  for (let i = 0; i < 3; i++) await w.pass();
  assert.ok(w.now - 180000 > T + 14 * 60000);
  assert.equal(prob(w.r, `seat-down:${MAC2}`).alert, true);
  assert.ok(w.posts.some((t) => /PROBLEM: .*seat 2 not answering/.test(t)), w.posts.join('\n'));
});

test('#2773 an outage nobody planned still alerts, beside a planned one', async () => {
  const w = watcher({ down: [MAC2, MAC3], planned: [{ what: 'fed2 seat 2', fromMs: T, untilMs: T + 60 * 60000 }] });
  for (let i = 0; i < 2; i++) await w.pass();
  assert.equal(prob(w.r, `seat-down:${MAC2}`).alert, false);
  assert.equal(prob(w.r, `seat-down:${MAC3}`).alert, true);
  assert.ok(w.posts.some((t) => /PROBLEM: .*seat 3 not answering/.test(t)));
});

test('#2773 a roll running is planned by itself: its seat is not restarted by the watcher, "seats"-wide problems not alerted', async () => {
  const w = watcher({ down: [HOST], rolls: ['roll-2986.sh'] });
  for (let i = 0; i < 3; i++) await w.pass();
  const p = prob(w.r, `seat-down:${HOST}`);
  assert.equal(p.alert, false); assert.match(p.title, /^planned: .*running: roll-2986\.sh/);
  const fx = w.r.fixes.find((x) => x.kind === 'restart-seat');
  assert.ok(fx && !fx.allowed && fx.blocked.includes('planned downtime'));
  for (const k of ['duty-unread', 'rounds-unread']) { const q = prob(w.r, k); if (q) assert.equal(q.alert, false, k); }
  assert.equal(w.posts.length, 0, w.posts.join('\n'));
});

test('#2773 the helper writes the file the watcher reads; the roll detector reads units and processes', async () => {
  const { command } = await import('../tools/planned-downtime.mjs');
  const { rollsIn, openWindows } = await import('../tools/health-watcher-planned.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'pd2773-')), e = { HW_PLANNED_DOWNTIME: join(dir, 'planned-downtime.json'), USER: 'ops' };
  assert.match(command(['add', 'seat 3', '15', 'roll', '#2986'], { env: e, nowMs: T }), /^planned: seat 3 until 2026-11-21T20:18:30.000Z \(roll #2986\)/);
  const list = JSON.parse(readFileSync(e.HW_PLANNED_DOWNTIME, 'utf8'));
  assert.deepEqual(list.map((x) => [x.what, x.untilMs - x.fromMs, x.why]), [['seat 3', 15 * 60000, 'roll #2986']]);
  assert.equal(openWindows(list, T + 19 * 60000).length, 1);
  assert.equal(openWindows(list, T + 21 * 60000).length, 0, 'past the 5 min grace');
  assert.match(command(['end', 'seat 3'], { env: e, nowMs: T + 60000 }), /ended 1/);
  assert.equal(command(['list'], { env: e, nowMs: T + 120000 }), 'no planned downtime open');
  assert.throws(() => command(['add', 'seat 3', '0'], { env: e }));
  assert.deepEqual(rollsIn('roll-seats.service loaded active running roll\narena-health-watcher.service loaded active running x\n',
    '4242 /bin/bash /home/x/ops/roll-2986.sh\n4243 node tools/health-watcher.mjs\n4244 bash restart-seat3.sh now\n'), ['roll-seats.service', 'roll-2986.sh', 'restart-seat3.sh']);
});
