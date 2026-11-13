// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE CERTIFIED LOCK SET'S OPEN POINT (kanban #2561, spec ruling on #2116, §17A): "a lock that arrives after the certificate is not in the round
// and goes back by forfeit at once". Before, a held lock outside the certificate - and every lock of a round that got no certificate by
// close + LOCK_SET_WINDOW_MS (VOID) - came back only through the settlement's VOID refund, or at its expiry. Now the forfeit door
// (GET /forfeit, and ?lock=fee for its fee lock) signs it at once, as a refused round's lock (§23.2); a certified lock waits for its round.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { lockRound, openLockRound, lockAndPlay } from './lock-round-fixture.js';
import { b32, wait } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { RPS, RPS_CORE_HASH, RPS_CONFIG_HASH, RPS_GAME_ID } from './plugins/rps/index.js';
import { decodePlayerResult, splitSignedResult } from '../../arena-protocol/src/result.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { LOCK_SET_VERSION } from '../../arena-protocol/src/constants.js';
import { LOCK_SET_WINDOW_MS } from '../../arena-protocol/src/lock-set.js';
import { LOCK_SET_RETURN_AFTER_MS } from '../src/lock-set-book.js';
import { lockFieldsToJson } from '../../arena-protocol/src/stake-lock.js';

// ON 2.0, 27 AND UP IS ALSO THE ARENA LOCK (arena-lock.js NAMED_CLAIM_VERSION, regtest's point 0): this fixture's locks are stock contracts, so its
// rounds sit below regtest's named-claim point by the harness switch, as a testnet4 round does (its point is none) - as gifts-in-fee-lock-1486 does
process.env.ARENA_DONATION_NETWORK = 'regtest'; process.env.ARENA_TEST_NAMED_CLAIM_HEIGHT = '999999999';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE, protocolVersion: LOCK_SET_VERSION };
const ROCK = 0, PAPER = 1, SCISSORS = 2;
let k = 0x70;
const player = () => ({ name: `p${k}`, key: b32(k++), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });
const salt = () => new Uint8Array(randomBytes(32));
const url = (d, path) => `http://127.0.0.1:${d.port}${path}`;
const lockSetAt = async (d, w) => (await fetch(url(d, `/lock-set?round=${toHex(w.rid)}`))).json();
const revealAt = (nodes, played, move, s) => Promise.all(nodes.map(async (d) => (await fetch(url(d, `/reveal?entry=${toHex(played.eid)}`), { method: 'POST', body: JSON.stringify({ move, salt: toHex(s) }) })).status));
const outcomes = (nodes, w, eid) => nodes.map((d) => [...new Set(d.round.results(w.rid, eid).map((r) => { const p = decodePlayerResult(splitSignedResult(r.bytes).body); return `${p.outcome} ${p.score}`; }))].join('|'));
const decided = (nodes, w) => Promise.all(nodes.map((d) => fetch(url(d, `/api/round-result?round=${toHex(w.rid)}`)).then((x) => x.json())
  .then((j) => (j.players || []).filter((p) => p.outcome && p.signedBy > 0).length).catch(() => -1)));
// THE FORFEIT DOOR: the committee's signature over the lock's contract, checked under the round's claim key
async function forfeitAt(d, w, eid, kind = 'stake') {
  const r = await fetch(url(d, `/forfeit?round=${toHex(w.rid)}&entry=${toHex(eid)}${kind === 'fee' ? '&lock=fee' : ''}`));
  const j = r.status === 200 ? await r.json() : { why: (await r.text()).slice(0, 140) };
  const verifies = !!j.signature && schnorr.verify(fromHex(j.signature), fromHex(j.contractId), w.claimPk.subarray(1));
  return { status: r.status, verifies, why: j.why || '' };
}
const down = (d) => { d.lockSets.silent = true; d.lockSets.step = async () => null; };
const up = (d) => { d.lockSets.silent = false; delete d.lockSets.step; };

