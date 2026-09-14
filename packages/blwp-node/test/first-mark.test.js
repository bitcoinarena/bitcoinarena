// A LATE FIRST MARK IS FORFEIT AT BOTH SEATS (§15, §13C), AND IS FORWARDED.
//
// The rule (protocol first-mark.js): a first mark signed at a tick after
// join_tick + the round's start deadline is the player's own late start -
// FORFEIT, not ENTRY_VOID: a refund the player could choose by starting late is
// one §13C forbids. The seat refuses the mark and keeps it as evidence. A first
// mark in time decides nothing, even where one seat has not seen it. No first
// mark at all is FORFEIT at the round's close (§15's walk-away, ruled
// 2026-09-12: protocol stoppedOutcome) - never ENTRY_VOID, never a refund.
//
// Forwarding: a seat that takes or refuses a first mark hands it - with the
// batches it commits to - to the round's other seats, so a seat the player
// never reached holds it (and a late one is FORFEIT there too).
//
// Two in-process seats of a lock round, the fixture's delivering winner (join
// tick 0): a run of inputs 0..59, a mark at 60, inputs 60..1319, a mark at 1320.
// A LATE run is the same drive with its FIRST mark at 1320. The round omits the
// deadline: 900 ticks. The lock is not spent: until W4 a FORFEIT lock refunds
// at expiry, the money hole every loser has.
//
// MEASURED BEFORE (tools/entry-void-before.mjs, cc3102b): no seat recorded
// anything for a late start, no seat forwarded a mark, and a down seat caught
// up late turned DELIVERED.
import { test } from 'node:test';
import { TEST_FEDERATION_ID } from '../../protocol/src/test-federation.js';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { feldmanGroup, tweakPoint } from '../src/curve.js';
import { resultFinality } from '../src/finality.js';
import { assumeSeated } from './seating.js';
import { lockPort } from './lock-fixture.js';
import { b32, rand, RANDOMNESS, STAKE, WINDOW_MS, WINNER, GENESIS_HASH, wordsAt, contractFor, say, secretScalar, opts, wait } from './window-fixture.js';
import { encodeRoundContract, roundId, encodeEntryContract, entryId } from '../../protocol/src/contracts.js';
import { START_DEADLINE_TICKS } from '../../protocol/src/constants.js';
import { dealHandout, encodeHandout, handoutId } from '../../protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../protocol/src/shares.js';
import { encodeInputBatch, batchId } from '../../protocol/src/batch.js';
import { encodeCheckpoint, checkpointId, joinSigned, NO_PREVIOUS } from '../../protocol/src/checkpoint.js';
import { decodePlayerResult, splitSignedResult } from '../../protocol/src/result.js';
import { init, step } from '../../core/src/sim.js';
import { hash as stateHash } from '../../core/src/state.js';
import { seedWordForEntry } from '../../protocol/src/seed.js';
import { netStakeMsat } from '../../protocol/src/payout.js';
import { entryFeeMsat } from '../../protocol/src/fee.js';
import { refundKeyOf, lockFieldsToJson } from '../../protocol/src/stake-lock.js';
import { toHex, sha256 } from '../../protocol/src/hash.js';

const curve = { ...feldmanGroup, tweakPoint };
const END = WINNER.ticks;                      // 1320: the run delivers here

async function seats() {
  const port = lockPort();
  const mk = (db, p = 0) => serve(db, { port: p, ...opts, stakeLocks: port, poolCurve: curve, finality: { everyMs: 100 } });
  const dbA = openStore(':memory:');
  const dbB = openStore(':memory:');
  let a = await mk(dbA);
  let b = await mk(dbB);
  const aPort = a.port;
  const bPort = b.port;
  const wire = () => {
    for (const [d, o] of [[a, b], [b, a]]) {
      const there = [`http://127.0.0.1:${o.port}`];
      d.verifier.peers = there; d.payouts.peers = there; d.preimages.peers = there; d.dkg.peers = there;
    }
  };
  wire();
  // THIS ROUND NAMES NO START DEADLINE: it gets the page's own window, 900 -
  // not the 1400 the fixture's settling rounds name past their planted marks.
  const c = { ...contractFor([a.round.pubkey, b.round.pubkey], BigInt(WINDOW_MS), [a, b].map((d) => `http://127.0.0.1:${d.port}`)),
    custody: 'FEDERATION', federationId: TEST_FEDERATION_ID, startDeadlineTicks: undefined };
  const rid = roundId(c);
  for (const d of [a, b]) {
    const r = await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: encodeRoundContract(c) });
    assert.equal(r.status, 201, await r.text());
    assumeSeated(d.round, rid, c.nodes);
  }
  for (let pass = 0; pass < 2; pass++) for (const d of [a, b]) await d.dkg.run(c.nodes);
  return {
    get a() { return a; }, get b() { return b; }, c, rid, port, claimPk: a.dkg.seatFor(c.nodes).pool.groupPublicKey,
    async downA() { await a.close(); },
    async upA() { a = await mk(dbA, aPort); wire(); },
    async downB() { await b.close(); },
    async upB() { b = await mk(dbB, bPort); wire(); },
    async close() { try { await a.close(); } catch { /* already down */ } try { await b.close(); } catch { /* already down */ } },
  };
}

