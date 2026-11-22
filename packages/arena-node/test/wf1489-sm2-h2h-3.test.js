// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 state audit round 2 (sm2-h2h-3): CROSSING ENTRIES SEAT DIFFERENT PLAYERS AT TWO SEATS OF ONE HEAD-TO-HEAD ROUND, AND THE ROUND
// IS NEVER DECIDED.
// Machine: "who is seated in a paying head-to-head round", per seat (round.js seatedEntriesOf, #1588): the game's `players` lock-backed entries
// in the order their ENTRIES were first taken at this seat (rowid). #1588 fixed crossing LOCKS on the assumption that "a client posts its
// entry to every seat before it hands any lock, so the seats hold the entries in one order". Two players who tap the same open table at the
// same moment post their entries concurrently: B's reaches seat 0 first, C's reaches seat 1 first (network order), and the entry relay
// (entry-relay.js, 0.7-1.2 s later) hands each to the other seat. Seat 0 holds A, B, C; seat 1 holds A, C, B. Both locks are then held at
// both seats (no "full" refusal since #1588): seat 0 seats {A, B}, seat 1 seats {A, C}. A plays B at one seat and C at the other.
// Invariant: every seat of one round seats the same players once it holds the same entries and locks; a seated entry gets a verdict the
// committee agrees on.
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
const ROCK = 0, PAPER = 1, SCISSORS = 2;
const mk = (n) => ({ name: `p${n}`, key: b32(0x60 + n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });
const salt = () => new Uint8Array(randomBytes(32));
// each seat's OWN signed result for an entry
const own = (w, eid) => w.nodes.map((d) => d.round.results(w.rid, eid).map((r) => decodePlayerResult(splitSignedResult(r.bytes).body))
  .filter((p) => toHex(p.nodePubkey) === toHex(d.round.pubkey)).map((p) => `${p.outcome} ${p.score}`).join(',') || '-');
const reveal = async (w, played, move, s) => Promise.all(w.nodes.map(async (d) => {
  const r = await fetch(`http://127.0.0.1:${d.port}/reveal?entry=${toHex(played.eid)}`, { method: 'POST', body: JSON.stringify({ move, salt: toHex(s) }) });
  return r.status;
}));
const seated = (w) => w.nodes.map((d) => d.round.seatedEntriesOf(w.rid, w.c.stakeMsat).map(({ entryId }) => toHex(entryId).slice(0, 8)).sort());
const order = (w) => w.nodes.map((d) => d.round.db.prepare('SELECT entry_id FROM entries WHERE round_id = ? ORDER BY rowid').all(w.rid).map((r) => Buffer.from(r.entry_id).toString('hex').slice(0, 8)));

test('#1489 sm2-h2h-3: two entries crossing on their way to the seats seat different players, and the round is never decided', { timeout: 110000 }, async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS] }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + SLACK_MS });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const sa = salt(), sb = salt(), sc = salt();
    // A: entered and locked at both seats
    const a = await lockAndPlay(w, mk(1), { hidden: { move: ROCK, salt: sa }, noMarks: true });
    // B and C tap the table at the same moment: B's entry reaches seat 0 first, C's seat 1 first; the entry relay hands each on to the other seat
    const [b, c] = await Promise.all([
      lockAndPlay(w, mk(2), { hidden: { move: PAPER, salt: sb }, noMarks: true, only: [], unreached: [1] }),
      lockAndPlay(w, mk(3), { hidden: { move: SCISSORS, salt: sc }, noMarks: true, only: [], unreached: [0] }),
    ]);
    const holdsAll = () => w.nodes.every((d) => [b, c].every((p) => !!d.round.entry(p.eid)));
    for (const stop = Date.now() + 8000; Date.now() < stop && !holdsAll(); await new Promise((r) => setTimeout(r, 100)));
    assert.ok(holdsAll(), 'the relay handed each entry on to the other seat');
    // then both players lock at both seats (the client's own posts)
    const feeOf = (p, who) => ({ paymentImage: { kind: 'hash', bytes: sha256(p.entry.feePreimage) }, amountMsat: p.entry.feeMsat, claimPk: w.claimPk,
      refundPk: refundKeyOf(who.key), expiration: p.fields.expiration });
    await w.port.put(b.feeOutpoint, feeOf(b, mk(2))); await w.port.put(c.feeOutpoint, feeOf(c, mk(3)));
    const hand = async (d, p, who) => {
      const base = `http://127.0.0.1:${d.port}`;
      const s = (await fetch(`${base}/lock?entry=${toHex(p.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(p.fields)) })).status;
      const f = (await fetch(`${base}/fee-lock?entry=${toHex(p.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(feeOf(p, who))) })).status;
      return `${s}/${f}`;
    };
    const locks = [];
    for (const d of w.nodes) for (const [p, who] of [[b, mk(2)], [c, mk(3)]]) locks.push(await hand(d, p, who));
    const ids = { a: toHex(a.eid).slice(0, 8), b: toHex(b.eid).slice(0, 8), c: toHex(c.eid).slice(0, 8) };
    const seats = seated(w);
    console.log('  FACTS (entries, locks, seats):', JSON.stringify({ ids, order: order(w), locks, seats }));
    // everyone reveals in the window: A rock, B paper, C scissors
    skipTo(Number(w.c.entryCloseMs) + 2000);
    await reveal(w, a, ROCK, sa); await reveal(w, b, PAPER, sb); await reveal(w, c, SCISSORS, sc);
    await closeRound(w);
    for (const stop = Date.now() + 20000; Date.now() < stop && own(w, a.eid).some((x) => x === '-'); await new Promise((r) => setTimeout(r, 500)));
    const got = { a: own(w, a.eid), b: own(w, b.eid), c: own(w, c.eid) };
    console.log('  FACTS (each seat\'s own result):', JSON.stringify(got));
    assert.deepEqual(seats[0], seats[1], `the two seats of one round seat different players: ${JSON.stringify({ ids, order: order(w), seats })}`);
    assert.equal(new Set(got.a).size, 1, `the seated player A is signed differently at the two seats: ${JSON.stringify(got)}`);
  } finally { await w.close(); }
});
