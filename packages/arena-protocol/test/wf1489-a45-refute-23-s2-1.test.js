// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// wf1489 a45 refute 23, skeptic 2 (variant of kanban #1863 / #2250): an ALL-VESTING set with many
// small entries. Each shrinking entry's trunc() rounds it UP by up to a basis point, so the set sums
// past 10000 by up to one bp per shrinking entry (here 200 entries 1 -> 0 over 2 days: +100 on day 1).
// The #1863 rule hands the negative remainder (-100) to the first share that can absorb it - and with
// every entry below 100 bp, none can: findIndex is -1, the remainder is dropped, the set sums to 10100,
// and splitDonation / splitTwoSets refuse every paid entry's donation network-wide for that day.
// A recipient of the parent set may propose such a set (donation-vote), so one recipient is the attacker.
import test from 'node:test';
import assert from 'node:assert/strict';
import { vestedShares, splitDonation, splitTwoSets, donationSetStands, encodeDonationSet, decodeDonationSet, VESTING_DAY_BLOCKS } from '../src/donation.js';

const key = (n) => Uint8Array.from([0x02, (n >> 8) & 0xff, n & 0xff, ...new Uint8Array(30).fill(7)]);
const SET = [];
let n = 1;
for (let i = 0; i < 200; i++) SET.push({ recipientPk: key(n++), shareBps: 1, label: `s${i}`, vesting: { targetBps: 0, startHeight: 0, days: 2 } });
for (let i = 0; i < 100; i++) SET.push({ recipientPk: key(n++), shareBps: 97, label: `g${i}`, vesting: { targetBps: 99, startHeight: 0, days: 2 } });
for (let i = 0; i < 2; i++) SET.push({ recipientPk: key(n++), shareBps: 50, label: `k${i}`, vesting: { targetBps: 50, startHeight: 0, days: 2 } });

test('the all-vesting set stands and round-trips its bytes', () => {
  assert.equal(donationSetStands(SET).ok, true, donationSetStands(SET).why);
  assert.equal(decodeDonationSet(encodeDonationSet(SET)).length, SET.length);
});

test('vestedShares of it sums to 10000 with no negative share at every height', () => {
  for (let day = 0; day <= 3; day++) {
    const out = vestedShares(SET, day * VESTING_DAY_BLOCKS);
    const sum = out.reduce((t, r) => t + r.shareBps, 0);
    assert.equal(sum, 10000, `day ${day}: sum ${sum}`);
    for (const r of out) assert.ok(r.shareBps >= 0, `day ${day}: ${r.label} ${r.shareBps}`);
  }
});

test('the vested set can be split on day 1 of 2', () => {
  const out = vestedShares(SET, VESTING_DAY_BLOCKS);
  const sp = splitDonation({ donationMsat: 1000000n, recipients: out });
  assert.equal(sp.owed, true, `splitDonation refused: ${sp.why}`);
  const two = splitTwoSets({ donationMsat: 1000000n, networkSet: out, gameSet: [{ recipientPk: key(9999), shareBps: 10000, label: 'g' }] });
  assert.equal(two.owed, true, `splitTwoSets refused: ${two.why}`);
});
