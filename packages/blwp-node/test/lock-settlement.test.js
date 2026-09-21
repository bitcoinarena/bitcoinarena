// W4: THE LOSER'S STAKE LOCK IS CLAIMED INTO THE ROUND'S ONE SETTLEMENT, AND THE
// WINNER IS PAID FROM IT (the owner 2026-09-14 07:22: "a loser loses the stake. The
// lock is claimed into the pool. Winners are paid from that."; FEDERATION.md
// money flow step 5).
//
// Two signer nodes of a lock round with a claim key made between them; a winner who
// delivers and a loser who wrecks, each staked by a lock both signer nodes verified. The
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
import { TEST_FEDERATION_ID } from '../../protocol/src/test-federation.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { feldmanGroup, tweakPoint } from '../src/curve.js';
import { assumeAssigned } from './assignment.js';
import { lockPort } from './lock-fixture.js';
import { b32, rand, RANDOMNESS, STAKE, WINDOW_MS, WINNER, LOSER, GENESIS_HASH, wordsAt, contractFor, say, secretScalar, opts, wait } from './window-fixture.js';
import { encodeRoundContract, decodeRoundContract, roundId, encodeEntryContract, entryId } from '../../protocol/src/contracts.js';
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

async function lockRound({ minScore = 1, stakeMsat = STAKE } = {}) {
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
    custody: 'FEDERATION', federationId: TEST_FEDERATION_ID, minScore, stakeMsat };
  const rid = roundId(c);
  for (const d of [a, b]) {
    const r = await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: encodeRoundContract(c) });
    assert.equal(r.status, 201, await r.text());
    assumeAssigned(d.round, rid, c.nodes);
  }
  for (let pass = 0; pass < 2; pass++) for (const d of [a, b]) await d.dkg.run(c.nodes);
  const held = a.dkg.signerNodeFor(c.nodes);
  assert.equal(held.ok, true, held.why);
  return { a, b, c, rid, port, claimPk: held.pool.groupPublicKey, close: async () => { await a.close(); await b.close(); } };
}

// `feeLock` DEFAULTS TO TRUE (2026-09-21): on a federation that charges no base fee this round's gate mints
// fee locks at every size measured, so an entry that brings none is refused at the door - which is pick (a)
// working, not a failure. A test that is ABOUT that refusal builds its own entry below.
async function lockAndPlay(w, who, { feeLock = true, feeFirst = false } = {}) {
  const session = ed25519.utils.randomSecretKey();
  const preimage = secretScalar();
  const e = rand(32);
  // PICK A: the fee locked to H(F), F handed over openly in the entry (F5).
  const feeSecret = feeLock ? rand(32) : new Uint8Array(32);
  const feeOutpoint = feeLock ? { txid: rand(32), outIdx: 1n } : { txid: new Uint8Array(32), outIdx: 0n };
  const dealt = await dealHandout({ preimage, signerNodes: w.c.nodes, roundId: w.rid, playerPubkey: who.key,
    ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e), coefficients: [scalarFrom32(rand(32)) % FIELD], needed: 2, curve: feldmanGroup });
  assert.equal(dealt.ok, true, dealt.why);
  const outpoint = { txid: rand(32), outIdx: 0n };
  const entry = {
    roundId: w.rid, playerPubkey: who.key, sessionPubkey: ed25519.getPublicKey(session),
    stakeCommitment: sha256(preimage), stakeMsat: w.c.stakeMsat, feeMsat: entryFeeMsat(w.c.stakeMsat), donationMsat: 0n,
    joinTick: 0, worldSecret: who.worldSecret, vssSharesRef: handoutId(dealt.handout), stakePoint: dealt.handout.commitments[0],
    feePreimage: feeSecret, stakeLockOutpoint: outpoint, feeLockOutpoint: feeOutpoint,
    claimKeyAttestationRef: b32(0x9a),
  };
  const eid = entryId(entry);
  const fields = { paymentImage: { kind: 'point', bytes: entry.stakePoint }, amountMsat: netStakeMsat(entry), claimPk: w.claimPk,
    refundPk: refundKeyOf(who.key), expiration: w.port.height + 200 };
  await w.port.put(outpoint, fields);
  const feeFields = feeLock ? { paymentImage: { kind: 'hash', bytes: sha256(feeSecret) }, amountMsat: entry.feeMsat, claimPk: w.claimPk,
    refundPk: refundKeyOf(who.key), expiration: w.port.height + 200 } : null;
  if (feeLock) await w.port.put(feeOutpoint, feeFields);
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
    const joined = await fetch(`${base}/entry`, { method: 'POST', body: encodeEntryContract(entry) });
    assert.equal(joined.status, 201, await joined.text());
    // PICK (a): THE STAKE COUNTS WHICHEVER LOCK COMES LAST - the fee lock may be handed first.
    const handFee = async () => {
      const fee = await fetch(`${base}/fee-lock?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(feeFields)) });
      assert.equal(fee.status, 201, await fee.text());
    };
    if (feeLock && feeFirst) {
      await handFee();
      assert.equal(d.round.stakeSeen(eid), null, 'a stake counted on its fee lock alone, before its stake lock');
    }
    const locked = await fetch(`${base}/lock?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(fields)) });
    assert.equal(locked.status, 201, await locked.text());
    if (feeLock && !feeFirst) await handFee();
    assert.equal(await say(d.port, encodeInputBatch(input)), String(who.ticks));
    assert.equal((await say(d.port, signedMark)).length, SIGNED_RECEIPT_BYTES);
  }
  return { eid, entry, fields, outpoint, feeOutpoint };
}

