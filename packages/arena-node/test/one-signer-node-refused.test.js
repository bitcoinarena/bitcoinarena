// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// ONE SIGNER NODE REFUSED: §13C'S VOID AFTER THE RESULT WINDOW (M3.3-34, ruled 2026-09-12).
//
// A joined entry's on-time first mark reaches signer node A; signer node B is UP and refuses
// it - here because B has not seen the stake lock - so the mark is receipted by
// 1 of 2. No result can reach the threshold, and nothing shows the player caused
// it: §13C's "the fault is on the operator side -> the entry becomes VOID, the
// stake is refunded by letting the HTLC expire, and the entry is excluded from
// the pool and from the payout table". Both signer nodes HOLD until the result window
// has passed - not at the close - and then record VOID, final, not HOLDING. The
// lock stays held (no act: it returns at its expiry); the forfeit door is 409.
// Not FORFEIT (walk-away, late start) and not ENTRY_VOID (§16, an outage: a signer node
// that answered and refused was up). When the refusals are the player's own
// equivocation (§13B) it is FORFEIT instead. A signer node that cannot be reached keeps
// the hold going; a refusal later made good ends as the run's own outcome.
//
// MEASURED BEFORE (scratchpad probe on this fixture): A 1 receipt, the offer to
// B "refused"; at the close both signer nodes HOLDING - 3 attempts at 2 s, 12 and 11 at
// 10 s - no result, finality null, no Void, forfeit 409 at both, lock held: a
// hold for ever.
import { testNow, skipTo } from './test-clock.js';
import { roundEndMs } from '../../arena-protocol/src/first-mark.js';
import { CLOCK } from './block-clock.js';
import { test } from 'node:test';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { feldmanGroup, tweakPoint } from '../src/curve.js';
import { resultFinality, resultWindow } from '../src/finality.js';
import { assumeAssigned } from './assignment.js';
import { lockPort, bondedChainSlot, bondedChainFor } from './lock-fixture.js';
import { b32, rand, RANDOMNESS, STAKE, WINDOW_MS, WINNER, GENESIS_HASH, wordsAt, playFor, warmPlay, contractFor, say, secretScalar, opts, wait, presentDay } from './window-fixture.js';
import { encodeRoundContract, roundId, encodeEntryContract, entryId } from '../../arena-protocol/src/contracts.js';
import { dealHandout, encodeHandout, handoutId } from '../../arena-protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../arena-protocol/src/shares.js';
import { encodeInputBatch, batchId } from '../../arena-protocol/src/batch.js';
import { encodeCheckpoint, checkpointId, joinSigned, NO_PREVIOUS } from '../../arena-protocol/src/checkpoint.js';
import { decodePlayerResult, splitSignedResult } from '../../arena-protocol/src/result.js';
import { init, step } from '../../nextblock/src/sim.js';
import { loaded, bedFrom } from './window-fixture.js';
import { hash as stateHash } from '../../nextblock/src/state.js';
import { seedWordForEntry } from '../../arena-protocol/src/seed.js';
import { netStakeMsat } from '../../arena-protocol/src/payout.js';
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { refundKeyOf, lockFieldsToJson } from '../../arena-protocol/src/stake-lock.js';
import { toHex, sha256 } from '../../arena-protocol/src/hash.js';
import { HOSTED } from './plugins/hosted.js';

const curve = { ...feldmanGroup, tweakPoint };
const END = WINNER.ticks;                      // 1320

