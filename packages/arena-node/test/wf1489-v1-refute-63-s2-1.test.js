// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute of #1479 / #1760 (feedback #007), skeptic 2: ONE SEAT colludes with the player. #1760 refuses a head-to-head lock new to a seat
// from the entry close at POST /lock and /fee-lock. But at the close every seat first learns who is in the round (server.js afterClose ->
// membersKnown) and, for EVERY entry it holds, pulls that entry's locks from every peer's GET /order-locks and takes them with takeStakeLock /
// takeFeeLock (takeEntryParts) - with no close check. So: three lockless entries under three fresh keys (rock, paper, scissors) before the close;
// after the close the honest reveal is public; the winner's locks go to the colluding seat only (its own door; simulated by writing its rows),
// and the honest seat takes them from that seat at its close. Expected if the effect is closed: the honest seat does not play the late-locked entry.
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

test('#1479/#1760 variant: one colluding seat holds the winner\'s late locks, the honest seat pulls them at its close (takeEntryParts)', async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS], entryCloseGraceMs: ENTRY_CLOSE_GRACE_MS }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 25000 });
  try {
    const [honestSeat, badSeat] = w.nodes;
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
    const seen = await (await fetch(`http://127.0.0.1:${honestSeat.port}/reveals?round=${toHex(w.rid)}`)).json();
    const theirs = (seen.reveals || []).find((r) => r.entry === toHex(honest.eid));
    const hm = theirs ? Number(theirs.move) : ROCK;
    const win = att[BEATS[hm]];
    skipTo(Number(w.c.entryCloseMs) + 2000);
    const feeFields = { paymentImage: { kind: 'hash', bytes: sha256(win.p.entry.feePreimage) }, amountMsat: win.p.entry.feeMsat, claimPk: w.claimPk,
      refundPk: refundKeyOf(win.who.key), expiration: win.p.fields.expiration };
    // the honest seat's own door refuses the late lock (#1760)
    const door = await fetch(`http://127.0.0.1:${honestSeat.port}/lock?entry=${toHex(win.p.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(win.p.fields)) });
    const doorSaid = { status: door.status, why: (await door.text()).slice(0, 160) };
    // the colluding seat keeps them anyway (its door is its operator's)
    badSeat.round.putStakeLock({ entryId: win.p.eid, roundId: w.rid, outpoint: win.p.outpoint, fields: lockFieldsToJson(win.p.fields), contractId: 'x' });
    badSeat.round.putFeeLock({ entryId: win.p.eid, roundId: w.rid, outpoint: win.p.feeOutpoint, fields: lockFieldsToJson(feeFields), contractId: 'x' });
    badSeat.round.putStakeSeen({ entryId: win.p.eid, paidMsat: win.p.fields.amountMsat });
    for (const d of w.nodes) await fetch(`http://127.0.0.1:${d.port}/reveal?entry=${toHex(win.p.eid)}`, { method: 'POST', body: JSON.stringify({ move: BEATS[hm], salt: toHex(win.s) }) });
    await closeRound(w);
    const settled = await untilSettled(w);
    const atHonest = { honest: resultsAt(honestSeat, w, honest.eid), attacker: resultsAt(honestSeat, w, win.p.eid), attackerSignedHere: signedBy(honestSeat, w, win.p.eid),
      lockTakenAtHonestSeat: !!honestSeat.round.stakeLock(win.p.eid), seenAtHonestSeat: !!honestSeat.round.stakeSeen(win.p.eid) };
    console.log('  FACTS (refute 63-s2-1):', JSON.stringify({ honestPublicMove: hm, doorSaid, state: settled.state, why: settled.why, atHonest,
      atBad: { honest: resultsAt(badSeat, w, honest.eid), attacker: resultsAt(badSeat, w, win.p.eid) } }));
    assert.equal(doorSaid.status, 409, 'the honest seat\'s door took the late lock itself');
    assert.ok(!atHonest.seenAtHonestSeat, `the honest seat took the winner's lock, handed on after the close by one seat: ${JSON.stringify(atHonest)}`);
    assert.notEqual(settled.state, 'ACCEPTED', `the round settled on the late-locked winner: ${JSON.stringify(settled)}`);
    assert.ok(!atHonest.attackerSignedHere.some((x) => x.startsWith('DELIVERED')), `the honest seat signed the late-locked winner DELIVERED: ${JSON.stringify(atHonest)}`);
  } finally { await w.close(); }
});
