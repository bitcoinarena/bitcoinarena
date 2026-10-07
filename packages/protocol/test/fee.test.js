// 22A: THE FEE TABLE, WHICH NOBODY COMPUTED UNTIL NOW.
//
// 5A.3 row 6 decides WHETHER a node qualifies for a share; until this file
// nothing said what the share IS, so a qualifying node could claim any amount
// and no predicate contradicted it. `grep` found no fee arithmetic anywhere in
// `packages/*/src` before this.
//
// 22A leaves nothing to taste: 2.00% of the gross, 1.00% to each of two
// seven-slot pools, unearned shares redistributed inside the same pool
// "keeping the total at 2%", and remainders floored in millisatoshi and handed
// out in ascending H(round_id || node_pubkey).
import { TEST_FEDERATION_ID } from '../src/test-federation.js';
import { test } from 'node:test';
import { TEST_DONATION_SET_REGTEST } from '../src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../src/donation.js';
import assert from 'node:assert/strict';
import { toHex } from '../src/hash.js';
import { roundId } from '../src/contracts.js';
import { remainderOrder } from '../src/payout.js';
import {
  nodeFeeTable, grossVolumeMsat, feeOwed, poolOfRole, entryFeeMsat, feeMatchesEntry,
  NODE_FEE_BPS, POOL_BPS,
  GAME_VERIFY, SETTLEMENT, GUARDIAN, POOLS,
} from '../src/fee.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const game = [b32(0x21), b32(0x22), b32(0x23), b32(0x24), b32(0x25), b32(0x26), b32(0x27)];
const settle = [b32(0x31), b32(0x32), b32(0x33), b32(0x34), b32(0x35), b32(0x36), b32(0x37)];
const pools = { [GAME_VERIFY]: game, [SETTLEMENT]: settle };
const all = new Set([...game, ...settle].map(toHex));

const contract = {
  networkId: b32(0x4e), configHash: b32(0x43), censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, gameId: NEXTBLOCK_GAME_ID, simCoreHash: b32(1), startTimeMs: 60500n, entryCloseMs: 2000n, objectionWindowMs: 600000n,
  custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: [], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000,
  censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n, bondMinSats: 50000n,
  blockTicks: 600, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: [...game, ...settle],
};

const player = (n, outcome, stakeMsat = 100000n) =>
  ({ pubkey: b32(n), outcome, score: 500, stakeMsat });
const entries = [player(0xa1, 'DELIVERED'), player(0xa2, 'FAILED'),
                 player(0xa3, 'FORFEIT'), player(0xa4, 'DELIVERED')];

const table = (over = {}) =>
  nodeFeeTable({ contract, entries, pools, eligible: all, ...over });
const paid = (t) => [...t.signerNodes.values()].reduce((a, b) => a + b, 0n);

test('a role is paid from its own pool, and relay is paid by nothing', () => {
  // 22A: "An operator selected for BOTH roles earns BOTH shares, because it
  // performs both services." So the shares are separate money and the table is
  // keyed by pool as well as key - measured while writing this: a table keyed
  // by pubkey alone judged a settlement claim against the game/verify share
  // and let it through.
  assert.equal(poolOfRole('game'), GAME_VERIFY);
  assert.equal(poolOfRole('verify'), GAME_VERIFY);
  assert.equal(poolOfRole('settlement'), SETTLEMENT);
  assert.equal(poolOfRole('relay'), null, '22A names two committees and relay is neither');
});

test('a signer node in both pools earns both shares, and they do not merge', () => {
  const both = b32(0x21);
  const t = nodeFeeTable({
    contract, entries,
    pools: { [GAME_VERIFY]: [both], [SETTLEMENT]: [both] },
    eligible: new Set([toHex(both)]),
  });
  assert.equal(feeOwed(t, both, 'verify'), 4000n);
  assert.equal(feeOwed(t, both, 'settlement'), 4000n);
  assert.equal(feeOwed(t, both, 'relay'), 0n);
  assert.equal(paid(t), 8000n, 'both shares, and the fee is still 2%');
});

test('the rates are 22A\'s and are not a taste', () => {
  assert.equal(NODE_FEE_BPS, 200, '2.00% of gross_round_volume');
  assert.equal(POOL_BPS, 100, '1.00% to each pool when the round names no guardian (the two-pool table)');
  assert.deepEqual(POOLS, [GAME_VERIFY, SETTLEMENT, GUARDIAN]);
});