test('2-of-2: a lock outside the certificate is forfeited back at once (stake and fee lock), a certified one is not; the honest pair still decides', { timeout: 120000 }, async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS], closeAtEnd: { everyMs: 250 } }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 25000 });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const sa = salt(), sb = salt();
    const a = await lockAndPlay(w, player(), { hidden: { move: ROCK, salt: sa }, noMarks: true });
    // the late player enters before the close with no lock anywhere yet (its locks are in the federation)
    const late = await lockAndPlay(w, player(), { hidden: { move: PAPER, salt: salt() }, noMarks: true, only: [] });
    const b = await lockAndPlay(w, player(), { hidden: { move: SCISSORS, salt: sb }, noMarks: true });
    const close = Number(w.c.entryCloseMs);
    skipTo(close + 50);
    let sets = [];
    for (let i = 0; i < 80 && !(sets.length && sets.every((s) => s.certificate)); i++) { await wait(50); sets = await Promise.all(w.nodes.map((d) => lockSetAt(d, w))); }
    // THE LOCK THAT ARRIVES AFTER THE CERTIFICATE: written at both seats by a second door (the order replay, a repair from a peer, an operator's
    // hand - POST /lock itself refuses it after the close), stake and fee lock, as the federation holds them
    const held = (at) => w.port.locks.get(`${toHex(at.txid)}:${at.outIdx}`);
    for (const d of w.nodes) {
      const at = close + 60;
      d.round.putStakeLock({ entryId: late.eid, roundId: w.rid, outpoint: late.outpoint, fields: lockFieldsToJson(held(late.outpoint).fields), contractId: held(late.outpoint).id, atMs: at });
      d.round.putFeeLock({ entryId: late.eid, roundId: w.rid, outpoint: late.feeOutpoint, fields: lockFieldsToJson(held(late.feeOutpoint).fields), contractId: held(late.feeOutpoint).id, atMs: at });
      d.round.putStakeSeen({ entryId: late.eid, paidMsat: w.c.stakeMsat, atMs: at });
    }
    // INSIDE THE WINDOW the late lock waits (kanban #2585: a second certificate over another set may still reach this seat); a certified one too
    const lateEarly = await forfeitAt(w.nodes[0], w, late.eid);
    const certified = await forfeitAt(w.nodes[0], w, a.eid);
    const ra = await revealAt(w.nodes, a, ROCK, sa), rb = await revealAt(w.nodes, b, SCISSORS, sb);
    let n = [0, 0];
    for (let i = 0; i < 80 && !n.every((v) => v >= 2); i++) { await wait(100); n = await decided(w.nodes, w); }
    // AT ONCE once the set cannot be contested (close + the window + LOCK_SET_RETURN_AFTER_MS), long before any settlement or the lock's expiry
    skipTo(close + LOCK_SET_WINDOW_MS + LOCK_SET_RETURN_AFTER_MS + 100);
    const lateStake = await forfeitAt(w.nodes[0], w, late.eid);
    const lateFee = await forfeitAt(w.nodes[0], w, late.eid, 'fee');
    const got = { a: outcomes(w.nodes, w, a.eid), b: outcomes(w.nodes, w, b.eid), late: outcomes(w.nodes, w, late.eid) };
    console.log('  FACTS (#2561 late lock back):', JSON.stringify({ certAt: sets.map((s) => s.certifiedAtMs && s.certifiedAtMs - close), entries: sets.map((s) => s.entries && s.entries.length),
      lateEarly, lateStake, lateFee, certified, ra, rb, decided: n, got }));
    for (const s of sets) assert.deepEqual([...(s.entries || [])].sort(), [toHex(a.eid), toHex(b.eid)].sort(), 'the certified set is not the honest pair');
    assert.equal(lateStake.status, 200, `the late lock's stake did not come back at once: ${lateStake.why}`);
    assert.ok(lateStake.verifies, 'the late stake\'s forfeit does not verify under the round\'s claim key');
    assert.equal(lateFee.status, 200, `the late lock's fee lock did not come back at once: ${lateFee.why}`);
    assert.ok(lateFee.verifies, 'the late fee lock\'s forfeit does not verify');
    assert.notEqual(certified.status, 200, 'a certified entry\'s stake was forfeited back before its round settled');
    assert.notEqual(lateEarly.status, 200, 'a lock outside the certificate came back inside the window, before a second certificate could reach the seat (kanban #2585)');
    for (const per of got.a) assert.equal(per, 'DELIVERED 2', JSON.stringify(got));
    for (const per of got.b) assert.equal(per, 'FAILED 0', JSON.stringify(got));
  } finally { await w.close(); }
});

