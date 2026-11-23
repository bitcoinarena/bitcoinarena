// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #2694 (follow-up of #2655, option 2): a liquidation the committee attests. Each seat signs (round, tick, size) of a
// forceOrder event its own exchange stream saw; the batch carries the signatures as attestation kind 4 beside the
// liquidation, and checkBatchLiquidations holds the two together - with `require`, a bare non-zero liquidation is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { encodeInputBatch, decodeInputBatch, batchId, MAX_ATTEST_SIGS, MAX_ATTESTED_LIQUIDATIONS } from '../src/batch.js';
import { liquidationEventId, liquidationAttestationStands, checkBatchLiquidations, checkBatchPrices } from '../src/price-sample.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const sks = [1, 2, 3, 4, 5, 6, 7].map((n) => b32(0x40 + n));
const keys = sks.map((sk) => schnorr.getPublicKey(sk));
const rid = b32(0x11);
const verify = (sig, msg, key) => { try { return schnorr.verify(sig, msg, key); } catch { return false; } };
const signed = (tick, size, n = 5, roundId = rid) =>
  [tick, 4, size, sks.slice(0, n).map((sk, i) => [keys[i], schnorr.sign(liquidationEventId({ roundId, tick, size }), sk, new Uint8Array(32))])];
const batch = (extra) => ({ roundId: rid, entryId: b32(2), previousHash: new Uint8Array(32), firstTick: 0,
  ticks: Array.from({ length: 40 }, () => [65536, 0, 0, 0, 0]), liquidations: [], loads: [], ...extra });
const check = (b, require = true) => checkBatchLiquidations({ batch: b, roundId: rid, committee: keys, threshold: 5, verify, require });

test('#2694 a liquidation event id is the tagged hash of round, tick and size, and each changes it', () => {
  const a = liquidationEventId({ roundId: rid, tick: 7, size: 655360 });
  assert.equal(a.length, 32);
  assert.notDeepEqual(a, liquidationEventId({ roundId: rid, tick: 8, size: 655360 }));
  assert.notDeepEqual(a, liquidationEventId({ roundId: rid, tick: 7, size: 655361 }));
  assert.notDeepEqual(a, liquidationEventId({ roundId: b32(0x12), tick: 7, size: 655360 }));
  assert.throws(() => liquidationEventId({ roundId: rid, tick: 7, size: 0 }), /positive/);
  assert.throws(() => liquidationEventId({ roundId: rid, tick: 7, size: -5 }), /positive/);
});

test('#2694 an attestation stands with the threshold of distinct committee keys, not fewer, not outsiders', () => {
  const [tick, , size, sigs] = signed(7, 655360, 5);
  const id = liquidationEventId({ roundId: rid, tick, size });
  const ok = liquidationAttestationStands({ id, sigs: sigs.map(([key, signature]) => ({ key, signature })), committee: keys, threshold: 5, verify });
  assert.equal(ok.ok, true);
  const four = liquidationAttestationStands({ id, sigs: sigs.slice(0, 4).map(([key, signature]) => ({ key, signature })), committee: keys, threshold: 5, verify });
  assert.equal(four.ok, false);
  const outsider = liquidationAttestationStands({ id, sigs: sigs.map(([key, signature]) => ({ key, signature })), committee: keys.slice(2), threshold: 5, verify });
  assert.equal(outsider.ok, false);
});

test('#2694 the batch carries kind 4 attestations and keeps its bytes; a batch without one keeps the old encoding', () => {
  const plain = batch({ liquidations: [[7, 655360]] });
  const bytesPlain = encodeInputBatch(plain);
  const withAtt = batch({ liquidations: [[7, 655360]], attests: [signed(7, 655360)] });
  const bytes = encodeInputBatch(withAtt);
  assert.ok(bytes.length > bytesPlain.length);
  const back = decodeInputBatch(bytes);
  assert.equal(back.attests.length, 1);
  assert.equal(back.attests[0][1], 4);
  assert.equal(back.attests[0][2], 655360);
  assert.equal(back.attests[0][3].length, 5);
  assert.deepEqual(batchId(back), batchId(withAtt));
  assert.equal(decodeInputBatch(bytesPlain).attests, undefined);
  // one attested liquidation a tick, at most MAX_ATTESTED_LIQUIDATIONS, at most MAX_ATTEST_SIGS signatures
  assert.throws(() => encodeInputBatch(batch({ liquidations: [[7, 655360]], attests: [signed(7, 655360), signed(7, 655361)] })), /one attested liquidation a tick/);
  assert.throws(() => encodeInputBatch(batch({ attests: Array.from({ length: MAX_ATTESTED_LIQUIDATIONS + 1 }, (_, i) => [i, 4, 1, []]) })), /one attested liquidation a tick/);
  assert.throws(() => encodeInputBatch(batch({ attests: [[1, 4, 1, Array.from({ length: MAX_ATTEST_SIGS + 1 }, () => [b32(1), new Uint8Array(64)])]] })), /at most/);
});

test('#2694 checkBatchLiquidations: attested strikes stand, a bare or altered one is refused under require', () => {
  // two attested strikes, played as attested
  assert.deepEqual(check(batch({ liquidations: [[7, 655360], [21, 1310720]], attests: [signed(7, 655360), signed(21, 1310720)] })), { ok: true, attested: 2 });
  // a bare strike at LIQ_MAX: refused under require, taken without
  const bare = batch({ liquidations: [[7, 655360], [11, 2147418112]], attests: [signed(7, 655360)] });
  assert.equal(check(bare).ok, false);
  assert.match(check(bare).why, /tick 11.*without the committee's attestation/);
  assert.equal(check(bare, false).ok, true);
  // a zero-size liquidation is no strike and needs no attestation
  assert.equal(check(batch({ liquidations: [[3, 0]] })).ok, true);
  // the size played is not the size attested
  const bigger = batch({ liquidations: [[7, 2147418112]], attests: [signed(7, 655360)] });
  assert.equal(check(bigger).ok, false);
  assert.match(check(bigger).why, /tick 7/);
  // an attestation whose liquidation the batch does not play
  assert.equal(check(batch({ liquidations: [], attests: [signed(7, 655360)] })).ok, false);
  // four signatures of seven, or another round's signatures
  assert.match(check(batch({ liquidations: [[7, 655360]], attests: [signed(7, 655360, 4)] })).why, /4 of the committee signed it, 5 are needed/);
  assert.equal(check(batch({ liquidations: [[7, 655360]], attests: [signed(7, 655360, 5, b32(0x12))] })).ok, false);
  // the price check leaves kind 4 to this one: a batch with an attested liquidation and no prices passes it, in either scheme
  const b = batch({ liquidations: [[7, 655360]], attests: [signed(7, 655360)] });
  for (const median of [false, true])
    assert.equal(checkBatchPrices({ batch: b, roundId: rid, committee: keys, threshold: 5, verify, require: true, median }).ok, true);
});
