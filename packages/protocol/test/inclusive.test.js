// 6e: ONE NUMBER LEAVES THE WALLET.
//
// 22A, "Collection: inclusive in the stake (changed)":
//
//   wallet commitment                 100 sat   <- what the player chose
//     node infrastructure fee           2 sat
//     player-selected donation          2 sat
//   net game stake                     96 sat   -> the pool
//
// Until this letter the code read 18's older sentence - fees "charged on top of
// the stake" - and `fee.js` called Collection the error. Measured before any of
// this was written: a loser who had donated 2% credited the pool with 100000
// msat where 96000 was game money, an invoice for the net 96000 was REFUSED,
// and the fee rule took a donation of 200000 on a stake of 100000.
//
// Each test here is one of those, or the example 22A itself gives.
import { TEST_FEDERATION_ID } from '../src/test-federation.js';
import { test } from 'node:test';
import { TEST_DONATION_SET_REGTEST } from '../src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../src/donation.js';
import assert from 'node:assert/strict';
import { toHex } from '../src/hash.js';
import {
  computePayoutTable, holdSettlement, invoiceMatchesEntry, netStakeMsat,
  DELIVERED, FAILED, SETTLE, CANCEL,
} from '../src/payout.js';
import {
  nodeFeeTable, entryFeeMsat, feeMatchesEntry, GAME_VERIFY, SETTLEMENT,
} from '../src/fee.js';
import { donatedMsat } from '../src/donation.js';
import { winnings } from '../src/payout-spend.js';
import { payoutInputsId } from '../src/slash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const game = [b32(0x21), b32(0x22), b32(0x23), b32(0x24), b32(0x25), b32(0x26), b32(0x27)];
const settle = [b32(0x31), b32(0x32), b32(0x33), b32(0x34), b32(0x35), b32(0x36), b32(0x37)];
const pools = { [GAME_VERIFY]: game, [SETTLEMENT]: settle };
const all = new Set([...game, ...settle].map(toHex));
const contract = {
  networkId: b32(0x4e), configHash: b32(0x43), censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, simCoreHash: b32(1), startTimeMs: 60500n, entryCloseMs: 2000n, objectionWindowMs: 600000n,
  custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: [], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000,
  censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n, bondMinSats: 50000n,
  blockTicks: 600, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: [...game, ...settle],
};

const STAKE = 100000n;
const FEE = entryFeeMsat(STAKE);
const entryOf = (n, outcome, { score = 0, donationMsat = 0n } = {}) => ({
  entryId: b32(n), pubkey: b32(n), outcome, score, stakeMsat: STAKE, feeMsat: FEE, donationMsat,
});

/**
 * 22A'S OWN EXAMPLE, RE-DERIVED RATHER THAN PATCHED.
 *
 * "61-player round, all donating 2%: gross_round_volume = 6,100 sat (61 x 100,
 * the wallet commitments); node fee (2%) = 122 sat; donation (2%) = 122 sat;
 * game pool = 5,856 sat".
 *
 * `fee.js` rejected Collection because "the net reading gives 117.12 sat, which
 * is not a whole satoshi". That was 2% of the NET stake - a base 22A never
 * uses. The fee base is the commitments, and it is the pool that is net.
 */
test("22A's 61-player round: 6,100 committed, 122 fee, 122 donated, 5,856 to the game", () => {
  const entries = Array.from({ length: 61 }, (_, i) =>
    entryOf(i + 1, FAILED, { donationMsat: (STAKE * 200n) / 10000n }));
  for (const e of entries) assert.equal(feeMatchesEntry(e).ok, true, feeMatchesEntry(e).why);

  const t = nodeFeeTable({ contract, entries, pools, eligible: all });
  assert.equal(t.gross, 6100000n, 'the fee base is the wallet commitments');
  assert.equal(t.fee, 122000n);
  assert.equal(t.pools[GAME_VERIFY], 61000n);
  assert.equal(t.pools[SETTLEMENT], 61000n);
  assert.equal(donatedMsat(entries), 122000n);

  const toTheGame = entries.reduce((s, e) => s + netStakeMsat(e), 0n);
  assert.equal(toTheGame, 5856000n);

  // NOTHING ON TOP AND NOTHING LOST: the three parts are the commitment
  assert.equal(t.fee + donatedMsat(entries) + toTheGame, 61n * STAKE);
  // and what the entries were charged in fee is what the table owes the nodes
  assert.equal(entries.reduce((s, e) => s + e.feeMsat, 0n), t.fee);

  // 117.12 sat is 2% of the game pool, and it was never 22A's number
  assert.equal(entryFeeMsat(toTheGame), 117120n);
  assert.notEqual(entryFeeMsat(toTheGame), t.fee);
});

