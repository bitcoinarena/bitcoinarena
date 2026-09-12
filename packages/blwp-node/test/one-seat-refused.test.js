// ONE SEAT REFUSED: §13C'S VOID AFTER THE RESULT WINDOW (M3.3-34, ruled 2026-09-12).
//
// A seated entry's on-time first mark reaches seat A; seat B is UP and refuses
// it - here because B has not seen the stake lock - so the mark is receipted by
// 1 of 2. No result can reach the threshold, and nothing shows the player caused
// it: §13C's "the fault is on the operator side -> the entry becomes VOID, the
// stake is refunded by letting the HTLC expire, and the entry is excluded from
// the pool and from the payout table". Both seats HOLD until the result window
// has passed - not at the close - and then record VOID, final, not HOLDING. The
// lock stays held (no act: it returns at its expiry); the forfeit door is 409.
// Not FORFEIT (walk-away, late start) and not ENTRY_VOID (§16, an outage: a seat
// that answered and refused was up). When the refusals are the player's own
// equivocation (§13B) it is FORFEIT instead. A seat that cannot be reached keeps
// the hold going; a refusal later made good ends as the run's own outcome.
//
// MEASURED BEFORE (scratchpad probe on this fixture): A 1 receipt, the offer to
// B "refused"; at the close both seats HOLDING - 3 attempts at 2 s, 12 and 11 at
// 10 s - no result, finality null, no Void, forfeit 409 at both, lock held: a
// hold for ever.
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
const END = WINNER.ticks;                      // 1320

async function seats() {
  const port = lockPort();
  const mk = (db, p = 0) => serve(db, { port: p, ...opts, stakeLocks: port, poolCurve: curve, finality: { everyMs: 100 } });
  const dbA = openStore(':memory:');
  const dbB = openStore(':memory:');
  let a = await mk(dbA);
  let b = await mk(dbB);
  const bPort = b.port;
  const wire = () => {
    for (const [d, o] of [[a, b], [b, a]]) {
      const there = [`http://127.0.0.1:${o.port}`];
      d.verifier.peers = there; d.payouts.peers = there; d.preimages.peers = there; d.dkg.peers = there;
    }
  };
  wire();
  const c = { ...contractFor([a.round.pubkey, b.round.pubkey], BigInt(WINDOW_MS), [a, b].map((d) => `http://127.0.0.1:${d.port}`)),
    federationId: b32(0xfe), startDeadlineTicks: undefined };
  const rid = roundId(c);
  for (const d of [a, b]) {
    assert.equal((await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: encodeRoundContract(c) })).status, 201);
    assumeSeated(d.round, rid, c.nodes);
  }
  for (let pass = 0; pass < 2; pass++) for (const d of [a, b]) await d.dkg.run(c.nodes);
  return {
    get a() { return a; }, get b() { return b; }, c, rid, port, claimPk: a.dkg.seatFor(c.nodes).pool.groupPublicKey,
    async downB() { await b.close(); },
    async upB() { b = await mk(dbB, bPort); wire(); },
    async close() { try { await a.close(); } catch { /* down */ } try { await b.close(); } catch { /* down */ } },
  };
}

/**
 * Seated at both seats; the stake lock posted to the seats named in `lockAt`
 * (a seat not given it has not seen the stake, and refuses the entry's marks).
 * `messages`: the run - a first mark at 60, a mark at 1320. `alt`: another
 * first mark at 90 and a mark at 120 on it - the player's second chain.
 */
