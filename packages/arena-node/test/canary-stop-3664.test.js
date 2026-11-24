// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE CANARY'S HARD STOP CLOSES THE BROWSER BEFORE IT EXITS (kanban #3664): the 16:57Z run hit its 7-min stop while the page was collecting
// into the player wallet; process.exit killed Chrome, and the wallet's last storage writes (Chrome commits localStorage a few seconds
// late) were lost. The next run (17:34Z) locked a note the federation had already counted spent - the lock was refused, the round VOID.
// The stop now closes the browser (a clean shutdown writes storage out), capped, and only then exits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeThenExit } from '../tools/canary/canary-stop.mjs';

test('#3664 the hard stop waits for the browser to close before it exits', async () => {
  const seen = [];
  const ctx = { close: () => new Promise((r) => setTimeout(() => { seen.push('closed'); r(); }, 50)) };
  await closeThenExit(ctx, () => seen.push('exit'), 5000);
  assert.deepEqual(seen, ['closed', 'exit']);
});

test('#3664 a browser that never closes does not hold the exit past the cap', async () => {
  const seen = [], t0 = Date.now();
  await closeThenExit({ close: () => new Promise(() => {}) }, () => seen.push('exit'), 100);
  assert.deepEqual(seen, ['exit']);
  assert.ok(Date.now() - t0 < 2000);
});

test('#3664 no browser yet, or a close that throws: it still exits', async () => {
  const seen = [];
  await closeThenExit(null, () => seen.push('a'), 100);
  await closeThenExit({ close: () => Promise.reject(new Error('gone')) }, () => seen.push('b'), 100);
  await closeThenExit({ close: () => { throw new Error('sync'); } }, () => seen.push('c'), 100);
  assert.deepEqual(seen, ['a', 'b', 'c']);
});
