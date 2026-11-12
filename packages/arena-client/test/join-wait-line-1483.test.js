// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// JOINING IS SAID FROM THE TAP, WITH THE COUNTDOWN (kanban #1483, Daniel 2026-11-11: "When clicking Join sometimes the countdown does not appear,
// only lock messages ('joining the round - stake lock: exchanging at tn4.bitcoin-arena.io/guardian-1') ... Make it more efficient and clear that we
// are in process of joining the round"). Measured on the live page (UI 634): the join's stage was empty for 16-22 s after the tap (Unity: "joining the
// round ..." with no countdown and no step) and the lock's steps showed raw. The lobby join's stage is now always the countdown and a step in words.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const HTML = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
const slice = (from, to) => { const a = HTML.indexOf(from); assert.ok(a > 0, `index.html holds ${from.slice(0, 50)}`); return HTML.slice(a, HTML.indexOf(to, a) + to.length); };
const SRC = slice('      function joinWaitLine(', '        return join;\n      }\n');
const NOW = 1_800_000_000_000;
const make = (win) => new Function('window', 'Date', SRC + '\nreturn { joinWaitLine, sayJoining };')(win, { now: () => win.now });

test('a join with no step yet says the countdown and what it does - never an empty stage', () => {
  const win = { now: NOW, ARENA_TX_STEPS: [] };
  const { sayJoining } = make(win);
  const join = win.ARENA_JOIN = sayJoining({ state: 'joining', stage: '', round: 'r' }, NOW + 45000);
  assert.equal(join.stage, 'round starts in 0:45 · checking the round with the game servers');
  win.now += 1000;
  assert.equal(join.stage, 'round starts in 0:44 · checking the round with the game servers', 'counted each second');
  assert.equal(join.step, '', 'the raw step stays empty: the 600 s cut still reads no named step');
});

test('the lock\'s raw steps read as words with the countdown, and a slow step says how long it takes', () => {
  const win = { now: NOW, ARENA_TX_STEPS: [] };
  const { sayJoining } = make(win);
  const join = win.ARENA_JOIN = sayJoining({ state: 'joining', stage: '', round: 'r' }, NOW + 75000);
  join.stage = 'exchanging at tn4.bitcoin-arena.io/guardian-1';
  assert.equal(join.stage, 'round starts in 1:15 · preparing your sats');
  assert.ok(!/tn4|guardian|stake lock/.test(join.stage));
  win.now += 6000;
  assert.equal(join.stage, 'round starts in 1:09 · preparing your sats (6 s)');
  join.stage = 'locking the stake, the node fee and the donation (submitted, accepted behind)';
  assert.equal(join.stage, 'round starts in 1:09 · locking your stake');
  assert.equal(join.step, 'locking the stake, the node fee and the donation (submitted, accepted behind)');
  join.stage = 'waiting for the test sats to arrive in your wallet';
  assert.match(join.stage, /your test sats are arriving$/);
});

test('a seat read in flight (the order\'s open step) is said too', () => {
  const win = { now: NOW, ARENA_TX_STEPS: [{ step: '-> fetchDonationSet', ms: 1 }, { step: '<- fetchDonationSet', ms: 2 }, { step: '-> claim key', ms: 3 }] };
  const { sayJoining } = make(win);
  const join = win.ARENA_JOIN = sayJoining({ state: 'joining', stage: '', round: 'r' }, NOW + 30000);
  assert.equal(join.stage, 'round starts in 0:30 · checking the round with the game servers');
  win.ARENA_TX_STEPS.push({ step: '-> merge 300 sat first', ms: 4 });
  assert.equal(join.stage, 'round starts in 0:30 · preparing your sats');
});

test('a round already running says so; loaded, refused and picked joins keep their own stage', () => {
  const win = { now: NOW, ARENA_TX_STEPS: [] };
  const { sayJoining } = make(win);
  const late = win.ARENA_JOIN = sayJoining({ state: 'joining', stage: 'locking the stake', round: 'r' }, NOW - 5000);
  assert.equal(late.stage, 'the round is running · locking your stake');
  const j = win.ARENA_JOIN = sayJoining({ state: 'joining', stage: '', round: 'r', next: true }, NOW + 61000);
  assert.equal(j.stage, 'next round starts in 1:01 · checking the round with the game servers');
  j.loaded = true; j.stage = 'next round starts in 1:01';
  assert.equal(j.stage, 'next round starts in 1:01', 'the loaded round\'s own countdown');
  j.loaded = false; j.state = 'refused'; j.stage = '';
  assert.equal(j.stage, '');
  j.state = 'picked'; j.stage = 'move hidden';
  assert.equal(j.stage, 'move hidden');
  assert.equal(JSON.parse(JSON.stringify(j)).stage, 'move hidden', 'the logs read it as a field');
});

test('the order strip says "Order locked" only for a join shown loaded', () => {
  assert.match(HTML, /j\.state === 'joining' && \(j\.loaded \|\| j\.held\) && \/round starts in/);
  // the partial ticker of 31f5b6202 wrote the composed line back into the stage: gone, one writer of the line
  assert.ok(!/const lockTicker = setInterval/.test(HTML));
  assert.match(HTML, /sayJoining\(join, holdUntilMs \|\| Number\(\(r\.raw && r\.raw\.startTimeMs\) \|\| 0\)\);/);
  assert.match(HTML, /if \(join\.step\) return;/);
});