/**
 * THE WALLET IS ASKED FOR THE NET STAKE, because that is what a hold can hold.
 *
 * 23.2 cancels a DELIVERED hold back to its player whole, and 23.5 keeps the
 * fee and the donation out of the pool wallet - so a hold for the commitment
 * would hand every winner their own fee back, and a loser's settle would put
 * the donation in the pool. Before 6e the net was the invoice refused.
 */
test('100 committed, 2 fee, 2 donated: the hold is for 96, and nothing else is', () => {
  const entry = { stakeCommitment: b32(0x7a), stakeMsat: STAKE, feeMsat: FEE, donationMsat: 2000n };
  assert.equal(netStakeMsat(entry), 96000n);

  const held = invoiceMatchesEntry({ paymentHash: b32(0x7a), amountMsat: 96000n, entry });
  assert.equal(held.ok, true, held.why);

  for (const amountMsat of [100000n, 98000n, 102000n, 104000n]) {
    const said = invoiceMatchesEntry({ paymentHash: b32(0x7a), amountMsat, entry });
    assert.equal(said.ok, false, `an invoice for ${amountMsat} stood against a 96000 hold`);
    assert.match(said.why, /this entry holds 96000/);
  }
});

/**
 * THE MONEY FOLLOWS THE HOLD. A loser's settle moves their net stake and not
 * their commitment; the winner's cancel hands back their net; and the pool
 * pays the winner exactly what it took in.
 */
test('a loser settles 96 into the pool, and the winner is paid exactly that', () => {
  const winner = entryOf(1, DELIVERED, { score: 500, donationMsat: 2000n });
  const loser = entryOf(2, FAILED, { donationMsat: 2000n });

  const s = holdSettlement({ roundId: b32(9), minScore: 1, entries: [winner, loser] });
  assert.deepEqual(s.actions.map((a) => a.action), [CANCEL, SETTLE]);
  assert.equal(s.poolMsat, 96000n, 'the pool took the fee or the donation with the stake');
  assert.equal(s.refundedMsat, 96000n, 'the winner s hold is their net stake');
  assert.equal(s.sharesMsat, 96000n);
  assert.equal(s.table.table[0].amountMsat, 192000n, 'own net stake back plus the loser s');

  const owed = winnings({ table: s.table.table, stakes: [winner, loser] });
  assert.equal(owed.ok, true, owed.why);
  assert.equal(owed.owedMsat, 96000n, 'the pool owes the winner something other than it holds');
  assert.equal(owed.owedMsat, s.poolMsat);
});

/**
 * 22A'S NET-STAKE WEIGHTING, AS RULED (M3.2-6e, 2026-09-13, pick A): within the
 * paying ranks a player's weight is its §18A rank weight times its own net
 * stake; the pool is split in proportion, floored, and the leftover goes out
 * by §18A.6 (ascending H(round_id || pubkey)). Before: such a table was
 * refused and every hold expired - one donor, and the pool got nothing.
 */
test('qualifiers who staked different nets are paid by rank weight times net stake, the pool spent exactly', () => {
  const donor = entryOf(1, DELIVERED, { score: 900, donationMsat: 5000n });   // net 93000
  const others = [2, 3, 4].map((n) => entryOf(n, DELIVERED, { score: 500 + n }));
  const loser = entryOf(50, FAILED);

  // ONE PAYING RANK (four qualifiers), THE ACCEPTED LIMIT: the winner takes the
  // whole pool whatever it donated - the donation weighs nothing against itself.
  const one = computePayoutTable({ roundId: b32(9), minScore: 1, entries: [donor, ...others, loser] });
  assert.equal(one.payingRanks, 1);
  assert.equal(one.pool, 98000n);
  assert.equal(one.table[0].amountMsat, 93000n + 98000n, 'the sole paying rank: own net back plus the whole pool');
  assert.deepEqual(one.table.slice(1, 4).map((r) => r.amountMsat), [98000n, 98000n, 98000n]);
  assert.equal(one.table[4].amountMsat, 0n);

  // AND THE HOLDS FOLLOW IT: the loser's net is settled into the pool, the
  // qualifiers' holds come back - no longer a refund of everybody.
  const held = holdSettlement({ roundId: b32(9), minScore: 1, entries: [donor, ...others, loser] });
  assert.equal(held.poolMsat, 98000n, 'the loser s net enters the pool');
  assert.equal(held.sharesMsat, 98000n);
  assert.deepEqual(held.actions.map((a) => a.action), ['CANCEL', 'CANCEL', 'CANCEL', 'CANCEL', 'SETTLE']);

  // TWO PAYING RANKS (five qualifiers): rank weights 4 and 3, times the nets
  // 93000 (the donor, first) and 98000 (second) - 372000 and 294000 of 666000.
  const fifth = entryOf(5, DELIVERED, { score: 505 });
  const two = computePayoutTable({ roundId: b32(9), minScore: 1, entries: [donor, ...others, fifth, loser] });
  assert.equal(two.payingRanks, 2);
  const first = (98000n * 372000n) / 666000n;                    // 54738, floored
  const second = (98000n * 294000n) / 666000n;                   // 43261, floored
  assert.equal(first, 54738n);
  assert.equal(second, 43261n);
  const shareOf = (row, own) => row.amountMsat - own;
  const donorShare = shareOf(two.table[0], 93000n);
  const secondShare = shareOf(two.table.find((r, i) => i > 0 && r.amountMsat > 98000n), 98000n);
  assert.equal(donorShare + secondShare, 98000n, 'the pool is spent exactly');
  assert.ok(donorShare - first <= 1n && secondShare - second <= 1n && donorShare >= first && secondShare >= second,
    `each share is its floor or one leftover msat above it: ${donorShare}, ${secondShare}`);
  assert.ok(donorShare < 56000n, `the donor's share is scaled down from the unweighted 4/7 of the pool (56000): ${donorShare}`);

  // LOSERS MAY DIFFER: they only feed the pool, and each puts in its own net
  const giving = entryOf(51, FAILED, { donationMsat: 5000n });
  const t = computePayoutTable({ roundId: b32(9), minScore: 1, entries: [others[0], loser, giving] });
  assert.equal(t.pool, 98000n + 93000n);
  assert.equal(t.table[0].amountMsat, 98000n + 191000n);

  // AND WITH NO POOL THERE IS NOTHING TO SCALE: each takes its own net back
  const quiet = computePayoutTable({ roundId: b32(9), minScore: 1, entries: [donor, others[0]] });
  assert.deepEqual(quiet.table.map((r) => r.amountMsat), [93000n, 98000n]);
});