// PICK (a) (the owner 2026-09-14): REFUSE AT THE DOOR. An entry that brings no fee lock - naming
// none, or naming one it never hands over - joined as far as the signer nodes let it, and its
// first batch offered.
async function joinWithout(w, who, { namesFeeLock }) {
  const session = ed25519.utils.randomSecretKey();
  const preimage = secretScalar();
  const e = rand(32);
  const dealt = await dealHandout({ preimage, signerNodes: w.c.nodes, roundId: w.rid, playerPubkey: who.key,
    ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e), coefficients: [scalarFrom32(rand(32)) % FIELD], needed: 2, curve: feldmanGroup });
  const outpoint = { txid: rand(32), outIdx: 0n };
  const entry = {
    roundId: w.rid, playerPubkey: who.key, sessionPubkey: ed25519.getPublicKey(session),
    stakeCommitment: sha256(preimage), stakeMsat: w.c.stakeMsat, feeMsat: entryFeeMsat(w.c.stakeMsat), donationMsat: 0n,
    joinTick: 0, worldSecret: who.worldSecret, vssSharesRef: handoutId(dealt.handout), stakePoint: dealt.handout.commitments[0],
    feePreimage: namesFeeLock ? rand(32) : new Uint8Array(32),
    stakeLockOutpoint: outpoint, feeLockOutpoint: namesFeeLock ? { txid: rand(32), outIdx: 1n } : { txid: new Uint8Array(32), outIdx: 0n },
    claimKeyAttestationRef: b32(0x9a),
  };
  const eid = entryId(entry);
  const fields = { paymentImage: { kind: 'point', bytes: entry.stakePoint }, amountMsat: netStakeMsat(entry), claimPk: w.claimPk,
    refundPk: refundKeyOf(who.key), expiration: w.port.height + 200 };
  await w.port.put(outpoint, fields);
  const at = [];
  for (const d of [w.a, w.b]) {
    const base = `http://127.0.0.1:${d.port}`;
    await fetch(`${base}/handout`, { method: 'POST', body: encodeHandout(dealt.handout) });
    const joined = await fetch(`${base}/entry`, { method: 'POST', body: encodeEntryContract(entry) });
    const why = joined.status === 201 ? 'joined' : await joined.text();
    const locked = joined.status === 201 ? await fetch(`${base}/lock?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(fields)) }) : null;
    at.push({ entry: joined.status, why, lock: locked ? locked.status : null, lockSaid: locked ? await locked.text() : null,
      stored: !!d.round.entry(eid), seen: !!d.round.stakeSeen(eid) });
  }
  const input = { roundId: w.rid, entryId: eid, previousHash: GENESIS_HASH, firstTick: 0, ticks: Array.from({ length: 60 }, (_, t) => wordsAt(t)), liquidations: [] };
  const played = String(await say(w.a.port, encodeInputBatch(input)));
  return { eid, outpoint, at, played };
}

const standing = async (d, w) => (await fetch(`http://127.0.0.1:${d.port}/lock-settlement?round=${toHex(w.rid)}`)).json();
const closeRound = (w) => Promise.all([say(w.a.port, `close ${toHex(w.rid)}`), say(w.b.port, `close ${toHex(w.rid)}`)]);

/**
 * FEDIMINTD'S MEASURED DEFAULT, APPLIED AFTER THE ENTRIES ARE IN (2026-09-21).
 *
 * `REAL_FEES` is 1000 msat base, measured on fedimintd 0.12.0, and §22A forbids exactly that: a BLWP
 * federation runs with `disable_base_fees`. The node enforces it at the entry door, so a round can no longer
 * be OPENED against such a federation - that is what refused 43 entries across five suites. The arithmetic is
 * still worth testing, so the rule arrives here instead: after every entry, before the close.
 *
 * It is called by the tests that are ABOUT the real rule, never blanket-applied - a test that chooses its own
 * federation (the fee-lock claim test runs a zero-fee one, because its 98000/2000 arithmetic is what a legal
 * federation pays) must keep the rule it chose.
 */
const federationChargesItsRealFee = (w) => { w.port.feeRule = REAL_FEES; };
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
    federationChargesItsRealFee(w);   // the arithmetic below is fedimintd's, and every entry is already in
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
    assert.equal(atB.txid, got.txid, 'the other signer node does not hold the same settlement');
    // AND THE WINNER'S OWN STAKE STILL COMES BACK BY ITS FORFEIT (W5b).
    const f = await fetch(`http://127.0.0.1:${w.a.port}/forfeit?round=${toHex(w.rid)}&entry=${toHex(won.eid)}`);
    assert.equal(f.status, 200, await f.text());
  } finally { await w.close(); }
});