// THE GUARDIAN POOL (§22A v4.6.4, RULED 2026-09-21 / 2026-10-01 15:44): 2/3 % each to game/verify, settlement and the
// guardians of the round's federation - and a node in all three pools is owed the same total as under two.
test('with guardians named the fee splits in three equal thirds, and the leftover msats take turns', () => {
  const nodes = [new Uint8Array(32).fill(1), new Uint8Array(32).fill(2)];
  const t = nodeFeeTable({ contract, entries, pools: { gameVerify: nodes, settlement: nodes, guardian: nodes },
    eligible: new Set(nodes.map((k) => Buffer.from(k).toString('hex'))) });
  assert.equal(t.fee, 8000n);
  assert.deepEqual(t.pools, { gameVerify: 2666n, settlement: 2666n, guardian: 2668n });
  const per = new Map();
  for (const [k, v] of t.signerNodes) { const key = k.split(':')[1]; per.set(key, (per.get(key) || 0n) + v); }
  assert.deepEqual([...per.values()].sort(), [4000n, 4000n], 'each node the same total as under two pools');
});

/**
 * THE BASE IS THE ACTIVATED ENTRIES. 22A: "gross_round_volume = sum of stake
 * of every financially activated entry... ENTRY_VOID and VOID entries are
 * excluded." A refunded entry is money that never moved, and charging a fee on
 * it would charge for a round the player was refunded out of.
 */
test('VOID and ENTRY_VOID stakes are outside the fee base', () => {
  assert.equal(grossVolumeMsat(entries), 400000n, 'four activated stakes of 100000');

  const withRefunds = [...entries, player(0xb1, 'VOID'), player(0xb2, 'ENTRY_VOID')];
  assert.equal(grossVolumeMsat(withRefunds), 400000n,
    'a refunded stake was charged a fee');

  assert.equal(grossVolumeMsat([]), 0n);
  assert.throws(() => grossVolumeMsat([{ ...player(0xa1, 'DELIVERED'), stakeMsat: 100 }]),
    /BigInt millisatoshi/);
});

test('the fee is two percent and the two pools are exactly it', () => {
  const t = table();
  assert.equal(t.gross, 400000n);
  assert.equal(t.fee, 8000n, '2% of 400000');
  assert.equal(t.pools[GAME_VERIFY], 4000n);
  assert.equal(t.pools[SETTLEMENT], 4000n);
  assert.equal(t.pools[GAME_VERIFY] + t.pools[SETTLEMENT], t.fee);
  assert.equal(paid(t) + t.unallocated, t.fee, 'the table hands out exactly the fee');
  assert.equal(t.unallocated, 0n);
});

/**
 * RAGGED NUMBERS ARE WHERE A FEE LEAKS. Every one of these is a gross that
 * does not divide by 10000, or a pool that does not divide by seven, or both.
 */
test('the pools sum to exactly the fee however ragged the numbers are', () => {
  for (const stake of [1n, 3n, 7n, 99n, 100001n, 123457n, 999999999n]) {
    const ragged = [player(0xa1, 'DELIVERED', stake), player(0xa2, 'FAILED', stake + 1n)];
    const t = nodeFeeTable({ contract, entries: ragged, pools, eligible: all });

    assert.equal(t.pools[GAME_VERIFY] + t.pools[SETTLEMENT], t.fee,
      `the pools lost a millisatoshi at ${stake}`);
    assert.equal(t.fee, (t.gross * 200n) / 10000n, `the fee is not 2% at ${stake}`);
    assert.equal(paid(t) + t.unallocated, t.fee, `the table leaked at ${stake}`);
    for (const v of t.signerNodes.values()) assert.ok(v >= 0n);
  }
});

/**
 * AND THE OPERATOR TAKES NOTHING. The fee is 2% of gross and not a
 * millisatoshi more, whoever is eligible - "keeping the total at 2%".
 */
test('an unearned share stays in its own pool and never reaches the operator', () => {
  const one = new Set([toHex(game[0]), ...settle.map(toHex)]);
  const t = table({ eligible: one });

  assert.equal(feeOwed(t, game[0], 'verify'), 4000n, 'the whole game/verify pool, and no more');
  for (const k of game.slice(1)) assert.equal(feeOwed(t, k, 'verify'), 0n);
  assert.equal(t.fee, 8000n, 'the fee did not grow because six signer nodes were idle');
  assert.equal(paid(t) + t.unallocated, 8000n);
  assert.equal(t.unallocated, 0n, 'and nothing fell out of the pools');

  // an unearned share does not cross into the OTHER pool either
  const settleShare = settle.reduce((sum, k) => sum + feeOwed(t, k, 'settlement'), 0n);
  assert.equal(settleShare, 4000n, 'the settlement pool is still exactly one percent');
});