/**
 * THE DONATION COMES OUT OF THE SAME COMMITMENT AS THE FEE, so the two cannot
 * come to more than it. Before 6e the fee rule never looked at the donation,
 * and 200000 on a 100000 stake stood.
 */
test('a fee and a donation that come to more than the stake do not stand', () => {
  for (const donationMsat of [0n, 2000n, 98000n]) {
    const said = feeMatchesEntry({ stakeMsat: STAKE, feeMsat: FEE, donationMsat });
    assert.equal(said.ok, true, `${donationMsat}: ${said.why}`);
    assert.equal(said.net, STAKE - FEE - donationMsat);
  }
  for (const donationMsat of [98001n, 200000n]) {
    const said = feeMatchesEntry({ stakeMsat: STAKE, feeMsat: FEE, donationMsat });
    assert.equal(said.ok, false, `a donation of ${donationMsat} stood on a stake of ${STAKE}`);
    assert.match(said.why, /cannot come to more than it/);
  }
  // and one that names no donation is not read as zero
  assert.equal(feeMatchesEntry({ stakeMsat: STAKE, feeMsat: FEE }).ok, false);
});

/**
 * AN ENTRY THAT NAMES NO FEE IS REFUSED, not read as the on-top reading. Zero
 * is exactly what a missing field would become, and zero fee on a 100000 stake
 * is a hold for the whole commitment.
 */
test('every money path refuses an entry that names only its stake', () => {
  const bare = { pubkey: b32(1), outcome: DELIVERED, score: 1, stakeMsat: STAKE };
  assert.throws(() => computePayoutTable({ roundId: b32(9), entries: [bare] }),
    /names its stake, its fee and its donation/);
  assert.throws(() => holdSettlement({ roundId: b32(9), entries: [bare] }),
    /names its stake, its fee and its donation/);
  const w = winnings({ table: [{ pubkey: b32(1), amountMsat: STAKE }], stakes: [bare] });
  assert.equal(w.ok, false);
  assert.match(w.why, /names its stake, its fee and its donation/);
});

/**
 * A SLASHING PROOF IS BOUND TO ALL THREE NUMBERS, because F reads all three.
 * Two inputs that differ only in a donation have different honest tables, and
 * an id that could not tell them apart would let an accuser choose the split.
 */
test('the inputs a payout proof binds to carry the fee and the donation', () => {
  const inputs = (over) => payoutInputsId({
    roundId: b32(9), minScore: 1, entries: [{ ...entryOf(1, DELIVERED, { score: 5 }), ...over }],
  });
  const base = toHex(inputs({}));
  assert.notEqual(toHex(inputs({ feeMsat: FEE + 1n })), base, 'the fee is outside the hash');
  assert.notEqual(toHex(inputs({ donationMsat: 1n })), base, 'the donation is outside the hash');
  assert.notEqual(toHex(inputs({ stakeMsat: STAKE + 1n })), base, 'the stake is outside the hash');
});
