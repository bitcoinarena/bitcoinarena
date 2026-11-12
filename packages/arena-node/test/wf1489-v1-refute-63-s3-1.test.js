// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute of #1479 / #1760 / #1916 (feedback #007), skeptic 3. #1916 lets a lock the door would refuse past takeEntryParts when
// "a threshold signed results naming the entry" (verify.js signersNaming). But signersNaming counts ANY signed result of the round for the
// entry's player key - a VOID one included, and it never looks at the entry (a result names no entry). Three seats, threshold 2: an honest
// seat A signs the lockless winner VOID (#1437); the colluding seat C signs it DELIVERED off its own late lock rows. A second honest seat B
// that looks at the round's members a little later (C answers B's GET /api/round-result slowly, up to VIEW_WAIT_MS) then counts A's VOID and
// C's DELIVERED as two "signers naming it", calls the entry accepted, takes C's late locks, and seats the winner: B + C settle 2 of 3.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { lockRound, lockAndPlay, closeRound, untilSettled } from './lock-round-fixture.js';
import { standing } from './lock-round-fixture.js';
import { resultFinality } from '../src/finality.js';
import { b32 } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { RPS, RPS_CORE_HASH, RPS_CONFIG_HASH, RPS_GAME_ID } from './plugins/rps/index.js';
import { decodePlayerResult, splitSignedResult } from '../../arena-protocol/src/result.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';
import { toHex, sha256 } from '../../arena-protocol/src/hash.js';
import { ENTRY_CLOSE_GRACE_MS } from '../src/round.js';
import { lockFieldsToJson } from '../src/stake-lock-signer-node.js';
import { refundKeyOf } from '../../arena-protocol/src/stake-lock.js';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE };
const ROCK = 0, PAPER = 1, SCISSORS = 2;
const BEATS = { [ROCK]: PAPER, [PAPER]: SCISSORS, [SCISSORS]: ROCK };
const mk = (n) => ({ name: `p${n}`, key: b32(0x50 + n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });
const salt = () => new Uint8Array(randomBytes(32));
const resultsAt = (d, w, eid) => d.round.results(w.rid, eid).map((r) => { const p = decodePlayerResult(splitSignedResult(r.bytes).body); return `${p.outcome} ${p.score}`; });
// kanban #1916: what the seat itself signed - a seat also keeps its peers' signed results, and the colluding seat's own DELIVERED is not the honest seat's
const signedBy = (d, w, eid) => d.round.results(w.rid, eid).map((r) => decodePlayerResult(splitSignedResult(r.bytes).body))
  .filter((p) => toHex(p.nodePubkey) === toHex(d.round.pubkey)).map((p) => `${p.outcome} ${p.score}`);

test('#1916 variant: an honest seat\'s VOID for the lockless winner counts as "a threshold signed results naming it" at a later honest seat', async () => {
  const w = await lockRound({ n: 3, serveOpts: { plugins: [NEXTBLOCK, RPS], entryCloseGraceMs: ENTRY_CLOSE_GRACE_MS }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 25000 });
  try {
    const [seatA, seatB, badSeat] = w.nodes;
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const hs = salt();
    const honest = await lockAndPlay(w, mk(1), { hidden: { move: ROCK, salt: hs }, noMarks: true });
    const att = {};
    for (const move of [ROCK, PAPER, SCISSORS]) {
      const who = mk(10 + move), s = salt();
      att[move] = { who, s, p: await lockAndPlay(w, who, { hidden: { move, salt: s }, noMarks: true, only: [] }) };
    }
    skipTo(Number(w.c.entryCloseMs) + 500);
    for (const d of w.nodes) await fetch(`http://127.0.0.1:${d.port}/reveal?entry=${toHex(honest.eid)}`, { method: 'POST', body: JSON.stringify({ move: ROCK, salt: toHex(hs) }) });
    const seen = await (await fetch(`http://127.0.0.1:${seatA.port}/reveals?round=${toHex(w.rid)}`)).json();
    const theirs = (seen.reveals || []).find((r) => r.entry === toHex(honest.eid));
    const hm = theirs ? Number(theirs.move) : ROCK;
    const win = att[BEATS[hm]];
    skipTo(Number(w.c.entryCloseMs) + 2000);
    const feeFields = { paymentImage: { kind: 'hash', bytes: sha256(win.p.entry.feePreimage) }, amountMsat: win.p.entry.feeMsat, claimPk: w.claimPk,
      refundPk: refundKeyOf(win.who.key), expiration: win.p.fields.expiration };
    const doors = [];
    for (const d of [seatA, seatB]) {
      const r = await fetch(`http://127.0.0.1:${d.port}/lock?entry=${toHex(win.p.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(win.p.fields)) });
      doors.push(r.status);
    }
    badSeat.round.putStakeLock({ entryId: win.p.eid, roundId: w.rid, outpoint: win.p.outpoint, fields: lockFieldsToJson(win.p.fields), contractId: 'x' });
    badSeat.round.putFeeLock({ entryId: win.p.eid, roundId: w.rid, outpoint: win.p.feeOutpoint, fields: lockFieldsToJson(feeFields), contractId: 'x' });
    badSeat.round.putStakeSeen({ entryId: win.p.eid, paidMsat: win.p.fields.amountMsat });
    for (const d of w.nodes) await fetch(`http://127.0.0.1:${d.port}/reveal?entry=${toHex(win.p.eid)}`, { method: 'POST', body: JSON.stringify({ move: BEATS[hm], salt: toHex(win.s) }) });
    // A and the colluding seat close first; B a moment later (its view of the colluding seat answered slowly)
    await closeRound({ ...w, nodes: [seatA, badSeat] }, { window: false });
    for (const stop = Date.now() + 20000; Date.now() < stop && !(signedBy(seatA, w, win.p.eid).length && signedBy(badSeat, w, win.p.eid).length); await new Promise((r) => setTimeout(r, 100)));
    const aSigned = signedBy(seatA, w, win.p.eid), cFirst = signedBy(badSeat, w, win.p.eid);
    await closeRound({ ...w, nodes: [seatB] }, { window: false });
    await closeRound(w);
    let settled = await untilSettled(w, 15000);
    const atOthers = {};
    for (const [n, d] of [['B', seatB], ['C', badSeat]]) {
      let g; for (const stop = Date.now() + 15000; Date.now() < stop; await new Promise((r) => setTimeout(r, 250))) { g = await standing(d, w); if (g.state === 'ACCEPTED') break; }
      atOthers[n] = { state: g.state, why: g.why && String(g.why).slice(0, 160) };
    }
    if (settled.state !== 'ACCEPTED' && Object.values(atOthers).some((x) => x.state === 'ACCEPTED')) settled = { ...settled, state: 'ACCEPTED', at: atOthers };
    const finalAtB = { honest: resultFinality(seatB.round, w.rid, honest.eid).state, attacker: resultFinality(seatB.round, w.rid, win.p.eid).state };
    const facts = { atOthers, finalAtB, honestPublicMove: hm, doors, aSigned, cFirst, state: settled.state, why: settled.why,
      bSigned: { attacker: signedBy(seatB, w, win.p.eid), honest: signedBy(seatB, w, honest.eid) },
      cSigned: { attacker: signedBy(badSeat, w, win.p.eid), honest: signedBy(badSeat, w, honest.eid) },
      lockSeenAtA: !!seatA.round.stakeSeen(win.p.eid), lockSeenAtB: !!seatB.round.stakeSeen(win.p.eid) };
    console.log('  FACTS (refute 63-s3-1):', JSON.stringify(facts));
    assert.deepEqual(doors, [409, 409], 'an honest door took the late lock itself');
    assert.ok(!facts.lockSeenAtB, `honest seat B took the winner's late lock from the colluding seat: ${JSON.stringify(facts)}`);
    assert.ok(!facts.bSigned.attacker.some((x) => x.startsWith('DELIVERED')), `honest seat B signed the late-locked winner DELIVERED: ${JSON.stringify(facts)}`);
    assert.notEqual(settled.state, 'ACCEPTED', `the round settled on the late-locked winner: ${JSON.stringify(facts)}`);
  } finally { await w.close(); }
});
