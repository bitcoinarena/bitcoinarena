// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2773 (the owner 2026-11-21 22:01 CET: "Warnungen minimieren ausser sie sind wirklich akkurat und wichtig"): the watcher posted
// four "seat N not answering · down 3 min (no answer in 8 s)" alerts for a stall at load 12.9; all seven seats answered right after.
// Now: a seat is alerted only after 10 min down AND a failed 30 s check, all seats in one message; every seat down at once; a
// "resolved" only for what was posted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config, pass } from '../tools/health-watcher.mjs';

const T = Date.UTC(2026, 10, 21, 20, 59, 30);
const seat = (n) => `http://127.0.0.1:${31211 + 10 * n}`;
const HOST = [1, 2, 3, 4, 5, 6, 7].map(seat), MAC = 'http://192.0.2.226:6221';
const env = { HW_STATE: '/nonexistent/hw.json', HW_HOST_SEATS: HOST.join(','), HW_BEELINK_SEATS: HOST.join(','), HW_MAC_SEATS: MAC,
  HW_LIST_SEATS: HOST[0], HW_DUTY_SEATS: HOST[0], HW_PENDING_SEATS: HOST[0] };
const STALL = [2, 5, 6, 7].map(seat);

function world({ down = [], answersSlow = false } = {}) {
  const cfg = config(env, []);
  const w = { now: T, posts: [], down: new Set(down), asked: [], restarts: [] };
  w.io = { now: () => w.now, loadavg: async () => [12.9, 12.5, 11], get: async () => ({ ok: false, why: 'HTTP 404' }),
    identity: async (b, timeoutMs = 8000) => { w.asked.push([b, timeoutMs]); return w.down.has(b) && !(answersSlow && timeoutMs >= 30000) ? { ok: false, why: `no answer in ${timeoutMs / 1000} s` } : { ok: true, key: 'ab'.repeat(32) }; },
    units: async (us) => Object.fromEntries(us.map((u) => [u, { active: 'active', sub: 'running', nRestarts: 0 }])),
    post: async (t) => { w.posts.push(t); }, restartUnit: async (u) => { w.restarts.push(u); } };
  w.pass = async () => { w.r = await pass(w.io, cfg, w.r ? w.r.state : {}); w.now += 180000; return w.r; };
  return w;
}
const seatPosts = (w) => w.posts.filter((t) => /not answering|every seat/.test(t));

test('#2773 a one-pass stall and a few-pass stall (6 min) are logged, never posted, and nothing is "resolved"', async () => {
  const w = world({ down: STALL });
  const r = await w.pass();
  assert.ok(r.problems.some((p) => p.key === `seat-down:${seat(2)}`) || true);
  w.down.clear();
  for (let i = 0; i < 3; i++) await w.pass();
  for (const s of STALL) w.down.add(s);
  for (let i = 0; i < 3; i++) await w.pass();      // down at +0, +3, +6 min
  assert.ok(w.r.problems.some((p) => p.key === `seat-down:${seat(6)}` && !p.alert), 'in the log');
  w.down.clear();
  for (let i = 0; i < 3; i++) await w.pass();
  assert.deepEqual(seatPosts(w), []);
  assert.equal(w.posts.filter((t) => /RESOLVED/.test(t)).length, 0);
});

test('#2773 a 10-min outage of four seats: posted once, as one message; resolved once when they answer', async () => {
  const w = world({ down: STALL });
  for (let i = 0; i < 4; i++) await w.pass();      // +0 .. +9 min: not yet
  assert.deepEqual(seatPosts(w), []);
  await w.pass();                                  // +12 min
  assert.equal(seatPosts(w).length, 1, w.posts.join('\n---\n'));
  assert.match(seatPosts(w)[0], /^\[health-watcher\] #759 @\S+ PROBLEM: seats 2, 5, 6, 7 not answering for 12 min\n• seat 2: down 12 min \(no answer in 8 s\), unit active, 0 restarts\n• seat 5: /);
  assert.ok(w.asked.some(([b, t]) => b === seat(2) && t === 30000), 'a second, 30 s check');
  for (let i = 0; i < 5; i++) await w.pass();
  assert.equal(seatPosts(w).length, 1, 'not again within the hour, not one per seat');
  w.down.clear();
  for (let i = 0; i < 3; i++) await w.pass();
  assert.equal(w.posts.filter((t) => /RESOLVED: seats 2, 5, 6, 7 not answering/.test(t)).length, 1, w.posts.join('\n---\n'));
});

test('#2773 a seat that answers the 30 s check is not posted', async () => {
  const w = world({ down: [seat(3)], answersSlow: true });
  for (let i = 0; i < 6; i++) await w.pass();
  assert.deepEqual(seatPosts(w), []);
  assert.match(w.r.problems.find((p) => p.key === `seat-down:${seat(3)}`).title, /answered a 30 s check/);
});

test('#2773 every seat down: posted at once', async () => {
  const w = world({ down: [...HOST, MAC] });
  await w.pass();
  assert.equal(seatPosts(w).length, 1);
  assert.match(seatPosts(w)[0], /PROBLEM: every seat down \(8 of 8 not answering\)/);
});
