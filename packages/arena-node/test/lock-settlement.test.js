// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// W4: THE LOSER'S STAKE LOCK IS CLAIMED INTO THE ROUND'S ONE SETTLEMENT, AND THE
// WINNER IS PAID FROM IT (2026-09-14 07:22: "a loser loses the stake. The
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
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
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
import { lockRound, lockAndPlay, standing, closeRound, untilSettled, curve, lnurl, proposerOf } from './lock-round-fixture.js';
import { b32, rand, RANDOMNESS, STAKE, WINDOW_MS, WINNER, LOSER, GENESIS_HASH, wordsAt, contractFor, say, secretScalar, opts, wait } from './window-fixture.js';
import { encodeRoundContract, decodeRoundContract, roundId, encodeEntryContract, entryId } from '../../arena-protocol/src/contracts.js';
import { dealHandout, encodeHandout, handoutId } from '../../arena-protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../arena-protocol/src/shares.js';
import { encodeInputBatch, batchId } from '../../arena-protocol/src/batch.js';
import { encodeCheckpoint, checkpointId, joinSigned, NO_PREVIOUS } from '../../arena-protocol/src/checkpoint.js';
import { SIGNED_RECEIPT_BYTES } from '../../arena-protocol/src/receipt.js';
import { init, step } from '../../nextblock/src/sim.js';
import { hash as stateHash } from '../../nextblock/src/state.js';
import { seedWordForEntry } from '../../arena-protocol/src/seed.js';
import { netStakeMsat } from '../../arena-protocol/src/payout.js';
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { refundKeyOf, lockFieldsToJson } from '../../arena-protocol/src/stake-lock.js';
import { toHex, fromHex, sha256 } from '../../arena-protocol/src/hash.js';

const REAL_FEES = { ppm: 0n, baseMsat: 1000n };

// PICK (a) (2026-09-14): REFUSE AT THE DOOR. An entry that brings no fee lock - naming
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

// THE RULE'S FIGURES (§22A, §0A.8): the entry fee is 5% of the stake (entryFeeMsat), the net what is left,
// and the guardians' measured rule takes 1000 msat on every input and every output. Every amount below is computed.
const IO = 1000n;
const netOf = (stake) => stake - entryFeeMsat(stake);
/** Each sitting signer node's net from two fee locks under the guardians' rule: its half, less its half of the two inputs' fees and its own output's fee. */
const seatNetOfTwo = (stake) => (2n * entryFeeMsat(stake) - 2n * IO) / 2n - IO;
test('after the window the loser\'s lock is claimed by one committee signature, and the winner is paid its net stake less the guardians\' 1000 msat per input and output - and the 100 sat round\'s fee locks (5%) pay both seats', async () => {
  const w = await lockRound();
  try {
    const won = await lockAndPlay(w, WINNER, { address: true });
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
    // ONE PAYOUT CONTRACT TO THE ONE QUALIFIER, AND ONE TO EACH SITTING SEAT: under 5% a 100 sat round's two fee locks
    // (5000 msat each) out-weigh the guardians' 1000 msat per input and output, so they are claimed for the seats
    const winnerPaid = paid.filter((p) => toHex(p.payoutPk) === toHex(refundKeyOf(WINNER.key)));
    const seatKeys = w.c.nodes.map((k) => toHex(refundKeyOf(k)));
    assert.equal(paid.length, 1 + seatKeys.length, 'one payout contract to the one qualifier and one to each seat');
    assert.equal(winnerPaid.length, 1);
    // WINNINGS-AUTO (RULED 2026-10-01): the winner named an address, and is paid all the same by its payout
    // contract to its own key - redeemed into its federation wallet - never by a send refunding to the committee.
    assert.ok(!winnerPaid[0].sent, 'the qualifier was paid by a Lightning send');
    assert.equal(netStakeMsat(lost.entry), netOf(lost.entry.stakeMsat));
    assert.equal(winnerPaid[0].msat, netStakeMsat(lost.entry) - 2n * IO, 'the net stake in, 1000 on the input, 1000 on the output');
    assert.deepEqual(paid.filter((p) => seatKeys.includes(toHex(p.payoutPk))).map((p) => p.msat), seatKeys.map(() => seatNetOfTwo(lost.entry.stakeMsat)));
    const sent = w.port.settlements[0];
    assert.equal(schnorr.verify(sent.signature, fromHex(got.message), w.claimPk.subarray(1)), true, 'the signature is not the claim key\'s over the txid');
    assert.deepEqual(sent.claims.map((c) => key(c.outpoint)).sort(), [key(lost.outpoint), key(won.feeOutpoint), key(lost.feeOutpoint)].sort());
    const atB = await standing(w.b, w);
    assert.equal(atB.txid, got.txid, 'the other signer node does not hold the same settlement');
    // AND THE WINNER'S OWN STAKE STILL COMES BACK BY ITS FORFEIT (W5b).
    const f = await fetch(`http://127.0.0.1:${w.a.port}/forfeit?round=${toHex(w.rid)}&entry=${toHex(won.eid)}`);
    assert.equal(f.status, 200, await f.text());
  } finally { await w.close(); }
});

