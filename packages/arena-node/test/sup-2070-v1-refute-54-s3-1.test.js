// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Adapted to 1.9 by #2536 (kanban #2070): 1.9 holds every move of a paying head-to-head round until entry close + H2H_REVEAL_HOLD_MS (#1822), so
// the card's read at close + 500 ms found no reveal. The griefer now reads GET /reveals the moment it serves the honest move, then acts.
// kanban #1489 v1 refute of #1544 skeptic 3, variant 1: THE SECOND COPY OF THE LOCK CARRY - order-batch.js replayOrder (server.js orderBook.replayOrder).
// c44f01792 gates the carry of a peer's late lock in takeEntryParts (threshold of peers) and marks a late lock taken at a seat's own door
// (late_lock). But server.js has a second copy of the same carry: orderBook.replayOrder fetches GET /order-locks from ONE peer and runs
// takeStakeLock + takeFeeLock with no entry-close check, no threshold and no late_lock mark - and it never checks the entry is an order or
// of the book's round. order-batch.js #take calls it for every id a peer's /book-certificates names that is not "whole" here, BEFORE the
// certificate's signatures are checked (certify -> #check refuses "holds no entry" first, then #take replays every listed id).
// So the griefer: entry + handout at every seat, no lock anywhere before the close. He reads the honest move from GET /reveals; when his
// move wins, his own seat (no #1733 door) takes his stake and fee locks and answers a forged /book-certificates for any market round
// listing his h2h entry id. Every honest seat replays it: its stake becomes seen there and he is played. Had he lost he does nothing (VOID).
// SAFE: after the entry close a lock replayed from one peer does not make a paying head-to-head stake played at an honest seat.
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
import { ENTRY_CLOSE_GRACE_MS } from '../src/round.js';
import { H2H_REVEAL_HOLD_MS } from '../src/server.js';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE };
const ROCK = 0, PAPER = 1, SCISSORS = 2;
const mk = (n) => ({ name: `p${n}`, key: b32(0x70 + n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });
const salt = () => new Uint8Array(randomBytes(32));
const results = (w, eid) => w.nodes.map((d) => d.round.results(w.rid, eid).map((r) => { const p = decodePlayerResult(splitSignedResult(r.bytes).body); return `${p.outcome} ${p.score}`; }));
const reveal = async (w, played, move, s) => Promise.all(w.nodes.map(async (d) =>
  (await fetch(`http://127.0.0.1:${d.port}/reveal?entry=${toHex(played.eid)}`, { method: 'POST', body: JSON.stringify({ move, salt: toHex(s) }) })).status));

test('a late lock replayed from one peer as a book "order" (replayOrder) does not make a head-to-head stake played at an honest seat', async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS], entryCloseGraceMs: ENTRY_CLOSE_GRACE_MS }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 25000 });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const sa = salt(), sg = salt();
    const a = await lockAndPlay(w, mk(1), { hidden: { move: PAPER, salt: sa }, noMarks: true });
    // the griefer: entry and handout at every seat, no lock anywhere (both are in the federation)
    const g = await lockAndPlay(w, mk(2), { hidden: { move: SCISSORS, salt: sg }, noMarks: true, only: [] });
    skipTo(Number(w.c.entryCloseMs) + 500);
    await reveal(w, a, PAPER, sa);
    // 1.9 serves no move before the close + H2H_REVEAL_HOLD_MS (#1822): the griefer reads it the moment it is public
    skipTo(Number(w.c.entryCloseMs) + H2H_REVEAL_HOLD_MS + 100);
    const pub = await (await fetch(`http://127.0.0.1:${w.nodes[0].port}/reveals?round=${toHex(w.rid)}`)).json();
    const theirs = pub.reveals.find((r) => r.entry === toHex(a.eid));
    assert.ok(theirs, 'the honest reveal is public');
    assert.ok((SCISSORS - theirs.move + 3) % 3 === 1, 'scissors beats paper: the griefer now chooses to take part');
    skipTo(Number(w.c.entryCloseMs) + 2000);
    // the griefer's own seat (no #1733 door) takes both his locks now
    w.nodes[0].round.entryCloseGraceMs = null;
    const feeFields = { paymentImage: { kind: 'hash', bytes: sha256(g.entry.feePreimage) }, amountMsat: g.entry.feeMsat, claimPk: w.claimPk,
      refundPk: refundKeyOf(mk(2).key), expiration: g.fields.expiration };
    // 1.9's door refuses the late lock at every seat, a seat with no grace too: the griefer's seat is PATCHED (it keeps no door) - planted in
    // its store as its own door would have kept it, so GET /order-locks serves it to the honest seats
    const plantAt = Number(w.c.entryCloseMs) + 2000;
    const plant = async (put, outpoint, f) => w.nodes[0].round[put]({ entryId: g.eid, roundId: w.rid, outpoint, fields: lockFieldsToJson(f),
      contractId: String(await w.port.contractId(f)), atMs: plantAt });
    await plant('putStakeLock', g.entry.stakeLockOutpoint, g.fields);
    await plant('putFeeLock', g.entry.feeLockOutpoint, feeFields);
    w.nodes[0].round.putStakeSeen({ entryId: g.eid, paidMsat: g.fields.amountMsat, atMs: plantAt });
    const at0 = ['stake planted', 'fee planted', `seen at seat 0: ${!!w.nodes[0].round.stakeSeen(g.eid)}`];
    // the honest seat refuses the same late lock at its own door
    const door = await fetch(`http://127.0.0.1:${w.nodes[1].port}/lock?entry=${toHex(g.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(g.fields)) });
    const doorAns = `${door.status} ${(await door.text()).slice(0, 80)}`;
    assert.match(doorAns, /^409 /, 'the honest door refuses the late stake lock');
    // the griefer seat answers /book-certificates of a market round with a record naming his h2h entry: order-batch #take hands every
    // listed id that is not whole here to replayOrder, before any signature is checked - this is that call
    const replayed = await w.nodes[1].orderBook.replayOrder(toHex(g.eid), `http://127.0.0.1:${w.nodes[0].port}`);
    const seenG = w.nodes.map((d) => !!d.round.stakeSeen(g.eid));
    await reveal(w, g, SCISSORS, sg);
    await closeRound(w);
    const got = { a: results(w, a.eid), g: results(w, g.eid) };
    console.log('  FACTS (refute-54-s3-1):', JSON.stringify({ at0, doorAns, replayed, seenG, results: got }));
    // the honest seat's OWN signed word on the griefer (a seat also keeps the copies its peers signed - the patched seat's among them)
    const ownG = w.nodes[1].round.results(w.rid, g.eid).filter((r) => toHex(r.nodePubkey) === toHex(w.nodes[1].round.pubkey))
      .map((r) => { const p = decodePlayerResult(splitSignedResult(r.bytes).body); return `${p.outcome} ${p.score}`; });
    console.log('  the honest seat\'s own result for the griefer:', JSON.stringify(ownG));
    assert.equal(ownG.length, 1, 'the honest seat signed its own result for the griefer');
    const gPlayed = ownG.some((x) => !x.startsWith('VOID'));
    assert.ok(!gPlayed && !seenG[1], `the honest seat refused the late lock at its door (${doorAns}) but replayOrder carried it from the griefer's one seat ` +
      `(${JSON.stringify(replayed)}), its stake became seen there (${JSON.stringify(seenG)}) and he was played after the honest move was public: ` +
      `griefer ${JSON.stringify(got.g)}, honest ${JSON.stringify(got.a)}`);
  } finally { await w.close(); }
});
