// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 a44-refute-7-s3 1 (refutes #2225 on the honest path): A LOCK AN HONEST SEAT TOOK BEFORE THE CLOSE IS NO LONGER PULLED BY A SEAT
// THAT MISSED IT. #2225 lets takeEntryParts take a head-to-head lock "new to this seat after the moves can be known" only when at least the
// round's threshold of PEERS serve it. The peers exclude this seat, so in a committee of n with threshold t > n - 1 (2-of-2, every lock-round
// fixture, round-2of2.mjs) no lock missing at one seat at the close can ever be taken - even one every other seat verified before the close.
// The #1588 design (server.js takeEntryParts: "/lock keeps every valid lock; the close fetches what is missing") relied on that pull.
// Scenario: honest B hands both locks to seat 0 just before the entry close; seat 1 was unreachable that moment (or the relay's post landed
// after the close and its door refused it, #1598). Seat 0 plays A vs B, seat 1 plays B against nobody (VOID) and A alone (VOID): no outcome
// gathers the round's threshold, the round never settles, the honest winner B is never paid. The same at 7 seats with t = 5 when the lock
// reached 2..4 seats before the close - a cheap grief for a player whose move is about to lose (no settlement, stake back at expiry).
// Invariant: an honest player's lock verified at a seat before the entry close counts at every seat of the round; the seats agree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { lockRound, lockAndPlay, closeRound, untilSettled } from './lock-round-fixture.js';
import { b32 } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { RPS, RPS_CORE_HASH, RPS_CONFIG_HASH, RPS_GAME_ID } from './plugins/rps/index.js';
import { decodePlayerResult, splitSignedResult } from '../../arena-protocol/src/result.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE };
const SLACK_MS = 25000;
const ROCK = 0, PAPER = 1;
const mk = (n) => ({ name: `p${n}`, key: b32(0x70 + n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });
const salt = () => new Uint8Array(randomBytes(32));
const reveal = async (w, played, move, s) => Promise.all(w.nodes.map(async (d) => {
  const r = await fetch(`http://127.0.0.1:${d.port}/reveal?entry=${toHex(played.eid)}`, { method: 'POST', body: JSON.stringify({ move, salt: toHex(s) }) });
  return r.status;
}));
const signedBy = (w, d, eid) => d.round.results(w.rid, eid).filter((r) => toHex(r.nodePubkey) === toHex(d.round.pubkey))
  .map((r) => { const p = decodePlayerResult(splitSignedResult(r.bytes).body); return `${p.outcome} ${p.score}`; });

test('#1489 a44-refute-7-s3-1: an honest lock seat 0 verified before the close is never taken by seat 1 after it (#2225 vouch threshold > peers)', { timeout: 110000 }, async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS] }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + SLACK_MS });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const sa = salt(), sb = salt();
    const a = await lockAndPlay(w, mk(1), { hidden: { move: ROCK, salt: sa }, noMarks: true });
    // B's entry reaches both seats; both its locks only seat 0 (seat 1 unreachable at that moment), before the entry close
    const b = await lockAndPlay(w, mk(2), { hidden: { move: PAPER, salt: sb }, noMarks: true, only: [0] });
    assert.ok(w.nodes[0].round.stakeSeen(b.eid), 'precondition: seat 0 counted B\'s stake before the close');
    // the close passes before the relay's post (1.5 s after the lock) reaches seat 1: its door refuses a lock new to it from here (#1598)
    skipTo(Number(w.c.entryCloseMs) + 500);
    await reveal(w, a, ROCK, sa);
    await reveal(w, b, PAPER, sb);
    await closeRound(w);
    const settled = await untilSettled(w, 20000);
    const got = w.nodes.map((d) => ({ a: signedBy(w, d, a.eid), b: signedBy(w, d, b.eid), bSeen: !!d.round.stakeSeen(b.eid) }));
    console.log('  FACTS (a44-refute-7-s3-1):', JSON.stringify({ got, state: settled && settled.state, why: settled && settled.why }));
    for (const [i, d] of w.nodes.entries()) {
      assert.deepEqual(signedBy(w, d, b.eid), ['DELIVERED 2'], `seat ${i} did not play the honest winner B whose locks seat 0 verified before the close: ${JSON.stringify(got)}`);
      assert.deepEqual(signedBy(w, d, a.eid), ['FAILED 0'], `seat ${i}: ${JSON.stringify(got)}`);
    }
    assert.equal(settled && settled.state, 'ACCEPTED', `the round never settled - the honest winner is not paid: ${JSON.stringify({ got, settled })}`);
  } finally { await w.close(); }
});