/**
 * A POOL NOBODY EARNED IS UNALLOCATED, NOT INCOME. 22A keeps the total at 2%
 * by redistributing INSIDE a role pool, and with nobody eligible there is no
 * inside. The spec hands it nowhere, and nowhere is the only direction that
 * cannot become the operator's.
 */
test('a pool nobody qualified for is unallocated, not handed to anybody', () => {
  const nobodyOnGame = new Set(settle.map(toHex));
  const t = table({ eligible: nobodyOnGame });

  assert.equal(t.unallocated, 4000n, 'the idle pool went somewhere');
  for (const k of game) assert.equal(feeOwed(t, k, 'verify'), 0n);
  assert.equal(paid(t), 4000n);
  assert.equal(paid(t) + t.unallocated, t.fee);

  const nobodyAtAll = table({ eligible: new Set() });
  assert.equal(nobodyAtAll.unallocated, 8000n);
  assert.equal(nobodyAtAll.signerNodes.size, 0);
});

/**
 * REMAINDERS ARE HANDED OUT IN THE ROUND'S ORDER, and it is the same order
 * `payout.js` already uses - one implementation of the rule, not two.
 */
test('a pool that does not divide by seven is still handed out to the last msat', () => {
  const odd = [player(0xa1, 'DELIVERED', 500001n)];
  const t = nodeFeeTable({ contract, entries: odd, pools, eligible: all });
  assert.equal(paid(t) + t.unallocated, t.fee);

  // 1% of 500001 is 5000 msat over seven signer nodes: 714 each and two over
  assert.equal(t.pools[GAME_VERIFY], 5000n);
  const shares = game.map((k) => feeOwed(t, k, 'verify'));
  assert.equal(shares.reduce((a, b) => a + b, 0n), 5000n);
  assert.equal(shares.filter((v) => v === 715n).length, 2, 'two signer nodes round up');
  assert.equal(shares.filter((v) => v === 714n).length, 5);

  // and they are the first two in the round's own remainder order
  const order = remainderOrder(roundId(contract), game.map((pubkey) => ({ pubkey })));
  assert.equal(feeOwed(t, order[0].pubkey, 'verify'), 715n);
  assert.equal(feeOwed(t, order[1].pubkey, 'verify'), 715n);
  assert.equal(feeOwed(t, order[2].pubkey, 'verify'), 714n,
    'the round decides who rounds up, or the caller does');
});

test('the round decides the remainder order, not the list order', () => {
  const odd = [player(0xa1, 'DELIVERED', 500001n)];
  const forwards = nodeFeeTable({ contract, entries: odd, pools, eligible: all });
  const backwards = nodeFeeTable({
    contract, entries: odd,
    pools: { [GAME_VERIFY]: [...game].reverse(), [SETTLEMENT]: settle },
    eligible: all,
  });
  for (const k of game)
    assert.equal(feeOwed(backwards, k, 'verify'), feeOwed(forwards, k, 'verify'),
      'the order the caller lists signer nodes in moved somebody\'s millisatoshi');

  // a different round rounds up a different pair
  const other = nodeFeeTable({
    contract: { ...contract, blockTicks: 601 }, entries: odd, pools, eligible: all,
  });
  assert.notDeepEqual(game.map((k) => feeOwed(other, k, 'verify')), game.map((k) => feeOwed(forwards, k, 'verify')),
    'the round id must decide it, and this round is a different round');
});

test('a round nobody staked in owes nobody anything', () => {
  const t = nodeFeeTable({ contract, entries: [], pools, eligible: all });
  assert.equal(t.gross, 0n);
  assert.equal(t.fee, 0n);
  assert.equal(paid(t), 0n);
  assert.equal(t.unallocated, 0n);
});

// ---------------------------------------------------------------------------
// AND WHAT ONE ENTRY OWES, 18's way.
//
// "Node fees and the player-selected donation are charged ON TOP of the stake
// at entry and therefore do not reduce the pool." So `stakeMsat` is the gross
// stake and 2% of it is what the player was charged beside it.
//
// 22A's Collection section describes the opposite - a 100 sat commitment
// giving a 96 sat net stake - and contradicts both 18 and 22A's own worked
// example: 61 x 100 sat gross is a 122 sat fee, exactly what 61 players paying
// 2 sat each hand over, while the net reading gives 117.12 sat and no whole
// satoshi. Collection's 96 is the error and is not implemented.

