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
import { test } from 'node:test';
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
  custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'BURN', donationSetId: new Uint8Array(32).fill(0xd0), censusHeight: 900000,
  censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n, bondMinSats: 50000n,
  blockTicks: 600, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: [...game, ...settle],
};

const STAKE = 100000n;
const FEE = entryFeeMsat(STAKE);
const seat = (n, outcome, { score = 0, donationMsat = 0n } = {}) => ({
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
    seat(i + 1, FAILED, { donationMsat: (STAKE * 200n) / 10000n }));
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
  const winner = seat(1, DELIVERED, { score: 500, donationMsat: 2000n });
  const loser = seat(2, FAILED, { donationMsat: 2000n });

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
 * WHERE 22A LEAVES A HOLE, NOTHING IS INVENTED.
 *
 * "each rank's share is then scaled by that player's net stake against the
 * mean net stake of the qualifiers" does not spend the pool as written, and
 * the normalised form lets a sole paying rank take the whole pool whatever it
 * donated. A table whose qualifiers staked different nets while there is a
 * pool is refused - no stake moves and every hold expires to its player.
 */
test('qualifiers who staked different nets are refused, not guessed at', () => {
  const donor = seat(1, DELIVERED, { score: 900, donationMsat: 5000n });
  const others = [2, 3, 4].map((n) => seat(n, DELIVERED, { score: 500 + n }));
  const loser = seat(50, FAILED);

  assert.throws(
    () => computePayoutTable({ roundId: b32(9), minScore: 1, entries: [donor, ...others, loser] }),
    /the qualifiers staked different nets \(93000, 98000 msat\)/);
  assert.throws(
    () => holdSettlement({ roundId: b32(9), minScore: 1, entries: [donor, ...others, loser] }),
    /no table until it is ruled/);

  // LOSERS MAY DIFFER: they only feed the pool, and each puts in its own net
  const giving = seat(51, FAILED, { donationMsat: 5000n });
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
    roundId: b32(9), minScore: 1, entries: [{ ...seat(1, DELIVERED, { score: 5 }), ...over }],
  });
  const base = toHex(inputs({}));
  assert.notEqual(toHex(inputs({ feeMsat: FEE + 1n })), base, 'the fee is outside the hash');
  assert.notEqual(toHex(inputs({ donationMsat: 1n })), base, 'the donation is outside the hash');
  assert.notEqual(toHex(inputs({ stakeMsat: STAKE + 1n })), base, 'the stake is outside the hash');
});
