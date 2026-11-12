// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute of #1485 (feedback #010): the seat's guard refuses a head-to-head handout only inside h2hHandoutLeadMs (2 s live), while the
// fix's own measurement says a lock alone takes 2.2-2.7 s at the seats. A handout just outside the lead is taken, the lock is then made (fees spent),
// and the entry lands after the close and is refused - the very state of round 77bd9609. The page's own guard rests on Date.now() of the player's
// machine (no clock correction anywhere in index.html), so a player whose clock runs a few seconds slow is left with only this seat guard.
// Scaled to the fixture's window: lead 1 s, handout about 1.3 s before the close, the order's lock step 1.7 s (live: 2 s lead, 2.2-2.7 s lock).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';   // lockFirst: false - the page's order, handout before any lock (the fixture locks first since #1596)
import { b32 } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { RPS, RPS_CORE_HASH, RPS_CONFIG_HASH, RPS_GAME_ID } from './plugins/rps/index.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE };
const mk = (n) => ({ name: `p${n}`, key: b32(0x70 + n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0], session: ed25519.utils.randomSecretKey() });

test('#1489 refute #1485: a head-to-head handout the seat takes leaves room for the order to land (a lock slower than the lead must not end in a spent lock and a refused entry)', async () => {
  const LEAD = 1000, LOCK_STEP = 1700;
  const w = await lockRound({ stakeMsat: 0n, serveOpts: { plugins: [NEXTBLOCK, RPS], h2hHandoutLeadMs: LEAD }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 25000 });
  const realFetch = globalThis.fetch;
  const seen = [];
  try {
    const close = Number(w.c.entryCloseMs);
    skipTo(Math.max(close - LEAD - 400, Number(w.c.committeeTimeMs) + 20));
    assert.ok(close - testNow() > LEAD, 'outside the lead');
    // the order's steps: the handout now, then the lock takes LOCK_STEP (the clock moves), then the entry
    let moved = false;
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      if (!moved && init && init.method === 'POST' && /\/entry$/.test(new URL(u).pathname)) { moved = true; skipTo(testNow() + LOCK_STEP); }
      const r = await realFetch(url, init);
      if (init && init.method === 'POST') seen.push(`${new URL(u).pathname} ${r.status}`);
      return r;
    };
    let got;
    try { await lockAndPlay(w, mk(1), { session: mk(1).session, hidden: { move: 0, salt: new Uint8Array(randomBytes(32)) }, noMarks: true, only: [], lockFirst: false, feeLock: false }); got = 'taken'; }
    catch (e) { got = String(e.message).split('\n').join(' ').slice(0, 300); }
    console.log('  FACTS (#1489 refute #1485):', JSON.stringify({ seen, got }));
    const handoutTaken = seen.some((s) => /^\/handout 201/.test(s));
    assert.ok(!handoutTaken || got === 'taken', `the seat took the handout ${close - (testNow() - LOCK_STEP)} ms before the close with a ${LEAD} ms lead, the lock step took ${LOCK_STEP} ms and the entry was refused: ${got}`);
  } finally { globalThis.fetch = realFetch; await w.close(); }
});