// A WITHDRAWAL CLAIMED ON ANOTHER DEVICE (spec §24, the owner 2026-09-14): alice plays on her desktop,
// forgets to withdraw, and two hours later plays on her iPhone holding only her seed. The signer nodes list
// the rounds they settled since a time, each with the keys its settlement pays and its locks' refund
// keys; the device derives its own key per round and matches it there, asking nothing per round.
// Before: /rounds lists only rounds still open for entry.
test('the signer nodes list the rounds they settled since a time with the keys each pays and its locks\' refund keys, so a device holding only the seed finds what it is owed', async () => {
  const w = await lockRound();
  try {
    const won = await lockAndPlay(w, WINNER);
    const lost = await lockAndPlay(w, LOSER);
    const settled = (since) => fetch(`http://127.0.0.1:${w.a.port}/settled?since=${since}`);
    const before = await (await settled(0)).json();
    assert.equal(before.rounds.some((r) => r.id === toHex(w.rid)), false, 'a round was listed as settled before it closed');
    await closeRound(w);
    const got = await untilSettled(w);
    assert.equal(got.state, 'ACCEPTED', got.why);
    const listed = await (await settled(0)).json();
    const mine = listed.rounds.find((r) => r.id === toHex(w.rid));
    assert.ok(mine, 'the settled round is not listed');
    assert.equal(mine.state, 'ACCEPTED');
    assert.deepEqual(mine.payouts, [toHex(refundKeyOf(WINNER.key))], 'the listed payout keys are not the qualifier\'s');
    assert.deepEqual([...mine.refunds].sort(), [toHex(refundKeyOf(WINNER.key)), toHex(refundKeyOf(LOSER.key))].sort(), 'the listed refund keys are not the two locks\'');
    assert.equal('contract' in mine, false, 'every listed round carries its contract');
    // AND THE CONTRACT OF A ROUND A DEVICE MATCHED, FROM /round: its id.
    const c = new Uint8Array(await (await fetch(`http://127.0.0.1:${w.a.port}/round?id=${mine.id}`)).arrayBuffer());
    assert.equal(toHex(roundId(decodeRoundContract(c))), toHex(w.rid), 'the round\'s contract is not its id');
    assert.ok(won.outpoint && lost.outpoint);
    const later = await (await settled(Number(mine.madeMs) + 1)).json();
    assert.equal(later.rounds.some((r) => r.id === toHex(w.rid)), false, 'a round settled before since= was listed');
    assert.equal((await settled('x')).status, 400);
    const atB = await (await fetch(`http://127.0.0.1:${w.b.port}/settled?since=0`)).json();
    assert.ok(atB.rounds.some((r) => r.id === toHex(w.rid)), 'the other signer node does not list the round it settled');
    console.log(`  /settled: ${listed.rounds.length} round(s) at signer node A, this one ${mine.state} at ${mine.madeMs}, paying ${mine.payouts.length} key, ${mine.refunds.length} refund keys; since ${Number(mine.madeMs) + 1}: ${later.rounds.length}; signer node B lists it too`);
  } finally { await w.close(); }
});

