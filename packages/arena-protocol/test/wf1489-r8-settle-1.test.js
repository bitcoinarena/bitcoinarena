// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// wf1489 r8 settlement audit: an ALL-VESTING donation set breaks the 10000 bps invariant.
//
// §27A.4.1 (comment in donation.js keySetStands, line ~185) explicitly ALLOWS a set
// where every recipient vests, so long as the vesting targets sum to exactly 10000.
// donationSetStands accepts such a set. But vestedShares(), whose own docstring promises
// "The answer is a plain set: keys, labels, shares summing to 10000", hands the rounding
// remainder `short` to `recipients.findIndex((r) => !r.vesting)`. When EVERY recipient
// vests that index is -1, the `if (short && first >= 0)` guard drops the correction, and
// the returned set sums to 9999 / 9998 at intermediate heights.
//
// That set is the one server.js (donation-set targets) and donation-pay.js feed straight
// into splitDonation / splitTwoSets, which require sum === 10000 and therefore REFUSE.
// A donation set the network authority legitimately approved (through the §27A.4.1 ballot)
// then makes every paid entry's donation split fail network-wide for the whole vesting
// window - donationOutputsExpected can compute no outputs, so the entry/settlement cannot
// be validated on its donation side.
import test from 'node:test';
import assert from 'node:assert/strict';
import { vestedShares, splitDonation, splitTwoSets, donationSetStands, VESTING_DAY_BLOCKS } from '../src/donation.js';

const key = (n) => Uint8Array.from([0x02, ...new Uint8Array(32).fill(n)]);

// A valid all-vesting set: shares sum to 10000, targets sum to 10000.
const ALL_VESTING = [
  { recipientPk: key(1), shareBps: 2000, label: 'a', vesting: { targetBps: 3000, startHeight: 0, days: 3 } },
  { recipientPk: key(2), shareBps: 2000, label: 'b', vesting: { targetBps: 3000, startHeight: 0, days: 3 } },
  { recipientPk: key(3), shareBps: 2000, label: 'c', vesting: { targetBps: 3000, startHeight: 0, days: 3 } },
  { recipientPk: key(4), shareBps: 4000, label: 'd', vesting: { targetBps: 1000, startHeight: 0, days: 3 } },
];

test('an all-vesting donation set is accepted by donationSetStands', () => {
  assert.equal(donationSetStands(ALL_VESTING).ok, true);
});

test('vestedShares of an all-vesting set sums to exactly 10000 at every height', () => {
  for (let day = 0; day <= 4; day++) {
    const h = day * VESTING_DAY_BLOCKS;
    const out = vestedShares(ALL_VESTING, h);
    const sum = out.reduce((t, r) => t + r.shareBps, 0);
    assert.equal(sum, 10000, `height ${h} (day ${day}) must sum to 10000, got ${sum}: ${out.map((r) => r.shareBps)}`);
  }
});

test('the vested set can still be split (donation money path does not refuse a valid set)', () => {
  const out = vestedShares(ALL_VESTING, VESTING_DAY_BLOCKS); // day 1 of 3
  const sp = splitDonation({ donationMsat: 1000000n, recipients: out });
  assert.equal(sp.owed, true, `splitDonation refused a valid all-vesting set: ${sp.why}`);

  // and as the network half of a round's two-set target, the way server.js feeds it
  const gameSet = [{ recipientPk: key(9), shareBps: 10000, label: 'g' }];
  const two = splitTwoSets({ donationMsat: 1000000n, networkSet: out, gameSet });
  assert.equal(two.owed, true, `splitTwoSets refused a valid all-vesting network set: ${two.why}`);
});
