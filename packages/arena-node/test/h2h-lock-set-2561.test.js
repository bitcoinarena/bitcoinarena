// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE CERTIFIED LOCK SET (protocol 28, kanban #2561, ruling #2116 (b); closes #1598). #1598: a player entered rock, paper and scissors under three
// session keys with no lock, read the honest move once reveals were out and locked only the winner. The refute chain found a way round every
// per-seat timing rule: a clock behind or ahead, a lying partner, a seat holding a reveal, the order replay as a second lock door, early reveals
// shutting honest locks out, a bogus in-flight lock. From protocol 28 the committee threshold-signs the set of locked entries at the close, no
// seat takes or serves a reveal before that certificate, only its entries are played, and without one by close + 3 s the round is VOID.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { b32, wait } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { RPS, RPS_CORE_HASH, RPS_CONFIG_HASH, RPS_GAME_ID } from './plugins/rps/index.js';
import { decodePlayerResult, splitSignedResult } from '../../arena-protocol/src/result.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { LOCK_SET_VERSION } from '../../arena-protocol/src/constants.js';
import { lockSetOf, lockSetId, lockSetSignatureId, encodeLockSetCertificate, LOCK_SET_WINDOW_MS } from '../../arena-protocol/src/lock-set.js';

// ON 2.0, 27 AND UP IS ALSO THE ARENA LOCK (arena-lock.js NAMED_CLAIM_VERSION, regtest's point 0): this fixture's locks are stock contracts, so its
// rounds sit below regtest's named-claim point by the harness switch, as a testnet4 round does (its point is none) - as gifts-in-fee-lock-1486 does
process.env.ARENA_DONATION_NETWORK = 'regtest'; process.env.ARENA_TEST_NAMED_CLAIM_HEIGHT = '999999999';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE, protocolVersion: LOCK_SET_VERSION };
const ROCK = 0, PAPER = 1, SCISSORS = 2;
let k = 0x40;
const player = () => ({ name: `p${k}`, key: b32(k++), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });
const salt = () => new Uint8Array(randomBytes(32));
const url = (d, path) => `http://127.0.0.1:${d.port}${path}`;
const revealAt = (nodes, played, move, s) => Promise.all(nodes.map(async (d) => {
  const r = await fetch(url(d, `/reveal?entry=${toHex(played.eid)}`), { method: 'POST', body: JSON.stringify({ move, salt: toHex(s) }) });
  return { status: r.status, why: r.status >= 300 ? (await r.text()).slice(0, 120) : '' };
}));
const outcomes = (nodes, w, eid) => nodes.map((d) => [...new Set(d.round.results(w.rid, eid).map((r) => { const p = decodePlayerResult(splitSignedResult(r.bytes).body); return `${p.outcome} ${p.score}`; }))].join('|'));
const decided = (nodes, w) => Promise.all(nodes.map((d) => fetch(url(d, `/api/round-result?round=${toHex(w.rid)}`)).then((x) => x.json())
  .then((j) => (j.players || []).filter((p) => p.outcome && p.signedBy > 0).length).catch(() => -1)));
const lockSetAt = async (d, w) => (await fetch(url(d, `/lock-set?round=${toHex(w.rid)}`))).json();
async function certAll(nodes, w, ms = 6000) {
  const until = Date.now() + ms;
  for (;;) {
    const got = await Promise.all(nodes.map((d) => lockSetAt(d, w)));
    if (got.every((s) => s.certificate) || Date.now() > until) return got;
    await wait(50);
  }
}
// THE SEAT IS DOWN for the lock set: it answers nothing and takes no part (its book does not step)
const down = (d) => { d.lockSets.silent = true; d.lockSets.step = async () => null; };
const up = (d) => { d.lockSets.silent = false; delete d.lockSets.step; };