// A WITHDRAWAL CLAIMED ON ANOTHER DEVICE (spec §24, 2026-09-14): alice plays on her desktop,
// forgets to withdraw, and two hours later plays on her iPhone holding only her seed. The signer nodes list
// the rounds they settled since a time, each with the keys its settlement pays and its locks' refund
// keys; the device derives its own key per round and matches it there, asking nothing per round.
// Before: /rounds lists only rounds still open for entry.
test('the signer nodes list the rounds they settled since a time with the keys each pays and its locks\' refund keys, so a device holding only the seed finds what it is owed', async () => {
  const w = await lockRound();
  try {
    const won = await lockAndPlay(w, WINNER, { address: true });
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
    // WINNINGS-AUTO: the winning is a payout contract to the winner's key, so the list names it for the seed to collect.
    assert.deepEqual(mine.payouts, [toHex(refundKeyOf(WINNER.key))], 'the winner\'s payout is not listed for its seed to collect');
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

// PICK (a) (2026-09-14): REFUSE AT THE DOOR - where the round's gate mints.
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
    const won = await lockAndPlay(w, WINNER, { feeLock: true, address: true });
    const lost = await lockAndPlay(w, LOSER, { feeLock: true });
    federationChargesItsRealFee(w);   // this round's numbers are fedimintd's own deductions
    await closeRound(w);
    const got = await untilSettled(w);
    assert.equal(got.state, 'ACCEPTED', got.why);
    const paid = [...w.port.payouts.values()];
    const winner = paid.find((p) => toHex(p.payoutPk) === toHex(refundKeyOf(WINNER.key)));
    console.log(`  the round of those who brought theirs: ${got.why}; payouts ${paid.map((p) => String(p.msat)).join(', ')}`);
    assert.equal(winner.msat, netOf(1000000n) - 2n * IO);
    assert.deepEqual(paid.filter((p) => p !== winner).map((p) => p.msat), [seatNetOfTwo(1000000n), seatNetOfTwo(1000000n)]);
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
    const won = await lockAndPlay(w, WINNER, { feeLock: true, address: true });
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
    const won = await lockAndPlay(w, WINNER, { feeLock: true, feeFirst: true, address: true });
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
    assert.equal(winner.msat, netOf(1000000n) - 2n * IO);
  } finally { await w.close(); }
});

// PICK A (2026-09-14): THE FEE LOCKS INTO THE SAME SETTLEMENT, FOR THE SITTING SIGNER NODES.
test('each player\'s fee lock is verified by both signer nodes and claimed in the round\'s one settlement: the winner paid its net stake, each sitting signer node half of 5% of the gross to its own key', async () => {
  const w = await lockRound();
  w.port.feeRule = { ppm: 0n, baseMsat: 0n };
  try {
    const won = await lockAndPlay(w, WINNER, { feeLock: true, address: true });
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
    // two halves of the 5% on the 2 x stake gross, each seat in both pools: the two fee locks' sum, halved
    const seatEach = (won.entry.feeMsat + lost.entry.feeMsat) / 2n;
    assert.deepEqual(paid.filter((p) => signerNodeKeys.includes(toHex(p.payoutPk))).map((p) => [toHex(p.payoutPk), p.msat]).sort(),
      signerNodeKeys.map((k) => [k, seatEach]), 'each sitting signer node is not paid its half of the fee (2.5% + 2.5% of the gross, both pools)');
    assert.deepEqual(paid.filter((p) => toHex(p.payoutPk) === toHex(refundKeyOf(WINNER.key))).map((p) => p.msat), [netStakeMsat(lost.entry)], 'the winner is not paid the loser\'s net stake by its contract');
    assert.equal(paid.some((p) => p.sent), false, 'something was paid by a Lightning send');
    assert.equal([won.feeOutpoint, lost.feeOutpoint, lost.outpoint].some((o) => w.port.locks.has(key(o))), false, 'a claimed lock is still held');
    assert.equal(w.port.locks.has(key(won.outpoint)), true, 'the winner\'s own stake lock was spent - it comes back by its forfeit');
  } finally { await w.close(); }
});

