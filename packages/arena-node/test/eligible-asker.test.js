// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SETTLEMENT ASKER - askerFor, askerOrder and eligibleAsker on their own (kanban #146, last surface; plan comment 195,
// accepted 2026-10-05). settlement.js asks eligibleAsker which signer node may ask for a lock settlement at the chain tip:
// the round id picks the first, the ring follows from there, and each node gets TAKEOVER_BLOCKS (2) blocks before the next
// may take over. Until now payout.js lines 120-144 (eligibleAsker) ran in no test. No defect was read from the source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askerFor, askerOrder, eligibleAsker, TAKEOVER_BLOCKS } from '../src/payout.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const hex = (b) => Buffer.from(b).toString('hex');
const SEVEN = Array.from({ length: 7 }, (_, i) => b32(0x11 + i));
const TWO = SEVEN.slice(0, 2);
// a round id whose first four bytes are n, big-endian
const rid = (n) => { const r = new Uint8Array(32); new DataView(r.buffer).setUint32(0, n >>> 0, false); return r; };
const BEACON = 900_000;

test('askerFor: the first four bytes of the round id, big-endian and unsigned, pick the node; refusals by name', () => {
  assert.deepEqual(askerFor(rid(10), SEVEN), { ok: true, asker: SEVEN[3], at: 3, of: 7 });            // 10 mod 7
  assert.deepEqual(askerFor(rid(0), SEVEN), { ok: true, asker: SEVEN[0], at: 0, of: 7 });
  // the top bit set stays unsigned: 0xffffffff mod 7 = 3 (as a signed int it would be -1)
  assert.equal(askerFor(rid(0xffffffff), SEVEN).at, 0xffffffff % 7);
  assert.equal(askerFor(rid(0x80000000), SEVEN).at, 0x80000000 % 7);
  assert.deepEqual(askerFor(rid(5), TWO), { ok: true, asker: TWO[1], at: 1, of: 2 });
  // only the first four bytes count
  const tail = rid(10); tail[31] = 0xee;
  assert.equal(askerFor(tail, SEVEN).at, 3);
  for (const bad of [rid(1).subarray(0, 31), undefined, 'ab'])
    assert.deepEqual(askerFor(bad, SEVEN), { ok: false, why: 'that is not a round id' });
  for (const bad of [[], undefined])
    assert.deepEqual(askerFor(rid(1), bad), { ok: false, why: 'that round joined nobody, so nobody asks for it' });
});

test('askerOrder: the ring starts at the asker and wraps; its refusals pass through', () => {
  const r = askerOrder(rid(10), SEVEN);
  assert.deepEqual({ ok: r.ok, at: r.at, of: r.of }, { ok: true, at: 3, of: 7 });
  assert.deepEqual(r.order.map(hex), [3, 4, 5, 6, 0, 1, 2].map((i) => hex(SEVEN[i])));
  assert.deepEqual(askerOrder(rid(5), TWO).order.map(hex), [hex(TWO[1]), hex(TWO[0])]);
  assert.deepEqual(askerOrder(rid(1).subarray(0, 31), SEVEN), { ok: false, why: 'that is not a round id' });
  assert.deepEqual(askerOrder(rid(1), []), { ok: false, why: 'that round joined nobody, so nobody asks for it' });
});

