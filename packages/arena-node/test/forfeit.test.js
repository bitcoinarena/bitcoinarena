// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SIGNER NODES FORFEIT A QUALIFIER'S STAKE LOCK, AND ONLY A QUALIFIER'S (v4.6.2 §23.2 row 1, W5b).
//
// Two signer nodes of a lock round, each with a share of the round's claim key; a
// winner who delivers (score 5) and a loser who does not, both staked by a lock
// the signer nodes verified (POST /lock, a port that holds locks by outpoint). After
// the close the signer nodes replay, post and wait out the objection window; then:
//   the winner's forfeit - a BIP-340 signature by claim_pk over the lock's
//   contract id - is made by both signer nodes, verifies, and both keep it;
//   the loser's is 409 and nobody keeps one;
//   before FINAL it is 409;
//   a Delivered run below the round's min_score is 409 (§18: not a qualifier);
//   one signer node's signature alone does not verify.
// HARNESS: in-process signer nodes are not assigned from a census, so the claim key's
// generation is started by hand here; the shipping path, where the signer nodes start
// it themselves with nothing handed or wired, is claim-key-own.test.js.
//
// MEASURED BEFORE (TASKBOOK, W5b): no signer node forfeited a verified lock; no door
// served a FROST signature over a lock's contract id.
import { test } from 'node:test';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { feldmanGroup, tweakPoint } from '../src/curve.js';
import { assumeAssigned } from './assignment.js';
import { lockPort, bondedChainSlot, bondedChainFor } from './lock-fixture.js';
import { lnurl, nameAddress, closeRound as closeRoundLive } from './lock-round-fixture.js';
import { testNow } from './test-clock.js';
import { presentDay } from './window-fixture.js';
import { b32, rand, RANDOMNESS, STAKE, WINDOW_MS, WINNER, LOSER, GENESIS_HASH, wordsAt, playFor, warmPlay, contractFor, say, secretScalar, opts, wait } from './window-fixture.js';
import { encodeRoundContract, roundId, encodeEntryContract, entryId } from '../../arena-protocol/src/contracts.js';
import { dealHandout, encodeHandout, handoutId } from '../../arena-protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../arena-protocol/src/shares.js';
import { encodeInputBatch, batchId } from '../../arena-protocol/src/batch.js';
import { encodeCheckpoint, checkpointId, joinSigned, NO_PREVIOUS } from '../../arena-protocol/src/checkpoint.js';
import { SIGNED_RECEIPT_BYTES } from '../../arena-protocol/src/receipt.js';
import { init, step } from '../../nextblock/src/sim.js';
import { loaded, bedFrom } from './window-fixture.js';
import { hash as stateHash } from '../../nextblock/src/state.js';
import { seedWordForEntry } from '../../arena-protocol/src/seed.js';
import { netStakeMsat } from '../../arena-protocol/src/payout.js';
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { refundKeyOf, lockFieldsToJson } from '../../arena-protocol/src/stake-lock.js';
import { signShare340, aggregate340, nonceGenerate340 } from '../../arena-protocol/src/frost-bip340.js';
import { toHex, fromHex, sha256 } from '../../arena-protocol/src/hash.js';
import { HOSTED } from './plugins/hosted.js';

const curve = { ...feldmanGroup, tweakPoint };