// W6 (the owner 2026-09-15): A SIGNER NODE KILLED INSIDE A LOCK SETTLEMENT RECOVERS TO THE RIGHT STATE ON
// RESTART. Two signer nodes on store files, each reaching the federation through a port that can die with
// the signer node: after the guardians took the settlement (a) or before it went (b). The signer nodes are then
// started again on their files - on the same ports, so the round's signer node addresses still hold - and
// sometimes cannot rebuild what they signed (c): the federation's fee rule changed, or the other signer node
// is down so no loser's P opens. Identical bytes sent again are ACCEPTED (stake-lock-step3.sh c1),
// so that is not the failure; a rebuild that differs or refuses is. Each case prints what the row
// and the federation held before and after the restart.
async function lockRoundOnDisk() {
  const dir = mkdtempSync(join(tmpdir(), 'w6-'));
  const port = lockPort();
  const death = { mode: 'none' };
  const sent = [];
  const dying = (name) => ({ ...port, async settle(args) {
    if (!args.signature) return port.settle(args);
    if (death.mode === 'before') throw new Error(`signer node ${name} died before its settlement reached the guardians`);
    const r = await port.settle(args);
    sent.push({ signerNode: name, txid: r.txid, accepted: r.accepted, error: r.error,
      signatureOverItsBytes: schnorr.verify(args.signature, fromHex(r.message), args.claimPk.subarray(1)) });
    if (death.mode === 'after') throw new Error(`signer node ${name} died after the guardians answered ${r.accepted ? 'accepted' : 'refused'}`);
    return r;
  } });
  const start = (name, at = 0) => serve(openStore(join(dir, `${name}.sqlite`)),
    { port: at, ...opts, stakeLocks: dying(name), poolCurve: curve, finality: { everyMs: 100 } });
  const w = { dir, port, death, sent, a: await start('a'), b: await start('b') };
  const wire = () => {
    for (const [d, o] of [[w.a, w.b], [w.b, w.a]]) {
      if (!d || !o) continue;
      const there = [`http://127.0.0.1:${o.port}`];
      d.verifier.peers = there; d.payouts.peers = there; d.preimages.peers = there; d.dkg.peers = there;
    }
  };
  wire();
  w.c = { ...contractFor([w.a.round.pubkey, w.b.round.pubkey], BigInt(WINDOW_MS), [w.a, w.b].map((d) => `http://127.0.0.1:${d.port}`)),
    custody: 'FEDERATION', federationId: TEST_FEDERATION_ID, minScore: 1, stakeMsat: STAKE };
  w.rid = roundId(w.c);
  for (const d of [w.a, w.b]) {
    const r = await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: encodeRoundContract(w.c) });
    assert.equal(r.status, 201, await r.text());
    assumeAssigned(d.round, w.rid, w.c.nodes);
  }
  for (let pass = 0; pass < 2; pass++) for (const d of [w.a, w.b]) await d.dkg.run(w.c.nodes);
  const held = w.a.dkg.signerNodeFor(w.c.nodes);
  assert.equal(held.ok, true, held.why);
  w.claimPk = held.pool.groupPublicKey;
  // STARTED AGAIN ON ITS FILE AND ITS PORT; a signer node named in `down` stays down.
  w.restart = async ({ down = [] } = {}) => {
    const at = { a: w.a && w.a.port, b: w.b && w.b.port };
    for (const n of ['a', 'b']) if (w[n]) { await w[n].close(); w[n] = null; }
    for (const n of ['a', 'b']) if (!down.includes(n)) w[n] = await start(n, at[n]);
    wire();
  };
  w.close = async () => { for (const n of ['a', 'b']) if (w[n]) await w[n].close(); rmSync(dir, { recursive: true, force: true }); };
  return w;
}
const rowAt = (d, w) => (d ? d.round.lockSettlement(w.rid) : null);
const heldAt = (w, o) => w.port.locks.has(key(o));
const payoutAt = (w, txid, i = 0) => (txid ? w.port.locks.has(`${txid}:${i}`) : false);
async function until(pred, ms = 10000) { for (const stop = Date.now() + ms; Date.now() < stop; await wait(100)) if (pred()) return true; return pred(); }
// WHAT EACH SIGNER NODE'S ROW AND THE FEDERATION HOLD, printed before any assertion.
const standingOf = (w, lost, signedTxid) => ({
  a: rowAt(w.a, w) && { state: rowAt(w.a, w).state, txid: rowAt(w.a, w).txid.slice(0, 12), why: rowAt(w.a, w).why.slice(0, 90) },
  b: rowAt(w.b, w) && { state: rowAt(w.b, w).state, txid: rowAt(w.b, w).txid.slice(0, 12) },
  loserLockHeld: heldAt(w, lost.outpoint), payoutAtSignedTxid: payoutAt(w, signedTxid), submissions: w.sent.length,
});
async function playAndDie(w, mode) {
  const won = await lockAndPlay(w, WINNER);
  const lost = await lockAndPlay(w, LOSER);
  w.death.mode = mode;
  await closeRound(w);
  await until(() => { const r = rowAt(w.a, w); return !!r && r.state === 'SUBMITTING' && (mode === 'before' || w.sent.length > 0); }, 30000);
  await wait(300);
  const signedTxid = rowAt(w.a, w) && rowAt(w.a, w).txid;
  w.death.mode = 'none';
  return { won, lost, signedTxid };
}

