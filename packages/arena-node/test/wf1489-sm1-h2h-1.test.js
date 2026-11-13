// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 state machine audit (sm1-h2h-1): TWO SEATS SEAT DIFFERENT PLAYERS OF ONE HEAD-TO-HEAD ROUND, AND THE ROUND IS NEVER DECIDED.
// Machine: "who is seated in a paying head-to-head round", per seat = the entries whose stake lock this seat verified first (round.js seatedEntriesOf,
// stake-lock-signer-node.js headToHeadFull). The /entry door takes entries before their locks (#1437), so a round may hold three entries; the first
// two locks to reach a seat take its two seats and the third is refused THERE. Locks reach the seats in network order: player B's lock lands first at
// seat 0, player C's first at seat 1 (two players tapping the same open table, or a player and the bot opponent). Seat 0 seats {A, B}, seat 1 seats
// {A, C}, and each refuses the other's lock - from the client and from the relay. At the close every seat waits (membersKnown -> takeEntryParts) for
// the lock of an entry it holds, which its own door refuses forever: the wait runs out at the result window and NO seat signs anything. The honest
// winner A is never paid; every stake sits in its lock until expiry.
// Invariant: the seats of one round seat the same players, and a seated player who revealed a winning move gets a result the committee agrees on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { lockRound, lockAndPlay, closeRound } from './lock-round-fixture.js';
import { b32 } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { RPS, RPS_CORE_HASH, RPS_CONFIG_HASH, RPS_GAME_ID } from './plugins/rps/index.js';
import { decodePlayerResult, splitSignedResult } from '../../arena-protocol/src/result.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';
import { toHex, sha256 } from '../../arena-protocol/src/hash.js';
import { lockFieldsToJson, refundKeyOf } from '../../arena-protocol/src/stake-lock.js';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE };
const SLACK_MS = 25000;
const ROCK = 0, SCISSORS = 2;
const mk = (n) => ({ name: `p${n}`, key: b32(0x30 + n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });
const salt = () => new Uint8Array(randomBytes(32));
const results = (w, eid) => w.nodes.map((d) => d.round.results(w.rid, eid).map((r) => {
  const p = decodePlayerResult(splitSignedResult(r.bytes).body);
  return `${p.outcome} ${p.score}`;
}));
const reveal = async (w, played, move, s) => Promise.all(w.nodes.map(async (d) => {
  const r = await fetch(`http://127.0.0.1:${d.port}/reveal?entry=${toHex(played.eid)}`, { method: 'POST', body: JSON.stringify({ move, salt: toHex(s) }) });
  return r.status;
}));
const seated = (w) => w.nodes.map((d) => d.round.seatedEntriesOf(w.rid, w.c.stakeMsat).map(({ entryId }) => toHex(entryId).slice(0, 8)).sort());

test('#1489 sm1-h2h-1: locks reaching two seats in different orders seat different players, and the round is never decided', { timeout: 110000 }, async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS] }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + SLACK_MS });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const sa = salt(), sb = salt(), sc = salt();
    // A: locked at both seats
    const a = await lockAndPlay(w, mk(1), { hidden: { move: ROCK, salt: sa }, noMarks: true });
    // B and C tap the same table at the same moment: both entries reach both seats before any lock (the door counts only locked entries)
    const b = await lockAndPlay(w, mk(2), { hidden: { move: SCISSORS, salt: sb }, noMarks: true, only: [] });
    const c = await lockAndPlay(w, mk(3), { hidden: { move: SCISSORS, salt: sc }, noMarks: true, only: [] });
    // then the locks: B's lands first at seat 0, C's first at seat 1; each one's lock then reaches the other seat (the client's own post, or
    // the relay) - refused there, that seat is full
    const feeOf = (p, who) => ({ paymentImage: { kind: 'hash', bytes: sha256(p.entry.feePreimage) }, amountMsat: p.entry.feeMsat, claimPk: w.claimPk,
      refundPk: refundKeyOf(who.key), expiration: p.fields.expiration });
    await w.port.put(b.feeOutpoint, feeOf(b, mk(2))); await w.port.put(c.feeOutpoint, feeOf(c, mk(3)));
    const hand = async (d, p, who) => {
      const base = `http://127.0.0.1:${d.port}`;
      const s = (await fetch(`${base}/lock?entry=${toHex(p.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(p.fields)) })).status;
      const f = (await fetch(`${base}/fee-lock?entry=${toHex(p.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(feeOf(p, who))) })).status;
      return `${s}/${f}`;
    };
    const first = await Promise.all([hand(w.nodes[0], b, mk(2)), hand(w.nodes[1], c, mk(3))]);
    const lateB = await hand(w.nodes[1], b, mk(2)), lateC = await hand(w.nodes[0], c, mk(3));
    console.log('  FACTS (locks):', JSON.stringify({ first, lateB, lateC }));
    const seats = seated(w);
    console.log('  FACTS (seats):', JSON.stringify({ a: toHex(a.eid).slice(0, 8), b: toHex(b.eid).slice(0, 8), c: toHex(c.eid).slice(0, 8), seats }));
    // everyone reveals in the window; A's rock beats both scissors
    skipTo(Number(w.c.entryCloseMs) + 500);
    await reveal(w, a, ROCK, sa); await reveal(w, b, SCISSORS, sb); await reveal(w, c, SCISSORS, sc);
    await closeRound(w);
    // let each seat's member wait run past the result window
    for (const stop = Date.now() + 25000; Date.now() < stop && results(w, a.eid).some((x) => !x.length); await new Promise((r) => setTimeout(r, 500)));
    const got = { a: results(w, a.eid), b: results(w, b.eid), c: results(w, c.eid) };
    console.log('  FACTS (results):', JSON.stringify(got));
    // since kanban #2538 the seats are the lowest entry ids among the locked entries (not the order the entries came), so A - entered first -
    // is seated only when its id is among the two lowest; seated, its rock wins at every seat, else it is VOID at every seat
    const aSeated = seats[0].includes(toHex(a.eid).slice(0, 8));
    for (const per of got.a) assert.deepEqual([...new Set(per)], [aSeated ? 'DELIVERED 2' : 'VOID 0'], `A's result at each seat: ${JSON.stringify({ ...got, seats })}`);
    assert.deepEqual(seats[0], seats[1], `the two seats of one round seat different players: ${JSON.stringify(seats)}`);
  } finally { await w.close(); }
});