test('2-of-2: no certificate by close + the window (VOID) - every lock is forfeited back at once', { timeout: 120000 }, async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS], closeAtEnd: { everyMs: 250 } }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 25000 });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const a = await lockAndPlay(w, player(), { hidden: { move: ROCK, salt: salt() }, noMarks: true });
    const close = Number(w.c.entryCloseMs);
    // INSIDE THE WINDOW: one seat down for the set, so no certificate - and no return yet (a certificate may still form)
    down(w.nodes[1]);
    skipTo(close + 50);
    await wait(400);
    const inWindow = await forfeitAt(w.nodes[0], w, a.eid);
    skipTo(close + LOCK_SET_WINDOW_MS + 2500);
    await wait(300);
    up(w.nodes[1]);
    const set = await lockSetAt(w.nodes[0], w);
    const stake = await forfeitAt(w.nodes[0], w, a.eid);
    const fee = await forfeitAt(w.nodes[0], w, a.eid, 'fee');
    console.log('  FACTS (#2561 VOID back):', JSON.stringify({ inWindow, void: set.void, certificate: !!set.certificate, stake, fee }));
    assert.notEqual(inWindow.status, 200, 'a stake came back inside the window, before the round could be known VOID');
    assert.equal(set.void, true, 'the round is not VOID');
    assert.equal(stake.status, 200, `a VOID round's stake did not come back at once: ${stake.why}`);
    assert.ok(stake.verifies, 'the forfeit does not verify');
    assert.equal(fee.status, 200, `a VOID round's fee lock did not come back at once: ${fee.why}`);
    assert.ok(fee.verifies, 'the fee lock\'s forfeit does not verify');
  } finally { up(w.nodes[1]); await w.close(); }
});

// FEEDBACK #018 / kanban #2511 (Hexbox, critical): the forfeit door read the lock by its entry alone and asked lockSetOut about the round the ASKER
// named - a certified loser of R1 named another protocol-28 round R2 of the same seats (VOID: every lock out) and had R1's stake and fee lock
// signed back after seeing the reveals. A lock goes back only through the round it stakes.
test('feedback #018: a certified entry of one round is not forfeited back by naming another protocol-28 round of the same seats (stake and fee lock)', { timeout: 180000 }, async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS], closeAtEnd: { everyMs: 250 } }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 25000 });
  try {
    const w2 = await openLockRound(w, { round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 30000 });
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const sa = salt(), sb = salt();
    const a = await lockAndPlay(w, player(), { hidden: { move: ROCK, salt: sa }, noMarks: true });
    const b = await lockAndPlay(w, player(), { hidden: { move: SCISSORS, salt: sb }, noMarks: true });
    skipTo(Number(w.c.entryCloseMs) + 50);
    let sets = [];
    for (let i = 0; i < 80 && !(sets.length && sets.every((s) => s.certificate)); i++) { await wait(50); sets = await Promise.all(w.nodes.map((d) => lockSetAt(d, w))); }
    for (const s of sets) assert.deepEqual([...(s.entries || [])].sort(), [toHex(a.eid), toHex(b.eid)].sort(), 'R1 is not certified with the pair');
    // R2: no entry, past its close + the window - VOID, every lock of it out
    skipTo(Math.max(Number(w2.c.entryCloseMs), Number(w.c.entryCloseMs)) + LOCK_SET_WINDOW_MS + 2500);
    await wait(600);
    const viaR2 = await Promise.all(w.nodes.map((d) => forfeitAt(d, w2, b.eid)));
    const feeViaR2 = await Promise.all(w.nodes.map((d) => forfeitAt(d, w2, b.eid, 'fee')));
    console.log('  FACTS (#018 cross-round forfeit):', JSON.stringify({ viaR2, feeViaR2 }));
    for (const x of [...viaR2, ...feeViaR2]) {
      assert.notEqual(x.status, 200, `R1's lock was signed back through R2: ${JSON.stringify(x)}`);
      assert.ok(!x.verifies, 'a signature over R1\'s lock came back through R2');
    }
  } finally { await w.close(); }
});