async function signerNodes({ endIn = 9000, lagB = 0 } = {}) {
  // A CHAIN THAT BONDS THE ROUND'S TWO SIGNER NODES (RULED 2026-09-25), as lockRound in lock-round-fixture.js: both are
  // running daemons, so the claim key is their own live DKG; the round's beacon is that chain's, and the player seeds from it.
  const slot = bondedChainSlot(lockPort());
  const port = slot.port;
  const mk = (db, p = 0) => serve(db, { plugins: HOSTED, port: p, ...opts, stakeLocks: port, poolCurve: curve, finality: { everyMs: 100 }, chainFor: slot.chainFor, randomnessFor: slot.randomnessFor });
  const dbA = openStore(':memory:');
  const dbB = openStore(':memory:');
  let a = await mk(dbA);
  // `lagB`: B's chain view runs this many ms behind the clock - a node that has not got the latest blocks yet.
  const mkB = (db, p = 0) => serve(db, { plugins: HOSTED, port: p, ...opts, stakeLocks: port, poolCurve: curve, finality: { everyMs: 100 }, chainFor: slot.chainFor, randomnessFor: slot.randomnessFor,
    ...(lagB ? { windowChain: function lagging() { return CLOCK.viewAt(this.now() - lagB); } } : {}) });
  let b = await mkB(dbB);
  const bPort = b.port;
  const wire = () => {
    for (const [d, o] of [[a, b], [b, a]]) {
      const there = [`http://127.0.0.1:${o.port}`];
      d.verifier.peers = there; d.stakeSecrets.peers = there; d.dkg.peers = there;
    }
  };
  wire();
  const base = { ...contractFor([a.round.pubkey, b.round.pubkey], BigInt(WINDOW_MS), [a, b].map((d) => `http://127.0.0.1:${d.port}`)),
    custody: 'FEDERATION', federationId: TEST_FEDERATION_ID, startDeadlineTicks: undefined };
  // `endIn`: THE ROUND IN THE PRESENT, its contract end this many ms from now (§13C's window opens at it).
  const drafted = endIn === null ? base : presentDay(base, testNow() + endIn);
  const c = { ...drafted, censusRoot: bondedChainFor(drafted.nodes, drafted, slot,
    { endpoints: [a, b].map((d) => `ws://127.0.0.1:${d.port}`) }).censusRoot };
  const rid = roundId(c);
  const randomness = slot.randomnessFor({ contract: c }).hash;
  for (const d of [a, b]) {
    assert.equal((await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: encodeRoundContract(c) })).status, 201);
    assumeAssigned(d.round, rid, c.nodes);
  }
  for (let pass = 0; pass < 2; pass++) for (const d of [a, b]) await d.dkg.run(c.nodes);
  return {
    get a() { return a; }, get b() { return b; }, c, rid, port, randomness, claimPk: a.dkg.signerNodeFor(c.nodes).pool.groupPublicKey,
    async downB() { await b.close(); },
    async upB() { b = await mkB(dbB, bPort); wire(); },
    async close() { try { await a.close(); } catch { /* down */ } try { await b.close(); } catch { /* down */ } },
  };
}

/**
 * Joined at both signer nodes; the stake lock posted to the signer nodes named in `lockAt`
 * (a signer node not given it has not seen the stake, and refuses the entry's marks).
 * `messages`: the run - a first mark at 60, a mark at 1320. `alt`: another
 * first mark at 90 and a mark at 120 on it - the player's second chain.
 */