/** Two signer nodes of a paying lock round, their claim key made between them. */
async function lockRound({ minScore = 1 } = {}) {
  // A CHAIN THAT BONDS THE ROUND'S TWO SIGNER NODES (RULED 2026-09-25), as lockRound in lock-round-fixture.js: both are
  // running daemons, so the claim key is their own live DKG; the round's beacon is that chain's.
  const slot = bondedChainSlot(lockPort());
  const port = slot.port;
  // THE WINNER'S LIGHTNING ADDRESS (ruled 2026-09-23: only a qualifier who named one is paid, so only then is a loser's lock claimed).
  const address = lnurl(port);
  const mk = () => serve(openStore(':memory:'), { plugins: HOSTED, port: 0, ...opts, stakeLocks: port, poolCurve: curve, finality: { everyMs: 100 },
    chainFor: slot.chainFor, randomnessFor: slot.randomnessFor, lnurlFetch: address.fetchLike });
  const a = await mk();
  const b = await mk();
  // ONCE A PORT IS BOUND, IT IS CLOSED WHATEVER HAPPENS NEXT (2026-09-20). Everything below can throw - the
  // `POST /round` assert did, for a whole session - and the caller's `finally { await w.close() }` cannot
  // help, because there is no `w` yet: the throw happens inside this function. Two listening servers then
  // keep node alive and `node --test` never exits, so a suite that fails in 107ms looks like a suite that
  // hangs. This is harness only; not one assertion is weakened, and a setup failure still fails.
  try {
    for (const [d, o] of [[a, b], [b, a]]) {
      const there = [`http://127.0.0.1:${o.port}`];
      d.verifier.peers = there;
     
      d.stakeSecrets.peers = there;
      d.dkg.peers = there;
    }
    // THE ROUND ENDS NOW, NOT IN 1970, as lock-round-fixture's: its results are held inside its window
    const drafted = presentDay({ ...contractFor([a.round.pubkey, b.round.pubkey], BigInt(WINDOW_MS), [a, b].map((d) => `http://127.0.0.1:${d.port}`)),
      custody: 'FEDERATION', federationId: TEST_FEDERATION_ID, minScore }, testNow() + 3000);
    const c = { ...drafted, censusRoot: bondedChainFor(drafted.nodes, drafted, slot,
      { endpoints: [a, b].map((d) => `ws://127.0.0.1:${d.port}`) }).censusRoot };
    const rid = roundId(c);
    for (const d of [a, b]) {
      const r = await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: encodeRoundContract(c) });
      assert.equal(r.status, 201, await r.text());
      assumeAssigned(d.round, rid, c.nodes);
    }
    for (let pass = 0; pass < 2; pass++) for (const d of [a, b]) await d.dkg.run(c.nodes);
    const held = a.dkg.signerNodeFor(c.nodes);
    assert.equal(held.ok, true, held.why);
    const beacon = slot.randomnessFor({ contract: c });
    return { a, b, c, rid, port, claimPk: held.pool.groupPublicKey, randomness: beacon && beacon.hash,
      close: async () => { await a.close(); await b.close(); } };
  } catch (e) {
    await a.close().catch(() => {});
    await b.close().catch(() => {});
    throw e;
  }
}

/** One player staked by a lock both signer nodes verified, then played (as joinAndPlay plays). */
async function lockAndPlay(w, who) {
  // THE WINNER UNDER THIS ROUND'S OWN BEACON (window-fixture playFor): the recorded tape misses there.
  await warmPlay(who, w.randomness);
  const play = playFor(who, w.randomness);
  const session = ed25519.utils.randomSecretKey();
  const preimage = secretScalar();
  const e = rand(32);
  const dealt = await dealHandout({ preimage, signerNodes: w.c.nodes, roundId: w.rid, playerPubkey: who.key,
    ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e), coefficients: [scalarFrom32(rand(32)) % FIELD], needed: 2, curve: feldmanGroup });
  assert.equal(dealt.ok, true, dealt.why);
  const outpoint = { txid: rand(32), outIdx: 0n };
  // AND IT BRINGS ITS FEE LOCK (2026-09-21). The fixture's federation is legal now - no base fee - so this
  // round's gate mints fee locks, and §23.1/pick (a)'s door refuses an entry that names none. That is the
  // production shape: a staked entry arrives with the 2% already locked to H(F). Nothing about the forfeit
  // changes; the stake lock below is still the one this suite is about.
  const feeSecret = rand(32);
  const feeOutpoint = { txid: rand(32), outIdx: 1n };
  const entry = {
    roundId: w.rid, playerPubkey: who.key, sessionPubkey: ed25519.getPublicKey(session),
    stakeCommitment: sha256(preimage), stakeMsat: STAKE, feeMsat: entryFeeMsat(STAKE), donationMsat: 0n,
    joinTick: 0, worldSecret: play.worldSecret, vssSharesRef: handoutId(dealt.handout), stakePoint: dealt.handout.commitments[0],
    feePreimage: feeSecret, stakeLockOutpoint: outpoint, feeLockOutpoint: feeOutpoint,
    claimKeyAttestationRef: b32(0x9a),
  };
  const eid = entryId(entry);
  const fields = { paymentImage: { kind: 'point', bytes: entry.stakePoint }, amountMsat: netStakeMsat(entry), claimPk: w.claimPk,
    refundPk: refundKeyOf(who.key), expiration: w.port.height + 200 };
  await w.port.put(outpoint, fields);
  const feeFields = { paymentImage: { kind: 'hash', bytes: sha256(feeSecret) }, amountMsat: entry.feeMsat,
    claimPk: w.claimPk, refundPk: refundKeyOf(who.key), expiration: w.port.height + 200 };
  await w.port.put(feeOutpoint, feeFields);
  const input = { roundId: w.rid, entryId: eid, previousHash: GENESIS_HASH, firstTick: 0,
    ticks: Array.from({ length: who.ticks }, (_, t) => play.words(t)), liquidations: [], loads: bedFrom(0) };
  const st = loaded(init(seedWordForEntry(entry, w.randomness || RANDOMNESS)));
  for (let t = 0; t < who.ticks; t++) step(st, ...play.words(t));
  const mark = { roundId: w.rid, entryId: eid, tick: who.ticks,
    stateHash: Uint8Array.from(stateHash(st).match(/../g).map((x) => parseInt(x, 16))),
    inputChainHash: batchId(input), previousHash: NO_PREVIOUS, sessionPubkey: ed25519.getPublicKey(session) };
  const signedMark = joinSigned(encodeCheckpoint(mark), ed25519.sign(checkpointId(mark), session));
  for (const d of [w.a, w.b]) {
    const base = `http://127.0.0.1:${d.port}`;
    assert.equal((await fetch(`${base}/handout`, { method: 'POST', body: encodeHandout(dealt.handout) })).status, 201);
    const joined = await fetch(`${base}/entry`, { method: 'POST', body: encodeEntryContract(entry) });
    assert.equal(joined.status, 201, await joined.text());
    const locked = await fetch(`${base}/lock?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(fields)) });
    assert.equal(locked.status, 201, await locked.text());
    const fee = await fetch(`${base}/fee-lock?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(feeFields)) });
    assert.equal(fee.status, 201, await fee.text());
    assert.equal(await say(d.port, encodeInputBatch(input)), String(who.ticks));
    assert.equal((await say(d.port, signedMark)).length, SIGNED_RECEIPT_BYTES);
  }
  return { eid, entry, fields, outpoint, feeOutpoint, session };
}