/** Seated and locked at both seats; the run's messages, with its first mark at `firstAt`. */
async function seatAndBuild(w, { firstAt = 60 } = {}) {
  const session = ed25519.utils.randomSecretKey();
  const preimage = secretScalar();
  const e = rand(32);
  const dealt = await dealHandout({ preimage, seats: w.c.nodes, roundId: w.rid, playerPubkey: WINNER.key,
    ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e), coefficients: [scalarFrom32(rand(32)) % FIELD], needed: 2, curve: feldmanGroup });
  const outpoint = { txid: rand(32), outIdx: 0n };
  const entry = {
    roundId: w.rid, playerPubkey: WINNER.key, sessionPubkey: ed25519.getPublicKey(session),
    stakeCommitment: sha256(preimage), stakeMsat: STAKE, feeMsat: entryFeeMsat(STAKE), donationMsat: 0n,
    joinTick: 0, worldSecret: WINNER.worldSecret, vssSharesRef: handoutId(dealt.handout), stakePoint: dealt.handout.commitments[0],
    feePreimage: new Uint8Array(32), stakeLockOutpoint: outpoint, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n },
    claimKeyAttestationRef: b32(0x9a),
  };
  const eid = entryId(entry);
  const fields = { paymentImage: { kind: 'point', bytes: entry.stakePoint }, amountMsat: netStakeMsat(entry), claimPk: w.claimPk,
    refundPk: refundKeyOf(WINNER.key), expiration: w.port.height + 200 };
  await w.port.put(outpoint, fields);
  for (const d of [w.a, w.b]) {
    const base = `http://127.0.0.1:${d.port}`;
    assert.equal((await fetch(`${base}/handout`, { method: 'POST', body: encodeHandout(dealt.handout) })).status, 201);
    assert.equal((await fetch(`${base}/entry`, { method: 'POST', body: encodeEntryContract(entry) })).status, 201);
    assert.equal((await fetch(`${base}/lock?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(fields)) })).status, 201);
  }
  const st = init(seedWordForEntry(entry, RANDOMNESS));
  const hashAt = (upTo, from) => { for (let t = from; t < upTo; t++) step(st, ...wordsAt(t)); return Uint8Array.from(stateHash(st).match(/../g).map((x) => parseInt(x, 16))); };
  const sign = (m) => joinSigned(encodeCheckpoint(m), ed25519.sign(checkpointId(m), session));
  const batchOf = (from, to, previousHash) => ({ roundId: w.rid, entryId: eid, previousHash, firstTick: from,
    ticks: Array.from({ length: to - from }, (_, t) => wordsAt(from + t)), liquidations: [] });
  const markOf = (tick, stateHashAt, input, previousHash) => ({ roundId: w.rid, entryId: eid, tick, stateHash: stateHashAt,
    inputChainHash: batchId(input), previousHash, sessionPubkey: entry.sessionPubkey });
  let messages;
  let firstId;
  if (firstAt < END) {
    const b1 = batchOf(0, firstAt, GENESIS_HASH);
    const m1 = markOf(firstAt, hashAt(firstAt, 0), b1, NO_PREVIOUS);
    const b2 = batchOf(firstAt, END, batchId(b1));
    const m2 = markOf(END, hashAt(END, firstAt), b2, checkpointId(m1));
    messages = [encodeInputBatch(b1), sign(m1), encodeInputBatch(b2), sign(m2)];
    firstId = checkpointId(m1);
  } else {
    const b1 = batchOf(0, END, GENESIS_HASH);
    const m1 = markOf(END, hashAt(END, 0), b1, NO_PREVIOUS);
    messages = [encodeInputBatch(b1), sign(m1)];
    firstId = checkpointId(m1);
  }
  // AND A LATE FIRST MARK FOR THE SAME ENTRY, under the same session key: its
  // first batch 0..1319 and a first mark at 1320 - the other half of a player
  // who sent an on-time first mark to one seat and a late one to another.
  const lateSt = init(seedWordForEntry(entry, RANDOMNESS));
  for (let t = 0; t < END; t++) step(lateSt, ...wordsAt(t));
  const lb = batchOf(0, END, GENESIS_HASH);
  const lm = markOf(END, Uint8Array.from(stateHash(lateSt).match(/../g).map((x) => parseInt(x, 16))), lb, NO_PREVIOUS);
  const late = [encodeInputBatch(lb), sign(lm)];
  // AND A SECOND ON-TIME FIRST MARK (tick 30, from nothing): the other half of a
  // player who sent one on-time first mark to one seat and a different one to another.
  const otherSt = init(seedWordForEntry(entry, RANDOMNESS));
  for (let t = 0; t < 30; t++) step(otherSt, ...wordsAt(t));
  const ob = batchOf(0, 30, GENESIS_HASH);
  const om = markOf(30, Uint8Array.from(stateHash(otherSt).match(/../g).map((x) => parseInt(x, 16))), ob, NO_PREVIOUS);
  const other = [encodeInputBatch(ob), sign(om)];
  return { entry, eid, outpoint, messages, firstId, late, other };
}

const answer = (s) => (typeof s === 'string' ? (s.length > 30 && !s.startsWith('error') ? 'receipt' : s.slice(0, 90)) : 'receipt');
const holdsFirst = (d, run) => d.round.holdsMark(run.firstId);
async function outcomeAt(d, w, run) {
  const v = d.round.startForfeit(run.eid);
  const results = d.round.results(w.rid, run.eid).map((r) => decodePlayerResult(splitSignedResult(r.bytes).body).outcome);
  const f = await fetch(`http://127.0.0.1:${d.port}/forfeit?round=${toHex(w.rid)}&entry=${toHex(run.eid)}`);
  return { lateStart: v ? `FORFEIT at ${v.markTick} > ${v.lastTick}` : null, results: [...new Set(results)], finality: resultFinality(d.round, w.rid, run.eid).state,
    forfeit: f.status };
}
async function closeAndSettle(w, run) {
  await Promise.all([say(w.a.port, `close ${toHex(w.rid)}`), say(w.b.port, `close ${toHex(w.rid)}`)]);
  for (let t = Date.now(); Date.now() - t < 15000; await wait(250)) {
    const f = await fetch(`http://127.0.0.1:${w.a.port}/forfeit?round=${toHex(w.rid)}&entry=${toHex(run.eid)}`);
    if (f.ok || !/before the result is final/.test(await f.text())) break;
  }
}
const untilForwarded = async (d, run) => { for (let t = Date.now(); Date.now() - t < 5000; await wait(100)) if (holdsFirst(d, run) || d.round.startForfeit(run.eid)) return true; return false; };

test('a first mark in time decides nothing - at both seats with the player at both, and at B by forward when the player reaches only A', async () => {
  const w = await seats();
  try {
    const run = await seatAndBuild(w);
    // THE PLAYER REACHES ONLY A with the first batch and mark; A forwards them to B.
    const saidA = [];
    for (const m of run.messages.slice(0, 2)) saidA.push(answer(await say(w.a.port, m)));
    const forwarded = await untilForwarded(w.b, run);
    const bReceipted = w.b.round.receiptCount(run.firstId);
    // AND THE REST OF THE RUN TO BOTH, so it can settle.
    for (const m of run.messages.slice(2)) for (const d of [w.a, w.b]) await say(d.port, m);
    await closeAndSettle(w, run);
    const facts = { deadline: START_DEADLINE_TICKS, firstMarkTick: 60, saidA, bHoldsTheFirstMarkByForward: forwarded,
      receiptsOfTheFirstMarkAtB: bReceipted, a: await outcomeAt(w.a, w, run), b: await outcomeAt(w.b, w, run) };
    console.log('  FACTS (in time):', JSON.stringify(facts));
    assert.deepEqual(facts, { deadline: 900, firstMarkTick: 60, saidA: ['60', 'receipt'], bHoldsTheFirstMarkByForward: true,
      receiptsOfTheFirstMarkAtB: 2,
      a: { lateStart: null, results: ['DELIVERED'], finality: 'FINAL', forfeit: 200 },
      b: { lateStart: null, results: ['DELIVERED'], finality: 'FINAL', forfeit: 200 } });
  } finally { await w.close(); }
});

test('a first mark after join + deadline is FORFEIT at the seat it reaches, and at the other by forward; nothing is DELIVERED', async () => {
  const w = await seats();
  try {
    const run = await seatAndBuild(w, { firstAt: END });
    const saidA = [];
    for (const m of run.messages) saidA.push(answer(await say(w.a.port, m)));
    const forwarded = await untilForwarded(w.b, run);
    await closeAndSettle(w, run);
    const facts = { firstMarkTick: END, saidA: saidA.map((s) => s.replace(/: the first mark.*/, '')), bForfeitByForward: forwarded,
      a: await outcomeAt(w.a, w, run), b: await outcomeAt(w.b, w, run), aStoredTheMark: holdsFirst(w.a, run) };
    console.log('  FACTS (late):', JSON.stringify(facts));
    // RULED 2026-09-12 (M3.3-34, late start at close): signed FORFEIT at the
    // close, FINAL 2 of 2. Measured before: results [], finality null.
    assert.deepEqual(facts, { firstMarkTick: 1320, saidA: ['1320', 'error FORFEIT'], bForfeitByForward: true,
      a: { lateStart: 'FORFEIT at 1320 > 900', results: ['FORFEIT'], finality: 'FINAL', forfeit: 409 },
      b: { lateStart: 'FORFEIT at 1320 > 900', results: ['FORFEIT'], finality: 'FINAL', forfeit: 409 },
      aStoredTheMark: false });
  } finally { await w.close(); }
});

test('a down seat caught up late with a late first mark does not turn DELIVERED: it is FORFEIT there too', async () => {
  const w = await seats();
  try {
    const run = await seatAndBuild(w, { firstAt: END });
    await w.downB();
    const saidA = [];
    for (const m of run.messages) saidA.push(answer(await say(w.a.port, m)));
    await w.upB();
    const saidB = [];
    for (const m of run.messages) saidB.push(answer(await say(w.b.port, m)));
    await closeAndSettle(w, run);
    const facts = { saidA: saidA.map((s) => s.replace(/: the first mark.*/, '')), saidB: saidB.map((s) => s.replace(/: the first mark.*/, '')),
      a: await outcomeAt(w.a, w, run), b: await outcomeAt(w.b, w, run) };
    console.log('  FACTS (caught up late):', JSON.stringify(facts));
    // RULED 2026-09-12 (M3.3-34, late start at close): signed FORFEIT at the
    // close, FINAL 2 of 2. Measured before: results [], finality null.
    assert.deepEqual(facts, { saidA: ['1320', 'error FORFEIT'], saidB: ['1320', 'error FORFEIT'],
      a: { lateStart: 'FORFEIT at 1320 > 900', results: ['FORFEIT'], finality: 'FINAL', forfeit: 409 },
      b: { lateStart: 'FORFEIT at 1320 > 900', results: ['FORFEIT'], finality: 'FINAL', forfeit: 409 } });
  } finally { await w.close(); }
});

// MEASURED BEFORE the ruling (2026-09-12, no-mark-probe.mjs): no result at either
// seat, finality null, and the lock back to the player at its expiry.
test('no first mark at all is FORFEIT at both seats at the close - final 2 of 2, never ENTRY_VOID, the lock not handed back', async () => {
  const w = await seats();
  try {
    const run = await seatAndBuild(w);
    await closeAndSettle(w, run);
    const facts = { a: await outcomeAt(w.a, w, run), b: await outcomeAt(w.b, w, run),
      lockHeld: w.port.locks.has(`${toHex(run.outpoint.txid)}:${run.outpoint.outIdx}`) };
    console.log('  FACTS (no mark):', JSON.stringify(facts));
    assert.deepEqual(facts, { a: { lateStart: null, results: ['FORFEIT'], finality: 'FINAL', forfeit: 409 },
      b: { lateStart: null, results: ['FORFEIT'], finality: 'FINAL', forfeit: 409 }, lockHeld: true });
  } finally { await w.close(); }
});

// LATE START AT THE CLOSE (M3.3-34, ruled 2026-09-12). A seated player whose
// first mark came after join tick + the start deadline has forfeited, whenever
// the close comes: FORFEIT, score 0, over the empty receipted transcript,
// signed by both seats, FINAL 2 of 2 - not VOID, not ENTRY_VOID, not FAILED,
// nothing refunded, the lock held. The same FORFEIT 0 as no mark at all,
// whichever seat recorded the late mark. MEASURED BEFORE: FORFEIT recorded at
// the door, no signed result at either seat, finality null.
async function signedAt(d, w, run) {
  const rs = d.round.results(w.rid, run.eid).map((r) => decodePlayerResult(splitSignedResult(r.bytes).body));
  const f = await fetch(`http://127.0.0.1:${d.port}/forfeit?round=${toHex(w.rid)}&entry=${toHex(run.eid)}`);
  return { lateStart: !!d.round.startForfeit(run.eid), results: [...new Set(rs.map((p) => `${p.outcome}/${p.score}`))],
    transcripts: [...new Set(rs.map((p) => toHex(p.transcriptHash).slice(0, 16)))],
    signers: new Set(d.round.results(w.rid, run.eid).map((r) => toHex(r.nodePubkey))).size,
    finality: resultFinality(d.round, w.rid, run.eid).state, entryVoid: !!d.round.entryVoid(run.eid), forfeit: f.status };
}
const transcriptsAcross = (x, y) => new Set([...x.transcripts, ...y.transcripts]).size;
const lockHeldOf = (w, run) => w.port.locks.has(`${toHex(run.outpoint.txid)}:${run.outpoint.outIdx}`);
const closingOf = async (d, w, run) => ((await (await fetch(`http://127.0.0.1:${d.port}/closing?round=${toHex(w.rid)}`)).json())
  .find((s) => s.entry === toHex(run.eid)) || null);
const finalAtBoth = async (w, run, ms = 20000) => {
  for (let t = Date.now(); Date.now() - t < ms; await wait(250))
    if ([w.a, w.b].every((d) => resultFinality(d.round, w.rid, run.eid).state === 'FINAL')) return true;
  return false;
};
const SIGNED_FORFEIT_0 = { results: ['FORFEIT/0'], signers: 2, finality: 'FINAL', entryVoid: false, forfeit: 409 };
const brief = (s) => ({ results: s.results, signers: s.signers, finality: s.finality, entryVoid: s.entryVoid, forfeit: s.forfeit });

test('late start at close (1): a late first mark at both seats is signed FORFEIT 0 by both, one transcript, FINAL 2 of 2, the lock held', async () => {
  const w = await seats();
  try {
    const run = await seatAndBuild(w, { firstAt: END });
    for (const m of run.messages) await say(w.a.port, m);
    await untilForwarded(w.b, run);
    await closeAndSettle(w, run);
    const a = await signedAt(w.a, w, run);
    const b = await signedAt(w.b, w, run);
    const facts = { a, b, transcriptsAcrossSeats: transcriptsAcross(a, b), lockHeld: lockHeldOf(w, run) };
    console.log('  FACTS (late close 1):', JSON.stringify(facts));
    assert.deepEqual({ a: { ...brief(a), lateStart: a.lateStart }, b: { ...brief(b), lateStart: b.lateStart }, n: facts.transcriptsAcrossSeats, lockHeld: facts.lockHeld },
      { a: { ...SIGNED_FORFEIT_0, lateStart: true }, b: { ...SIGNED_FORFEIT_0, lateStart: true }, n: 1, lockHeld: true });
  } finally { await w.close(); }
});

test('late start at close (2): seat B down, then caught up late - both sign the same FORFEIT 0, FINAL 2 of 2', async () => {
  const w = await seats();
  try {
    const run = await seatAndBuild(w, { firstAt: END });
    await w.downB();
    for (const m of run.messages) await say(w.a.port, m);
    await w.upB();
    for (const m of run.messages) await say(w.b.port, m);
    await closeAndSettle(w, run);
    const a = await signedAt(w.a, w, run);
    const b = await signedAt(w.b, w, run);
    const facts = { a, b, transcriptsAcrossSeats: transcriptsAcross(a, b), lockHeld: lockHeldOf(w, run) };
    console.log('  FACTS (late close 2):', JSON.stringify(facts));
    assert.deepEqual({ a: { ...brief(a), lateStart: a.lateStart }, b: { ...brief(b), lateStart: b.lateStart }, n: facts.transcriptsAcrossSeats, lockHeld: facts.lockHeld },
      { a: { ...SIGNED_FORFEIT_0, lateStart: true }, b: { ...SIGNED_FORFEIT_0, lateStart: true }, n: 1, lockHeld: true });
  } finally { await w.close(); }
});

test('late start at close (3): the late mark reached A only and its forward was lost - B never saw it, and both still sign the same FORFEIT 0', async () => {
  const w = await seats();
  try {
    const run = await seatAndBuild(w, { firstAt: END });
    await w.downB();
    for (const m of run.messages) await say(w.a.port, m);
    await w.upB();                              // nobody catches B up
    await wait(1000);
    const bSawIt = !!w.b.round.startForfeit(run.eid);
    await closeAndSettle(w, run);
    const a = await signedAt(w.a, w, run);
    const b = await signedAt(w.b, w, run);
    const facts = { bSawTheLateMarkBeforeTheClose: bSawIt, a, b, transcriptsAcrossSeats: transcriptsAcross(a, b), lockHeld: lockHeldOf(w, run) };
    console.log('  FACTS (late close 3):', JSON.stringify(facts));
    assert.equal(bSawIt, false, 'B was handed the late mark: this is not the case the test names');
    assert.deepEqual({ a: { ...brief(a), lateStart: a.lateStart }, b: { ...brief(b), lateStart: b.lateStart }, n: facts.transcriptsAcrossSeats, lockHeld: facts.lockHeld },
      { a: { ...SIGNED_FORFEIT_0, lateStart: true }, b: { ...SIGNED_FORFEIT_0, lateStart: false }, n: 1, lockHeld: true });
  } finally { await w.close(); }
});

test('late start at close (4): the peer is down at the close - the seat holds, signs nothing, and both sign FORFEIT 0 when it is back', async () => {
  const w = await seats();
  try {
    const run = await seatAndBuild(w, { firstAt: END });
    for (const m of run.messages) await say(w.a.port, m);
    await untilForwarded(w.b, run);
    await w.downB();
    assert.equal(await say(w.a.port, `close ${toHex(w.rid)}`), 'closed');
    await wait(1500);
    const held = await closingOf(w.a, w, run);
    const whileDown = await signedAt(w.a, w, run);
    await w.upB();
    assert.equal(await say(w.b.port, `close ${toHex(w.rid)}`), 'closed');
    const final = await finalAtBoth(w, run);
    const a = await signedAt(w.a, w, run);
    const b = await signedAt(w.b, w, run);
    const facts = { held: held && { state: held.state, attempts: held.attempts, why: String(held.lastWhy).slice(0, 40) },
      whileDown: brief(whileDown), final, a, b, transcriptsAcrossSeats: transcriptsAcross(a, b), lockHeld: lockHeldOf(w, run) };
    console.log('  FACTS (late close 4):', JSON.stringify(facts));
    assert.equal(held.state, 'HOLDING');
    assert.match(held.lastWhy, /waiting on 1 seat/);
    assert.deepEqual(whileDown.results, []);
    assert.equal(whileDown.signers, 0);
    assert.deepEqual({ a: brief(a), b: brief(b), n: facts.transcriptsAcrossSeats, lockHeld: facts.lockHeld },
      { a: SIGNED_FORFEIT_0, b: SIGNED_FORFEIT_0, n: 1, lockHeld: true });
  } finally { await w.close(); }
});

// THE GUARD (ruled required): a seat holding only a late first mark waits while
// any other seat is unreachable, because that seat may hold an on-time first
// mark. How such a conflict resolves is ENTRY_VOID territory - parked; only the
// hold is measured here.
test('late start at close (5): an on-time first mark at B and a late one at A, B down at A\'s close - A holds and signs nothing', async () => {
  const w = await seats();
  try {
    const run = await seatAndBuild(w);
    await w.downA();
    const saidB = [];
    for (const m of run.messages.slice(0, 2)) saidB.push(answer(await say(w.b.port, m)));
    await w.upA();
    const saidA = [];
    for (const m of run.late) saidA.push(answer(await say(w.a.port, m)).replace(/: the first mark.*/, ''));
    await wait(500);
    const bHeld = { onTimeFirstMark: holdsFirst(w.b, run), lateStart: !!w.b.round.startForfeit(run.eid) };
    await w.downB();
    assert.equal(await say(w.a.port, `close ${toHex(w.rid)}`), 'closed');
    await wait(1500);
    const held = await closingOf(w.a, w, run);
    const atA = await signedAt(w.a, w, run);
    const facts = { saidB, saidA, bBeforeItWentDown: bHeld, aLateStart: atA.lateStart,
      held: held && { state: held.state, attempts: held.attempts, why: String(held.lastWhy).slice(0, 40) }, atA: brief(atA) };
    console.log('  FACTS (late close 5, guard):', JSON.stringify(facts));
    assert.equal(bHeld.onTimeFirstMark, true, 'B does not hold the on-time first mark: this is not the case the test names');
    assert.equal(atA.lateStart, true, 'A recorded no late start: this is not the case the test names');
    assert.equal(held.state, 'HOLDING');
    // THE REASON, RULED 2026-09-13 (M3.3-34, Plan A): A now holds the proof of the
    // two first marks before its close - B's FORFEIT answer to A's forward makes A
    // pull it - and a seat holding the proof does not wait on a down seat. It still
    // holds and signs nothing; before Plan A this read "waiting on 1 seat".
    assert.match(held.lastWhy, /no quorum yet: the player signed two first marks for this entry - one of them late \(§13B\)/);
    assert.deepEqual(atA.results, []);
    assert.equal(atA.signers, 0);
  } finally { await w.close(); }
});

// TWO FIRST MARKS ARE THE PLAYER'S EQUIVOCATION (§13B), NOT AN OUTAGE (M3, the
// guard case's leftover): an on-time first mark to B while A was down, and a
// late one to A. The player signed two chains from one parent, so the entry is
// FORFEIT - never ENTRY_VOID, which would refund a stake the player chose to
// split (§13C: "a player cannot manufacture a refund").
test('late start at close (5b): an on-time first mark at B and a late one at A, both seats up at the close - FORFEIT, never ENTRY_VOID or a refund', async () => {
  const w = await seats();
  try {
    const run = await seatAndBuild(w);
    await w.downA();
    for (const m of run.messages.slice(0, 2)) await say(w.b.port, m);      // on time, to B only (A down)
    await w.upA();
    for (const m of run.late) await say(w.a.port, m);                       // late, to A
    await wait(1000);
    const before = { bOnTime: holdsFirst(w.b, run), aLate: !!w.a.round.startForfeit(run.eid), bLate: !!w.b.round.startForfeit(run.eid),
      offersAtB: w.b.round.firstMarkOffers(run.eid) };
    await Promise.all([say(w.a.port, `close ${toHex(w.rid)}`), say(w.b.port, `close ${toHex(w.rid)}`)]);
    await wait(WINDOW_MS + 3000);
    const at2 = async (d) => {
      const s = await signedAt(d, w, run);
      const nq = d.round.noQuorum(run.eid);
      return { entryVoid: s.entryVoid, results: s.results, finality: s.finality, noQuorum: nq ? nq.outcome : null, forfeit: s.forfeit };
    };
    const after = { a: await at2(w.a), b: await at2(w.b), lockHeld: lockHeldOf(w, run) };
    console.log('  FACTS (late close 5b, two first marks):', JSON.stringify({ before, after }));
    assert.equal(before.bOnTime, true, 'B does not hold the on-time first mark: not the case the test names');
    assert.equal(before.aLate, true, 'A recorded no late start: not the case the test names');
    for (const s of ['a', 'b']) {
      assert.equal(after[s].entryVoid, false, `${s} recorded ENTRY_VOID: a refund for the player's own two first marks`);
      assert.notEqual(after[s].forfeit, 200, `${s} forfeited the lock to the player`);
      assert.ok(after[s].results.includes('FORFEIT/0') || after[s].noQuorum === 'FORFEIT', `${s} did not reach FORFEIT: ${JSON.stringify(after[s])}`);
    }
    assert.equal(after.lockHeld, true);
  } finally { await w.close(); }
});

// THE OTHER ORDER (5b's NOT COVERED): B decides its outage BEFORE the late first
// mark reaches it - the player's chain passes the line at B while A is down, so
// B records ENTRY_VOID - and only then does the player send A a late first mark.
// RULED (2026-09-12): two first marks are FORFEIT at both seats, never a refund,
// even after a real outage-Void; B's Void stays as history, B signs no refund.
// MEASURED BEFORE: A 409 when asked first, then B's forfeit showed A the Void,
// A recorded it, and B's door answered 200 - a refund signed 2 of 2.
test('late start at close (5c): B records ENTRY_VOID on a real outage, then the player sends A a late first mark - FORFEIT at both, no refund signed, the lock held', async () => {
  const w = await seats();
  try {
    const run = await seatAndBuild(w);
    await w.downA();
    for (const m of run.messages) await say(w.b.port, m);                   // on time, then past the line, to B only (A down)
    await wait(500);
    const bVoidFirst = !!w.b.round.entryVoid(run.eid);
    await w.upA();
    for (const m of run.late) await say(w.a.port, m);                       // late, to A
    await wait(1000);
    const before = { bVoidFirst, aLate: !!w.a.round.startForfeit(run.eid), aHoldsOnTime: holdsFirst(w.a, run),
      aVoid: !!w.a.round.entryVoid(run.eid), proofAtA: w.a.round.equivocation(w.rid, run.eid).length, proofAtB: w.b.round.equivocation(w.rid, run.eid).length };
    await Promise.all([say(w.a.port, `close ${toHex(w.rid)}`), say(w.b.port, `close ${toHex(w.rid)}`)]);
    await wait(WINDOW_MS + 3000);
    const at2 = async (d) => {
      const s = await signedAt(d, w, run);
      const nq = d.round.noQuorum(run.eid);
      return { entryVoid: s.entryVoid, results: s.results, finality: s.finality, noQuorum: nq ? nq.outcome : null, forfeit: s.forfeit,
        proof: d.round.equivocation(w.rid, run.eid).length };
    };
    // Each seat's forfeit door is asked - A, then B, then A again (B's door may show A its Void).
    const after = { a: await at2(w.a), b: await at2(w.b) };
    after.aAgain = (await fetch(`http://127.0.0.1:${w.a.port}/forfeit?round=${toHex(w.rid)}&entry=${toHex(run.eid)}`)).status;
    after.aVoidAfterDoors = !!w.a.round.entryVoid(run.eid);
    after.forfeitKept = [w.a, w.b].map((d) => !!d.round.forfeit(run.eid));
    after.lockHeld = lockHeldOf(w, run);
    console.log('  FACTS (late close 5c, ENTRY_VOID first):', JSON.stringify({ before, after }));
    assert.equal(before.bVoidFirst, true, 'B did not record ENTRY_VOID before the late mark: not the case the test names');
    assert.equal(before.aLate, true, 'A recorded no late start: not the case the test names');
    for (const s of ['a', 'b']) {
      assert.equal(after[s].noQuorum, 'FORFEIT', `${s} did not decide FORFEIT: ${JSON.stringify(after[s])}`);
      assert.equal(after[s].finality, 'FORFEIT', `${s}'s finality is not FORFEIT: ${JSON.stringify(after[s])}`);
      assert.equal(after[s].forfeit, 409, `${s} will sign the refund of the lock to the player`);
    }
    assert.equal(after.aAgain, 409, 'A signs the refund once B has shown it the Void');
    assert.equal(after.b.entryVoid, true, 'B\'s ENTRY_VOID record was not kept as history');
    assert.equal(after.aVoidAfterDoors, false, 'A recorded ENTRY_VOID from B\'s evidence');
    assert.deepEqual(after.forfeitKept, [false, false], 'a seat keeps a refund of the lock');
    assert.equal(after.lockHeld, true);
  } finally { await w.close(); }
});

// A SECOND ON-TIME FIRST MARK AFTER THE VOID (M3.3-34, ruled 2026-09-12, path 1):
// B down, A records ENTRY_VOID on a real outage, B back - and the player sends B
// a DIFFERENT on-time first mark. Same-mark Void evidence only: B refuses it and
// keeps the pair; FORFEIT at both, no refund signed, the lock held.
test('late start at close (5d): A records ENTRY_VOID on a real outage, then the player sends B a different on-time first mark - FORFEIT at both, no refund signed, the lock held', async () => {
  const w = await seats();
  try {
    const run = await seatAndBuild(w);
    await w.downB();
    for (const m of run.messages) await say(w.a.port, m);                   // on time, then past the line, to A only (B down)
    await wait(500);
    const aVoidFirst = !!w.a.round.entryVoid(run.eid);
    await w.upB();
    const saidB = [];
    for (const m of run.other) saidB.push(answer(await say(w.b.port, m)));  // a different on-time first mark, to B
    await wait(1000);
    const aDoor = await (await fetch(`http://127.0.0.1:${w.a.port}/entry-void?entry=${toHex(run.eid)}`)).json().catch(() => null);
    const before = { aVoidFirst, saidB, bVoid: !!w.b.round.entryVoid(run.eid),
      aVoidDoor: aDoor && { evidenceKind: aDoor.evidenceKind, evidence: !!aDoor.evidence, receipt: !!aDoor.receipt },
      bPeers: w.b.verifier.peersOf(w.rid).length,
      proofAtA: w.a.round.equivocation(w.rid, run.eid).length, proofAtB: w.b.round.equivocation(w.rid, run.eid).length };
    await Promise.all([say(w.a.port, `close ${toHex(w.rid)}`), say(w.b.port, `close ${toHex(w.rid)}`)]);
    await wait(WINDOW_MS + 3000);
    const at2 = async (d) => {
      const s = await signedAt(d, w, run);
      const nq = d.round.noQuorum(run.eid);
      return { entryVoid: s.entryVoid, results: s.results, finality: s.finality, noQuorum: nq ? nq.outcome : null, forfeit: s.forfeit,
        proof: d.round.equivocation(w.rid, run.eid).length };
    };
    // Each seat's forfeit door - B, then A (whose door may show B its Void), then B again.
    const after = { b: await at2(w.b), a: await at2(w.a) };
    after.bAgain = (await fetch(`http://127.0.0.1:${w.b.port}/forfeit?round=${toHex(w.rid)}&entry=${toHex(run.eid)}`)).status;
    after.bVoidAfterDoors = !!w.b.round.entryVoid(run.eid);
    after.forfeitKept = [w.a, w.b].map((d) => !!d.round.forfeit(run.eid));
    after.lockHeld = lockHeldOf(w, run);
    console.log('  FACTS (late close 5d, a second on-time first mark after the Void):', JSON.stringify({ before, after }));
    assert.equal(before.aVoidFirst, true, 'A did not record ENTRY_VOID before the second mark: not the case the test names');
    for (const s of ['a', 'b']) {
      assert.equal(after[s].noQuorum, 'FORFEIT', `${s} did not decide FORFEIT: ${JSON.stringify(after[s])}`);
      assert.equal(after[s].finality, 'FORFEIT', `${s}'s finality is not FORFEIT: ${JSON.stringify(after[s])}`);
      assert.equal(after[s].forfeit, 409, `${s} will sign the refund of the lock to the player`);
    }
    assert.equal(after.bAgain, 409, 'B signs the refund once A has shown it the Void');
    assert.equal(after.a.entryVoid, true, 'A\'s ENTRY_VOID record was not kept as history');
    assert.equal(after.bVoidAfterDoors, false, 'B recorded ENTRY_VOID for a different first mark than the one A voided');
    assert.deepEqual(after.forfeitKept, [false, false], 'a seat keeps a refund of the lock');
    assert.equal(after.lockHeld, true);
  } finally { await w.close(); }
});

// A VOID SEAT THAT MISSED THE LATE MARK'S FORWARD (M3.3-34, ruled, path 2): A
// down, B records ENTRY_VOID; A back; B down while the player sends A a late
// first mark - so A's forward of it to B is lost; B back. The late mark is
// pullable proof: after the window, BEFORE any forfeit door is asked (a door can
// show a seat the Void and make the pair there), both seats hold the pair and
// close FORFEIT; then no door signs a refund, and the lock is held.
test('late start at close (5e): B records ENTRY_VOID, the late first mark reaches only A and its forward to B is lost - pulled at the close, FORFEIT at both, no refund', async () => {
  const w = await seats();
  try {
    const run = await seatAndBuild(w);
    await w.downA();
    for (const m of run.messages) await say(w.b.port, m);                   // on time, then past the line, to B only (A down)
    await wait(500);
    const bVoidFirst = !!w.b.round.entryVoid(run.eid);
    await w.upA();
    await w.downB();
    for (const m of run.late) await say(w.a.port, m);                       // late, to A - its forward to B is lost (B down)
    await wait(500);
    await w.upB();
    await wait(500);
    const before = { bVoidFirst, aLate: !!w.a.round.startForfeit(run.eid), aVoid: !!w.a.round.entryVoid(run.eid),
      proofAtA: w.a.round.equivocation(w.rid, run.eid).length, proofAtB: w.b.round.equivocation(w.rid, run.eid).length };
    await Promise.all([say(w.a.port, `close ${toHex(w.rid)}`), say(w.b.port, `close ${toHex(w.rid)}`)]);
    await wait(WINDOW_MS + 3000);
    const state = (d) => {
      const nq = d.round.noQuorum(run.eid);
      return { entryVoid: !!d.round.entryVoid(run.eid), noQuorum: nq ? nq.outcome : null, finality: resultFinality(d.round, w.rid, run.eid).state,
        proof: d.round.equivocation(w.rid, run.eid).length, results: d.round.results(w.rid, run.eid).length };
    };
    const pulled = { a: state(w.a), b: state(w.b) };                        // after the window, before any door
    const door = async (d) => (await fetch(`http://127.0.0.1:${d.port}/forfeit?round=${toHex(w.rid)}&entry=${toHex(run.eid)}`)).status;
    const doors = { b: await door(w.b), a: await door(w.a), bAgain: await door(w.b) };
    const after = { aVoid: !!w.a.round.entryVoid(run.eid), forfeitKept: [w.a, w.b].map((d) => !!d.round.forfeit(run.eid)), lockHeld: lockHeldOf(w, run) };
    console.log('  FACTS (late close 5e, the late mark\'s forward lost):', JSON.stringify({ before, pulled, doors, after }));
    assert.equal(before.bVoidFirst, true, 'B did not record ENTRY_VOID first: not the case the test names');
    assert.equal(before.aLate, true, 'A recorded no late start: not the case the test names');
    assert.equal(before.proofAtB, 0, 'B holds the pair before the close: the forward was not lost - not the case the test names');
    for (const s of ['a', 'b']) {
      assert.equal(pulled[s].noQuorum, 'FORFEIT', `${s} did not decide FORFEIT from the pull: ${JSON.stringify(pulled[s])}`);
      assert.equal(pulled[s].finality, 'FORFEIT', `${s}'s finality is not FORFEIT: ${JSON.stringify(pulled[s])}`);
    }
    assert.ok(pulled.b.proof >= 1, 'B never pulled the late mark: the Void seat has no pair');
    assert.equal(pulled.b.entryVoid, true, 'B\'s ENTRY_VOID record was not kept as history');
    assert.deepEqual(doors, { b: 409, a: 409, bAgain: 409 }, 'a forfeit door signs the refund of the lock to the player');
    assert.equal(after.aVoid, false, 'A recorded ENTRY_VOID from B\'s evidence');
    assert.deepEqual(after.forfeitKept, [false, false], 'a seat keeps a refund of the lock');
    assert.equal(after.lockHeld, true);
  } finally { await w.close(); }
});

test('late start at close (7): a late mark after both seats have signed FORFEIT 0 changes nothing - the same result, the same transcript', async () => {
  const w = await seats();
  try {
    const run = await seatAndBuild(w);
    await closeAndSettle(w, run);
    const beforeA = await signedAt(w.a, w, run);
    const beforeB = await signedAt(w.b, w, run);
    const saidA = [];
    for (const m of run.late) saidA.push(answer(await say(w.a.port, m)).slice(0, 60));
    await wait(1000);
    const a = await signedAt(w.a, w, run);
    const b = await signedAt(w.b, w, run);
    const facts = { before: { a: brief(beforeA), b: brief(beforeB), transcripts: [...new Set([...beforeA.transcripts, ...beforeB.transcripts])] },
      saidA, after: { a: brief(a), b: brief(b), transcripts: [...new Set([...a.transcripts, ...b.transcripts])] }, lockHeld: lockHeldOf(w, run) };
    console.log('  FACTS (late close 7):', JSON.stringify(facts));
    assert.deepEqual(facts.before.a, SIGNED_FORFEIT_0);
    assert.deepEqual(facts.after, { a: SIGNED_FORFEIT_0, b: SIGNED_FORFEIT_0, transcripts: facts.before.transcripts });
    assert.equal(facts.before.transcripts.length, 1);
    assert.equal(facts.lockHeld, true);
  } finally { await w.close(); }
});