async function joinAndBuild(w, { lockAt = ['a', 'b'] } = {}) {
  // THE WINNER UNDER THIS ROUND'S OWN BEACON (window-fixture playFor): the recorded tape misses there.
  await warmPlay(WINNER, w.randomness);
  const play = playFor(WINNER, w.randomness);
  const session = ed25519.utils.randomSecretKey();
  const preimage = secretScalar();
  const e = rand(32);
  const dealt = await dealHandout({ preimage, signerNodes: w.c.nodes, roundId: w.rid, playerPubkey: WINNER.key,
    ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e), coefficients: [scalarFrom32(rand(32)) % FIELD], needed: 2, curve: feldmanGroup });
  const outpoint = { txid: rand(32), outIdx: 0n };
  // AND IT BRINGS ITS FEE LOCK (2026-09-21). `lock-fixture`'s federation is legal now - no base fee, as §22A
  // requires - so this round's gate mints fee locks, and pick (a)'s door refuses an entry that names none.
  // That is the production shape: a staked entry arrives with the 2% already locked to H(F).
  const feeSecret = rand(32);
  const feeOutpoint = { txid: rand(32), outIdx: 1n };
  const entry = {
    roundId: w.rid, playerPubkey: WINNER.key, sessionPubkey: ed25519.getPublicKey(session),
    stakeCommitment: sha256(preimage), stakeMsat: STAKE, feeMsat: entryFeeMsat(STAKE), donationMsat: 0n,
    joinTick: 0, worldSecret: play.worldSecret, vssSharesRef: handoutId(dealt.handout), stakePoint: dealt.handout.commitments[0],
    feePreimage: feeSecret, stakeLockOutpoint: outpoint, feeLockOutpoint: feeOutpoint,
    claimKeyAttestationRef: b32(0x9a),
  };
  const eid = entryId(entry);
  const fields = { paymentImage: { kind: 'point', bytes: entry.stakePoint }, amountMsat: netStakeMsat(entry), claimPk: w.claimPk,
    refundPk: refundKeyOf(WINNER.key), expiration: w.port.height + 200 };
  await w.port.put(outpoint, fields);
  const feeFields = { paymentImage: { kind: 'hash', bytes: sha256(feeSecret) }, amountMsat: entry.feeMsat,
    claimPk: w.claimPk, refundPk: refundKeyOf(WINNER.key), expiration: w.port.height + 200 };
  await w.port.put(feeOutpoint, feeFields);
  const lockOn = async (d) => assert.equal((await fetch(`http://127.0.0.1:${d.port}/lock?entry=${toHex(eid)}`,
    { method: 'POST', body: JSON.stringify(lockFieldsToJson(fields)) })).status, 201);
  const feeOn = async (d) => assert.equal((await fetch(`http://127.0.0.1:${d.port}/fee-lock?entry=${toHex(eid)}`,
    { method: 'POST', body: JSON.stringify(lockFieldsToJson(feeFields)) })).status, 201);
  for (const [name, d] of [['a', w.a], ['b', w.b]]) {
    const base = `http://127.0.0.1:${d.port}`;
    assert.equal((await fetch(`${base}/handout`, { method: 'POST', body: encodeHandout(dealt.handout) })).status, 201);
    assert.equal((await fetch(`${base}/entry`, { method: 'POST', body: encodeEntryContract(entry) })).status, 201);
    if (lockAt.includes(name)) { await lockOn(d); await feeOn(d); }
  }
  const sign = (m) => joinSigned(encodeCheckpoint(m), ed25519.sign(checkpointId(m), session));
  const batchOf = (from, to, previousHash) => ({ roundId: w.rid, entryId: eid, previousHash, firstTick: from,
    ticks: Array.from({ length: to - from }, (_, t) => play.words(from + t)), liquidations: [], loads: bedFrom(from) });
  const markOf = (tick, h, input, previousHash) => ({ roundId: w.rid, entryId: eid, tick, stateHash: h,
    inputChainHash: batchId(input), previousHash, sessionPubkey: entry.sessionPubkey });
  const chain = (ticks) => {
    const st = loaded(init(seedWordForEntry(entry, w.randomness || RANDOMNESS)));
    const out = [];
    let from = 0; let prevBatch = GENESIS_HASH; let prevMark = NO_PREVIOUS; let first = null;
    for (const to of ticks) {
      for (let t = from; t < to; t++) step(st, ...play.words(t));
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
  // THE HANDED-OUT `lockOn` HANDS BOTH LOCKS. Every call site means "let this signer node see the stake", and
  // a stake is only seen when its stake lock AND its fee lock are in - so handing one alone left B with one
  // receipt where the test asks for two. The suite's own choreography is unchanged.
  return { eid, outpoint, feeOutpoint, messages: run.messages, firstId: run.firstId, alt: alt.messages, altFirstId: alt.firstId,
    lockOn: async (d) => { await lockOn(d); await feeOn(d); } };
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
const feeHeld = (w, run) => w.port.locks.has(`${toHex(run.feeOutpoint.txid)}:${run.feeOutpoint.outIdx}`);
const brief = (x) => ({ results: x.results, finality: x.finality, noQuorum: x.noQuorum, entryVoid: x.entryVoid, closing: x.closing && x.closing.state,
  forfeit: x.forfeit.status, publicResults: x.publicResults, payoutTable: x.payoutTable });
const VOIDED = { results: [], finality: 'VOID', noQuorum: 'VOID', entryVoid: false, closing: 'VOID', forfeit: 409,
  publicResults: { signed: 0, noQuorum: 'VOID' }, payoutTable: null };

test('one signer node refused (1): B is up and refuses the on-time first mark - both HOLD until the result window, then both record VOID, the lock held', async () => {
  const w = await signerNodes();
  try {
    const run = await joinAndBuild(w, { lockAt: ['a'] });
    const saidB = [];
    for (const m of run.messages) { await say(w.a.port, m); saidB.push(String(await say(w.b.port, m)).slice(0, 40)); }
    await until(() => w.b.round.refusedFirstMark(run.eid) && Object.values(w.a.round.firstMarkOffers(run.eid)).includes('refused'));
    const offersAtA = w.a.round.firstMarkOffers(run.eid);
    await Promise.all([say(w.a.port, `close ${toHex(w.rid)}`), say(w.b.port, `close ${toHex(w.rid)}`)]);
    // WAITED ON, NOT SLEPT ON: read once both signer nodes' closes have recorded the
    // hold - in the full suite a close can take longer than a fixed sleep. The
    // assertions below (HOLDING, "no quorum yet", nothing decided) are what show
    // the read came inside the result window.
    await until(async () => (await Promise.all([w.a, w.b].map(async (d) => ((await (await fetch(
      `http://127.0.0.1:${d.port}/closing?round=${toHex(w.rid)}`)).json()).some((s) => s.entry === toHex(run.eid)))))).every(Boolean), 10000);
    const inWindow = { a: await at(w.a, w, run), b: await at(w.b, w, run) };
    skipTo(Number(roundEndMs(w.c)) + 605000 + 100);                        // past the result window (WINDOW-10-SPEC)
    await until(() => w.a.round.noQuorum(run.eid) && w.b.round.noQuorum(run.eid));
    await wait(300);
    const after = { a: await at(w.a, w, run), b: await at(w.b, w, run), lockHeld: lockHeld(w, run) };
    console.log('  FACTS (refused, 1):', JSON.stringify({ saidB, offersAtA, inWindow, after }));
    console.log('  VOID MONEY:', JSON.stringify({ stakeLockHeld: after.lockHeld, feeLockHeld: feeHeld(w, run),
      settlements: w.port.settlements.length, payouts: [...w.port.payouts.values()].map((x) => String(x.msat)) }));
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

    // A VOID CLAIMS NOTHING - THE FEE LOCK UNWINDS WITH THE STAKE (§13C, and 2026-09-21).
    //
    // This is the round that FAILED for a technical reason: B refused the on-time first mark, no quorum
    // formed, and after the result window both signer nodes recorded VOID. §22A's 2% is compensation for a
    // round that actually ran, so there is nothing to compensate here - and the operator must not profit
    // from a failure of its own side. Both locks therefore go back to the player by expiry: neither is
    // claimed, no settlement is submitted, and not one millisatoshi is paid to anybody.
    //
    // MEASURED on this path before it was asserted: stake lock held true, fee lock held true, settlements 0,
    // payouts []. Nothing in the settler needed changing - what was missing was the evidence. It could only
    // be written once the fixture's entries carried a fee lock at all, which is why it sits here.
    assert.equal(feeHeld(w, run), true, 'the fee lock was claimed out of a VOID round');
    assert.equal(w.port.settlements.length, 0, 'a VOID round submitted a settlement');
    assert.deepEqual([...w.port.payouts.values()], [], 'a VOID round paid somebody - the seats take nothing');
  } finally { await w.close(); }
});

test('one signer node refused (2): the refusals are the player\'s own two first marks - FORFEIT at both signer nodes, not VOID', async () => {
  const w = await signerNodes();
  try {
    const run = await joinAndBuild(w);
    await w.downB();
    // The player's first chain to A (B is down: its forward goes unanswered)...
    for (const m of run.messages.slice(0, 2)) await say(w.a.port, m);
    await w.upB();
    // ...and a second first chain to B: B takes it and hands its first mark to A,
    // which refuses it (it holds another); each signer node refuses the other's.
    for (const m of run.alt) await say(w.b.port, m);
    for (const m of run.messages.slice(0, 2)) await say(w.a.port, m);
    await wait(1000);
    const offers = { a: w.a.round.firstMarkOffers(run.eid), b: w.b.round.firstMarkOffers(run.eid) };
    await Promise.all([say(w.a.port, `close ${toHex(w.rid)}`), say(w.b.port, `close ${toHex(w.rid)}`)]);
    skipTo(Number(roundEndMs(w.c)) + 605000 + 100);                        // past the result window (WINDOW-10-SPEC)
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

// THE OWNER 2026-09-15 07:49: the result window is the objection window, and a signer node that cannot
// retrieve the transcript in it treats the entry as VOID. Until then (M3.3-34) A held past the
// window with no VOID - measured this morning: HOLDING "waiting on 1 signer node" at the window + 2 s.
test('one signer node refused (4): the refusing signer node is unreachable at the close - past the window A cannot retrieve the transcript and decides VOID; back, both VOID', async () => {
  const w = await signerNodes();
  try {
    const run = await joinAndBuild(w, { lockAt: ['a'] });
    for (const m of run.messages) { await say(w.a.port, m); await say(w.b.port, m); }
    await until(() => w.b.round.refusedFirstMark(run.eid) && Object.values(w.a.round.firstMarkOffers(run.eid)).includes('refused'));
    await w.downB();
    assert.equal(await say(w.a.port, `close ${toHex(w.rid)}`), 'closed');
    // PAST THE RESULT WINDOW ON THE CHAIN (RULED 2026-09-24): two seconds past its end block - opened at the first block at
    // or after the round's contract end - not W past this node's close.
    const endMs = (Number(roundEndMs(w.c)) + 605000);
    skipTo(endMs + 100);
    await until(() => w.a.round.noQuorum(run.eid), 30000);                // A decides on its next pass past the end block
    const pastWindowBDown = await at(w.a, w, run);
    await w.upB();
    assert.equal(await say(w.b.port, `close ${toHex(w.rid)}`), 'closed');
    await until(() => w.a.round.noQuorum(run.eid) && w.b.round.noQuorum(run.eid));
    const after = { a: await at(w.a, w, run), b: await at(w.b, w, run), lockHeld: lockHeld(w, run) };
    console.log('  FACTS (refused, 4 - peer unreachable):', JSON.stringify({ pastWindowBDown, after }));
    assert.equal(pastWindowBDown.closing.state, 'VOID');
    assert.match(pastWindowBDown.closing.why, /no quorum at 0 of 2/);
    assert.equal(pastWindowBDown.noQuorum, 'VOID');
    assert.equal(pastWindowBDown.finality, 'VOID');
    assert.deepEqual(pastWindowBDown.results, [], 'A signed a result for a run it could not retrieve');
    for (const s of ['a', 'b']) assert.deepEqual(brief(after[s]), VOIDED, s);
    assert.equal(after.lockHeld, true);
  } finally { await w.close(); }
});

// THE FIRST MARK REACHED ONLY THE SIGNER NODE THAT REFUSED IT (M3.3-34 follow-up): the
// player's direct send, not A's forward. Refused while the refusing signer node was up,
// the operator side's fault (§13C) - VOID at both signer nodes after the window, never
// the walk-away's FORFEIT 0 at one signer node or both.
test('one signer node refused (8): the first mark reached only the signer node that refused it - both HOLD, then VOID at both, never FORFEIT 0', async () => {
  const w = await signerNodes();
  try {
    const run = await joinAndBuild(w, { lockAt: ['a'] });
    const saidB = [];
    for (const m of run.messages.slice(0, 2)) saidB.push(String(await say(w.b.port, m)).slice(0, 40));   // to B only
    await wait(500);
    const refusedAtB = !!w.b.round.refusedFirstMark(run.eid);
    await Promise.all([say(w.a.port, `close ${toHex(w.rid)}`), say(w.b.port, `close ${toHex(w.rid)}`)]);
    await until(async () => (await Promise.all([w.a, w.b].map(async (d) => ((await (await fetch(
      `http://127.0.0.1:${d.port}/closing?round=${toHex(w.rid)}`)).json()).some((s) => s.entry === toHex(run.eid)))))).every(Boolean)
      || [w.a, w.b].every((d) => d.round.results(w.rid, run.eid).length > 0), 10000);
    const inWindow = { a: await at(w.a, w, run), b: await at(w.b, w, run) };
    skipTo(Number(roundEndMs(w.c)) + 605000 + 100);                        // past the result window (WINDOW-10-SPEC)
    await until(() => [w.a, w.b].every((d) => d.round.noQuorum(run.eid) || resultFinality(d.round, w.rid, run.eid).state === 'FINAL'));
    await wait(300);
    const after = { a: await at(w.a, w, run), b: await at(w.b, w, run), lockHeld: lockHeld(w, run) };
    console.log('  FACTS (refused, 8 - reached only the refusing signer node):', JSON.stringify({ saidB, refusedAtB, inWindow, after }));
    for (const s of ['a', 'b']) {
      assert.deepEqual(inWindow[s].results, [], `${s} signed at the close`);
      assert.equal(inWindow[s].closing && inWindow[s].closing.state, 'HOLDING', s);
      assert.deepEqual(brief(after[s]), VOIDED, s);
    }
    assert.equal(after.lockHeld, true);
  } finally { await w.close(); }
});

test('one signer node refused (5, 6): B refuses, then sees the stake and takes the mark in time - 2 of 2, the run\'s own outcome, FINAL, never voided', async () => {
  const w = await signerNodes();
  try {
    const run = await joinAndBuild(w, { lockAt: ['a'] });
    for (const m of run.messages.slice(0, 2)) { await say(w.a.port, m); await say(w.b.port, m); }
    await until(() => w.b.round.refusedFirstMark(run.eid));
    const refusedFirst = !!w.b.round.refusedFirstMark(run.eid);
    await run.lockOn(w.b);                                  // B sees the stake now
    const saidB = [];
    for (const m of run.messages.slice(0, 2)) saidB.push(String(await say(w.b.port, m)).slice(0, 30));
    for (const m of run.messages.slice(2)) for (const d of [w.a, w.b]) await say(d.port, m);
    await Promise.all([say(w.a.port, `close ${toHex(w.rid)}`), say(w.b.port, `close ${toHex(w.rid)}`)]);
    await until(() => [w.a, w.b].every((d) => resultFinality(d.round, w.rid, run.eid).state === 'PROVISIONALLY_FINAL'));
    skipTo(Number(roundEndMs(w.c)) + 605000 + 100);                        // past the result window (WINDOW-10-SPEC)
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

// §13C'S RESULT WINDOW ON THE WALL CLOCK (WINDOW-10-SPEC, RULED 2026-10-01; it was blocks from 2026-09-24): it opens at
// the round's contract end (roundEndMs - the same instant at every holder) and closes 600 s later; each holder decides
// from end + 605 s on its own clock. Two holders that close seconds apart write their §13C outcome from that same instant -
// not each at its own close + W, where the first could freeze a refund or a forfeit the other could still contradict.
async function writesOf(w, run, ms = 25000) {
  const at_ = { a: null, b: null };
  for (const stop = Date.now() + ms; Date.now() < stop && !(at_.a && at_.b); await wait(50))
    for (const s of ['a', 'b']) if (!at_[s] && w[s].round.noQuorum(run.eid)) at_[s] = { ms: testNow(), outcome: w[s].round.noQuorum(run.eid).outcome };
  return at_;
}

test('§13C on the wall clock (VOID): two holders closing three seconds apart write VOID, both only from the round\'s end + 605 s - not each at its own close + W', async () => {
  const w = await signerNodes({ endIn: 9000 });
  try {
    const run = await joinAndBuild(w, { lockAt: ['a'] });
    for (const m of run.messages) { await say(w.a.port, m); await say(w.b.port, m); }
    await until(() => w.b.round.refusedFirstMark(run.eid) && Object.values(w.a.round.firstMarkOffers(run.eid)).includes('refused'));
    const closeA = testNow();
    await say(w.a.port, `close ${toHex(w.rid)}`);
    await wait(3000);
    const closeB = testNow();
    await say(w.b.port, `close ${toHex(w.rid)}`);
    const endMs = (Number(roundEndMs(w.c)) + 605000);
    const early = await writesOf(w, run, 1500);                           // inside the window: neither writes
    assert.deepEqual([early.a, early.b], [null, null], 'a holder wrote inside the result window');
    skipTo(endMs + 100);
    const wrote = await writesOf(w, run);
    console.log('  FACTS (13C VOID timing):', JSON.stringify({ closesApart: closeB - closeA, wroteA: wrote.a && wrote.a.ms - closeA,
      wroteB: wrote.b && wrote.b.ms - closeA, gap: wrote.a && wrote.b ? wrote.b.ms - wrote.a.ms : null, endBlockAfterCloseA: endMs - closeA,
      outcomes: [wrote.a && wrote.a.outcome, wrote.b && wrote.b.outcome] }));
    assert.deepEqual([wrote.a && wrote.a.outcome, wrote.b && wrote.b.outcome], ['VOID', 'VOID']);
    assert.ok(wrote.a.ms >= endMs && wrote.b.ms >= endMs, 'a holder wrote before the round\'s end + 605 s');
  } finally { await w.close(); }
});

test('§13C on the wall clock (FORFEIT): the player\'s two first marks, two holders closing three seconds apart - FORFEIT at both, both only from the round\'s end + 605 s', async () => {
  const w = await signerNodes({ endIn: 12000 });
  try {
    const run = await joinAndBuild(w);
    await w.downB();
    for (const m of run.messages.slice(0, 2)) await say(w.a.port, m);
    await w.upB();
    for (const m of run.alt) await say(w.b.port, m);
    for (const m of run.messages.slice(0, 2)) await say(w.a.port, m);
    await wait(1000);
    const closeA = testNow();
    await say(w.a.port, `close ${toHex(w.rid)}`);
    await wait(3000);
    await say(w.b.port, `close ${toHex(w.rid)}`);
    const endMs = (Number(roundEndMs(w.c)) + 605000);
    const early = await writesOf(w, run, 1500);                           // inside the window: neither writes
    assert.deepEqual([early.a, early.b], [null, null], 'a holder wrote inside the result window');
    skipTo(endMs + 100);
    const wrote = await writesOf(w, run);
    console.log('  FACTS (13C FORFEIT timing):', JSON.stringify({ wroteA: wrote.a && wrote.a.ms - closeA, wroteB: wrote.b && wrote.b.ms - closeA,
      gap: wrote.a && wrote.b ? wrote.b.ms - wrote.a.ms : null, endBlockAfterCloseA: endMs - closeA, outcomes: [wrote.a && wrote.a.outcome, wrote.b && wrote.b.outcome] }));
    assert.deepEqual([wrote.a && wrote.a.outcome, wrote.b && wrote.b.outcome], ['FORFEIT', 'FORFEIT']);
    assert.ok(wrote.a.ms >= endMs && wrote.b.ms >= endMs, 'a holder wrote before the round\'s end + 605 s');
  } finally { await w.close(); }
});

// A HOLDER WHOSE CHAIN LAGS DECIDES AT THE SAME INSTANT (WINDOW-10-SPEC): no block decides a window - B's chain view
// runs LAG behind, and both write VOID from the round's end + 605 s; resultWindow answers by the clock alone at both.
test('§13C on the wall clock: a holder whose chain lags decides at the same instant - end + 605 s - as one whose chain does not', async () => {
  const LAG = 4000;
  const w = await signerNodes({ endIn: 9000, lagB: LAG });
  try {
    const run = await joinAndBuild(w, { lockAt: ['a'] });
    for (const m of run.messages) { await say(w.a.port, m); await say(w.b.port, m); }
    await until(() => w.b.round.refusedFirstMark(run.eid) && Object.values(w.a.round.firstMarkOffers(run.eid)).includes('refused'));
    await Promise.all([say(w.a.port, `close ${toHex(w.rid)}`), say(w.b.port, `close ${toHex(w.rid)}`)]);
    const endMs = (Number(roundEndMs(w.c)) + 605000);
    const edge = (d, now) => resultWindow(Object.assign(Object.create(d.round), { now: () => now }), w.rid, w.c).ok;
    skipTo(endMs + 100);
    const wrote = await writesOf(w, run);
    console.log('  FACTS (13C, a lagging chain):', JSON.stringify({ wroteAfterEnd: [wrote.a && wrote.a.ms - endMs, wrote.b && wrote.b.ms - endMs],
      outcomes: [wrote.a && wrote.a.outcome, wrote.b && wrote.b.outcome], atEnd: [edge(w.a, endMs), edge(w.b, endMs)], before: [edge(w.a, endMs - 1), edge(w.b, endMs - 1)] }));
    assert.deepEqual([wrote.a && wrote.a.outcome, wrote.b && wrote.b.outcome], ['VOID', 'VOID']);
    assert.ok(wrote.a.ms >= endMs && wrote.b.ms >= endMs, 'a holder wrote before the round\'s end + 605 s');
    assert.deepEqual([edge(w.a, endMs), edge(w.b, endMs)], [true, true], 'the lagging chain kept B from deciding at end + 605 s');
    assert.deepEqual([edge(w.a, endMs - 1), edge(w.b, endMs - 1)], [false, false]);
  } finally { await w.close(); }
});

// §13C'S EVIDENCE IS TIED TO ITS BLOCK (RULED 2026-09-24): a refusal counts only when its block is strictly before
// the result window's end block, at every holder. THE LATE REFUSAL: A closes before the end block holding nothing of the
// entry; past the end block the player's on-time first mark reaches B, which refuses it (it does not see the stake), and
// B closes. The refusal sits at or after the end block - outside at both holders: they write the same record.
test('a refusal after the result window\'s end block is outside at both holders: A that closed before it and B that refused after it write the same record', async () => {
  const w = await signerNodes({ endIn: 12000 });
  try {
    const run = await joinAndBuild(w, { lockAt: ['a'] });
    const endMs = (Number(roundEndMs(w.c)) + 605000);
    const aClosedBeforeEnd = testNow() < endMs;
    await say(w.a.port, `close ${toHex(w.rid)}`);
    skipTo(endMs + 1000);
    const refusedAfterEnd = testNow() >= endMs;
    const saidB = [];
    for (const m of run.messages.slice(0, 2)) saidB.push(String(await say(w.b.port, m)).slice(0, 40));   // to B only, late
    await until(() => !!w.b.round.refusedFirstMark(run.eid), 5000);
    await say(w.b.port, `close ${toHex(w.rid)}`);
    await until(() => [w.a, w.b].every((d) => d.round.noQuorum(run.eid) || d.round.results(w.rid, run.eid).some((r) => toHex(r.nodePubkey) === toHex(d.round.pubkey))), 20000);
    await wait(500);
    const rec = (d) => {
      const nq = d.round.noQuorum(run.eid);
      const mine = d.round.results(w.rid, run.eid).find((r) => toHex(r.nodePubkey) === toHex(d.round.pubkey));
      const p = mine && decodePlayerResult(splitSignedResult(mine.bytes).body);
      return { record: nq ? nq.outcome : p ? `${p.outcome}/${p.score}` : null, finality: resultFinality(d.round, w.rid, run.eid).state,
        refusedHere: !!d.round.refusedFirstMark(run.eid) };
    };
    const after = { a: rec(w.a), b: rec(w.b) };
    console.log('  FACTS (late refusal):', JSON.stringify({ aClosedBeforeEnd, refusedAfterEnd, saidB, after }));
    assert.equal(aClosedBeforeEnd, true, 'A did not close before the end block: not the case the test names');
    assert.equal(refusedAfterEnd, true, 'B did not refuse after the end block: not the case the test names');
    assert.equal(after.b.refusedHere, true, 'B kept no refusal: not the case the test names');
    assert.equal(after.a.record, after.b.record, `the holders split on a refusal after the end block: A ${after.a.record}, B ${after.b.record}`);
    // THE REFUSAL, OUTSIDE, IS NO EVIDENCE. Since the result window's deadline (RULED 2026-10-04) B's own
    // result - made only when it closes, after the deadline - completes the 2 of 2 late, so the entry is VOID at both by
    // that deadline (§13A: results must be in before the window closes; §13C: no quorum in the window, nothing proven
    // against the player, refunded) - not by the refusal: neither seat's reason rests on a refused first mark.
    const whyAt = (d) => (d.round.noQuorum(run.eid) || {}).why || resultFinality(d.round, w.rid, run.eid).why || '';
    const whys = { a: whyAt(w.a), b: whyAt(w.b) };
    console.log('  FACTS (late refusal, reasons):', JSON.stringify(whys));
    assert.ok([whys.a, whys.b].every((x) => !/refus/i.test(x)), `a refusal after the end block was counted: ${JSON.stringify(whys)}`);
    // the deadline's reasons: a threshold completed late, or (A held none of it in time) a transcript not published in time
    for (const x of [whys.a, whys.b]) assert.match(x, /no result at the threshold by|was not published by the settlement threshold by/);
  } finally { await w.close(); }
});