test('2-of-2: the #1598 attack and its second doors - lockless entries, a late lock, a lock written after the close, an early reveal, a forged certificate - none plays; the honest pair does', async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS], closeAtEnd: { everyMs: 250 } }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 25000 });
  try {
    const [s0, s1] = w.nodes;
    skipTo(Number(w.c.committeeTimeMs) + 20);
    // the attacker: rock, paper and scissors under three fresh keys, no lock anywhere
    const moves = [ROCK, PAPER, SCISSORS], sx = moves.map(() => salt());
    const x = [];
    for (const m of moves) x.push(await lockAndPlay(w, player(), { hidden: { move: m, salt: sx[m] }, noMarks: true, only: [] }));
    const sa = salt(), sb = salt();
    const a = await lockAndPlay(w, player(), { hidden: { move: ROCK, salt: sa }, noMarks: true });
    // AN EARLY REVEAL (before the close) is refused and shuts no door: the honest lock after it is taken
    const early = await revealAt(w.nodes, x[0], ROCK, sx[ROCK]);
    const b = await lockAndPlay(w, player(), { hidden: { move: SCISSORS, salt: sb }, noMarks: true });
    // AT THE CLOSE, ONE SEAT DOWN FOR THE SET: no certificate, so no reveal is taken and none is served, whatever the clock says
    down(s1);
    skipTo(Number(w.c.entryCloseMs) + 50);
    await wait(600);
    const beforeCert = { reveal: await revealAt([s0], a, ROCK, sa), served: await (await fetch(url(s0, `/reveals?round=${toHex(w.rid)}`))).json(), set: await lockSetAt(s0, w) };
    // A FORGED CERTIFICATE: seat 0's own signature over a set naming the attacker's winning entry (paper beats rock), the threshold is 2
    const forgedSet = lockSetOf({ roundId: w.rid, entries: [a.eid, x[1].eid] });
    const at = BigInt(Number(w.c.entryCloseMs) + 100);
    const sig = schnorr.sign(lockSetSignatureId({ setId: lockSetId(forgedSet), atMs: at }), s0.round.identity.secret);
    const forged = encodeLockSetCertificate({ set: forgedSet, sigs: [{ key: s0.round.pubkey, atMs: at, sig }] });
    up(s1);
    const forgedTaken = await (await fetch(url(s1, `/lock-set?round=${toHex(w.rid)}`), { method: 'POST', body: JSON.stringify({ certificate: toHex(forged) }) })).json();
    // the honest certificate forms once seat 1 is back (inside the window)
    const sets = await certAll(w.nodes, w);
    const certMs = sets.map((s) => s.certifiedAtMs - Number(w.c.entryCloseMs));
    // AFTER THE CERTIFICATE: the attacker locks his winning entry (paper) - the door is shut; and a stake written straight into the store
    // (a second lock door: the order replay, a repair from a peer, an operator's hand) adds nothing to a certificate already signed
    let lateLock = 'taken';
    try { await lockAndPlay(w, player(), { hidden: { move: PAPER, salt: salt() }, noMarks: true }); } catch (e) { lateLock = String(e.message).split('\n')[0].slice(0, 120); }
    for (const d of w.nodes) d.round.putStakeSeen({ entryId: x[1].eid, paidMsat: w.c.stakeMsat, atMs: Number(w.c.entryCloseMs) - 10 });
    const xReveal = await revealAt(w.nodes, x[1], PAPER, sx[PAPER]);
    const aReveal = await revealAt(w.nodes, a, ROCK, sa);
    const bReveal = await revealAt(w.nodes, b, SCISSORS, sb);
    let n = [0, 0];
    for (let i = 0; i < 60 && !n.every((v) => v >= 2); i++) { await wait(100); n = await decided(w.nodes, w); }
    const got = { a: outcomes(w.nodes, w, a.eid), b: outcomes(w.nodes, w, b.eid), x: x.map((e) => outcomes(w.nodes, w, e.eid)) };
    console.log('  FACTS (#2561 attack):', JSON.stringify({ early, beforeCert, forgedTaken, certMs, entries: sets[0].entries && sets[0].entries.length, lateLock, xReveal, aReveal, bReveal, decided: n, got }));
    assert.ok(early.every((r) => r.status === 409), 'a reveal before the close was taken');
    assert.ok(beforeCert.reveal.every((r) => r.status === 409 && /not certified/.test(r.why)), `a reveal was taken before the certificate: ${JSON.stringify(beforeCert.reveal)}`);
    assert.deepEqual(beforeCert.served.reveals, [], 'a move was served before the certificate');
    assert.equal(beforeCert.set.certificate, null, 'a certificate formed with one seat of a 2-of-2 down');
    assert.equal(forgedTaken.certificate, false, 'a certificate with one signature of a 2-of-2 was taken');
    for (const s of sets) {
      assert.ok(s.certificate, 'no certificate at a seat');
      assert.deepEqual([...s.entries].sort(), [toHex(a.eid), toHex(b.eid)].sort(), 'the certified set is not the two locked players');
    }
    assert.notEqual(lateLock, 'taken', 'a lock after the close was taken');
    assert.ok(xReveal.every((r) => r.status === 409 && /not in the round's certified lock set/.test(r.why)), 'the attacker\'s uncertified entry revealed');
    assert.ok([...aReveal, ...bReveal].every((r) => r.status === 201 || r.status === 200), 'an honest reveal after the certificate was refused');
    for (const per of got.a) assert.equal(per, 'DELIVERED 2', JSON.stringify(got));
    for (const per of got.b) assert.equal(per, 'FAILED 0', JSON.stringify(got));
    for (const e of got.x) for (const per of e) assert.ok(per === '' || per === 'VOID 0', `an uncertified entry was played: ${JSON.stringify(got)}`);
  } finally { await w.close(); }
});