test('W6 (a): the guardians took the settlement and the signer nodes died before saving it; started again on their stores with the same plan, the signer nodes hold ACCEPTED', async () => {
  const w = await lockRoundOnDisk();
  try {
    const { lost, signedTxid } = await playAndDie(w, 'after');
    const before = standingOf(w, lost, signedTxid);
    await w.restart();
    await until(() => ['a', 'b'].every((n) => (rowAt(w[n], w) || {}).state !== 'SUBMITTING'));
    const after = standingOf(w, lost, signedTxid);
    console.log(`  (a) before the restart ${JSON.stringify(before)}`);
    console.log(`  (a) after it          ${JSON.stringify(after)}`);
    assert.equal(before.payoutAtSignedTxid, true, 'the guardians did not take it before the signer nodes died');
    assert.equal(before.a.state, 'SUBMITTING');
    assert.equal(after.a.state, 'ACCEPTED', after.a.why);
    assert.equal(after.b.state, 'ACCEPTED');
    assert.equal(after.loserLockHeld, false);
    assert.equal(after.payoutAtSignedTxid, true);
  } finally { await w.close(); }
});

test('W6 (a)+(c): the guardians took it, the signer nodes died before saving, and after the restart the plan rebuilt differs (the federation\'s fee rule changed) - the signer nodes hold ACCEPTED from the federation, and no signature goes out over other bytes', async () => {
  const w = await lockRoundOnDisk();
  try {
    const { lost, signedTxid } = await playAndDie(w, 'after');
    const before = standingOf(w, lost, signedTxid);
    w.port.feeRule = { ppm: 0n, baseMsat: 1500n };
    await w.restart();
    await until(() => ['a', 'b'].every((n) => (rowAt(w[n], w) || {}).state !== 'SUBMITTING'));
    const after = standingOf(w, lost, signedTxid);
    const overOther = w.sent.filter((x) => !x.signatureOverItsBytes).length;
    console.log(`  (a)+(c) fee rule changed, before ${JSON.stringify(before)}`);
    console.log(`  (a)+(c) fee rule changed, after  ${JSON.stringify(after)}; signatures sent over other bytes: ${overOther}`);
    assert.equal(before.payoutAtSignedTxid, true, 'the guardians did not take it before the signer nodes died');
    assert.equal(after.a.state, 'ACCEPTED', `the money moved and signer node A holds ${after.a.state}: ${after.a.why}`);
    assert.equal(after.b.state, 'ACCEPTED', `the money moved and signer node B holds ${after.b.state}`);
    assert.equal(overOther, 0, 'a signature went out over bytes it does not sign');
  } finally { await w.close(); }
});

test('W6 (a)+(c): the guardians took it, the signer nodes died before saving, and after the restart signer node B stays down so no loser\'s P opens - signer node A holds ACCEPTED from the federation', async () => {
  const w = await lockRoundOnDisk();
  try {
    const { lost, signedTxid } = await playAndDie(w, 'after');
    const before = standingOf(w, lost, signedTxid);
    await w.restart({ down: ['b'] });
    await until(() => (rowAt(w.a, w) || {}).state !== 'SUBMITTING', 8000);
    const after = standingOf(w, lost, signedTxid);
    console.log(`  (a)+(c) signer node B down, before ${JSON.stringify(before)}`);
    console.log(`  (a)+(c) signer node B down, after  ${JSON.stringify(after)}`);
    assert.equal(before.payoutAtSignedTxid, true, 'the guardians did not take it before the signer nodes died');
    assert.equal(after.a.state, 'ACCEPTED', `the money moved and signer node A holds ${after.a.state}: ${after.a.why}`);
  } finally { await w.close(); }
});

test('W6 (b): the signer nodes died before their settlement reached the guardians; started again, they submit it - the same txid - and hold ACCEPTED', async () => {
  const w = await lockRoundOnDisk();
  try {
    const { lost, signedTxid } = await playAndDie(w, 'before');
    const before = standingOf(w, lost, signedTxid);
    await w.restart();
    await until(() => ['a', 'b'].every((n) => (rowAt(w[n], w) || {}).state !== 'SUBMITTING'));
    const after = standingOf(w, lost, signedTxid);
    console.log(`  (b) before the restart ${JSON.stringify(before)}`);
    console.log(`  (b) after it          ${JSON.stringify(after)}`);
    assert.equal(before.loserLockHeld, true, 'the loser\'s lock was claimed before any submit');
    assert.equal(before.payoutAtSignedTxid, false);
    assert.equal(after.a.state, 'ACCEPTED', after.a.why);
    assert.equal(after.loserLockHeld, false);
    assert.equal(after.payoutAtSignedTxid, true, 'the settlement that went in is not the one signed');
  } finally { await w.close(); }
});

