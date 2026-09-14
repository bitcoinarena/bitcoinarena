// W4: THE LOSER'S STAKE LOCK IS CLAIMED INTO THE ROUND'S ONE SETTLEMENT, AND THE
// WINNER IS PAID FROM IT (the owner 2026-09-14 07:22: "a loser loses the stake. The
// lock is claimed into the pool. Winners are paid from that."; FEDERATION.md
// money flow step 5).
//
// Two seats of a lock round with a claim key made between them; a winner who
// delivers and a loser who wrecks, each staked by a lock both seats verified. The
// federation port is the fixture's, checking a settlement as the guardians do
// (every claimed lock stored, P opening its point, the signature under claim_pk
// over the txid, the payouts inside what the locks pay) with the guardians' real
// fee rule, measured on stock fedimintd 0.12.0 by stake-lock-step3.sh: 1000 msat
// per input and per output, 0 ppm.
//
// MEASURED BEFORE (W5b, TASKBOOK): nothing claimed a loser's lock - its forfeit
// was 409, the lock stayed held and went back to the loser at its expiry.
// HARNESS: lockRound and lockAndPlay as forfeit.test.js has them (file-local there).
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
import { toHex, fromHex, sha256 } from '../../protocol/src/hash.js';

const curve = { ...feldmanGroup, tweakPoint };
const REAL_FEES = { ppm: 0n, baseMsat: 1000n };

async function lockRound({ minScore = 1 } = {}) {
  const port = lockPort();
  port.feeRule = REAL_FEES;
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

const standing = async (d, w) => (await fetch(`http://127.0.0.1:${d.port}/lock-settlement?round=${toHex(w.rid)}`)).json();
const closeRound = (w) => Promise.all([say(w.a.port, `close ${toHex(w.rid)}`), say(w.b.port, `close ${toHex(w.rid)}`)]);
async function untilSettled(w, ms = 30000) {
  let got;
  for (const stop = Date.now() + ms; Date.now() < stop; await wait(250)) {
    got = await standing(w.a, w);
    if (got.state === 'ACCEPTED') return got;
  }
  return got;
}
const key = (o) => `${toHex(o.txid)}:${o.outIdx}`;

test('after the window the loser\'s lock is claimed by one committee signature, and the winner is paid 96000 msat from it - the real guardians\' 1000 msat per input and output taken out', async () => {
  const w = await lockRound();
  try {
    const won = await lockAndPlay(w, WINNER);
    const lost = await lockAndPlay(w, LOSER);
    assert.equal((await standing(w.a, w)).state, 'NONE', 'a settlement before the round closed');
    await closeRound(w);
    const got = await untilSettled(w);
    const paid = [...w.port.payouts.values()];
    console.log(`  settled: ${got.state} - ${got.why}; the loser's lock ${w.port.locks.has(key(lost.outpoint)) ? 'STILL HELD' : 'claimed'}, `
      + `the winner's ${w.port.locks.has(key(won.outpoint)) ? 'still held for its forfeit' : 'GONE'}; payouts ${paid.map((p) => `${p.msat} msat to ${toHex(p.payoutPk).slice(0, 12)}`).join(', ')}; `
      + `submissions ${w.port.settlements.length}`);
    assert.equal(got.state, 'ACCEPTED', got.why);
    assert.equal(w.port.locks.has(key(lost.outpoint)), false, 'the loser\'s lock was not claimed');
    assert.equal(w.port.locks.has(key(won.outpoint)), true, 'the settlement spent the winner\'s own lock - that comes back by its forfeit');
    assert.equal(paid.length, 1, 'one payout contract, to the one qualifier');
    assert.equal(toHex(paid[0].payoutPk), toHex(refundKeyOf(WINNER.key)), 'the payout is not keyed to the winner\'s own lock key');
    assert.equal(netStakeMsat(lost.entry), 98000n);
    assert.equal(paid[0].msat, 96000n, '98000 in, 1000 on the input, 1000 on the output');
    const sent = w.port.settlements[0];
    assert.equal(schnorr.verify(sent.signature, fromHex(got.message), w.claimPk.subarray(1)), true, 'the signature is not the claim key\'s over the txid');
    assert.deepEqual(sent.claims.map((c) => key(c.outpoint)), [key(lost.outpoint)]);
    const atB = await standing(w.b, w);
    assert.equal(atB.txid, got.txid, 'the other seat does not hold the same settlement');
    // AND THE WINNER'S OWN STAKE STILL COMES BACK BY ITS FORFEIT (W5b).
    const f = await fetch(`http://127.0.0.1:${w.a.port}/forfeit?round=${toHex(w.rid)}&entry=${toHex(won.eid)}`);
    assert.equal(f.status, 200, await f.text());
  } finally { await w.close(); }
});

test('a round with a loser and no qualifier claims nothing: the hold path\'s verdict, and the lock expires back to its player', async () => {
  const w = await lockRound({ minScore: 1000000 });
  try {
    const one = await lockAndPlay(w, WINNER);
    const two = await lockAndPlay(w, LOSER);
    await closeRound(w);
    await wait(WINDOW_MS + 3000);
    const got = await standing(w.a, w);
    console.log(`  no qualifier: ${got.state}; locks held ${[one, two].filter((x) => w.port.locks.has(key(x.outpoint))).length} of 2; submissions ${w.port.settlements.length}`);
    assert.equal(got.state, 'NONE');
    assert.equal(w.port.settlements.length, 0, 'a settlement with nobody to pay was submitted');
    assert.equal(w.port.locks.has(key(two.outpoint)), true);
  } finally { await w.close(); }
});
