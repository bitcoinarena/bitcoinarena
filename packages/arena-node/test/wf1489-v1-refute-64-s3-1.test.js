// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute 3 of #1485/#1742/#1892 (feedback #010), lens: second copies of the head-to-head order. The fix chain guards the page's order
// (index.html: tap guard, pre-handout guard, h2hLockRefusal before lockStake) and the seat's door (takeHandout refuses a head-to-head handout with less
// than ceil(h2hHandoutLeadMs * 1.5) left: 4.05 s live since 8289312b6, 2 s before). The other client that places paid head-to-head orders, the test
// opponent tools/rps-opponent.mjs, was not touched: its enter() makes the stake and fee lock FIRST (lockEntry, submitOnly) and posts the handout AFTER,
// and its only time guards are MIN_LEFT_MS (900 ms) before it starts and 400 ms before the lock. So with 0.9-4.05 s left the bot locks (developers' and
// reserves' parts spent), then every seat refuses its handout 409 and with it the entry - the state of round 77bd9609, now made wider by the fix's own
// longer lead (2 s -> 4.05 s).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { b32 } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { RPS, RPS_CORE_HASH, RPS_CONFIG_HASH, RPS_GAME_ID } from './plugins/rps/index.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE };
const mk = (n) => ({ name: `p${n}`, key: b32(0x70 + n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0], session: ed25519.utils.randomSecretKey() });

const BOT = readFileSync(new URL('../tools/rps-opponent.mjs', import.meta.url), 'utf8');
const START = readFileSync(new URL('../src/node-start.js', import.meta.url), 'utf8');

// the bot's own guards, as its source has them
const botGuards = () => {
  const minLeft = Number((BOT.match(/MIN_LEFT_MS\s*=\s*Number\(env\.MIN_LEFT_MS\s*\|\|\s*(\d+)\)/) || [])[1]);
  const beforeLock = Number((BOT.match(/Number\(c\.entryCloseMs\)\s*-\s*Date\.now\(\)\s*<\s*(\d+)\)\s*return\s*\{\s*ok:\s*false,\s*why:\s*'too late to enter'/) || [])[1]);
  const body = BOT.slice(BOT.indexOf('async function enter('), BOT.indexOf('// A TABLE IS WATCHED'));
  return { minLeft, beforeLock, lockAt: body.indexOf('await lockEntry('), handoutAt: body.indexOf('/handout') };
};

test('#1489 refute 3 #1485: the test opponent makes no head-to-head lock the seats will refuse the handout of', async () => {
  const g = botGuards();
  const liveLead = Number((START.match(/h2hHandoutLeadMs:\s*(\d+)/) || [])[1]);
  const seatKeeps = Math.ceil(liveLead * 3 / 2);   // server.js H2H_HANDOUT_LEAD_MS since 8289312b6
  assert.ok(Number.isFinite(g.minLeft) && Number.isFinite(g.beforeLock) && g.lockAt > 0 && g.handoutAt > 0 && Number.isFinite(liveLead), JSON.stringify({ g, liveLead }));

  // the seat's door, scaled to the fixture (lead 0.9 s, kept 1.35 s of the 1.5 s window): at 1.0 s left the bot's guards (>= 900 and >= 400 ms) let it lock
  const w = await lockRound({ stakeMsat: 0n, serveOpts: { plugins: [NEXTBLOCK, RPS], h2hHandoutLeadMs: 900 }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 25000 });
  let atSeat;
  try {
    const close = Number(w.c.entryCloseMs);
    skipTo(close - 1000);
    const left = close - testNow();
    const botWouldLock = left >= g.minLeft && left >= g.beforeLock;
    try { await lockAndPlay(w, mk(1), { session: mk(1).session, hidden: { move: 0, salt: new Uint8Array(randomBytes(32)) }, noMarks: true, only: [], feeLock: false }); atSeat = 'taken'; }
    catch (e) { atSeat = String(e.message).split('\n').join(' ').slice(0, 200); }
    console.log('  FACTS (#1489 refute 3 #1485):', JSON.stringify({ bot: g, liveLeadMs: liveLead, seatKeepsMs: seatKeeps, fixtureLeftMs: left, botWouldLock, atSeat }));
    // the bot locks before its handout; a lock it makes must be one whose handout and entry the seats take
    const lockFirst = g.lockAt < g.handoutAt;
    assert.ok(!(lockFirst && botWouldLock && atSeat !== 'taken'),
      `rps-opponent locks first (lockEntry before POST /handout) with ${left} ms left (its guards: ${g.minLeft} / ${g.beforeLock} ms), and the seat refused the handout: ${atSeat}`);
  } finally { await w.close(); }
  // and live: the bot's guard before the lock must cover the seat's kept lead
  assert.ok(g.lockAt > g.handoutAt || Math.max(g.minLeft, g.beforeLock) >= seatKeeps,
    `live: the bot locks with ${Math.max(g.minLeft, g.beforeLock)} ms left, the seats refuse a head-to-head handout under ${seatKeeps} ms`);
});
