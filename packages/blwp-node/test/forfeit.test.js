// THE SEATS FORFEIT A QUALIFIER'S STAKE LOCK, AND ONLY A QUALIFIER'S (v4.6.2 §23.2 row 1, W5b).
//
// Two seats of a lock round, each with a share of the round's claim key; a
// winner who delivers (score 12) and a loser who wrecks, both staked by a lock
// the seats verified (POST /lock, a port that holds locks by outpoint). After
// the close the seats replay, post and wait out the objection window; then:
//   the winner's forfeit - a BIP-340 signature by claim_pk over the lock's
//   contract id - is made by both seats, verifies, and both keep it;
//   the loser's is 409 and nobody keeps one;
//   before FINAL it is 409;
//   a Delivered run below the round's min_score is 409 (§18: not a qualifier);
//   one seat's signature alone does not verify.
// HARNESS: in-process seats are not seated from a census, so the claim key's
// generation is started by hand here; the shipping path, where the seats start
// it themselves with nothing handed or wired, is claim-key-own.test.js.
//
// MEASURED BEFORE (TASKBOOK, W5b): no seat forfeited a verified lock; no door
// served a FROST signature over a lock's contract id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { feldmanGroup, tweakPoint } from '../src/curve.js';
import { assumeSeated } from './seating.js';
import { lockPort } from './lock-fixture.js';
import { b32, rand, RANDOMNESS, STAKE, WINDOW_MS, WINNER, LOSER, GENESIS_HASH, wordsAt, contractFor, say, secretScalar, opts, wait } from './window-fixture.js';
import { encodeRoundContract, roundId, encodeEntryContract, entryId } from '../../protocol/src/contracts.js';
import { dealHandout, encodeHandout, handoutId } from '../../protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../protocol/src/shares.js';
import { encodeInputBatch, batchId } from '../../protocol/src/batch.js';
import { encodeCheckpoint, checkpointId, joinSigned, NO_PREVIOUS } from '../../protocol/src/checkpoint.js';
import { SIGNED_RECEIPT_BYTES } from '../../protocol/src/receipt.js';
import { init, step } from '../../core/src/sim.js';
import { hash as stateHash } from '../../core/src/state.js';
import { seedWordForEntry } from '../../protocol/src/seed.js';
import { netStakeMsat } from '../../protocol/src/payout.js';
import { entryFeeMsat } from '../../protocol/src/fee.js';
import { refundKeyOf, lockFieldsToJson } from '../../protocol/src/stake-lock.js';
import { signShare340, aggregate340, nonceGenerate340 } from '../../protocol/src/frost-bip340.js';
import { toHex, fromHex, sha256 } from '../../protocol/src/hash.js';

const curve = { ...feldmanGroup, tweakPoint };

/** Two seats of a paying lock round, their claim key made between them. */
async function lockRound({ minScore = 1 } = {}) {
  const port = lockPort();
  const mk = () => serve(openStore(':memory:'), { port: 0, ...opts, stakeLocks: port, poolCurve: curve, finality: { everyMs: 100 } });
  const a = await mk();
  const b = await mk();
  for (const [d, o] of [[a, b], [b, a]]) {
    const there = [`http://127.0.0.1:${o.port}`];
    d.verifier.peers = there;
    d.payouts.peers = there;
    d.preimages.peers = there;
    d.dkg.peers = there;
  }
  const c = { ...contractFor([a.round.pubkey, b.round.pubkey], BigInt(WINDOW_MS), [a, b].map((d) => `http://127.0.0.1:${d.port}`)),
    federationId: b32(0xfe), minScore };
  const rid = roundId(c);
  for (const d of [a, b]) {
    const r = await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: encodeRoundContract(c) });
    assert.equal(r.status, 201, await r.text());
    assumeSeated(d.round, rid, c.nodes);
  }
  for (let pass = 0; pass < 2; pass++) for (const d of [a, b]) await d.dkg.run(c.nodes);
  const held = a.dkg.seatFor(c.nodes);
  assert.equal(held.ok, true, held.why);
  return { a, b, c, rid, port, claimPk: held.pool.groupPublicKey, close: async () => { await a.close(); await b.close(); } };
}

