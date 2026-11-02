// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE HELD PROOF (spec §23A.3a, kanban #998, rulings #1029 and #1030).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { HELD_CLAIM_PK, HELD_CLAIM_KEY_TAG, HELD_MIN_BLOCKS_LEFT, heldProofHeight, heldReadWindow, heldWindowOpen, heldPaymentImage, heldLockFields,
  signHeldRead, heldReadHash, signHeldAsk, checkHeldAsk, heldLockCounted } from '../src/held-proof.js';
import { taggedHash, toHex } from '../src/hash.js';

const keyOf = (n) => { const secret = new Uint8Array(32).fill(n); return { secret, hex: toHex(schnorr.getPublicKey(secret)) }; };
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const guardians = [1, 2, 3, 4].map(keyOf), gateway = keyOf(9), stranger = keyOf(8);
const seated = guardians.map((g) => g.hex), federationId = 'f0'.repeat(32), epoch = 40, tip = 144 * 40 + 72;
const lock = { outpoint: 'aa'.repeat(32) + ':0', contractId: 'cc'.repeat(32), amountMsat: '100000000' };
const readBy = (g, over = {}) => signHeldRead({ federationId, epoch, gateway: gateway.hex, ...lock, blocksLeft: 6, tipHeight: tip, ...over }, g.hex, (h) => schnorr.sign(h, g.secret));
const judge = (reads, over = {}) => heldLockCounted({ heldLock: { ...lock, reads }, federationId, epoch, node: gateway.hex, seated, threshold: 3, verify, ...over });
const three = guardians.slice(0, 3).map((g) => readBy(g));

test('the claim key is a point, the first the tag gives: nobody chose it and nobody holds its key', () => {
  let found = null;
  for (let i = 0; i < 256 && !found; i++) {
    const hex = '02' + toHex(taggedHash(HELD_CLAIM_KEY_TAG, new Uint8Array([0, 0, 0, i])));
    try { secp256k1.Point.fromHex(hex); found = hex; } catch { /* not on the curve: the next */ }
  }
  assert.equal(found, HELD_CLAIM_PK);
});

test('the payment image is fixed by gateway and epoch, the refund key is the gateway\'s, and the height is the epoch\'s first + 72', () => {
  const a = heldLockFields({ node: gateway.hex, epoch, amountMsat: 1000n, expiration: 300 });
  assert.equal(toHex(a.refundPk), '02' + gateway.hex);
  assert.equal(toHex(a.claimPk), HELD_CLAIM_PK);
  assert.deepEqual(a.paymentImage, { kind: 'hash', bytes: heldPaymentImage(gateway.hex, epoch) });
  assert.notEqual(toHex(heldPaymentImage(gateway.hex, 41)), toHex(heldPaymentImage(gateway.hex, 40)), 'a lock serves one epoch');
  assert.notEqual(toHex(heldPaymentImage(stranger.hex, 40)), toHex(heldPaymentImage(gateway.hex, 40)), 'and one gateway');
  assert.equal(heldProofHeight(40), 5832);
  assert.deepEqual(heldReadWindow(40), { from: 5829, to: 5832 });
});

test('the window: both ends in, one block either side out', () => {
  assert.deepEqual([5828, 5829, 5832, 5833].map((t) => heldWindowOpen(40, t)), [false, true, true, false]);
});

test('the threshold of reads counts the amount, floored to sat; fewer count 0', () => {
  assert.equal(judge(three).sats, 100000n);
  assert.equal(judge(three.slice(0, 2)).sats, 0n);
  assert.equal(judge([]).sats, 0n);
  assert.equal(judge([...three, readBy(guardians[3])]).signers, 4);
  assert.equal(heldLockCounted({ heldLock: { ...lock, amountMsat: '100000999', reads: guardians.slice(0, 3).map((g) => readBy(g, { amountMsat: '100000999' })) }, federationId, epoch, node: gateway.hex, seated, threshold: 3, verify }).sats, 100000n);
  assert.equal(heldLockCounted({ heldLock: null, federationId, epoch, node: gateway.hex, seated, threshold: 3, verify }).sats, 0n);
});