test('W6 (b)+(c): the signer nodes died before sending, and after the restart the plan rebuilt differs - the signer nodes sign it afresh and hold ACCEPTED; no signature goes out over other bytes', async () => {
  const w = await lockRoundOnDisk();
  try {
    const { lost, signedTxid } = await playAndDie(w, 'before');
    const before = standingOf(w, lost, signedTxid);
    w.port.feeRule = { ppm: 0n, baseMsat: 1500n };
    await w.restart();
    await until(() => ['a', 'b'].every((n) => (rowAt(w[n], w) || {}).state !== 'SUBMITTING'));
    const now = rowAt(w.a, w);
    const after = { ...standingOf(w, lost, signedTxid), payoutAtNewTxid: payoutAt(w, now && now.txid) };
    const overOther = w.sent.filter((x) => !x.signatureOverItsBytes).length;
    console.log(`  (b)+(c) fee rule changed, before ${JSON.stringify(before)}`);
    console.log(`  (b)+(c) fee rule changed, after  ${JSON.stringify(after)}; signatures sent over other bytes: ${overOther}`);
    assert.equal(overOther, 0, 'a signature went out over bytes it does not sign');
    assert.equal(after.a.state, 'ACCEPTED', after.a.why);
    assert.notEqual(now.txid.slice(0, 12), before.a.txid, 'the plan did not change, so this measures nothing');
    assert.equal(after.loserLockHeld, false);
    assert.equal(after.payoutAtNewTxid, true);
  } finally { await w.close(); }
});

test('W6 mixed: the signer nodes died before sending and the loser\'s lock then left the federation by itself (a refund after expiry) with no payout stored - the signer nodes keep SUBMITTING with the reason and do not retry', async () => {
  const w = await lockRoundOnDisk();
  try {
    const { lost, signedTxid } = await playAndDie(w, 'before');
    const before = standingOf(w, lost, signedTxid);
    w.port.locks.delete(key(lost.outpoint));
    await w.restart();
    await wait(3000);
    const after = standingOf(w, lost, signedTxid);
    console.log(`  mixed, before the restart ${JSON.stringify(before)}`);
    console.log(`  mixed, after it          ${JSON.stringify(after)}`);
    assert.equal(after.a.state, 'SUBMITTING', `a picture the federation does not settle was written ${after.a.state}`);
    assert.match(after.a.why, /gone|payout/, 'the row does not say why it waits');
    assert.equal(after.submissions, before.submissions, 'a settlement was retried over a picture that is neither in nor out');
  } finally { await w.close(); }
});

// PICK (a) (the owner 2026-09-14): REFUSE AT THE DOOR - where the round's gate mints.
test('where the round mints fee locks (1000 sat, the federation\'s own rule) a signer node refuses at the door an entry that brings none - not joined, no stake counted - and the round of those who brought theirs settles as before', async () => {
  const w = await lockRound({ stakeMsat: 1000000n });
  try {
    const bare = await joinWithout(w, { key: b32(0x07), worldSecret: b32(0x17) }, { namesFeeLock: false });
    console.log(`  no fee lock named: ${bare.at.map((s) => `${s.entry} "${s.why.slice(0, 120)}"`).join(' / ')}; stored ${bare.at.map((s) => s.stored).join('/')}`);
    for (const s of bare.at) {
      assert.equal(s.entry, 409, 'an entry with no fee lock was taken in a round that mints them');
      assert.match(s.why, /this round mints fee locks .*an entry that brings no fee lock is not taken/);
      assert.equal(s.stored, false);
      assert.equal(s.seen, false);
    }
    const won = await lockAndPlay(w, WINNER, { feeLock: true });
    const lost = await lockAndPlay(w, LOSER, { feeLock: true });
    federationChargesItsRealFee(w);   // this round's numbers are fedimintd's own deductions
    await closeRound(w);
    const got = await untilSettled(w);
    assert.equal(got.state, 'ACCEPTED', got.why);
    const paid = [...w.port.payouts.values()];
    const winner = paid.find((p) => toHex(p.payoutPk) === toHex(refundKeyOf(WINNER.key)));
    console.log(`  the round of those who brought theirs: ${got.why}; payouts ${paid.map((p) => String(p.msat)).join(', ')}`);
    assert.equal(winner.msat, 978000n);
    assert.deepEqual(paid.filter((p) => p !== winner).map((p) => p.msat), [18000n, 18000n]);
    assert.equal(w.port.locks.has(key(lost.outpoint)), false, 'the loser\'s lock was not claimed');
    assert.equal(w.port.locks.has(key(won.outpoint)), true);
    assert.equal(w.port.locks.has(key(bare.outpoint)), true, 'a lock the round never took was claimed');
  } finally { await w.close(); }
});