// UNDER 5% THAT IS A 40 SAT ROUND: its 2000 msat fee locks are what the guardians' 4000 msat of input and output fees eat
test('under the real guardians\' 1000 msat per input and output a 40 sat round\'s 2000 msat fee locks (5%) cannot reach a signer node: none is claimed, both stay held, the winner is still paid', async () => {
  const w = await lockRound({ stakeMsat: 40000n });
  try {
    const won = await lockAndPlay(w, WINNER, { feeLock: true, address: true });
    const lost = await lockAndPlay(w, LOSER, { feeLock: true });
    federationChargesItsRealFee(w);   // the arithmetic below is fedimintd's, and every entry is already in
    await closeRound(w);
    await untilSettled(w);
    const got = await standing(proposerOf(w), w);   // the combining signer node's own account of what it moved
    const paid = [...w.port.payouts.values()];
    console.log(`  real fee rule with fee locks: ${got.state} - ${got.why}; payouts ${paid.map((p) => p.msat).join(', ')}`);
    assert.equal(got.state, 'ACCEPTED', got.why);
    assert.match(got.why, /no fee lock claimed: the fee locks hold 4000 msat and their inputs alone cost 2000/);
    assert.equal(won.entry.feeMsat, 2000n, 'a 40 sat stake\'s 5% fee lock');
    assert.deepEqual(paid.map((p) => p.msat), [netStakeMsat(lost.entry) - 2n * IO]);
    assert.equal(w.port.locks.has(key(won.feeOutpoint)) && w.port.locks.has(key(lost.feeOutpoint)), true, 'a fee lock was claimed that pays no signer node');
  } finally { await w.close(); }
});

// PICK (b): AT THE LARGEST BRACKET - 1000 sat - THE CLAIMED FEE LOCKS
// PAY EVERY SITTING SIGNER NODE SOMETHING UNDER THE REAL GUARDIANS' 1000 msat PER INPUT AND OUTPUT.
test('a 1000 sat round\'s 50000 msat fee locks (5%) are claimed under the real guardians\' fees and every sitting signer node nets more than nothing', async () => {
  const w = await lockRound({ stakeMsat: 1000000n });
  try {
    const won = await lockAndPlay(w, WINNER, { feeLock: true, address: true });
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
    assert.equal(won.entry.feeMsat, entryFeeMsat(1000000n));
    assert.equal(feeIn.length, 2, 'both fee locks are claimed');
    assert.equal(signerNodeNets.length, 2, 'every sitting signer node is paid');
    for (const n of signerNodeNets) assert.ok(n > 0n, `a signer node nets ${n}`);
    assert.equal([won.feeOutpoint, lost.feeOutpoint, lost.outpoint].some((o) => w.port.locks.has(key(o))), false);
  } finally { await w.close(); }
});

