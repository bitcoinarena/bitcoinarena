// 22A: THE PLAYER'S DONATION, WHICH GOES TO A SET AND NOT TO AN ADDRESS.
//
// `donationMsat` has been on every Entry Contract since it was written and was
// read by nothing - the same state `feeMsat` was in before the fee table.
//
// THE ROUNDING HERE IS NOT THE FEE'S ROUNDING. 22A gives the node fee's
// remainder to ascending H(round_id || node_pubkey) and gives the donation's
// to "the first recipient in the set as published". Two rules, written down
// separately; copying either onto the other would be inventing a third.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  donationSetStands, splitDonation, donationAfterFailures, donatedMsat,
  DONATION_BPS_TOTAL,
} from '../src/donation.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const evenly = [{ lnurl: 'LNURL1', shareBps: 5000 }, { lnurl: 'LNURL2', shareBps: 5000 }];
const three = [{ lnurl: 'LNURL1', shareBps: 3333 }, { lnurl: 'LNURL2', shareBps: 3333 },
               { lnurl: 'LNURL3', shareBps: 3334 }];
const paidTotal = (r) => r.shares.reduce((sum, s) => sum + s.amountMsat, 0n);

test('basis points are 22A\'s and the set must sum to exactly them', () => {
  assert.equal(DONATION_BPS_TOTAL, 10000);
});

/**
 * A SET THAT DOES NOT SUM TO 10000 IS NOT A DIVISION OF THE DONATION: under it
 * money is either left over with nobody named to receive it, or promised
 * twice. 22A says MUST.
 */
test('a set that sums to exactly 10000 stands, and one that does not never does', () => {
  assert.equal(donationSetStands(evenly).ok, true);
  assert.equal(donationSetStands(three).ok, true);
  assert.equal(donationSetStands([{ lnurl: 'ONE', shareBps: 10000 }]).ok, true,
    'one recipient taking the whole donation is a set of one');

  for (const [set, why] of [
    [[{ lnurl: 'A', shareBps: 5000 }, { lnurl: 'B', shareBps: 4999 }], /sum to 9999 /],
    [[{ lnurl: 'A', shareBps: 5000 }, { lnurl: 'B', shareBps: 5001 }], /sum to 10001 /],
    [[{ lnurl: 'A', shareBps: 0 }], /sum to 0 /],
  ]) {
    const seen = donationSetStands(set);
    assert.equal(seen.ok, false);
    assert.match(seen.why, why);
    assert.match(seen.why, /22A says exactly 10000/);
  }
});

test('a set nobody can be paid from does not stand', () => {
  for (const [set, why] of [
    [undefined, /names nobody/],
    [[], /names nobody/],
    [[{ shareBps: 10000 }], /no address to be paid at/],
    [[{ lnurl: '', shareBps: 10000 }], /no address to be paid at/],
    [[{ lnurl: 'A', shareBps: 1.5 }], /no whole share/],
    [[{ lnurl: 'A', shareBps: -1 }, { lnurl: 'B', shareBps: 10001 }], /no whole share/],
    [[{ lnurl: 'A', shareBps: '10000' }], /no whole share/],
  ]) {
    const seen = donationSetStands(set);
    assert.equal(seen.ok, false, JSON.stringify(set));
    assert.match(seen.why, why);
  }
});

/**
 * ONE RECIPIENT LISTED TWICE IS ONE PARTY WITH TWO SHARES, and the set is
 * meant to be "a parameter the network can hold an opinion about" - an opinion
 * it cannot form if one address can appear under two weights.
 */
test('the same recipient twice is refused rather than quietly doubled', () => {
  const twice = [{ lnurl: 'SAME', shareBps: 5000 }, { lnurl: 'SAME', shareBps: 5000 }];
  const seen = donationSetStands(twice);
  assert.equal(seen.ok, false);
  assert.match(seen.why, /SAME is listed twice/);
});

test('the donation is split by the shares, to the millisatoshi', () => {
  const even = splitDonation({ donationMsat: 2000n, recipients: evenly });
  assert.equal(even.ok, true);
  assert.deepEqual(even.shares.map((s) => s.amountMsat), [1000n, 1000n]);
  assert.equal(paidTotal(even), 2000n);

  const uneven = splitDonation({ donationMsat: 2000n, recipients: three });
  assert.equal(paidTotal(uneven), 2000n);
  assert.deepEqual(uneven.shares.map((s) => s.lnurl), ['LNURL1', 'LNURL2', 'LNURL3']);
});

/**
 * THE REMAINDER GOES TO THE FIRST AS PUBLISHED, and the split is therefore
 * EXACT - nothing is dropped and nothing is left for a collector to keep. That
 * is a different property from the node fee, where each entry's own floor can
 * collect less than the round's table owes.
 */