async function seatAndBuild(w, { lockAt = ['a', 'b'] } = {}) {
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
  const lockOn = async (d) => assert.equal((await fetch(`http://127.0.0.1:${d.port}/lock?entry=${toHex(eid)}`,
    { method: 'POST', body: JSON.stringify(lockFieldsToJson(fields)) })).status, 201);
  for (const [name, d] of [['a', w.a], ['b', w.b]]) {
    const base = `http://127.0.0.1:${d.port}`;
    assert.equal((await fetch(`${base}/handout`, { method: 'POST', body: encodeHandout(dealt.handout) })).status, 201);
    assert.equal((await fetch(`${base}/entry`, { method: 'POST', body: encodeEntryContract(entry) })).status, 201);
    if (lockAt.includes(name)) await lockOn(d);
  }
  const sign = (m) => joinSigned(encodeCheckpoint(m), ed25519.sign(checkpointId(m), session));
  const batchOf = (from, to, previousHash) => ({ roundId: w.rid, entryId: eid, previousHash, firstTick: from,
    ticks: Array.from({ length: to - from }, (_, t) => wordsAt(from + t)), liquidations: [] });
  const markOf = (tick, h, input, previousHash) => ({ roundId: w.rid, entryId: eid, tick, stateHash: h,
    inputChainHash: batchId(input), previousHash, sessionPubkey: entry.sessionPubkey });
  const chain = (ticks) => {
    const st = init(seedWordForEntry(entry, RANDOMNESS));
    const out = [];
    let from = 0; let prevBatch = GENESIS_HASH; let prevMark = NO_PREVIOUS; let first = null;
    for (const to of ticks) {
      for (let t = from; t < to; t++) step(st, ...wordsAt(t));
      const b = batchOf(from, to, prevBatch);
      const m = markOf(to, Uint8Array.from(stateHash(st).match(/../g).map((x) => parseInt(x, 16))), b, prevMark);
      out.push(encodeInputBatch(b), sign(m));
      if (!first) first = checkpointId(m);
      from = to; prevBatch = batchId(b); prevMark = checkpointId(m);
    }
    return { messages: out, firstId: first };
  };
  const run = chain([60, END]);
  const alt = chain([90, 120]);
  return { eid, outpoint, messages: run.messages, firstId: run.firstId, alt: alt.messages, altFirstId: alt.firstId, lockOn };
}

async function at(d, w, run) {
  const rs = d.round.results(w.rid, run.eid).map((r) => decodePlayerResult(splitSignedResult(r.bytes).body));
  const f = await fetch(`http://127.0.0.1:${d.port}/forfeit?round=${toHex(w.rid)}&entry=${toHex(run.eid)}`);
  const pub = await fetch(`http://127.0.0.1:${d.port}/results?round=${toHex(w.rid)}&entry=${toHex(run.eid)}`);
  const closing = ((await (await fetch(`http://127.0.0.1:${d.port}/closing?round=${toHex(w.rid)}`)).json())
    .find((s) => s.entry === toHex(run.eid))) || null;
  const nq = d.round.noQuorum(run.eid);
  return {
    receipts: Math.max(d.round.receiptCount(run.firstId), d.round.receiptCount(run.altFirstId)),
    results: [...new Set(rs.map((p) => `${p.outcome}/${p.score}`))],
    finality: resultFinality(d.round, w.rid, run.eid).state,
    noQuorum: nq ? nq.outcome : null, entryVoid: !!d.round.entryVoid(run.eid), refusedHere: !!d.round.refusedFirstMark(run.eid),
    closing: closing && { state: closing.state, attempts: closing.attempts, why: String(closing.lastWhy).slice(0, 60) },
    forfeit: { status: f.status, why: (await f.text()).slice(0, 60) },
    publicResults: { signed: Number(pub.headers.get('x-results')), noQuorum: pub.headers.get('x-no-quorum') },
    payoutTable: d.round.payout(w.rid) ? d.round.payout(w.rid).state : null,
  };
}
const until = async (fn, ms = 20000) => { for (let t = Date.now(); Date.now() - t < ms; await wait(200)) if (await fn()) return true; return false; };
const lockHeld = (w, run) => w.port.locks.has(`${toHex(run.outpoint.txid)}:${run.outpoint.outIdx}`);
const brief = (x) => ({ results: x.results, finality: x.finality, noQuorum: x.noQuorum, entryVoid: x.entryVoid, closing: x.closing && x.closing.state,
  forfeit: x.forfeit.status, publicResults: x.publicResults, payoutTable: x.payoutTable });