test('where the round mints, an entry that names a fee lock and never hands it over is never committed: its stake lock kept and not counted, its play refused, and the settlement runs without it', async () => {
  const w = await lockRound({ stakeMsat: 1000000n });
  try {
    const half = await joinWithout(w, { key: b32(0x07), worldSecret: b32(0x17) }, { namesFeeLock: true });
    console.log(`  a fee lock named, never handed: ${half.at.map((s) => `entry ${s.entry}, lock ${s.lock} "${String(s.lockSaid).slice(-70)}", seen ${s.seen}`).join(' / ')}; its batch: "${half.played.slice(0, 80)}"`);
    for (const s of half.at) {
      assert.equal(s.entry, 201);
      assert.equal(s.lock, 201);
      assert.match(s.lockSaid, /counted once its fee lock is verified/);
      assert.equal(s.seen, false, 'a stake counted without its fee lock');
    }
    assert.match(half.played, /stake not seen/);
    const won = await lockAndPlay(w, WINNER, { feeLock: true });
    const lost = await lockAndPlay(w, LOSER, { feeLock: true });
    federationChargesItsRealFee(w);   // this round's numbers are fedimintd's own deductions
    await closeRound(w);
    const got = await untilSettled(w);
    assert.equal(got.state, 'ACCEPTED', got.why);
    const claimed = w.port.settlements[0].claims.map((c) => key(c.outpoint));
    assert.equal(claimed.includes(key(half.outpoint)), false, 'a stake never committed was claimed');
    assert.equal(claimed.includes(key(lost.outpoint)), true);
    assert.equal(w.port.locks.has(key(half.outpoint)), true, 'the uncommitted player\'s lock did not stay theirs');
    assert.equal(w.port.locks.has(key(won.outpoint)), true);
  } finally { await w.close(); }
});

test('where the round mints, a fee lock handed before its stake lock counts the stake once the stake lock comes: either order commits it, and the round settles as before', async () => {
  const w = await lockRound({ stakeMsat: 1000000n });
  try {
    const won = await lockAndPlay(w, WINNER, { feeLock: true, feeFirst: true });
    const lost = await lockAndPlay(w, LOSER, { feeLock: true });
    for (const d of [w.a, w.b]) {
      assert.ok(d.round.stakeSeen(won.eid), 'the fee-lock-first stake was never counted');
      assert.ok(d.round.stakeSeen(lost.eid));
    }
    federationChargesItsRealFee(w);   // this round's numbers are fedimintd's own deductions
    await closeRound(w);
    const got = await untilSettled(w);
    assert.equal(got.state, 'ACCEPTED', got.why);
    const winner = [...w.port.payouts.values()].find((p) => toHex(p.payoutPk) === toHex(refundKeyOf(WINNER.key)));
    console.log(`  fee lock first: ${got.why}; the winner ${winner && winner.msat}`);
    assert.equal(winner.msat, 978000n);
  } finally { await w.close(); }
});

// PICK A (the owner 2026-09-14): THE FEE LOCKS INTO THE SAME SETTLEMENT, FOR THE SITTING SIGNER NODES.
test('each player\'s fee lock is verified by both signer nodes and claimed in the round\'s one settlement: the winner paid 98000, each sitting signer node 2000 to its own key', async () => {
  const w = await lockRound();
  w.port.feeRule = { ppm: 0n, baseMsat: 0n };
  try {
    const won = await lockAndPlay(w, WINNER, { feeLock: true });
    const lost = await lockAndPlay(w, LOSER, { feeLock: true });
    await closeRound(w);
    const got = await untilSettled(w);
    const paid = [...w.port.payouts.values()];
    const sent = w.port.settlements[0];
    console.log(`  fee locks: ${got.state} - ${got.why}; inputs ${sent ? sent.claims.length : 0}; payouts ${paid.map((p) => `${p.msat} to ${toHex(p.payoutPk).slice(0, 10)}`).join(', ')}`);
    assert.equal(got.state, 'ACCEPTED', got.why);
    assert.deepEqual(sent.claims.map((c) => key(c.outpoint)).sort(), [key(lost.outpoint), key(won.feeOutpoint), key(lost.feeOutpoint)].sort(),
      'the inputs are not the loser\'s stake and both fee locks');
    const signerNodeKeys = w.c.nodes.map((k) => toHex(refundKeyOf(k))).sort();
    assert.deepEqual(paid.filter((p) => signerNodeKeys.includes(toHex(p.payoutPk))).map((p) => [toHex(p.payoutPk), p.msat]).sort(),
      signerNodeKeys.map((k) => [k, 2000n]), 'each sitting signer node is not paid its 2000 msat (1% + 1% of 200000, both pools)');
    assert.deepEqual(paid.filter((p) => toHex(p.payoutPk) === toHex(refundKeyOf(WINNER.key))).map((p) => p.msat), [98000n]);
    assert.equal([won.feeOutpoint, lost.feeOutpoint, lost.outpoint].some((o) => w.port.locks.has(key(o))), false, 'a claimed lock is still held');
    assert.equal(w.port.locks.has(key(won.outpoint)), true, 'the winner\'s own stake lock was spent - it comes back by its forfeit');
  } finally { await w.close(); }
});