test('a fee is two percent of that entry\'s own stake, on top of it', () => {
  assert.equal(entryFeeMsat(100000n), 2000n);
  assert.equal(entryFeeMsat(0n), 0n, 'a stake of nothing owes nothing');

  // 22A's worked example, in millisatoshi: 61 players at 100 sat
  const perPlayer = entryFeeMsat(100000n);
  assert.equal(perPlayer * 61n, 122000n, '122 sat, which is 22A\'s own number');

  for (const bad of [100000, '100000', undefined])
    assert.throws(() => entryFeeMsat(bad), /BigInt millisatoshi/);
  assert.throws(() => entryFeeMsat(-1n), /cannot be negative/);
});

test('an honest two percent stands and anything else does not', () => {
  const ok = feeMatchesEntry({ stakeMsat: 100000n, feeMsat: 2000n, donationMsat: 0n });
  assert.equal(ok.ok, true, ok.why);
  assert.equal(ok.owed, 2000n);

  const over = feeMatchesEntry({ stakeMsat: 100000n, feeMsat: 2001n, donationMsat: 0n });
  assert.equal(over.ok, false, 'one millisatoshi over stood');
  assert.equal(over.owed, 2000n);
  assert.match(over.why, /the 1 over is money no fee table allocates/);

  const under = feeMatchesEntry({ stakeMsat: 100000n, feeMsat: 1999n, donationMsat: 0n });
  assert.equal(under.ok, false, 'one millisatoshi under stood');

  const none = feeMatchesEntry({ stakeMsat: 100000n, feeMsat: 0n, donationMsat: 0n });
  assert.equal(none.ok, false, 'a positive stake with no fee stood');
  assert.equal(none.owed, 2000n);
});

/**
 * TOO MUCH IS THE DIRECTION THAT BECOMES INCOME. The fee table computes from
 * the stakes, so a millisatoshi over what 2% comes to is a millisatoshi the
 * table never allocates to anybody and that stays with whoever collected it.
 */
test('an over-charged fee is never allocated by the table', () => {
  const overcharged = { pubkey: b32(0xa1), outcome: 'DELIVERED', score: 500,
    stakeMsat: 100000n, feeMsat: 9999n };
  assert.equal(feeMatchesEntry(overcharged).ok, false);

  const t = nodeFeeTable({ contract, entries: [overcharged], pools, eligible: all });
  assert.equal(t.gross, 100000n, 'the base is the stake, and the fee rides beside it');
  assert.equal(t.fee, 2000n, 'the table owes 2% of the stake, not what was charged');
  assert.equal(paid(t) + t.unallocated, 2000n,
    'the 7999 over is allocated to nobody, which is why the entry must not stand');
});

test('a malformed entry is answered, not thrown at the caller', () => {
  for (const bad of [undefined, null, {}, { stakeMsat: 100000n }, { feeMsat: 2000n },
                     { stakeMsat: 100000, feeMsat: 2000 }])
    assert.equal(feeMatchesEntry(bad).ok, false);
  assert.match(feeMatchesEntry({}).why, /BigInt millisatoshi/);
  assert.match(feeMatchesEntry({ stakeMsat: -1n, feeMsat: 0n }).why, /cannot be negative/);
  assert.match(feeMatchesEntry({ stakeMsat: 1n, feeMsat: -1n }).why, /cannot be negative/);
});

/**
 * AND THE FLOOR DOES NOT AGGREGATE, which is measured here rather than
 * reconciled by invention.
 *
 * Each entry pays `floor(2% of its own stake)`; the table owes
 * `floor(2% of the sum)`. Those are not the same number: seven stakes of
 * 33333 msat collect 4662 and the table owes 4666, and three of 49 collect
 * nothing at all while the table owes 2. The gap is at most one millisatoshi
 * per entry and is always in the same direction - collected <= owed - so it
 * can never become income, which is why it is recorded and not patched. 22A
 * defines the fee on the gross and says nothing about which rounding a
 * collector uses; picking one here would be inventing a rule.
 */
test('per-entry floors can collect less than the table owes, never more', () => {
  const cases = [[2, 149n, 4n, 5n], [7, 33333n, 4662n, 4666n], [3, 49n, 0n, 2n],
                 [61, 100000n, 122000n, 122000n]];
  for (const [n, stake, collected, owedOnGross] of cases) {
    const each = entryFeeMsat(stake);
    assert.equal(each * BigInt(n), collected, `${n} x ${stake} collected`);

    const many = Array.from({ length: n }, (_, i) =>
      ({ pubkey: b32(0xc0 + i), outcome: 'DELIVERED', score: 500, stakeMsat: stake }));
    const t = nodeFeeTable({ contract, entries: many, pools, eligible: all });
    assert.equal(t.fee, owedOnGross, `${n} x ${stake} owed`);
    assert.ok(collected <= owedOnGross, 'a collector must never gather more than the table owes');
  }
});