test('the remainder goes to the first recipient, and the split is exact', () => {
  for (const amount of [1n, 3n, 7n, 999n, 2001n, 100003n, 999999999n]) {
    const r = splitDonation({ donationMsat: amount, recipients: three });
    assert.equal(r.ok, true);
    assert.equal(paidTotal(r), amount, `${amount} did not add up`);
    for (const s of r.shares) assert.ok(s.amountMsat >= 0n);
  }

  // 2001 over 3333/3333/3334 is 666/666/667 with two left over, and both go
  // to the first as published - not to the largest share, not to a hash order
  const r = splitDonation({ donationMsat: 2001n, recipients: three });
  assert.deepEqual(r.shares.map((s) => s.amountMsat), [668n, 666n, 667n]);
  assert.equal(paidTotal(r), 2001n);

  // and the order the set is PUBLISHED in decides it, so a reordered set pays
  // the remainder somewhere else
  // Reversed, LNURL3's 3334 is first: its own floor is 667 and the same two
  // left over make 669, not 668. The order decides who is topped up, and the
  // share decides what they are topped up FROM.
  const reordered = splitDonation({ donationMsat: 2001n, recipients: [...three].reverse() });
  assert.equal(reordered.shares[0].lnurl, 'LNURL3');
  assert.equal(reordered.shares[0].amountMsat, 669n);
  assert.deepEqual(reordered.shares.map((s) => s.amountMsat), [669n, 666n, 666n]);
  assert.equal(paidTotal(reordered), 2001n);
});

/**
 * A PLAYER WITH DONATIONS OFF PAYS NONE OF THEM, and 22A says the set is
 * irrelevant to that entry - so a zero donation is answered without judging
 * the set at all.
 */
test('donations switched off pay nothing, whatever the set says', () => {
  const off = splitDonation({ donationMsat: 0n, recipients: evenly });
  assert.equal(off.ok, true);
  assert.deepEqual(off.shares.map((s) => s.amountMsat), [0n, 0n]);
  assert.match(off.why, /donations are off/);

  const broken = splitDonation({ donationMsat: 0n, recipients: [{ lnurl: 'A', shareBps: 1 }] });
  assert.equal(broken.ok, true, '22A: the set is irrelevant to an entry that donates nothing');
  assert.equal(paidTotal(broken), 0n);
});

test('a donation that is not money is answered, not thrown at the caller', () => {
  for (const bad of [2000, '2000', undefined, null])
    assert.equal(splitDonation({ donationMsat: bad, recipients: evenly }).ok, false);
  assert.match(splitDonation({ donationMsat: -1n, recipients: evenly }).why, /cannot be negative/);
  assert.match(splitDonation({ donationMsat: 1n, recipients: [] }).why, /names nobody/,
    'a positive donation still needs a set that stands');
});

/**
 * AND THE CLAUSE THIS EXISTS FOR. 22A: clients "MUST NOT redirect the share to
 * the remaining recipients, which would let one unreachable endpoint quietly
 * redistribute other people's money."
 */
test('a failed payment is not redirected to the other recipients', () => {
  const split = splitDonation({ donationMsat: 2001n, recipients: three });
  const owed = split.shares.map((s) => s.amountMsat);

  const after = donationAfterFailures({ shares: split.shares, failed: ['LNURL2'] });
  assert.equal(after.paid.length, 2);
  assert.equal(after.unpaid.length, 1);
  assert.equal(after.unpaid[0].lnurl, 'LNURL2');
  assert.equal(after.unpaidMsat, 666n);

  // every other recipient is owed exactly what it was owed before
  assert.equal(after.paid[0].amountMsat, owed[0], 'the first was paid the failure\'s share');
  assert.equal(after.paid[1].amountMsat, owed[2], 'the last was paid the failure\'s share');
  assert.equal(after.paidMsat, 2001n - 666n);
  assert.equal(after.paidMsat + after.unpaidMsat, 2001n,
    'the donation is accounted for, and the unreachable share simply did not move');

  // and the entry stands: a donation is outside the pool
  assert.equal(after.entryStands, true);
  assert.match(after.why, /not redistributed/);
});

test('every recipient failing pays nobody, and still does not void the entry', () => {
  const split = splitDonation({ donationMsat: 2001n, recipients: three });
  const all = donationAfterFailures({ shares: split.shares, failed: ['LNURL1', 'LNURL2', 'LNURL3'] });
  assert.equal(all.paidMsat, 0n);
  assert.equal(all.unpaidMsat, 2001n);
  assert.equal(all.entryStands, true);

  const none = donationAfterFailures({ shares: split.shares });
  assert.equal(none.unpaid.length, 0);
  assert.equal(none.paidMsat, 2001n);
  assert.match(none.why, /every recipient was paid/);
});

test('a round\'s donations exclude the entries that were refunded', () => {
  const entries = [
    { pubkey: b32(0xa1), outcome: 'DELIVERED', donationMsat: 2000n },
    { pubkey: b32(0xa2), outcome: 'FAILED', donationMsat: 1000n },
    { pubkey: b32(0xa3), outcome: 'VOID', donationMsat: 9000n },
    { pubkey: b32(0xa4), outcome: 'ENTRY_VOID', donationMsat: 9000n },
  ];
  assert.equal(donatedMsat(entries), 3000n, 'a refunded entry donated money that never moved');
});
