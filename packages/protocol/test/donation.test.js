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
import { toHex } from '../src/hash.js';
import { roundId, encodeRoundContract, decodeRoundContract } from '../src/contracts.js';
import {
  donationSetStands, splitDonation, donationAfterFailures, donatedMsat,
  encodeDonationSet, decodeDonationSet, donationSetId, canonicalLnurl, isMixedCase,
  donationSetMatchesRound, DONATION_BPS_TOTAL,
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
  assert.equal(even.owed, true);
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
    assert.equal(r.owed, true);
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
  assert.equal(off.owed, true);
  assert.deepEqual(off.shares.map((s) => s.amountMsat), [0n, 0n]);
  assert.match(off.why, /donations are off/);

  const broken = splitDonation({ donationMsat: 0n, recipients: [{ lnurl: 'A', shareBps: 1 }] });
  assert.equal(broken.owed, true, '22A: the set is irrelevant to an entry that donates nothing');
  assert.equal(paidTotal(broken), 0n);
});

test('a donation that is not money is answered, not thrown at the caller', () => {
  for (const bad of [2000, '2000', undefined, null])
    assert.equal(splitDonation({ donationMsat: bad, recipients: evenly }).owed, false);
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

// ---------------------------------------------------------------------------
// AND THE SET AS BYTES, so a committee can check one instead of being handed
// an array.
//
// Every other object here that decides money encodes and carries a tagged id.
// The donation set was the only one that did not, which is what stopped two
// independent nodes agreeing on WHICH set a player donated under.

test('a set round-trips as its canonical form, and every field is inside its id', () => {
  // CANONICAL, not verbatim: bech32 says case carries no meaning in an
  // address, so the bytes carry the lowered form and a set typed in upper
  // comes back lowered. The payee is the same payee either way.
  const back = decodeDonationSet(encodeDonationSet(three));
  assert.deepEqual(back, three.map((r) => ({ ...r, lnurl: canonicalLnurl(r.lnurl) })));
  assert.equal(toHex(donationSetId(back)), toHex(donationSetId(three)));

  // an address changed is a different set: 22A's "a donation to an undisclosed
  // address is not a donation" is uncheckable if the bytes hashed another one
  const was = toHex(donationSetId(three));
  const renamed = three.map((r, i) => (i === 1 ? { ...r, lnurl: 'LNURL9' } : r));
  assert.notEqual(toHex(donationSetId(renamed)), was, 'the address');

  // and a share changed is a different set
  const reweighted = [{ lnurl: 'LNURL1', shareBps: 3334 }, { lnurl: 'LNURL2', shareBps: 3333 },
                      { lnurl: 'LNURL3', shareBps: 3333 }];
  assert.notEqual(toHex(donationSetId(reweighted)), was, 'the share');

  // a recipient added or removed likewise
  assert.notEqual(toHex(donationSetId(evenly)), was, 'the recipients');

  const longer = new Uint8Array(encodeDonationSet(three).length + 1);
  longer.set(encodeDonationSet(three));
  assert.throws(() => decodeDonationSet(longer), /trailing bytes/);
  assert.throws(() => decodeDonationSet(new Uint8Array([0x01, 0x00, 0x01])), /not a donation set/);
});

/**
 * REORDERING IS A DIFFERENT SET, and this is the one place in the package
 * where a vector is deliberately NOT sorted. Everywhere else sorting is what
 * makes two honest callers agree; here 22A gives the remainder to "the first
 * recipient in the set as published", so the order decides who is topped up
 * and a sorted encoding would hide a real difference in who gets paid.
 */
test('reordering the recipients is a different set, because order pays somebody', () => {
  const forwards = donationSetId(three);
  const backwards = donationSetId([...three].reverse());
  assert.notEqual(toHex(forwards), toHex(backwards),
    'a reordered set pays the remainder to somebody else and must not share an id');

  // and the money follows the order, which is why the id must
  const a = splitDonation({ donationMsat: 2001n, recipients: three });
  const b = splitDonation({ donationMsat: 2001n, recipients: [...three].reverse() });
  assert.equal(a.shares[0].lnurl, 'LNURL1');
  assert.equal(b.shares[0].lnurl, 'LNURL3');
  assert.notEqual(a.shares[0].amountMsat, b.shares[1].amountMsat);
});

/**
 * A SET THAT DOES NOT STAND DOES NOT ENCODE. Otherwise there would be bytes
 * with a real tagged id naming shares that sum to 9999 - an object as
 * published-looking as an honest one that hands out a different amount than
 * the player chose.
 */
test('a set that does not stand cannot be given an id at all', () => {
  for (const bad of [
    [{ lnurl: 'A', shareBps: 9999 }],
    [{ lnurl: 'A', shareBps: 5000 }, { lnurl: 'B', shareBps: 5001 }],
    [{ lnurl: 'SAME', shareBps: 5000 }, { lnurl: 'SAME', shareBps: 5000 }],
    [],
  ]) {
    assert.throws(() => encodeDonationSet(bad), /does not stand/, JSON.stringify(bad));
    assert.throws(() => donationSetId(bad), /does not stand/);
  }
});

test('bytes that do not stand are refused on the way in as well as out', () => {
  // A stranger is exactly who might send a set that does not stand, so the
  // decoder checks too rather than trusting that the encoder was ours.
  const honest = encodeDonationSet(evenly);
  const tampered = new Uint8Array(honest);
  tampered[tampered.length - 1] -= 1;            // 5000 -> 4999, so 9999 in all
  assert.throws(() => decodeDonationSet(tampered), /does not stand/);
});

/**
 * AND THE ZERO-DONATION ANSWER IS `owed`, NOT `ok`.
 *
 * 22A: the set is irrelevant to an entry that donates nothing, so a zero
 * donation succeeds even against a set that would not stand. A field called
 * `ok` invited a caller to read that as "this set stands", which it never
 * said. Whether a set stands is `donationSetStands`, a different question with
 * a different name.
 */
test('a zero donation answers what is owed, and never that the set stands', () => {
  const wouldNotStand = [{ lnurl: 'A', shareBps: 1 }];
  const off = splitDonation({ donationMsat: 0n, recipients: wouldNotStand });

  assert.equal(off.owed, true, '22A: nothing is owed, and the set is irrelevant');
  assert.equal('ok' in off, false, 'the answer must not be readable as "this set stands"');
  assert.equal(donationSetStands(wouldNotStand).ok, false, 'and that set does NOT stand');
  assert.throws(() => donationSetId(wouldNotStand), /does not stand/);

  // the same field answers a real split, so a caller reads one word for one
  // question either way
  assert.equal(splitDonation({ donationMsat: 10n, recipients: evenly }).owed, true);
  assert.equal(splitDonation({ donationMsat: 10n, recipients: wouldNotStand }).owed, false);
});

// ---------------------------------------------------------------------------
// AN LNURL IS BECH32, AND BECH32 DECIDES ITS OWN CASE RULES.
//
// Treating the string as opaque bytes was a hole, measured on the delivered
// code: `[{LNURL1ABC, 5000}, {lnurl1abc, 5000}]` STOOD - one party holding two
// shares, which is exactly what the duplicate check exists to prevent - and
// the same payee produced two different set ids, so two honest nodes handed
// the same recipients in different case disagreed about which set was used.

test('a payee is the same payee whatever case the address is typed in', () => {
  const upper = [{ lnurl: 'LNURL1ABC', shareBps: 5000 },
                 { lnurl: 'LNURL2DEF', shareBps: 5000 }];
  const lower = upper.map((r) => ({ ...r, lnurl: r.lnurl.toLowerCase() }));

  assert.equal(donationSetStands(upper).ok, true);
  assert.equal(donationSetStands(lower).ok, true);
  assert.equal(toHex(donationSetId(upper)), toHex(donationSetId(lower)),
    'two honest nodes must not disagree because one typed the address in caps');

  // and the money follows the same identity
  const a = splitDonation({ donationMsat: 1001n, recipients: upper });
  const b = splitDonation({ donationMsat: 1001n, recipients: lower });
  assert.deepEqual(a.shares.map((s) => s.amountMsat), b.shares.map((s) => s.amountMsat));
});

test('one payee under two spellings is one payee, and does not stand', () => {
  const twice = [{ lnurl: 'LNURL1ABC', shareBps: 5000 },
                 { lnurl: 'lnurl1abc', shareBps: 5000 }];
  const seen = donationSetStands(twice);
  assert.equal(seen.ok, false, 'one party was allowed to hold two shares');
  assert.match(seen.why, /is listed twice, which is one party with two shares/);
  assert.throws(() => donationSetId(twice), /does not stand/);

  // the other way round is the same answer
  assert.equal(donationSetStands([...twice].reverse()).ok, false);
});

test('mixed case does not stand, because bech32 does not allow it', () => {
  for (const lnurl of ['LnUrL1abc', 'lnurl1ABC', 'LNURL1abc'])
    assert.match(donationSetStands([{ lnurl, shareBps: 10000 }]).why,
      /mixed case, which bech32 does not allow/, lnurl);

  // all-upper and all-lower both stand; digits and separators are neither
  for (const lnurl of ['LNURL1ABC', 'lnurl1abc', 'lnurl1', '1234'])
    assert.equal(donationSetStands([{ lnurl, shareBps: 10000 }]).ok, true, lnurl);
});

test('the fold is ASCII, so no locale can move an address', () => {
  assert.equal(canonicalLnurl('LNURL1ABC'), 'lnurl1abc');
  assert.equal(canonicalLnurl('lnurl1abc'), 'lnurl1abc', 'a lowered address is unchanged');
  assert.equal(canonicalLnurl('1234'), '1234');

  // `toLowerCase` is Unicode and maps these; the fold must not, or two
  // implementations could canonicalise one address two ways
  assert.equal(canonicalLnurl('İ'), 'İ', 'a dotted capital I is left alone');
  assert.equal(canonicalLnurl('Ä'), 'Ä', 'and so is a non-ASCII letter');

  assert.equal(isMixedCase('LnUrL'), true);
  assert.equal(isMixedCase('LNURL1'), false);
  assert.equal(isMixedCase('lnurl1'), false);
  assert.equal(isMixedCase('1234'), false);
});

/**
 * AND A SET THAT WAS ALREADY CANONICAL KEEPS THE ID IT HAD. Lowercase was
 * already the fold's output, so nothing published in lower moved.
 */
test('an all-lower set keeps exactly the id it already had', () => {
  const lower = [{ lnurl: 'lnurl1abc', shareBps: 3333 },
                 { lnurl: 'lnurl2def', shareBps: 3333 },
                 { lnurl: 'lnurl3ghi', shareBps: 3334 }];
  // Measured against the pre-fold code itself, not reasoned about: both give
  // 44022895c61f07fd, because lowercase was already what the fold outputs, so
  // the bytes never moved for anything published in lower.
  assert.equal(toHex(donationSetId(lower)).slice(0, 16), '44022895c61f07fd');
  assert.equal(toHex(donationSetId(lower)),
    toHex(donationSetId(lower.map((r) => ({ ...r, lnurl: r.lnurl.toUpperCase() })))));
});

/**
 * ONE SET HAS ONE BYTE STRING, AND A STRANGER'S DO NOT COUNT.
 *
 * The encoder folds, so nothing this package writes is ever uppercase - but a
 * stranger does not use this encoder. Measured on the delivered fold:
 * hand-crafted bytes spelling the payee `LNURL1ABC` decoded happily and stood,
 * leaving one set with two byte strings. A committee comparing what it
 * received, or hashing it directly instead of re-encoding, would see two
 * different sets and disagree - the very disagreement folding was adopted to
 * remove.
 */
test('bytes that are not the set\'s own encoding are refused', () => {
  const name = Buffer.from('LNURL1ABC', 'ascii');
  const crafted = new Uint8Array(Buffer.concat([
    Buffer.from([0x10, 0x00, 0x01, 0x00, 0x01, 0x00, name.length]),
    name,
    Buffer.from([0x27, 0x10]),                       // 10000 basis points
  ]));
  assert.throws(() => decodeDonationSet(crafted), /is not canonical/,
    'a second byte string for one set was accepted');

  // and the canonical bytes for that same payee decode as they always did
  const honest = encodeDonationSet([{ lnurl: 'LNURL1ABC', shareBps: 10000 }]);
  assert.deepEqual(decodeDonationSet(honest), [{ lnurl: 'lnurl1abc', shareBps: 10000 }]);

  // the encoder cannot produce a non-canonical string in the first place:
  // typed in either case it writes the same bytes
  assert.equal(toHex(encodeDonationSet([{ lnurl: 'LNURL1ABC', shareBps: 10000 }])),
               toHex(encodeDonationSet([{ lnurl: 'lnurl1abc', shareBps: 10000 }])));
});

// ---------------------------------------------------------------------------
// AND WHICH SET A ROUND NAMED, 22A: "The set is named in the Round Contract
// and its HASH IS PART OF THE CONTRACT HASH, so it cannot change after entry."
//
// Until this a set had an id and nothing named which one applied, so two
// honest nodes could agree on a set's bytes and still disagree about whether
// it was this round's - the last way a player's donation could be split by a
// list nobody signed up to.

const roundWith = (donationSetId) => ({
  simCoreHash: b32(1), startTimeMs: 1000n, entryCloseMs: 2000n, objectionWindowMs: 600000n,
  custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'BURN', donationSetId,
  censusHeight: 900000, censusRoot: b32(2), committeeSeed: b32(3), stakeMsat: 100000n,
  bondMinSats: 50000n, blockTicks: 600, exposureReference: 1000, corridorHalfWidth: 40,
  spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150, minScore: 1,
  rankNumerator: 3, rankDenominator: 4, nodes: [b32(9)],
});

test('a round names one donation set, and another set is not it', () => {
  const contract = roundWith(donationSetId(three));
  assert.equal(donationSetMatchesRound(contract, three).ok, true);

  // the same payees in another order are a different set - the order decides
  // who takes the remainder - so they are not the set this round named
  const reordered = donationSetMatchesRound(contract, [...three].reverse());
  assert.equal(reordered.ok, false);
  assert.match(reordered.why, /not the one this round named/);

  assert.equal(donationSetMatchesRound(contract, evenly).ok, false);
  assert.equal(donationSetMatchesRound(roundWith(b32(0xd0)), three).ok, false);
});

test('a set that does not stand can never be the set a round named', () => {
  const wontStand = [{ lnurl: 'lnurl1abc', shareBps: 9999 }];
  assert.throws(() => donationSetId(wontStand), /does not stand/,
    'a non-standing set has no id, so no contract can name it');

  // and presenting one against any round is a refusal, not a crash
  const seen = donationSetMatchesRound(roundWith(b32(0xd0)), wontStand);
  assert.equal(seen.ok, false);
  assert.match(seen.why, /does not stand/);
});

test('a round that names no set is answered, not crashed at', () => {
  for (const bad of [undefined, {}, { donationSetId: 'not bytes' },
                     { donationSetId: new Uint8Array(31) }])
    assert.match(donationSetMatchesRound(bad, three).why, /names no donation set/);
});

/**
 * AND THE ID IS INSIDE THE ROUND ID, which is what 22A's "it cannot change
 * after entry" actually rests on. Measured against the pre-change encoder:
 * the contract grew 211 to 243 bytes and its id moved
 * 5b0b853d321cd581... to 71a39572bb516259...
 */
test('the donation set is inside the round id, so it cannot change after entry', () => {
  const here = roundWith(donationSetId(three));
  const there = roundWith(donationSetId(evenly));
  assert.notDeepEqual(roundId(here), roundId(there),
    'a round naming another set must be another round');

  const back = decodeRoundContract(encodeRoundContract(here));
  assert.deepEqual(back.donationSetId, here.donationSetId);
  assert.equal(toHex(roundId(back)), toHex(roundId(here)));

  // a round that names nothing does not encode, and says which field by name
  const missing = { ...here };
  delete missing.donationSetId;
  assert.throws(() => encodeRoundContract(missing), /expected 32 bytes, got nothing/);
});
