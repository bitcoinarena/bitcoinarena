// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 sm1-find-entry 2 (state machine audit, entry): THE PLAYER WHO LOSES THE RACE FOR THE LAST SEAT HAS NO WAY BACK BUT EXPIRY.
// A paying head-to-head round (Rock Paper Scissors, 2 players) takes entries at the door before any lock (kanban #1437) and seats only
// lock-backed ones; the lock that would seat a third player is refused at /lock ("already seats"). Two honest players who both saw one seat
// free and both locked (the on-demand pairing, two tabs, a reload) reach exactly this: the slower one's entry stands at every seat, his
// money is in the federation, and his /lock is refused. Then:
//  - GET /forfeit for his entry refuses: "this signer node verified no stake lock for that entry";
//  - POST /refused-lock - the return door for a lock that entered nothing (open once the entries closed) - refuses too:
//    "that player entered the round at this signer node: the stake is settled with the round" - but the round never settles it.
// His stake waits for the lock's expiry (144 blocks live, about a day), on a lock every seat refused.
// Invariant: a lock every seat refused for an entry they hold has a return path before its expiry (the refused-lock door or the forfeit).
// SINCE #1588 (merged with this fix in #1489): /lock no longer refuses the lock that would seat one player more - every valid lock is kept, and the
// seats are the game's players in the order their ENTRIES came. So in this race the third player's lock is taken, he is seated (his entry came
// first), and the player whose entry came last is left outside the seats with his lock held, signed VOID and never claimed. The invariant is the
// same: that lock comes back before its expiry - by GET /forfeit, once the seat's settlement is ACCEPTED without claiming it (forfeit.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { lockRound, lockAndPlay, closeRound, untilSettled } from './lock-round-fixture.js';
import { b32 } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { RPS, RPS_CORE_HASH, RPS_CONFIG_HASH, RPS_GAME_ID } from './plugins/rps/index.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';
import { lockFieldsToJson } from '../src/stake-lock-signer-node.js';
import { toHex, sha256 } from '../../arena-protocol/src/hash.js';
import { refundKeyOf } from '../../arena-protocol/src/stake-lock.js';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE };
const ROCK = 0, PAPER = 1, SCISSORS = 2;
const GRACE = 60000;
const mk = (n) => ({ name: `p${n}`, key: b32(0x50 + n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });
const salt = () => new Uint8Array(randomBytes(32));

const reveal = async (w, played, move, s) => Promise.all(w.nodes.map(async (d) => {
  const r = await fetch(`http://127.0.0.1:${d.port}/reveal?entry=${toHex(played.eid)}`, { method: 'POST', body: JSON.stringify({ move, salt: toHex(s) }) });
  return r.status;
}));
const seated = (w) => w.nodes.map((d) => d.round.seatedEntriesOf(w.rid, w.c.stakeMsat).map(({ entryId }) => toHex(entryId).slice(0, 8)).sort());

test('#1489 sm1-entry-2 a stake lock that seats nobody in a head-to-head round comes back before its expiry', { timeout: 120000 }, async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS], unenteredGraceMs: GRACE }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 25000 });
  const base = (d) => `http://127.0.0.1:${d.port}`;
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const s1 = salt(), s2 = salt(), s3 = salt();
    // the third player's entry lands first, while every seat looks free (the door counts only lock-backed entries)
    const c = await lockAndPlay(w, mk(3), { hidden: { move: PAPER, salt: s3 }, noMarks: true, only: [] });
    // the two others enter and lock
    const a = await lockAndPlay(w, mk(1), { hidden: { move: ROCK, salt: s1 }, noMarks: true });
    const b = await lockAndPlay(w, mk(2), { hidden: { move: SCISSORS, salt: s2 }, noMarks: true });
    // now the third player's lock: kept at every seat (#1588); the seats are the two lowest entry ids of the three (kanban #2538)
    const feeOf = (p, who) => ({ paymentImage: { kind: 'hash', bytes: sha256(p.entry.feePreimage) }, amountMsat: p.entry.feeMsat, claimPk: w.claimPk,
      refundPk: refundKeyOf(who.key), expiration: p.fields.expiration });
    await w.port.put(c.feeOutpoint, feeOf(c, mk(3)));
    const lockAns = [];
    for (const d of w.nodes) {
      const r = await fetch(`${base(d)}/lock?entry=${toHex(c.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(c.fields)) });
      const f = await fetch(`${base(d)}/fee-lock?entry=${toHex(c.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(feeOf(c, mk(3)))) });
      lockAns.push([r.status, (await r.text()).slice(0, 100), f.status]);
    }
    const seats = seated(w);
    const short = (p) => toHex(p.eid).slice(0, 8);
    console.log('  FACTS sm1-entry-2 (seats):', JSON.stringify({ lock: lockAns, a: short(a), b: short(b), c: short(c), seats }));
    for (const [st, why, fst] of lockAns) { assert.equal(st, 201, `a valid lock is kept (#1588): ${why}`); assert.ok(fst === 201 || fst === 200, `its fee lock: ${fst}`); }
    // since kanban #2538 the seats are the two lowest entry ids (the same at every seat whatever order the entries came in), not the first two
    // entries; the moves (rock, scissors, paper) make every pair of them decided
    const byId = [[a, ROCK], [b, SCISSORS], [c, PAPER]].sort((x, y) => (toHex(x[0].eid) < toHex(y[0].eid) ? -1 : 1));
    const [[p1, m1], [p2, m2]] = byId, outside = byId[2][0];
    const loser = (m1 - m2 + 3) % 3 === 1 ? p2 : p1;
    for (const per of seats) assert.deepEqual(per, [short(p1), short(p2)].sort(), 'the seats are the two lowest entry ids, at every seat');
    // everyone reveals; the seated pair is decided; the round settles
    skipTo(Number(w.c.entryCloseMs) + 500);
    await reveal(w, a, ROCK, s1); await reveal(w, b, SCISSORS, s2); await reveal(w, c, PAPER, s3);
    await closeRound(w);
    const settled = await untilSettled(w);
    assert.equal(settled.state, 'ACCEPTED', `${settled.why} ${JSON.stringify({ lock: lockAns, seats, a: short(a), b: short(b), c: short(c) })}`);
    // EVERY SEAT'S OWN SETTLEMENT ACCEPTED FIRST (2.0: the second seat reads its settlement ACCEPTED a moment after the first - SUBMITTING
    // in between, measured - and each seat returns an outside lock only once its own settlement is ACCEPTED without claiming it)
    { const { stateOf } = await import('../src/settlement-state.js');
      for (const stop = Date.now() + 30000; Date.now() < stop && !w.nodes.every((d) => stateOf(d.round, w.rid) === 'ACCEPTED');) await new Promise((r) => setTimeout(r, 250)); }
    // the player outside the seats: his held lock comes back now, not at expiry
    const fe = await fetch(`${base(w.nodes[0])}/forfeit?round=${toHex(w.rid)}&entry=${toHex(outside.eid)}`);
    const feWhy = fe.status === 200 ? 'signed' : (await fe.text()).slice(0, 200);
    console.log('  FACTS sm1-entry-2 (return):', JSON.stringify({ settled: settled.state, forfeitOutside: [fe.status, feWhy] }));
    assert.equal(fe.status, 200, `the lock that seats nobody has no return before its expiry: forfeit ${fe.status} (${feWhy})`);
    // a seated player's lock is not returned that way: the loser's was claimed
    const fl = await fetch(`${base(w.nodes[0])}/forfeit?round=${toHex(w.rid)}&entry=${toHex(loser.eid)}`);
    assert.notEqual(fl.status, 200, 'a seated loser\'s lock was forfeited back');
  } finally { await w.close(); }
});
