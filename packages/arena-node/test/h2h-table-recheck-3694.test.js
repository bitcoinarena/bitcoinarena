// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// NO LOCK ON A TABLE THAT FILLED AFTER THE HANDOUT (kanban #3694, bypass audit wf_12229180-099, a check-then-use of #2634 / #1485).
// The full-table check (#2634) and the close lead (#1485) run at POST /handout only. The page posts its handout, then waits for the funding
// (wallet, exchange, deposit invoice: no bound) and asks its pre-lock check, which looked only at the time left (h2hLockRefusal). If the last
// seat of a paid head-to-head table is taken in that gap, the page locks anyway and every seat refuses its entry ("already seats ... 2
// players"): the developers' and reserves' parts of the lock are spent - the #010 loss on a timely tap. The pre-lock check now asks the seats
// again (the handout posted once more: every door check runs on it) and locks nothing when fewer than the threshold still take it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { b32, rand, secretScalar } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { RPS, RPS_CORE_HASH, RPS_CONFIG_HASH, RPS_GAME_ID } from './plugins/rps/index.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';
import { dealHandout, encodeHandout } from '../../arena-protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../arena-protocol/src/shares.js';
import { feldmanGroup } from '../src/curve.js';
import * as join from '../../arena-client/src/join.js';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE };
const ROCK = 0, SCISSORS = 2;
const mk = (n) => ({ name: `p${n}`, key: b32(0x30 + n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });
const salt = () => new Uint8Array(randomBytes(32));

// the page's check right before the lock: the seats asked again where the client has it (#3694), else the time check alone (before #3694)
const preLock = (o) => (typeof join.h2hLockRecheck === 'function'
  ? join.h2hLockRecheck(o)
  : Promise.resolve(join.h2hLockRefusal(o)));

test('#3694: the table fills between the handout and the lock - the page\'s pre-lock check locks nothing', async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS], entryCloseGraceMs: 15000, h2hHandoutLeadMs: 100 }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 25000 });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const nodes = w.nodes.map((d) => `http://127.0.0.1:${d.port}`);
    const needed = w.needed || 2;
    // the page: its handout first, at every seat, while the table is empty (201)
    const e = rand(32);
    const dealt = await dealHandout({ preimage: secretScalar(), signerNodes: w.c.nodes, roundId: w.rid, playerPubkey: b32(0x3f),
      ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e), coefficients: Array.from({ length: needed - 1 }, () => scalarFrom32(rand(32)) % FIELD),
      needed, curve: feldmanGroup });
    assert.equal(dealt.ok, true, dealt.why);
    const stake = { body: encodeHandout(dealt.handout), handout: { needed } };
    const put = await join.postHandout(stake, nodes, { needed });
    assert.equal(put.ok, true, `the handout was refused while the table was empty: ${put.refused}`);
    // ... the funding runs; meanwhile two other players take both seats, stake and fee locked
    await lockAndPlay(w, mk(1), { hidden: { move: ROCK, salt: salt() }, noMarks: true });
    await lockAndPlay(w, mk(2), { hidden: { move: SCISSORS, salt: salt() }, noMarks: true });
    // what a seat answers that handout now: the table is full
    const again = await fetch(`${nodes[0]}/handout`, { method: 'POST', body: stake.body });
    const now = `${again.status} ${(await again.text()).slice(0, 120)}`;
    // the funding is done: the page asks its pre-lock check
    const why = await preLock({ stake, nodes, needed, put, entryCloseMs: w.c.entryCloseMs, leadMs: 0 });
    console.log('#3694 FACTS:', JSON.stringify({ handoutNow: now, preLock: why }));
    assert.match(now, /^409 .*table is full/, 'the precondition: a seat refuses that handout now');
    assert.ok(why, 'the page\'s pre-lock check says lock on a table that filled after its handout - every seat then refuses the entry and the lock\'s fee parts are spent');
    assert.match(String(why), /table is full/);
  } finally { await w.close(); }
});

test('#3694: a table with a seat still free - the pre-lock check lets the lock go', async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS], entryCloseGraceMs: 15000, h2hHandoutLeadMs: 100 }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 25000 });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const nodes = w.nodes.map((d) => `http://127.0.0.1:${d.port}`);
    const needed = w.needed || 2;
    const e = rand(32);
    const dealt = await dealHandout({ preimage: secretScalar(), signerNodes: w.c.nodes, roundId: w.rid, playerPubkey: b32(0x3e),
      ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e), coefficients: Array.from({ length: needed - 1 }, () => scalarFrom32(rand(32)) % FIELD),
      needed, curve: feldmanGroup });
    const stake = { body: encodeHandout(dealt.handout), handout: { needed } };
    const put = await join.postHandout(stake, nodes, { needed });
    assert.equal(put.ok, true);
    await lockAndPlay(w, mk(1), { hidden: { move: ROCK, salt: salt() }, noMarks: true });
    const why = await preLock({ stake, nodes, needed, put, entryCloseMs: w.c.entryCloseMs, leadMs: 0 });
    assert.equal(why, null, `one seat still free, and the pre-lock check refused: ${why}`);
  } finally { await w.close(); }
});