test('each read stands alone: blocks_left may differ, and exactly 6 holds; 5 does not', () => {
  const left = [6, 9, 7].map((blocksLeft, i) => readBy(guardians[i], { blocksLeft, tipHeight: tip - i }));
  assert.equal(judge(left).sats, 100000n);
  assert.equal(HELD_MIN_BLOCKS_LEFT, 6);
  assert.equal(judge([...three.slice(0, 2), readBy(guardians[2], { blocksLeft: 5 })]).sats, 0n);
});

test('a read outside the window, of another epoch, gateway, federation, lock or amount counts for nothing', () => {
  const swap = (over) => judge([...three.slice(0, 2), readBy(guardians[2], over)]).sats;
  assert.equal(swap({ tipHeight: tip + 1 }), 0n);
  assert.equal(swap({ tipHeight: tip - 4 }), 0n);
  assert.equal(swap({ epoch: 41, tipHeight: 144 * 41 + 72 }), 0n);
  assert.equal(swap({ gateway: stranger.hex }), 0n);
  assert.equal(swap({ federationId: 'f1'.repeat(32) }), 0n);
  assert.equal(swap({ outpoint: 'bb'.repeat(32) + ':0' }), 0n);
  assert.equal(swap({ contractId: 'dd'.repeat(32) }), 0n);
  assert.equal(swap({ amountMsat: '200000000' }), 0n);
});

test('a guardian counts once, only a seated one counts, and a changed read fails its signature', () => {
  assert.equal(judge([three[0], three[0], three[0], three[1]]).sats, 0n);
  assert.equal(judge([...three.slice(0, 2), readBy(stranger)]).sats, 0n);
  assert.equal(judge([...three.slice(0, 2), { ...three[2], blocksLeft: 99 }]).sats, 0n);
  assert.equal(judge([...three.slice(0, 2), { ...three[2], signature: 'ab' }]).sats, 0n);
  assert.equal(judge(three, { seated: seated.slice(0, 2) }).sats, 0n, 'judged by the record, not by who signed');
  assert.equal(judge(three, { seated: null }).sats, 0n, 'no record, no count');
});

test('junk in the reads is passed over and never throws', () => {
  assert.equal(judge([null, 7, {}, ...three]).sats, 100000n);
  assert.equal(judge('nope').sats, 0n);
  assert.equal(judge(three, { node: stranger.hex }).sats, 0n);
});

test('the same reads give every guardian the same answer, with no chain and no lock left to read', () => {
  const at = (s) => judge(three, { seated: [...s] });
  assert.deepEqual(at(seated), at([...seated].reverse()));
});

test('an ask is signed by its gateway, and every field is under the signature', () => {
  const a = signHeldAsk({ federationId, epoch, node: gateway.hex, outpoint: lock.outpoint, amountMsat: lock.amountMsat, expiration: 300 }, (h) => schnorr.sign(h, gateway.secret));
  assert.equal(checkHeldAsk(a, verify).ok, true);
  for (const change of [{ epoch: 41 }, { outpoint: 'bb'.repeat(32) + ':0' }, { amountMsat: '1' }, { expiration: 301 }]) assert.match(checkHeldAsk({ ...a, ...change }, verify).why, /not signed/);
  assert.match(checkHeldAsk({ ...a, node: stranger.hex }, verify).why, /not signed/);
  assert.match(checkHeldAsk({ ...a, amountMsat: '0' }, verify).why, /amount/);
  assert.match(checkHeldAsk({ ...a, outpoint: 'x' }, verify).why, /outpoint/);
  assert.match(checkHeldAsk(null, verify).why, /names a federation/);
});

test('the read\'s hash covers every field, and not who signed it', () => {
  const base = three[0];
  for (const change of [{ epoch: 41 }, { blocksLeft: 7 }, { tipHeight: 5 }, { amountMsat: '1' }, { contractId: 'dd'.repeat(32) }]) assert.notEqual(toHex(heldReadHash({ ...base, ...change })), toHex(heldReadHash(base)));
  assert.equal(toHex(heldReadHash({ ...base, guardian: 'other' })), toHex(heldReadHash(base)));
});
