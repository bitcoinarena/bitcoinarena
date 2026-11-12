// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2043 (#1489 refute 3 of #1485/#1742/#1892, feedback #010): the test opponent's head-to-head order, handout first and the lock only after the
// seats took it with time left on their clock (tools/h2h-order.mjs handoutThenLock), against two real seats (lead 0.9 s, kept 1.35 s).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockRound } from './lock-round-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { RPS, RPS_CORE_HASH, RPS_CONFIG_HASH, RPS_GAME_ID } from './plugins/rps/index.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';
import { feldmanGroup } from '../src/curve.js';
import { dealHandout, encodeHandout } from '../../arena-protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../arena-protocol/src/shares.js';
import { b32 } from './window-fixture.js';
import { randomBytes } from 'node:crypto';
import { handoutThenLock, h2hLeadMs } from '../tools/h2h-order.mjs';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE };
const rand = (n) => new Uint8Array(randomBytes(n));
const scalar = () => { for (;;) { const s = rand(32); const v = scalarFrom32(s); if (v > 0n && v < FIELD) return s; } };

const handoutOf = async (w, k) => {
  const e = rand(32);
  const dealt = await dealHandout({ preimage: scalar(), signerNodes: w.c.nodes, roundId: w.rid, playerPubkey: b32(0x60 + k), ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e),
    coefficients: Array.from({ length: w.needed - 1 }, () => scalarFrom32(rand(32)) % FIELD), needed: w.needed, curve: feldmanGroup });
  assert.equal(dealt.ok, true, dealt.why);
  return encodeHandout(dealt.handout);
};

test('#2043: the bot locks only after the seats took its handout with time left on their clock', async () => {
  const w = await lockRound({ stakeMsat: 0n, serveOpts: { plugins: [NEXTBLOCK, RPS], h2hHandoutLeadMs: 900 }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 25000 });
  const nodes = w.nodes.map((d) => `http://127.0.0.1:${d.port}`);
  const close = Number(w.c.entryCloseMs);
  try {
    let locked = 0;
    const lock = async () => { locked++; return { stake: 'locked' }; };
    const order = async (k, o = {}) => handoutThenLock({ body: await handoutOf(w, k), needed: w.needed, nodes, entryCloseMs: close, leadMs: 1000, lock, ...o });   // the host's own clock (Date.now) runs behind the seats' (testNow), as a slow host's

    // in time: both seats take it, their 201s say how long they still take entries, and the lock runs
    skipTo(close - 3000);
    const a = await order(1);
    console.log('  FACTS (#2043 in time):', JSON.stringify({ ok: a.ok, why: a.why, seatLeftMs: a.put.seatCloseAtMs - Date.now(), ownLeftMs: close - Date.now(), locked }));
    assert.equal(a.ok, true, a.why);
    assert.ok(Number.isFinite(a.put.seatCloseAtMs), 'the seats said how long they still take entries');
    assert.equal(locked, 1);

    // the host's clock runs behind (the fixture's skips): its own reading says plenty, the seats' says under 3 s - with a 2.5 s lead nothing is locked
    skipTo(close - 2400);
    const b = await order(2, { leadMs: 2500 });
    console.log('  FACTS (#2043 slow host clock):', JSON.stringify({ ok: b.ok, why: b.why, locked }));
    assert.equal(b.ok, false);
    assert.match(b.why, /seats' clock/);
    assert.equal(locked, 1, 'no lock for a handout the seats took too late for the lock');

    // the refute's case: 1.0 s left, under the seats' kept 1.35 s - every seat refuses the handout 409 and nothing is locked
    skipTo(close - 1000);
    const c = await order(3);
    console.log('  FACTS (#2043 late):', JSON.stringify({ ok: c.ok, why: c.why, locked }));
    assert.equal(c.ok, false);
    assert.match(c.why, /nothing was locked/);
    assert.equal(locked, 1, 'no lock for a refused handout');
  } finally { await w.close(); }
});

test("#2043: the bot's lead before a lock is the page's rule", () => {
  assert.equal(h2hLeadMs([]), 4000);
  assert.equal(h2hLeadMs([1200, 3100]), 4600);
});
