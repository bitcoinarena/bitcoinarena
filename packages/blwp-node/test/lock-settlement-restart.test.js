// W6 SPLIT OUT OF lock-settlement.test.js (2026-09-23) so each file runs inside the 180 s cap: the restart cases
// grew a send plan each when a paid winner came to name a Lightning address.
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
import { lockRound, lockAndPlay, standing, closeRound, untilSettled, curve, lnurl } from './lock-round-fixture.js';
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

const REAL_FEES = { ppm: 0n, baseMsat: 1000n };

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
const key = (o) => `${toHex(o.txid)}:${o.outIdx}`;

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
  const address = lnurl(port);
  const start = (name, at = 0) => serve(openStore(join(dir, `${name}.sqlite`)),
    { port: at, ...opts, stakeLocks: dying(name), poolCurve: curve, finality: { everyMs: 100 }, lnurlFetch: address.fetchLike });
  const w = { dir, port, death, sent, lnurl: address, a: await start('a'), b: await start('b') };
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
// A SETTLEMENT IS IN when an output of its txid is stored - or, for the winning sent to the winner's address, when the
// send made from that txid's own output is PAID: a gateway claims that contract as it pays, so it is no longer stored
// (measured: which output that is follows the payout keys' order, and the old check read only output 0).
const payoutAt = (w, txid) => (txid ? [...Array(8).keys()].some((i) => w.port.locks.has(`${txid}:${i}`))
  || [w.a, w.b].some((d) => d && d.round.sendAttemptsOf(w.rid).some((r) => r.attempt === 0 && String(r.txid) === txid && r.state === 'PAID'))
  : false);
async function until(pred, ms = 10000) { for (const stop = Date.now() + ms; Date.now() < stop; await wait(100)) if (pred()) return true; return pred(); }
// WHAT EACH SIGNER NODE'S ROW AND THE FEDERATION HOLD, printed before any assertion.
const standingOf = (w, lost, signedTxid) => ({
  a: rowAt(w.a, w) && { state: rowAt(w.a, w).state, txid: rowAt(w.a, w).txid.slice(0, 12), why: rowAt(w.a, w).why.slice(0, 90) },
  b: rowAt(w.b, w) && { state: rowAt(w.b, w).state, txid: rowAt(w.b, w).txid.slice(0, 12) },
  loserLockHeld: heldAt(w, lost.outpoint), payoutAtSignedTxid: payoutAt(w, signedTxid), submissions: w.sent.length,
});
async function playAndDie(w, mode) {
  const won = await lockAndPlay(w, WINNER, { address: true });
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
    // THE NEW SETTLEMENT WENT IN: its payout is stored at the new txid - or, since the winner named an address, it was the
    // outgoing contract a gateway claimed by paying: the send made from the new txid's own output is PAID.
    const sentFromNew = [w.a, w.b].some((d) => d && d.round.sendAttemptsOf(w.rid)
      .some((r) => r.attempt === 0 && String(r.txid).slice(0, 12) === now.txid.slice(0, 12) && r.state === 'PAID'));
    assert.ok(after.payoutAtNewTxid || sentFromNew, 'nothing of the new settlement is in the federation');
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