const ask = async (d, w, eid) => {
  const r = await fetch(`http://127.0.0.1:${d.port}/forfeit?round=${toHex(w.rid)}&entry=${toHex(eid)}`);
  return { status: r.status, body: r.ok ? await r.json() : (await r.text()).trim() };
};
// lock-round-fixture's close: in live order past final_after
const closeRound = (w) => closeRoundLive({ ...w, c: w.c || w.contract });
async function untilForfeit(w, eid, ms = 20000) {
  let got;
  for (const stop = Date.now() + ms; Date.now() < stop; await wait(250)) {
    got = await ask(w.a, w, eid);
    if (got.status === 200) return got;
  }
  return got;
}

test('the qualifier\'s lock is forfeited by both signer nodes after the window - it verifies under the claim key and both keep it; the loser\'s is 409', async () => {
  const w = await lockRound();
  try {
    const winner = await lockAndPlay(w, WINNER);
    const loser = await lockAndPlay(w, LOSER);
    await nameAddress([w.a, w.b], winner);
    const early = await ask(w.a, w, winner.eid);
    assert.deepEqual(await closeRound(w), ['closed', 'closed']);
    const got = await untilForfeit(w, winner.eid);
    // AND THE ROUND'S SETTLEMENT (W4), which waits for FINAL as the forfeit does and
    // can land after it: the loser's lock is read once the signer nodes have acted on it.
    for (const stop = Date.now() + 20000; Date.now() < stop && !w.port.settlements.length; await wait(250)) { /* waiting */ }
    const id = String(await w.port.contractId(winner.fields));
    const sig = got.status === 200 ? fromHex(got.body.signature) : null;
    const onB = w.b.round.forfeit(winner.eid);
    const fromB = await ask(w.b, w, winner.eid);
    const lost = await ask(w.a, w, loser.eid);
    const facts = {
      beforeClose: early.status, forfeit: got.status,
      isTheLocksId: got.status === 200 && got.body.contractId === id,
      claimPkIsTheRounds: got.status === 200 && got.body.claimPk === toHex(w.claimPk),
      verifies: !!sig && schnorr.verify(sig, fromHex(id), w.claimPk.subarray(1)),
      bKeepsTheSame: !!onB && !!sig && toHex(onB.signature) === toHex(sig), bAnswersTheSame: fromB.status === 200 && fromB.body.signature === got.body.signature,
      loser: lost.status, loserKeptBy: [w.a, w.b].filter((d) => d.round.forfeit(loser.eid)).length,
      loserLockHeld: w.port.locks.has(`${toHex(loser.outpoint.txid)}:${loser.outpoint.outIdx}`),
      // W4 (2026-09-14 07:22: "a loser loses the stake. The lock is claimed
      // into the pool."): the loser's lock is not forfeited - it is an input of the
      // round's one settlement. Before W4 this read held (the parked hole: back to
      // the loser at its expiry).
      loserClaimedBySettlement: w.port.settlements.some((s) => s.claims.some((c) =>
        toHex(c.outpoint.txid) === toHex(loser.outpoint.txid) && String(c.outpoint.outIdx) === String(loser.outpoint.outIdx))),
    };
    console.log('  FACTS (forfeit):', JSON.stringify(facts), '| before:', String(early.body).slice(0, 90), '| loser:', String(lost.body).slice(0, 110));
    assert.deepEqual(facts, { beforeClose: 409, forfeit: 200, isTheLocksId: true, claimPkIsTheRounds: true, verifies: true,
      bKeepsTheSame: true, bAnswersTheSame: true, loser: 409, loserKeptBy: 0, loserLockHeld: false, loserClaimedBySettlement: true });
    assert.match(String(early.body), /no forfeit before the result is final/);
    assert.match(String(lost.body), /FAILED .* not a qualifier/);

    // ONE SIGNER NODE ALONE (harness: its share read from its own store) does not make a forfeit.
    const held = w.a.dkg.signerNodeFor(w.c.nodes);
    const message = fromHex(id);
    const hiding = nonceGenerate340(rand(32), held.signerNode.share);
    const binding = nonceGenerate340(rand(32), held.signerNode.share);
    const commitments = [{ id: held.signerNode.id, hiding: curve.pointFromScalar(hiding), binding: curve.pointFromScalar(binding) }];
    const share = signShare340({ id: held.signerNode.id, share: held.signerNode.share, groupPublicKey: w.claimPk, nonces: { hiding, binding }, message, commitments, curve });
    const alone = aggregate340({ commitments, message, groupPublicKey: w.claimPk, shares: [share], curve }).signature;
    assert.equal(schnorr.verify(alone, message, w.claimPk.subarray(1)), false, 'one signer node alone made a forfeit that verifies');
  } finally { await w.close(); }
});