const VOIDED = { results: [], finality: 'VOID', noQuorum: 'VOID', entryVoid: false, closing: 'VOID', forfeit: 409,
  publicResults: { signed: 0, noQuorum: 'VOID' }, payoutTable: null };

test('one seat refused (1): B is up and refuses the on-time first mark - both HOLD until the result window, then both record VOID, the lock held', async () => {
  const w = await seats();
  try {
    const run = await seatAndBuild(w, { lockAt: ['a'] });
    const saidB = [];
    for (const m of run.messages) { await say(w.a.port, m); saidB.push(String(await say(w.b.port, m)).slice(0, 40)); }
    await until(() => w.b.round.refusedFirstMark(run.eid) && Object.values(w.a.round.firstMarkOffers(run.eid)).includes('refused'));
    const offersAtA = w.a.round.firstMarkOffers(run.eid);
    await Promise.all([say(w.a.port, `close ${toHex(w.rid)}`), say(w.b.port, `close ${toHex(w.rid)}`)]);
    // WAITED ON, NOT SLEPT ON: read once both seats' closes have recorded the
    // hold - in the full suite a close can take longer than a fixed sleep. The
    // assertions below (HOLDING, "no quorum yet", nothing decided) are what show
    // the read came inside the result window.
    await until(async () => (await Promise.all([w.a, w.b].map(async (d) => ((await (await fetch(
      `http://127.0.0.1:${d.port}/closing?round=${toHex(w.rid)}`)).json()).some((s) => s.entry === toHex(run.eid)))))).every(Boolean), 10000);
    const inWindow = { a: await at(w.a, w, run), b: await at(w.b, w, run) };
    await until(() => w.a.round.noQuorum(run.eid) && w.b.round.noQuorum(run.eid));
    await wait(300);
    const after = { a: await at(w.a, w, run), b: await at(w.b, w, run), lockHeld: lockHeld(w, run) };
    console.log('  FACTS (refused, 1):', JSON.stringify({ saidB, offersAtA, inWindow, after }));
    assert.deepEqual(Object.values(offersAtA), ['refused']);
    assert.equal(inWindow.a.receipts, 1);
    for (const s of ['a', 'b']) {
      assert.equal(inWindow[s].closing.state, 'HOLDING', s);
      assert.match(inWindow[s].closing.why, /no quorum yet/, s);
      assert.equal(inWindow[s].noQuorum, null, s);
      assert.deepEqual(brief(after[s]), VOIDED, s);
    }
    assert.equal(after.a.refusedHere, false);
    assert.equal(after.b.refusedHere, true);
    assert.equal(after.lockHeld, true);
  } finally { await w.close(); }
});

test('one seat refused (2): the refusals are the player\'s own two first marks - FORFEIT at both seats, not VOID', async () => {
  const w = await seats();
  try {
    const run = await seatAndBuild(w);
    await w.downB();
    // The player's first chain to A (B is down: its forward goes unanswered)...
    for (const m of run.messages.slice(0, 2)) await say(w.a.port, m);
    await w.upB();
    // ...and a second first chain to B: B takes it and hands its first mark to A,
    // which refuses it (it holds another); each seat refuses the other's.
    for (const m of run.alt) await say(w.b.port, m);
    for (const m of run.messages.slice(0, 2)) await say(w.a.port, m);
    await wait(1000);
    const offers = { a: w.a.round.firstMarkOffers(run.eid), b: w.b.round.firstMarkOffers(run.eid) };
    await Promise.all([say(w.a.port, `close ${toHex(w.rid)}`), say(w.b.port, `close ${toHex(w.rid)}`)]);
    await until(() => w.a.round.noQuorum(run.eid) && w.b.round.noQuorum(run.eid));
    const after = { a: await at(w.a, w, run), b: await at(w.b, w, run), lockHeld: lockHeld(w, run),
      proofs: { a: w.a.round.equivocation(w.rid, run.eid).length, b: w.b.round.equivocation(w.rid, run.eid).length } };
    console.log('  FACTS (refused, 2 - equivocation):', JSON.stringify({ offers, after }));
    for (const s of ['a', 'b']) {
      assert.equal(after[s].noQuorum, 'FORFEIT', s);
      assert.equal(after[s].finality, 'FORFEIT', s);
      assert.equal(after[s].closing.state, 'FORFEIT', s);
      assert.equal(after[s].entryVoid, false, s);
      assert.deepEqual(after[s].results, [], s);
    }
    assert.equal(after.lockHeld, true);
  } finally { await w.close(); }
});