test('eligibleAsker on 7: each node gets a 2-block head start before the next may take over', () => {
  assert.equal(TAKEOVER_BLOCKS, 2);
  const at = (advanced) => eligibleAsker({ roundId: rid(10), signerNodes: SEVEN, beaconHeight: BEACON, tipHeight: BEACON + advanced });
  const ring = [3, 4, 5, 6, 0, 1, 2].map((i) => hex(SEVEN[i]));
  const zero = at(0);
  assert.deepEqual({ ok: zero.ok, allowed: zero.allowed.map(hex), advanced: zero.advanced, nextAt: zero.nextAt }, { ok: true, allowed: ring.slice(0, 1), advanced: 0, nextAt: BEACON + 2 });
  assert.deepEqual(zero.order.map(hex), ring);
  assert.deepEqual({ allowed: at(1).allowed.length, nextAt: at(1).nextAt }, { allowed: 1, nextAt: BEACON + 2 });
  assert.deepEqual({ allowed: at(2).allowed.map(hex), nextAt: at(2).nextAt }, { allowed: ring.slice(0, 2), nextAt: BEACON + 4 });
  assert.deepEqual({ allowed: at(3).allowed.length, nextAt: at(3).nextAt }, { allowed: 2, nextAt: BEACON + 4 });
  assert.deepEqual({ allowed: at(11).allowed.length, nextAt: at(11).nextAt }, { allowed: 6, nextAt: BEACON + 12 });
  assert.deepEqual({ allowed: at(12).allowed.map(hex), nextAt: at(12).nextAt }, { allowed: ring, nextAt: null });
  assert.equal(at(500).nextAt, null);
  // a tip below the beacon allows nobody, and says when the first may ask
  const behind = at(-3);
  assert.deepEqual({ ok: behind.ok, allowed: behind.allowed, advanced: behind.advanced, nextAt: behind.nextAt }, { ok: true, allowed: [], advanced: -3, nextAt: BEACON });
  // each key's place in the ring, and a stranger is not in it
  for (const [place, i] of [3, 4, 5, 6, 0, 1, 2].entries()) assert.equal(zero.placeOf(SEVEN[i]), place);
  assert.equal(zero.placeOf(b32(0x99)), -1);
});

test('eligibleAsker: a custom 1-block wait, and the same on a 2-of-2', () => {
  const one = (advanced) => eligibleAsker({ roundId: rid(10), signerNodes: SEVEN, beaconHeight: BEACON, tipHeight: BEACON + advanced, takeoverBlocks: 1 });
  assert.deepEqual({ allowed: one(0).allowed.length, nextAt: one(0).nextAt }, { allowed: 1, nextAt: BEACON + 1 });
  assert.deepEqual({ allowed: one(3).allowed.length, nextAt: one(3).nextAt }, { allowed: 4, nextAt: BEACON + 4 });
  assert.deepEqual({ allowed: one(6).allowed.length, nextAt: one(6).nextAt }, { allowed: 7, nextAt: null });
  const two = (advanced) => eligibleAsker({ roundId: rid(5), signerNodes: TWO, beaconHeight: BEACON, tipHeight: BEACON + advanced });
  assert.deepEqual({ allowed: two(0).allowed.map(hex), nextAt: two(0).nextAt }, { allowed: [hex(TWO[1])], nextAt: BEACON + 2 });
  assert.deepEqual({ allowed: two(1).allowed.length, nextAt: two(1).nextAt }, { allowed: 1, nextAt: BEACON + 2 });
  assert.deepEqual({ allowed: two(2).allowed.map(hex), nextAt: two(2).nextAt }, { allowed: [hex(TWO[1]), hex(TWO[0])], nextAt: null });
  assert.deepEqual({ allowed: two(-1).allowed, nextAt: two(-1).nextAt }, { allowed: [], nextAt: BEACON });
  assert.deepEqual([two(0).placeOf(TWO[1]), two(0).placeOf(TWO[0]), two(0).placeOf(SEVEN[5])], [0, 1, -1]);
});

test('eligibleAsker refuses by name: a bad round or committee passed through, a beacon, tip or wait that is not one', () => {
  const ask = (o) => eligibleAsker({ roundId: rid(10), signerNodes: SEVEN, beaconHeight: BEACON, tipHeight: BEACON, ...o });
  assert.deepEqual(ask({ roundId: rid(1).subarray(0, 31) }), { ok: false, why: 'that is not a round id' });
  assert.deepEqual(ask({ signerNodes: [] }), { ok: false, why: 'that round joined nobody, so nobody asks for it' });
  for (const beaconHeight of [-1, 1.5, undefined, '900000'])
    assert.deepEqual(ask({ beaconHeight }), { ok: false, why: 'that round names no beacon height to wait from' });
  for (const tipHeight of [-1, 1.5, undefined, null])
    assert.deepEqual(ask({ tipHeight }), { ok: false, why: 'this node has no chain tip to measure the wait against' });
  for (const takeoverBlocks of [0, -2, 1.5, '2'])
    assert.deepEqual(ask({ takeoverBlocks }), { ok: false, why: 'a takeover wait is a positive number of blocks' });
});
