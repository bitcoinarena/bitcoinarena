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
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toHex } from '../src/hash.js';
import { roundId } from '../src/contracts.js';
import { remainderOrder } from '../src/payout.js';
import {
  nodeFeeTable, grossVolumeMsat, feeOwed, poolOfRole, NODE_FEE_BPS, POOL_BPS,
  GAME_VERIFY, SETTLEMENT, POOLS,
} from '../src/fee.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const game = [b32(0x21), b32(0x22), b32(0x23), b32(0x24), b32(0x25), b32(0x26), b32(0x27)];
const settle = [b32(0x31), b32(0x32), b32(0x33), b32(0x34), b32(0x35), b32(0x36), b32(0x37)];
const pools = { [GAME_VERIFY]: game, [SETTLEMENT]: settle };
const all = new Set([...game, ...settle].map(toHex));

const contract = {
  simCoreHash: b32(1), startTimeMs: 1000n, entryCloseMs: 2000n, objectionWindowMs: 600000n,
  custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'BURN', censusHeight: 900000,
  censusRoot: b32(2), committeeSeed: b32(3), stakeMsat: 100000n, bondMinSats: 50000n,
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
const paid = (t) => [...t.seats.values()].reduce((a, b) => a + b, 0n);

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

test('a seat in both pools earns both shares, and they do not merge', () => {
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
  assert.equal(POOL_BPS, 100, '1.00% to each pool');
  assert.deepEqual(POOLS, [GAME_VERIFY, SETTLEMENT]);
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
    for (const v of t.seats.values()) assert.ok(v >= 0n);
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
  assert.equal(t.fee, 8000n, 'the fee did not grow because six seats were idle');
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
  assert.equal(nobodyAtAll.seats.size, 0);
});

/**
 * REMAINDERS ARE HANDED OUT IN THE ROUND'S ORDER, and it is the same order
 * `payout.js` already uses - one implementation of the rule, not two.
 */
test('a pool that does not divide by seven is still handed out to the last msat', () => {
  const odd = [player(0xa1, 'DELIVERED', 500001n)];
  const t = nodeFeeTable({ contract, entries: odd, pools, eligible: all });
  assert.equal(paid(t) + t.unallocated, t.fee);

  // 1% of 500001 is 5000 msat over seven seats: 714 each and two over
  assert.equal(t.pools[GAME_VERIFY], 5000n);
  const shares = game.map((k) => feeOwed(t, k, 'verify'));
  assert.equal(shares.reduce((a, b) => a + b, 0n), 5000n);
  assert.equal(shares.filter((v) => v === 715n).length, 2, 'two seats round up');
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
      'the order the caller lists seats in moved somebody\'s millisatoshi');

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