test('a Delivered run below the round\'s min_score is not a qualifier: its forfeit is 409 (§18)', async () => {
  // 1000, not 100: the fixture's winner delivers with score 5 since its driver started aiming at the core's own
  // GATE_X (window-fixture.js; the score was 12, then 367, then 34, and each number is the driver of its day -
  // MEASURED, never chosen). What this test pins is unchanged: a DELIVERED run under the round's minimum is
  // not a qualifier, and the refusal says the score and the minimum out loud. Score 2 since 087b707f tightened the
  // paying front (2026-09-23: FRONT_SCORE_SPAN 40 -> 36 m) - the same run, measured here in the node's own
  // score, not a figure carried over from a core test.
  // it was 12, then 367), and the claim is about a DELIVERED run under the minimum.
  // THE FLOOR NO RUN REACHES, the field's largest: scores are E x T x C in 1e-5 points (a delivering world scores up to
  // 395 points, measured), so a smaller floor is not sure to be above the run.
  const w = await lockRound({ minScore: 0xffffffff });
  try {
    const winner = await lockAndPlay(w, WINNER);
    assert.deepEqual(await closeRound(w), ['closed', 'closed']);
    let got;
    for (const stop = Date.now() + 20000; Date.now() < stop; await wait(250)) {
      got = await ask(w.a, w, winner.eid);
      if (!/before the result is final/.test(String(got.body))) break;
    }
    console.log(`  a Delivered run, min_score 4294967295: ${got.status} ${String(got.body).slice(0, 120)}`);
    assert.equal(got.status, 409);
    assert.match(String(got.body), /DELIVERED with score [1-9]\d* and this round's minimum is 4294967295: not a qualifier/);
    assert.equal(w.a.round.forfeit(winner.eid), null);
  } finally { await w.close(); }
});