test('5-of-7, honest path: one seat slow (1.5 s), one seat down - the certificate forms inside the window and the round decides inside an 8 s round\'s slot', async () => {
  const w = await lockRound({ n: 7, serveOpts: { plugins: [NEXTBLOCK, RPS], closeAtEnd: { everyMs: 250 } }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 40000 });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const sa = salt(), sb = salt();
    const a = await lockAndPlay(w, player(), { hidden: { move: PAPER, salt: sa }, noMarks: true });
    const b = await lockAndPlay(w, player(), { hidden: { move: ROCK, salt: sb }, noMarks: true });
    const slow = w.nodes[5], gone = w.nodes[6], live = w.nodes.slice(0, 6);
    slow.lockSets.answerDelayMs = 1500;
    down(gone);
    const close = Number(w.c.entryCloseMs);
    skipTo(close);
    const t0 = Date.now();
    // THE PAGE: polls GET /lock-set, reveals once a certificate stands (arena-client revealWhenCertified does the same)
    let cert = null;
    while (!cert && Date.now() - t0 < LOCK_SET_WINDOW_MS + 2000) {
      const s = await Promise.all(live.slice(0, 5).map((d) => lockSetAt(d, w)));
      cert = s.find((x) => x.certificate) || null;
      if (!cert) await wait(50);
    }
    const certSeen = Date.now() - t0;
    const ra = await revealAt(w.nodes.slice(0, 6), a, PAPER, sa), rb = await revealAt(w.nodes.slice(0, 6), b, ROCK, sb);
    let n = live.map(() => 0);
    for (let i = 0; i < 100 && !n.slice(0, 5).every((v) => v >= 2); i++) { await wait(100); n = await decided(live, w); }
    const decidedMs = Date.now() - t0;
    const sets = await certAll(live, w, 4000);
    console.log('  FACTS (#2561 honest 5-of-7):', JSON.stringify({ certAtMs: cert && cert.certifiedAtMs - close, certSeenMs: certSeen, perSeatCert: sets.map((s) => s.certifiedAtMs && s.certifiedAtMs - close),
      ra: ra.map((r) => r.status), rb: rb.map((r) => r.status), decided: n, decidedMs, a: outcomes(live, w, a.eid), b: outcomes(live, w, b.eid) }));
    assert.ok(cert, 'no certificate with one seat slow and one down');
    assert.ok(cert.certifiedAtMs - close <= LOCK_SET_WINDOW_MS, 'the certificate is outside the window');
    assert.ok(certSeen < LOCK_SET_WINDOW_MS, `the page saw the certificate only ${certSeen} ms after the close`);
    assert.deepEqual([...cert.entries].sort(), [toHex(a.eid), toHex(b.eid)].sort());
    assert.ok(n.filter((v) => v >= 2).length >= 5, `fewer than 5 seats decided: ${JSON.stringify(n)}`);
    assert.ok(decidedMs < 8000, `decided ${decidedMs} ms after the close - outside an 8 s round's slot`);
    for (const per of outcomes(live.slice(0, 5), w, a.eid)) assert.equal(per, 'DELIVERED 2');
  } finally { up(w.nodes[6]); await w.close(); }
});

test('5-of-7, clocks: a seat 2 s behind takes the attacker\'s lock after the real close, a seat 2 s ahead closes early - the attacker is not certified, the round is VOID', async () => {
  const w = await lockRound({ n: 7, serveOpts: { plugins: [NEXTBLOCK, RPS], closeAtEnd: { everyMs: 250 } }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 40000 });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const sa = salt(), sc = salt();
    // one honest player only: the attacker's late entry would be the second seat (paper beats rock)
    const a = await lockAndPlay(w, player(), { hidden: { move: ROCK, salt: sa }, noMarks: true });
    const behind = w.nodes[0], ahead = w.nodes[1];
    behind.round.now = () => testNow() - 2000;
    ahead.round.now = () => testNow() + 2000;
    const close = Number(w.c.entryCloseMs);
    // the attacker's entry and lock reach only the seat that is behind, 500 ms after the real close (1.5 s before the close by its clock)
    skipTo(close + 500);
    let c = null, why = '';
    try { c = await lockAndPlay(w, player(), { hidden: { move: PAPER, salt: sc }, noMarks: true, unreached: [1, 2, 3, 4, 5, 6] }); } catch (e) { why = String(e.message).split('\n')[0].slice(0, 160); }
    const sets = await certAll(w.nodes, w, 8000);
    const cReveal = c ? await revealAt(w.nodes, c, PAPER, sc) : [];
    const aReveal = await revealAt(w.nodes, a, ROCK, sa);
    const behindView = (await lockSetAt(behind, w)).views.find((v) => v.key === toHex(behind.round.pubkey));
    console.log('  FACTS (#2561 clocks):', JSON.stringify({ attackerTakenAtBehind: !!c, why, behindViewNamesAttacker: !!(c && behindView && behindView.entries.includes(toHex(c.eid))),
      perSeat: sets.map((s) => ({ at: s.certifiedAtMs && s.certifiedAtMs - close, n: s.entries && s.entries.length })), cReveal: cReveal.map((r) => r.status), aReveal: aReveal.map((r) => r.status) }));
    assert.ok(c, `the seat that is behind did not take the late entry, so the variant did not run: ${why}`);
    for (const s of sets) {
      assert.ok(s.certificate, 'a seat holds no certificate');
      assert.deepEqual(s.entries, [toHex(a.eid)], 'the certified set is not the honest player alone');
    }
    assert.ok(cReveal.every((r) => r.status === 409 || r.status === 404), 'the late entry revealed');   // 404: a seat that never took it
    // one certified entry: nobody to play - the decide signs every entry VOID (head-to-head.js: fewer entries than the game's players)
  } finally { await w.close(); }
});
