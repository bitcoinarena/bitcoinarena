// SEATS RECORD ENTRY_VOID FROM THE PLAYER'S FIRST MARK (§16), AND FORWARD IT.
//
// The rule (protocol entry-void.js): a first mark signed at a tick after
// join_tick + the round's start deadline is ENTRY_VOID - the seat refuses it
// and keeps the signed mark as evidence. A first mark in time is not Void,
// even where one seat has not seen it. No first mark at all is NOT ENTRY_VOID
// (§15's walk-away, unbuilt, listed).
//
// Forwarding: a seat that takes a first mark hands it - with the batches it
// commits to - to the round's other seats, so a seat the player never reached
// holds it (and a late one is Void there too).
//
// Two in-process seats of a lock round, the fixture's delivering winner (join
// tick 0): a run of inputs 0..59, a mark at 60, inputs 60..1319, a mark at 1320.
// A LATE run is the same drive with its FIRST mark at 1320. The round omits the
// deadline: 900 ticks.
//
// MEASURED BEFORE (tools/entry-void-before.mjs, cc3102b): no seat records a
// Void, no seat forwards a mark, and a down seat caught up late turned DELIVERED.
import { test } from 'node:test';
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
  const dbB = openStore(':memory:');
  const a = await mk(openStore(':memory:'));
  let b = await mk(dbB);
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
    federationId: b32(0xfe), startDeadlineTicks: undefined };
  const rid = roundId(c);
  for (const d of [a, b]) {
    const r = await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: encodeRoundContract(c) });
    assert.equal(r.status, 201, await r.text());
    assumeSeated(d.round, rid, c.nodes);
  }
  for (let pass = 0; pass < 2; pass++) for (const d of [a, b]) await d.dkg.run(c.nodes);
  return {
    a, get b() { return b; }, c, rid, port, claimPk: a.dkg.seatFor(c.nodes).pool.groupPublicKey,
    async downB() { await b.close(); },
    async upB() { b = await mk(dbB, bPort); wire(); },
    async close() { await a.close(); try { await b.close(); } catch { /* already down */ } },
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
  return { entry, eid, outpoint, messages, firstId };
}

const answer = (s) => (typeof s === 'string' ? (s.length > 30 && !s.startsWith('error') ? 'receipt' : s.slice(0, 90)) : 'receipt');
const holdsFirst = (d, run) => d.round.holdsMark(run.firstId);
async function outcomeAt(d, w, run) {
  const v = d.round.entryVoid(run.eid);
  const results = d.round.results(w.rid, run.eid).map((r) => decodePlayerResult(splitSignedResult(r.bytes).body).outcome);
  const f = await fetch(`http://127.0.0.1:${d.port}/forfeit?round=${toHex(w.rid)}&entry=${toHex(run.eid)}`);
  return { entryVoid: v ? `ENTRY_VOID at ${v.markTick} > ${v.lastTick}` : null, results: [...new Set(results)], finality: resultFinality(d.round, w.rid, run.eid).state,
    forfeit: f.status };
}
async function closeAndSettle(w, run) {
  await Promise.all([say(w.a.port, `close ${toHex(w.rid)}`), say(w.b.port, `close ${toHex(w.rid)}`)]);
  for (let t = Date.now(); Date.now() - t < 15000; await wait(250)) {
    const f = await fetch(`http://127.0.0.1:${w.a.port}/forfeit?round=${toHex(w.rid)}&entry=${toHex(run.eid)}`);
    if (f.ok || !/before the result is final/.test(await f.text())) break;
  }
}
const untilForwarded = async (d, run) => { for (let t = Date.now(); Date.now() - t < 5000; await wait(100)) if (holdsFirst(d, run) || d.round.entryVoid(run.eid)) return true; return false; };

test('a first mark in time is not Void - at both seats with the player at both, and at B by forward when the player reaches only A', async () => {
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
      a: { entryVoid: null, results: ['DELIVERED'], finality: 'FINAL', forfeit: 200 },
      b: { entryVoid: null, results: ['DELIVERED'], finality: 'FINAL', forfeit: 200 } });
  } finally { await w.close(); }
});

test('a first mark after join + deadline is ENTRY_VOID at the seat it reaches, and at the other by forward; nothing is DELIVERED', async () => {
  const w = await seats();
  try {
    const run = await seatAndBuild(w, { firstAt: END });
    const saidA = [];
    for (const m of run.messages) saidA.push(answer(await say(w.a.port, m)));
    const forwarded = await untilForwarded(w.b, run);
    await closeAndSettle(w, run);
    const facts = { firstMarkTick: END, saidA: saidA.map((s) => s.replace(/: the first mark.*/, '')), bVoidByForward: forwarded,
      a: await outcomeAt(w.a, w, run), b: await outcomeAt(w.b, w, run), aStoredTheMark: holdsFirst(w.a, run) };
    console.log('  FACTS (late):', JSON.stringify(facts));
    assert.deepEqual(facts, { firstMarkTick: 1320, saidA: ['1320', 'error ENTRY_VOID'], bVoidByForward: true,
      a: { entryVoid: 'ENTRY_VOID at 1320 > 900', results: [], finality: null, forfeit: 409 },
      b: { entryVoid: 'ENTRY_VOID at 1320 > 900', results: [], finality: null, forfeit: 409 },
      aStoredTheMark: false });
  } finally { await w.close(); }
});

test('a down seat caught up late with a late first mark does not turn DELIVERED: it is ENTRY_VOID there too', async () => {
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
    assert.deepEqual(facts, { saidA: ['1320', 'error ENTRY_VOID'], saidB: ['1320', 'error ENTRY_VOID'],
      a: { entryVoid: 'ENTRY_VOID at 1320 > 900', results: [], finality: null, forfeit: 409 },
      b: { entryVoid: 'ENTRY_VOID at 1320 > 900', results: [], finality: null, forfeit: 409 } });
  } finally { await w.close(); }
});

test('no first mark at all is not ENTRY_VOID at either seat (the §15 walk-away stays a hole, not a Void)', async () => {
  const w = await seats();
  try {
    const run = await seatAndBuild(w);
    await closeAndSettle(w, run);
    const facts = { a: await outcomeAt(w.a, w, run), b: await outcomeAt(w.b, w, run),
      lockHeld: w.port.locks.has(`${toHex(run.outpoint.txid)}:${run.outpoint.outIdx}`) };
    console.log('  FACTS (no mark):', JSON.stringify(facts));
    assert.deepEqual(facts, { a: { entryVoid: null, results: [], finality: null, forfeit: 409 },
      b: { entryVoid: null, results: [], finality: null, forfeit: 409 }, lockHeld: true });
  } finally { await w.close(); }
});