test('under the real guardians\' 1000 msat per input and output the 2000 msat fee locks cannot reach a signer node: none is claimed, both stay held, the winner is still paid 96000', async () => {
  const w = await lockRound();
  try {
    const won = await lockAndPlay(w, WINNER, { feeLock: true });
    const lost = await lockAndPlay(w, LOSER, { feeLock: true });
    federationChargesItsRealFee(w);   // the arithmetic below is fedimintd's, and every entry is already in
    await closeRound(w);
    const got = await untilSettled(w);
    const paid = [...w.port.payouts.values()];
    console.log(`  real fee rule with fee locks: ${got.state} - ${got.why}; payouts ${paid.map((p) => p.msat).join(', ')}`);
    assert.equal(got.state, 'ACCEPTED', got.why);
    assert.match(got.why, /no fee lock claimed: the fee locks hold 4000 msat and their inputs alone cost 2000/);
    assert.deepEqual(paid.map((p) => p.msat), [96000n]);
    assert.equal(w.port.locks.has(key(won.feeOutpoint)) && w.port.locks.has(key(lost.feeOutpoint)), true, 'a fee lock was claimed that pays no signer node');
  } finally { await w.close(); }
});

// PICK (b): AT THE SMALLEST BRACKET THE GATE MINTS FOR - 1000 sat - THE CLAIMED FEE LOCKS
// PAY EVERY SITTING SIGNER NODE SOMETHING UNDER THE REAL GUARDIANS' 1000 msat PER INPUT AND OUTPUT.
test('a 1000 sat round\'s 20000 msat fee locks are claimed under the real guardians\' fees and every sitting signer node nets more than nothing', async () => {
  const w = await lockRound({ stakeMsat: 1000000n });
  try {
    const won = await lockAndPlay(w, WINNER, { feeLock: true });
    const lost = await lockAndPlay(w, LOSER, { feeLock: true });
    federationChargesItsRealFee(w);   // the arithmetic below is fedimintd's, and every entry is already in
    await closeRound(w);
    const got = await untilSettled(w);
    const sent = w.port.settlements[0];
    const signerNodeKeys = w.c.nodes.map((k) => toHex(refundKeyOf(k)));
    const paid = [...w.port.payouts.values()];
    const signerNodeNets = paid.filter((p) => signerNodeKeys.includes(toHex(p.payoutPk))).map((p) => p.msat);
    const feeIn = sent ? sent.claims.filter((c) => [key(won.feeOutpoint), key(lost.feeOutpoint)].includes(key(c.outpoint))) : [];
    console.log(`  1000 sat: ${got.state} - ${got.why}`);
    console.log(`  stake 1000000 msat, fee lock ${won.entry.feeMsat} msat x ${feeIn.length}, input fees ${feeIn.length * 1000} msat, `
      + `output fees ${signerNodeNets.length * 1000} msat, per-signer node net [${signerNodeNets.join(', ')}] msat; winner paid ${paid.filter((p) => toHex(p.payoutPk) === toHex(refundKeyOf(WINNER.key))).map((p) => p.msat).join(', ')}`);
    assert.equal(got.state, 'ACCEPTED', got.why);
    assert.equal(won.entry.feeMsat, 20000n);
    assert.equal(feeIn.length, 2, 'both fee locks are claimed');
    assert.equal(signerNodeNets.length, 2, 'every sitting signer node is paid');
    for (const n of signerNodeNets) assert.ok(n > 0n, `a signer node nets ${n}`);
    assert.equal([won.feeOutpoint, lost.feeOutpoint, lost.outpoint].some((o) => w.port.locks.has(key(o))), false);
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