test('one seat refused (4): the refusing seat is unreachable at the close - A holds past the window, no VOID; back, both VOID', async () => {
  const w = await seats();
  try {
    const run = await seatAndBuild(w, { lockAt: ['a'] });
    for (const m of run.messages) { await say(w.a.port, m); await say(w.b.port, m); }
    await until(() => w.b.round.refusedFirstMark(run.eid) && Object.values(w.a.round.firstMarkOffers(run.eid)).includes('refused'));
    await w.downB();
    assert.equal(await say(w.a.port, `close ${toHex(w.rid)}`), 'closed');
    await wait(WINDOW_MS + 2000);
    const pastWindowBDown = await at(w.a, w, run);
    await w.upB();
    assert.equal(await say(w.b.port, `close ${toHex(w.rid)}`), 'closed');
    await until(() => w.a.round.noQuorum(run.eid) && w.b.round.noQuorum(run.eid));
    const after = { a: await at(w.a, w, run), b: await at(w.b, w, run), lockHeld: lockHeld(w, run) };
    console.log('  FACTS (refused, 4 - peer unreachable):', JSON.stringify({ pastWindowBDown, after }));
    assert.equal(pastWindowBDown.closing.state, 'HOLDING');
    assert.match(pastWindowBDown.closing.why, /waiting on 1 seat/);
    assert.equal(pastWindowBDown.noQuorum, null);
    assert.equal(pastWindowBDown.finality, null);
    for (const s of ['a', 'b']) assert.deepEqual(brief(after[s]), VOIDED, s);
    assert.equal(after.lockHeld, true);
  } finally { await w.close(); }
});

test('one seat refused (5, 6): B refuses, then sees the stake and takes the mark in time - 2 of 2, the run\'s own outcome, FINAL, never voided', async () => {
  const w = await seats();
  try {
    const run = await seatAndBuild(w, { lockAt: ['a'] });
    for (const m of run.messages.slice(0, 2)) { await say(w.a.port, m); await say(w.b.port, m); }
    await until(() => w.b.round.refusedFirstMark(run.eid));
    const refusedFirst = !!w.b.round.refusedFirstMark(run.eid);
    await run.lockOn(w.b);                                  // B sees the stake now
    const saidB = [];
    for (const m of run.messages.slice(0, 2)) saidB.push(String(await say(w.b.port, m)).slice(0, 30));
    for (const m of run.messages.slice(2)) for (const d of [w.a, w.b]) await say(d.port, m);
    await Promise.all([say(w.a.port, `close ${toHex(w.rid)}`), say(w.b.port, `close ${toHex(w.rid)}`)]);
    await until(() => [w.a, w.b].every((d) => resultFinality(d.round, w.rid, run.eid).state === 'FINAL'));
    await wait(WINDOW_MS + 1500);                           // long past the result window
    const after = { a: await at(w.a, w, run), b: await at(w.b, w, run) };
    console.log('  FACTS (refused, 5/6 - made good):', JSON.stringify({ refusedFirst, saidB, after }));
    assert.equal(refusedFirst, true);
    for (const s of ['a', 'b']) {
      assert.equal(after[s].receipts, 2, s);
      assert.deepEqual(after[s].results.map((r) => r.split('/')[0]), ['DELIVERED'], s);
      assert.equal(after[s].finality, 'FINAL', s);
      assert.equal(after[s].noQuorum, null, s);
      assert.equal(after[s].publicResults.signed, 2, s);
      assert.equal(after[s].publicResults.noQuorum, null, s);
    }
  } finally { await w.close(); }
});
