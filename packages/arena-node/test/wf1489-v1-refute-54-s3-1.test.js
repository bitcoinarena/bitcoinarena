// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
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

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE };
const ROCK = 0, PAPER = 1, SCISSORS = 2;
const mk = (n) => ({ name: `p${n}`, key: b32(0x70 + n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });
const salt = () => new Uint8Array(randomBytes(32));
const results = (w, eid) => w.nodes.map((d) => d.round.results(w.rid, eid).map((r) => { const p = decodePlayerResult(splitSignedResult(r.bytes).body); return `${p.outcome} ${p.score}`; }));
const reveal = async (w, played, move, s) => Promise.all(w.nodes.map(async (d) =>
  (await fetch(`http://127.0.0.1:${d.port}/reveal?entry=${toHex(played.eid)}`, { method: 'POST', body: JSON.stringify({ move, salt: toHex(s) }) })).status));

test('a late lock replayed from one peer as a book "order" (replayOrder) does not make a head-to-head stake played at an honest seat', { todo: 'kanban #1489 merge19v1: the griefer seat of this setup takes a late head-to-head lock at its own door; on the 1.9 line every seat refuses it there (#1598, h2hLockRefusal, any grace), so the setup does not stand. The fix this test asks for (#2070: replayOrder takes only a market order of the batch\'s round, only after the certificate\'s signatures) is merged' }, async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS], entryCloseGraceMs: ENTRY_CLOSE_GRACE_MS }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 25000 });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const sa = salt(), sg = salt();
    const a = await lockAndPlay(w, mk(1), { hidden: { move: PAPER, salt: sa }, noMarks: true });
    // the griefer: entry and handout at every seat, no lock anywhere (both are in the federation)
    const g = await lockAndPlay(w, mk(2), { hidden: { move: SCISSORS, salt: sg }, noMarks: true, only: [] });
    skipTo(Number(w.c.entryCloseMs) + 500);
    await reveal(w, a, PAPER, sa);
    const pub = await (await fetch(`http://127.0.0.1:${w.nodes[0].port}/reveals?round=${toHex(w.rid)}`)).json();
    const theirs = pub.reveals.find((r) => r.entry === toHex(a.eid));
    assert.ok(theirs, 'the honest reveal is public');
    assert.ok((SCISSORS - theirs.move + 3) % 3 === 1, 'scissors beats paper: the griefer now chooses to take part');
    skipTo(Number(w.c.entryCloseMs) + 2000);
    // the griefer's own seat (no #1733 door) takes both his locks now
    w.nodes[0].round.entryCloseGraceMs = null;
    const feeFields = { paymentImage: { kind: 'hash', bytes: sha256(g.entry.feePreimage) }, amountMsat: g.entry.feeMsat, claimPk: w.claimPk,
      refundPk: refundKeyOf(mk(2).key), expiration: g.fields.expiration };
    const at0 = [];
    for (const [path, body] of [['lock', g.fields], ['fee-lock', feeFields]]) {
      const r = await fetch(`http://127.0.0.1:${w.nodes[0].port}/${path}?entry=${toHex(g.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(body)) });
      at0.push(`${r.status} ${(await r.text()).slice(0, 80)}`);
    }
    assert.match(at0[0], /^201 /, 'the griefer seat takes the late stake lock');
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
    const gPlayed = got.g[1].some((x) => !x.startsWith('VOID'));
    assert.ok(!gPlayed && !seenG[1], `the honest seat refused the late lock at its door (${doorAns}) but replayOrder carried it from the griefer's one seat ` +
      `(${JSON.stringify(replayed)}), its stake became seen there (${JSON.stringify(seenG)}) and he was played after the honest move was public: ` +
      `griefer ${JSON.stringify(got.g)}, honest ${JSON.stringify(got.a)}`);
  } finally { await w.close(); }
});