test('a round with a loser and no qualifier pays no stake and still pays the seats: both stake locks expire back, both fee locks settle the 5%', async () => {
  const w = await lockRound({ minScore: 150000001 })   // above the highest score there is (1500 points, core score.js); the delivered run scores per round - 11448150 in one, over 20000000 in another (measured 2026-10-01: both qualified at lower minimums)
  try {
    const one = await lockAndPlay(w, WINNER);
    const two = await lockAndPlay(w, LOSER);
    await closeRound(w);
    // POLLED, NOT SLEPT (2026-09-23): a fixed WINDOW + 3 s raced finality at +5.7-6.0 s on origin (1 in 2 red), and one
    // signer node - the proposer - now combines, offering its plan again each second while a peer is not final. The
    // assertion is what settles, not how soon: the proposer's row, up to 30 s.
    let got = await standing(proposerOf(w), w);
    for (const stop = Date.now() + 30000; Date.now() < stop && got.state !== 'ACCEPTED'; await wait(250)) got = await standing(proposerOf(w), w);
    const paidNQ = [...w.port.payouts.values()];
    const claimedNQ = w.port.settlements.flatMap((x) => x.claims.map((c) => key(c.outpoint)));
    console.log(`  no qualifier: ${got.state}; stake locks held ${[one, two].filter((x) => w.port.locks.has(key(x.outpoint))).length} of 2;`
      + ` fee locks held ${[one, two].filter((x) => w.port.locks.has(key(x.feeOutpoint))).length} of 2;`
      + ` submissions ${w.port.settlements.length}; claimed ${JSON.stringify(claimedNQ)};`
      + ` payouts ${paidNQ.map((x) => `${x.msat} to ${toHex(x.payoutPk).slice(0, 10)}`).join(', ')};`
      + ` seats ${w.c.nodes.map((k) => toHex(refundKeyOf(k)).slice(0, 10)).join(',')};`
      + ` winner key ${toHex(refundKeyOf(WINNER.key)).slice(0, 10)} loser key ${toHex(refundKeyOf(LOSER.key)).slice(0, 10)}`);
    // THE RULING (2026-09-21): §22A's 2% is SEAT COMPENSATION FOR A ROUND THAT ACTUALLY RAN. It is not
    // a qualifier's prize and it is not operator profit. So a finished round with a loser and no qualifier
    // settles: the stakes go back to their players and the seats are paid for the work. Only a VOID round -
    // a technical failure - claims nothing at all, and the operator must not profit from that; that is the
    // hold path's own case, not this one.
    //
    // This test asserted NONE and zero submissions, and that was true only while the fixture's entries
    // brought no fee lock. On a federation BLWP would accept, the round MINTS them, so there is something to
    // settle even with nobody to pay out of the stakes. The expectation moves because the fixture is the
    // production shape now - not to match a leftover.
    assert.equal(got.state, 'ACCEPTED', got.why);
    assert.ok(w.port.settlements.length > 0, 'the round ran and the seats earned, but nothing was submitted');

    // NO STAKE REACHES A QUALIFIER, because there is none: min_score is 150000001, above any score there is. Neither lock is claimed - both expire back to the players who staked them.
    const players = [refundKeyOf(WINNER.key), refundKeyOf(LOSER.key)].map(toHex);
    assert.deepEqual(paidNQ.filter((x) => players.includes(toHex(x.payoutPk))), [],
      'a stake was paid out although nobody qualified');
    assert.equal(w.port.locks.has(key(two.outpoint)), true, 'the loser\'s stake lock was claimed, not expired back');
    assert.equal(w.port.locks.has(key(one.outpoint)), true, 'the non-qualifier\'s stake lock was claimed');

    // AND THE SEATS ARE PAID THEIR 5%, measured: two players staking 100000 msat each is 200000 gross, 5% of it is
    // 10000 msat, and this round's two sitting seats take half each - 2.5% GAME/VERIFY and 2.5% SETTLEMENT, both pools.
    // Both fee locks are claimed to pay it.
    const seatKeys = w.c.nodes.map((k) => toHex(refundKeyOf(k))).sort();
    const seatEach = (one.entry.feeMsat + two.entry.feeMsat) / 2n;
    assert.deepEqual(paidNQ.filter((x) => seatKeys.includes(toHex(x.payoutPk)))
      .map((x) => [toHex(x.payoutPk), x.msat]).sort(), seatKeys.map((k) => [k, seatEach]),
      'the sitting seats were not paid their 5% of the round that ran');
    assert.equal([one, two].filter((x) => w.port.locks.has(key(x.feeOutpoint))).length, 0,
      'a fee lock was left held, so the seats were not paid from it');
  } finally { await w.close(); }
});
