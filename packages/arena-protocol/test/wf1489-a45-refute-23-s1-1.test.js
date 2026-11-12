// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// wf1489 a45 refute 23 (variant of kanban #1863): a MIXED vesting set that donationSetStands
// accepts makes vestedShares hand a plain recipient a NEGATIVE share at intermediate heights.
// The vesting entries' trunc() rounds the shrinking ones up, so their sum can pass 10000
// (here 10001); rest = -1 and the plain entry gets floor(1 * -1 / 1) = -1. The set still sums
// to 10000, short = 0, so the #1863 guard never runs - and splitDonation / splitTwoSets refuse
// the set: every paid entry's donation is refused network-wide on those days.
import test from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { vestedShares, splitDonation, splitTwoSets, donationSetStands, VESTING_DAY_BLOCKS } from '../src/donation.js';

// a real compressed point per n (the 1.9.17 merge: a recipient key must be a secp256k1 point, kanban #1489 v1-refute-3)
const key = (n) => secp256k1.getPublicKey(Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? (n + 1) & 0xff : i === 30 ? ((n + 1) >> 8) & 0xff : 0)), true);
const MIXED = [
  { recipientPk: key(1), shareBps: 3333, label: 'a', vesting: { targetBps: 0, startHeight: 0, days: 7 } },
  { recipientPk: key(2), shareBps: 3333, label: 'b', vesting: { targetBps: 0, startHeight: 0, days: 7 } },
  { recipientPk: key(3), shareBps: 3333, label: 'c', vesting: { targetBps: 10000, startHeight: 0, days: 7 } },
  { recipientPk: key(4), shareBps: 1, label: 'plain' },
];

test('the mixed set stands', () => {
  assert.equal(donationSetStands(MIXED).ok, true);
});

test('vestedShares of a standing mixed set is a plain set (no negative share) at every height', () => {
  for (let day = 0; day <= 8; day++) {
    const out = vestedShares(MIXED, day * VESTING_DAY_BLOCKS);
    const sum = out.reduce((t, r) => t + r.shareBps, 0);
    assert.equal(sum, 10000, `day ${day}`);
    for (const r of out) assert.ok(Number.isInteger(r.shareBps) && r.shareBps >= 0,
      `day ${day}: ${r.label} got ${r.shareBps} (${out.map((x) => x.shareBps)})`);
  }
});

test('the vested mixed set can be split on day 6 of 7', () => {
  const out = vestedShares(MIXED, 6 * VESTING_DAY_BLOCKS);
  const sp = splitDonation({ donationMsat: 1000000n, recipients: out });
  assert.equal(sp.owed, true, `splitDonation refused: ${sp.why}`);
  const gameSet = [{ recipientPk: key(9), shareBps: 10000, label: 'g' }];
  const two = splitTwoSets({ donationMsat: 1000000n, networkSet: out, gameSet });
  assert.equal(two.owed, true, `splitTwoSets refused: ${two.why}`);
});