/** One player staked by a lock both seats verified, then played (as seatAndPlay plays). */
async function lockAndPlay(w, who) {
  const session = ed25519.utils.randomSecretKey();
  const preimage = secretScalar();
  const e = rand(32);
  const dealt = await dealHandout({ preimage, seats: w.c.nodes, roundId: w.rid, playerPubkey: who.key,
    ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e), coefficients: [scalarFrom32(rand(32)) % FIELD], needed: 2, curve: feldmanGroup });
  assert.equal(dealt.ok, true, dealt.why);
  const outpoint = { txid: rand(32), outIdx: 0n };
  const entry = {
    roundId: w.rid, playerPubkey: who.key, sessionPubkey: ed25519.getPublicKey(session),
    stakeCommitment: sha256(preimage), stakeMsat: STAKE, feeMsat: entryFeeMsat(STAKE), donationMsat: 0n,
    joinTick: 0, worldSecret: who.worldSecret, vssSharesRef: handoutId(dealt.handout), stakePoint: dealt.handout.commitments[0],
    feePreimage: new Uint8Array(32), stakeLockOutpoint: outpoint, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n },
    claimKeyAttestationRef: b32(0x9a),
  };
  const eid = entryId(entry);
  const fields = { paymentImage: { kind: 'point', bytes: entry.stakePoint }, amountMsat: netStakeMsat(entry), claimPk: w.claimPk,
    refundPk: refundKeyOf(who.key), expiration: w.port.height + 200 };
  await w.port.put(outpoint, fields);
  const input = { roundId: w.rid, entryId: eid, previousHash: GENESIS_HASH, firstTick: 0,
    ticks: Array.from({ length: who.ticks }, (_, t) => wordsAt(t)), liquidations: [] };
  const st = init(seedWordForEntry(entry, RANDOMNESS));
  for (let t = 0; t < who.ticks; t++) step(st, ...wordsAt(t));
  const mark = { roundId: w.rid, entryId: eid, tick: who.ticks,
    stateHash: Uint8Array.from(stateHash(st).match(/../g).map((x) => parseInt(x, 16))),
    inputChainHash: batchId(input), previousHash: NO_PREVIOUS, sessionPubkey: ed25519.getPublicKey(session) };
  const signedMark = joinSigned(encodeCheckpoint(mark), ed25519.sign(checkpointId(mark), session));
  for (const d of [w.a, w.b]) {
    const base = `http://127.0.0.1:${d.port}`;
    assert.equal((await fetch(`${base}/handout`, { method: 'POST', body: encodeHandout(dealt.handout) })).status, 201);
    const seated = await fetch(`${base}/entry`, { method: 'POST', body: encodeEntryContract(entry) });
    assert.equal(seated.status, 201, await seated.text());
    const locked = await fetch(`${base}/lock?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(fields)) });
    assert.equal(locked.status, 201, await locked.text());
    assert.equal(await say(d.port, encodeInputBatch(input)), String(who.ticks));
    assert.equal((await say(d.port, signedMark)).length, SIGNED_RECEIPT_BYTES);
  }
  return { eid, entry, fields, outpoint };
}

const ask = async (d, w, eid) => {
  const r = await fetch(`http://127.0.0.1:${d.port}/forfeit?round=${toHex(w.rid)}&entry=${toHex(eid)}`);
  return { status: r.status, body: r.ok ? await r.json() : (await r.text()).trim() };
};
const closeRound = (w) => Promise.all([say(w.a.port, `close ${toHex(w.rid)}`), say(w.b.port, `close ${toHex(w.rid)}`)]);
async function untilForfeit(w, eid, ms = 20000) {
  let got;
  for (const stop = Date.now() + ms; Date.now() < stop; await wait(250)) {
    got = await ask(w.a, w, eid);
    if (got.status === 200) return got;
  }
  return got;
}

test('the qualifier\'s lock is forfeited by both seats after the window - it verifies under the claim key and both keep it; the loser\'s is 409', async () => {
  const w = await lockRound();
  try {
    const winner = await lockAndPlay(w, WINNER);
    const loser = await lockAndPlay(w, LOSER);
    const early = await ask(w.a, w, winner.eid);
    assert.deepEqual(await closeRound(w), ['closed', 'closed']);
    const got = await untilForfeit(w, winner.eid);
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
    };
    console.log('  FACTS (forfeit):', JSON.stringify(facts), '| before:', String(early.body).slice(0, 90), '| loser:', String(lost.body).slice(0, 110));
    assert.deepEqual(facts, { beforeClose: 409, forfeit: 200, isTheLocksId: true, claimPkIsTheRounds: true, verifies: true,
      bKeepsTheSame: true, bAnswersTheSame: true, loser: 409, loserKeptBy: 0, loserLockHeld: true });
    assert.match(String(early.body), /no forfeit before the result is final/);
    assert.match(String(lost.body), /FAILED .* not a qualifier/);

    // ONE SEAT ALONE (harness: its share read from its own store) does not make a forfeit.
    const held = w.a.dkg.seatFor(w.c.nodes);
    const message = fromHex(id);
    const hiding = nonceGenerate340(rand(32), held.seat.share);
    const binding = nonceGenerate340(rand(32), held.seat.share);
    const commitments = [{ id: held.seat.id, hiding: curve.pointFromScalar(hiding), binding: curve.pointFromScalar(binding) }];
    const share = signShare340({ id: held.seat.id, share: held.seat.share, groupPublicKey: w.claimPk, nonces: { hiding, binding }, message, commitments, curve });
    const alone = aggregate340({ commitments, message, groupPublicKey: w.claimPk, shares: [share], curve }).signature;
    assert.equal(schnorr.verify(alone, message, w.claimPk.subarray(1)), false, 'one seat alone made a forfeit that verifies');
  } finally { await w.close(); }
});

test('a Delivered run below the round\'s min_score is not a qualifier: its forfeit is 409 (§18)', async () => {
  const w = await lockRound({ minScore: 100 });
  try {
    const winner = await lockAndPlay(w, WINNER);
    assert.deepEqual(await closeRound(w), ['closed', 'closed']);
    let got;
    for (const stop = Date.now() + 20000; Date.now() < stop; await wait(250)) {
      got = await ask(w.a, w, winner.eid);
      if (!/before the result is final/.test(String(got.body))) break;
    }
    console.log(`  a Delivered run, score 12, min_score 100: ${got.status} ${String(got.body).slice(0, 120)}`);
    assert.equal(got.status, 409);
    assert.match(String(got.body), /DELIVERED with score 12 and this round's minimum is 100: not a qualifier/);
    assert.equal(w.a.round.forfeit(winner.eid), null);
  } finally { await w.close(); }
});
