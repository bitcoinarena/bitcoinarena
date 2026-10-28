// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// 22A: THE FEE TABLE, WHICH NOBODY COMPUTED UNTIL NOW.
//
// 5A.3 row 6 decides WHETHER a node qualifies for a share; until this file
// nothing said what the share IS, so a qualifying node could claim any amount
// and no predicate contradicted it. `grep` found no fee arithmetic anywhere in
// `packages/*/src` before this.
//
// 22A leaves nothing to taste: 5.00% of the gross since Bitcoin Arena (§0A.8BLWP's was 2%), two halves
// to two seven-slot pools when no guardian is named (three equal thirds when one is), unearned shares redistributed
// inside the same pool "keeping the total", and remainders floored in millisatoshi and handed out in ascending
// H(round_id || node_pubkey). Every figure below is computed from the rule (FEE, HALF), not written down.
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
// THE RULE (§22A, §0A.8): the fee is NODE_FEE_BPS of the gross, floored; with no guardian, game/verify takes half of it
// (floored) and settlement the rest
const FEE = (gross) => (gross * BigInt(NODE_FEE_BPS)) / 10000n;
const HALF = (fee) => fee / 2n;
const GROSS = 400000n;                                     // the four activated stakes of 100000 below

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
  assert.equal(feeOwed(t, both, 'verify'), HALF(FEE(GROSS)));
  assert.equal(feeOwed(t, both, 'settlement'), FEE(GROSS) - HALF(FEE(GROSS)));
  assert.equal(feeOwed(t, both, 'relay'), 0n);
  assert.equal(paid(t), FEE(GROSS), 'both shares, and the fee is still the whole fee');
});

test('the rates are 22A\'s and are not a taste', () => {
  assert.equal(NODE_FEE_BPS, 500, '5.00% of gross_round_volume (§0A.8)');
  assert.equal(POOL_BPS, 250, '2.50% to each pool when the round names no guardian (two halves)');
  assert.deepEqual(POOLS, [GAME_VERIFY, SETTLEMENT, GUARDIAN, 'gateway', 'liquidity'], 'the gateway seats\' pool (2026.0.15) and the liquidity providers\' (2026.0.16) appended');
});

// THE GUARDIAN POOL (§22A v4.6.4, RULED 2026-09-21 / 2026-10-01 15:44): 2/3 % each to game/verify, settlement and the
// guardians of the round's federation - and a node in all three pools is owed the same total as under two.
test('with guardians named the fee splits in three equal thirds, and the leftover msats take turns', () => {
  const nodes = [new Uint8Array(32).fill(1), new Uint8Array(32).fill(2)];
  const t = nodeFeeTable({ contract, entries, pools: { gameVerify: nodes, settlement: nodes, guardian: nodes },
    eligible: new Set(nodes.map((k) => Buffer.from(k).toString('hex'))) });
  const fee = FEE(GROSS), third = fee / 3n;
  assert.equal(t.fee, fee);
  assert.deepEqual(t.pools, { gameVerify: third, settlement: third, guardian: fee - 2n * third });
  const per = new Map();
  for (const [k, v] of t.signerNodes) { const key = k.split(':')[1]; per.set(key, (per.get(key) || 0n) + v); }
  assert.deepEqual([...per.values()].sort(), [HALF(fee), fee - HALF(fee)], 'each node the same total as under two pools');
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

test('the fee is five percent and the two pools are exactly it', () => {
  const t = table();
  assert.equal(t.gross, GROSS);
  assert.equal(t.fee, FEE(GROSS), '5% of 400000');
  assert.equal(t.pools[GAME_VERIFY], HALF(FEE(GROSS)));
  assert.equal(t.pools[SETTLEMENT], FEE(GROSS) - HALF(FEE(GROSS)));
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
    assert.equal(t.fee, FEE(t.gross), `the fee is not the rule's at ${stake}`);
    assert.equal(paid(t) + t.unallocated, t.fee, `the table leaked at ${stake}`);
    for (const v of t.signerNodes.values()) assert.ok(v >= 0n);
  }
});

/**
 * AND THE OPERATOR TAKES NOTHING. The fee is the rule's share of gross and not a
 * millisatoshi more, whoever is eligible - "keeping the total".
 */
test('an unearned share stays in its own pool and never reaches the operator', () => {
  const one = new Set([toHex(game[0]), ...settle.map(toHex)]);
  const t = table({ eligible: one });

  assert.equal(feeOwed(t, game[0], 'verify'), HALF(FEE(GROSS)), 'the whole game/verify pool, and no more');
  for (const k of game.slice(1)) assert.equal(feeOwed(t, k, 'verify'), 0n);
  assert.equal(t.fee, FEE(GROSS), 'the fee did not grow because six signer nodes were idle');
  assert.equal(paid(t) + t.unallocated, FEE(GROSS));
  assert.equal(t.unallocated, 0n, 'and nothing fell out of the pools');

  // an unearned share does not cross into the OTHER pool either
  const settleShare = settle.reduce((sum, k) => sum + feeOwed(t, k, 'settlement'), 0n);
  assert.equal(settleShare, FEE(GROSS) - HALF(FEE(GROSS)), 'the settlement pool is still exactly its half');
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

  assert.equal(t.unallocated, HALF(FEE(GROSS)), 'the idle pool went somewhere');
  for (const k of game) assert.equal(feeOwed(t, k, 'verify'), 0n);
  assert.equal(paid(t), FEE(GROSS) - HALF(FEE(GROSS)));
  assert.equal(paid(t) + t.unallocated, t.fee);

  const nobodyAtAll = table({ eligible: new Set() });
  assert.equal(nobodyAtAll.unallocated, FEE(GROSS));
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

  // half of the fee on 500001 (5%: 25000) is 12500 msat over seven signer nodes: 1785 each and five over
  const pool = HALF(FEE(500001n)), each = pool / 7n, over = Number(pool - each * 7n);
  assert.equal(t.pools[GAME_VERIFY], pool);
  assert.ok(over > 0 && over < 7, 'this pool must not divide by seven, or it measures nothing');
  const shares = game.map((k) => feeOwed(t, k, 'verify'));
  assert.equal(shares.reduce((a, b) => a + b, 0n), pool);
  assert.equal(shares.filter((v) => v === each + 1n).length, over, `${over} signer nodes round up`);
  assert.equal(shares.filter((v) => v === each).length, 7 - over);

  // and they are the first in the round's own remainder order
  const order = remainderOrder(roundId(contract), game.map((pubkey) => ({ pubkey })));
  for (let i = 0; i < 7; i++)
    assert.equal(feeOwed(t, order[i].pubkey, 'verify'), i < over ? each + 1n : each,
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
// stake and 5% of it (§0A.8; 2% under BLWP) is what the player was charged beside it.
//
// 22A's Collection section describes the opposite - a 100 sat commitment
// giving a 96 sat net stake - and contradicts both 18 and 22A's own worked
// example: 61 x 100 sat gross is a 122 sat fee, exactly what 61 players paying
// 2 sat each hand over, while the net reading gives 117.12 sat and no whole
// satoshi. Collection's 96 is the error and is not implemented.

test('a fee is five percent of that entry\'s own stake, on top of it', () => {
  assert.equal(entryFeeMsat(100000n), FEE(100000n));
  assert.equal(entryFeeMsat(0n), 0n, 'a stake of nothing owes nothing');

  // 22A's worked example, in millisatoshi: 61 players at 100 sat - the entries' fees are the table's fee on their gross
  const perPlayer = entryFeeMsat(100000n);
  assert.equal(perPlayer * 61n, FEE(61n * 100000n), '305 sat at 5% (122 under BLWP\'s 2%)');

  for (const bad of [100000, '100000', undefined])
    assert.throws(() => entryFeeMsat(bad), /BigInt millisatoshi/);
  assert.throws(() => entryFeeMsat(-1n), /cannot be negative/);
});

test('an honest five percent stands and anything else does not', () => {
  const owed = FEE(100000n);
  const ok = feeMatchesEntry({ stakeMsat: 100000n, feeMsat: owed, donationMsat: 0n });
  assert.equal(ok.ok, true, ok.why);
  assert.equal(ok.owed, owed);

  const over = feeMatchesEntry({ stakeMsat: 100000n, feeMsat: owed + 1n, donationMsat: 0n });
  assert.equal(over.ok, false, 'one millisatoshi over stood');
  assert.equal(over.owed, owed);
  assert.match(over.why, /the 1 over is money no fee table allocates/);

  const under = feeMatchesEntry({ stakeMsat: 100000n, feeMsat: owed - 1n, donationMsat: 0n });
  assert.equal(under.ok, false, 'one millisatoshi under stood');

  const none = feeMatchesEntry({ stakeMsat: 100000n, feeMsat: 0n, donationMsat: 0n });
  assert.equal(none.ok, false, 'a positive stake with no fee stood');
  assert.equal(none.owed, owed);
});

/**
 * TOO MUCH IS THE DIRECTION THAT BECOMES INCOME. The fee table computes from
 * the stakes, so a millisatoshi over what 5% comes to is a millisatoshi the
 * table never allocates to anybody and that stays with whoever collected it.
 */
test('an over-charged fee is never allocated by the table', () => {
  const overcharged = { pubkey: b32(0xa1), outcome: 'DELIVERED', score: 500,
    stakeMsat: 100000n, feeMsat: 9999n };
  assert.equal(feeMatchesEntry(overcharged).ok, false);

  const t = nodeFeeTable({ contract, entries: [overcharged], pools, eligible: all });
  assert.equal(t.gross, 100000n, 'the base is the stake, and the fee rides beside it');
  assert.equal(t.fee, FEE(100000n), 'the table owes 5% of the stake, not what was charged');
  assert.equal(paid(t) + t.unallocated, FEE(100000n),
    `the ${9999n - FEE(100000n)} over is allocated to nobody, which is why the entry must not stand`);
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
 * Each entry pays `floor(5% of its own stake)`; the table owes
 * `floor(5% of the sum)`. Those are not the same number: seven stakes of
 * 33333 msat collect 11662 and the table owes 11666, and three of 19 collect
 * nothing at all while the table owes 2. The gap is at most one millisatoshi
 * per entry and is always in the same direction - collected <= owed - so it
 * can never become income, which is why it is recorded and not patched. 22A
 * defines the fee on the gross and says nothing about which rounding a
 * collector uses; picking one here would be inventing a rule.
 */
test('per-entry floors can collect less than the table owes, never more', () => {
  // each case's collected and owed from the rule: per-entry floors, and the floor of the sum
  const cases = [[2, 59n], [7, 33333n], [3, 19n], [61, 100000n]].map(([n, stake]) => [n, stake, entryFeeMsat(stake) * BigInt(n), FEE(stake * BigInt(n))]);
  assert.ok(cases.some(([, , collected, owed]) => collected < owed), 'no case where the floors collect less: this measures nothing');
  assert.deepEqual(cases.find(([n]) => n === 7).slice(2), [11662n, 11666n]);
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

// THE DRAIN IS PAID (§23A.6 step 5): a round naming a successor lists, beside the successor's guardians, the
// draining predecessor's seated ones - "one share per seat across both federations, so a guardian seated in both earns two
// shares, and a guardian seated only in the old one still earns one"
test('a guardian seated in the successor and in its draining predecessor is listed twice and earns two guardian shares', () => {
  const g = [1, 2, 3].map((n) => new Uint8Array(32).fill(0x60 + n));
  const old = new Uint8Array(32).fill(0x70);                     // seated only in the predecessor
  const pool = [g[0], g[1], g[2], g[0], g[1], old];             // successor's three, then the predecessor's seated: g0, g1, old
  const all = [...g, old];
  const t = nodeFeeTable({ contract, entries, pools: { gameVerify: g, settlement: g, guardian: pool },
    eligible: new Set(all.map((k) => Buffer.from(k).toString('hex'))) });
  const guardianPool = t.pools.guardian, each = guardianPool / 6n;
  const owed = (k) => t.signerNodes.get(`guardian:${toHex(k)}`) || 0n;   // the guardian pool's row (feeOwed reads the two role pools)
  assert.ok(owed(g[0]) >= 2n * each && owed(g[0]) <= 2n * each + 2n, 'seated in both: two shares');
  assert.ok(owed(g[2]) >= each && owed(g[2]) <= each + 1n, 'seated in the successor only: one');
  assert.ok(owed(old) >= each && owed(old) <= each + 1n, 'seated in the predecessor only: one');
  assert.equal(all.reduce((s, k) => s + owed(k), 0n), guardianPool, 'the whole guardian pool, nothing more');
});

test('2026.0.15 (§23A.9): a third of the guardian pool goes to the gateway seats; earlier rounds and rounds with no gateway as before', () => {
  const g = [b32(0x51), b32(0x52), b32(0x53)], gw = [b32(0x52), b32(0x61)];   // one gateway is also a guardian, as every seat is
  const elig = new Set([...game, ...settle, ...g, ...gw].map(toHex));
  const t15 = nodeFeeTable({ contract: { ...contract, protocolVersion: 15 }, entries, pools: { ...pools, guardian: g, gateway: gw }, eligible: elig });
  const fee = t15.fee, third = fee / 3n, guardianPool = fee - 2n * third, gwPool = guardianPool / 3n;
  assert.deepEqual(t15.pools, { gameVerify: third, settlement: third, guardian: guardianPool - gwPool, gateway: gwPool });
  const sum = (pool) => [...t15.signerNodes].filter(([k]) => k.startsWith(`${pool}:`)).reduce((a, [, v]) => a + v, 0n);
  assert.equal(sum('gateway'), gwPool);
  assert.equal(sum('guardian'), guardianPool - gwPool);
  assert.equal([...t15.signerNodes.keys()].filter((k) => k.startsWith('gateway:')).length, 2, 'both seats paid');
  const t13 = nodeFeeTable({ contract: { ...contract, protocolVersion: 13 }, entries, pools: { ...pools, guardian: g, gateway: gw }, eligible: elig });
  assert.deepEqual(t13.pools, { gameVerify: third, settlement: third, guardian: guardianPool }, 'a 2026.0.13 round pays no gateway');
  const none = nodeFeeTable({ contract: { ...contract, protocolVersion: 15 }, entries, pools: { ...pools, guardian: g, gateway: [b32(0x61)] }, eligible: new Set([...game, ...settle, ...g].map(toHex)) });
  assert.deepEqual(none.pools, { gameVerify: third, settlement: third, guardian: guardianPool }, 'no eligible gateway: the guardians keep it');
  assert.equal(POOLS.indexOf('gateway'), 3, 'appended: the fee table ids of every earlier table are as they were');
});

test('2026.0.16 (§23A.10): four quarters - game/verify, settlement, custody, liquidity; no provider: its quarter is custody\'s', () => {
  const g = [b32(0x51), b32(0x52), b32(0x53)], gw = [b32(0x52), b32(0x61)], lp = [b32(0x71), b32(0x72)];
  const elig = new Set([...game, ...settle, ...g, ...gw, ...lp].map(toHex));
  const t = nodeFeeTable({ contract: { ...contract, protocolVersion: 16 }, entries, pools: { ...pools, guardian: g, gateway: gw, liquidity: lp }, eligible: elig });
  const fee = t.fee, q = fee / 4n, custody = fee - 3n * q, gwPool = custody / 3n;
  // the custody quarter keeps the floors' leftover, then a third of it is the gateway seats' (§23A.9)
  assert.deepEqual(t.pools, { gameVerify: q, settlement: q, guardian: custody - gwPool, gateway: gwPool, liquidity: q });
  const sum = (pool) => [...t.signerNodes].filter(([k]) => k.startsWith(`${pool}:`)).reduce((a, [, v]) => a + v, 0n);
  assert.equal(sum('liquidity'), q);
  assert.equal([...t.signerNodes.keys()].filter((k) => k.startsWith('liquidity:')).length, 2, 'both providers paid');
  assert.equal(sum('gameVerify') + sum('settlement') + sum('guardian') + sum('gateway') + sum('liquidity'), fee, 'nothing lost');
  const none = nodeFeeTable({ contract: { ...contract, protocolVersion: 16 }, entries, pools: { ...pools, guardian: g, liquidity: [b32(0x79)] }, eligible: new Set([...game, ...settle, ...g].map(toHex)) });
  assert.deepEqual(none.pools, { gameVerify: q, settlement: q, guardian: fee - 2n * q }, 'no eligible provider: custody keeps the liquidity quarter');
  const t15 = nodeFeeTable({ contract: { ...contract, protocolVersion: 15 }, entries, pools: { ...pools, guardian: g, liquidity: lp }, eligible: elig });
  assert.equal(t15.pools.liquidity, undefined, 'a 2026.0.15 round pays no provider (thirds, as before)');
  assert.equal(POOLS.indexOf('liquidity'), 4, 'appended');
});

test('2026.0.16: with more than one provider the liquidity quarter follows available balance (floored to 10,000 sat)', () => {
  const g = [b32(0x51)], lp = [b32(0x71), b32(0x72), b32(0x73)];
  const elig = new Set([...game, ...settle, ...g, ...lp].map(toHex));
  const weights = { liquidity: new Map([[toHex(lp[0]), 300_000n], [toHex(lp[1]), 109_999n], [toHex(lp[2]), 0n]]) };
  const t = nodeFeeTable({ contract: { ...contract, protocolVersion: 16 }, entries, pools: { ...pools, guardian: g, liquidity: lp }, eligible: elig, weights });
  const q = t.pools.liquidity;
  const share = (k) => t.signerNodes.get(`liquidity:${toHex(k)}`) || 0n;
  const w0 = 300_000n, w1 = 100_000n;   // 109,999 floors to 100,000; a provider with 0 available earns 0
  assert.equal(share(lp[2]), 0n);
  assert.ok(share(lp[0]) - (q * w0) / (w0 + w1) <= 1n && share(lp[1]) - (q * w1) / (w0 + w1) <= 1n, 'proportional, the leftover msat in the round\'s order');
  assert.equal(share(lp[0]) + share(lp[1]), q, 'the whole quarter, nothing lost');
  const even = nodeFeeTable({ contract: { ...contract, protocolVersion: 16 }, entries, pools: { ...pools, guardian: g, liquidity: lp }, eligible: elig });
  assert.ok([...lp].every((k) => even.signerNodes.get(`liquidity:${toHex(k)}`) >= q / 3n), 'no weights: evenly');
});

// kanban #559/#543 (spec §23A.3a part 1): from 2026.0.20, under pressure, the guardians' part split by (min(bond, B*))^2
test('2026.0.20: the guardians\' part follows the pressure weights; 2026.0.19 and no weights: evenly', () => {
  const g = [b32(0x51), b32(0x52), b32(0x53)];
  const elig = new Set([...game, ...settle, ...g].map(toHex));
  const weights = { guardian: new Map([[toHex(g[0]), 86_667n * 86_667n], [toHex(g[1]), 50_000n * 50_000n], [toHex(g[2]), 50_000n * 50_000n]]) };
  const share = (t, k) => t.signerNodes.get(`guardian:${toHex(k)}`) || 0n;
  const t20 = nodeFeeTable({ contract: { ...contract, protocolVersion: 20 }, entries, pools: { ...pools, guardian: g }, eligible: elig, weights });
  const part = g.reduce((a, k) => a + share(t20, k), 0n);
  const w0 = 86_667n * 86_667n, w1 = 50_000n * 50_000n, tot = w0 + 2n * w1;
  assert.ok(share(t20, g[0]) - (part * w0) / tot <= 1n, 'the guardian at B* takes its weight\'s part');
  assert.ok(share(t20, g[0]) > 2n * share(t20, g[1]), 'about 3 times each other one (1 against 0.333)');
  const t19 = nodeFeeTable({ contract: { ...contract, protocolVersion: 19 }, entries, pools: { ...pools, guardian: g }, eligible: elig, weights });
  assert.ok(share(t19, g[0]) - share(t19, g[1]) <= 1n, 'protocol 19: the same weights are not read - evenly');
  const t20even = nodeFeeTable({ contract: { ...contract, protocolVersion: 20 }, entries, pools: { ...pools, guardian: g }, eligible: elig });
  assert.ok(share(t20even, g[0]) - share(t20even, g[2]) <= 1n, 'protocol 20 while CALM (no weights): evenly');
});

// kanban #559/#543 (spec §23A.3a part 2): the gateways' part follows the proved peg-ins on 2026.0.20, evenly before
test('2026.0.20: under peg-in pressure the gateways\' part follows weights.gateway; 2026.0.19 and no weights: evenly', () => {
  const g = [b32(0x51), b32(0x52), b32(0x53)], gw = [b32(0x52), b32(0x61)];
  const elig = new Set([...game, ...settle, ...g, ...gw].map(toHex));
  const at = (v, weights) => nodeFeeTable({ contract: { ...contract, protocolVersion: v }, entries, pools: { ...pools, guardian: g, gateway: gw }, eligible: elig, weights });
  const owed = (t, k) => t.signerNodes.get(`gateway:${toHex(k)}`) || 0n;
  const w = { gateway: new Map([[toHex(gw[0]), 100n * 100n], [toHex(gw[1]), 50n * 50n]]) };   // one at P*, one at half of it
  const t20 = at(20, w), part = t20.pools.gateway;
  assert.ok(Math.abs(Number((owed(t20, gw[0]) * 1000n) / part) - 800) <= 1, 'the one at P* takes 80 % of the gateways\' part');
  assert.equal(owed(t20, gw[0]) + owed(t20, gw[1]), part, 'the whole part, nothing more');
  const t19 = at(19, w);
  assert.ok(owed(t19, gw[0]) - owed(t19, gw[1]) <= 1n && owed(t19, gw[1]) - owed(t19, gw[0]) <= 1n, '2026.0.19: evenly');
  const plain = at(20, null);
  assert.ok(owed(plain, gw[0]) - owed(plain, gw[1]) <= 1n && owed(plain, gw[1]) - owed(plain, gw[0]) <= 1n, 'no weights (CALM): evenly');
});

// kanban #559 P3 (spec §23A.9): "An empty or unearned gateway share goes to the other gateway seat. With no gateway seated, it goes
// to the guardians." The signed seating names only the paid seats (server.js: a seat held below the minimums is left out), so an
// empty seat is a missing key, and an unearned one a key the round does not count eligible. Pinned on ragged volumes, where every
// floor leaves a remainder: the pools always sum to the fee, nothing unallocated.
test('§23A.9 P3: one gateway seat takes the whole gateway third; an unearned seat\'s goes to the other; none seated - the guardians\'', () => {
  const g = [b32(0x51), b32(0x52), b32(0x53)], a = b32(0x51), b = b32(0x52);   // both seats guardians, as every seat is
  // three stakes that leave a remainder at every floor: the fee, its thirds, the gateway third, the gateway seats' halves
  const ragged = [player(0xa1, 'DELIVERED', 100003n), player(0xa2, 'FAILED', 123457n), player(0xa3, 'FAILED', 98761n)];
  const sum = (t, pool) => [...t.signerNodes].filter(([k]) => k.startsWith(`${pool}:`)).reduce((s, [, v]) => s + v, 0n);
  const owed = (t, pool, k) => t.signerNodes.get(`${pool}:${toHex(k)}`) || 0n;
  for (const v of [15, 16, 20]) {
    const at = (gateway, elig = [...game, ...settle, ...g]) => nodeFeeTable({ contract: { ...contract, protocolVersion: v }, entries: ragged,
      pools: { ...pools, guardian: g, gateway }, eligible: new Set(elig.map(toHex)) });
    const both = at([a, b]);
    const custody = both.pools.guardian + both.pools.gateway, gwPool = custody / 3n;
    assert.ok(custody % 3n !== 0n || gwPool % 2n !== 0n || both.fee % 3n !== 0n, 'the volumes leave a remainder somewhere');
    assert.equal(both.pools.gateway, gwPool, `v${v}: a third of the custody pool, floored`);
    assert.ok(owed(both, GUARDIAN, a) > 0n && owed(both, 'gateway', a) > 0n && owed(both, 'gateway', b) > 0n);
    const d = owed(both, 'gateway', a) - owed(both, 'gateway', b);
    assert.ok(d >= -1n && d <= 1n, `v${v}: two seats share it evenly, the odd msat to one`);

    // ONE SEAT EMPTY: the seating names a only
    const one = at([a]);
    assert.equal(owed(one, 'gateway', a), gwPool, `v${v}: the one seated gateway takes the whole gateway third`);
    assert.equal(one.signerNodes.has(`gateway:${toHex(b)}`), false);
    assert.equal(one.pools.guardian, custody - gwPool, `v${v}: the guardians keep only their two thirds`);

    // ONE SEAT UNEARNED: seated, but not counted eligible in the round (a conflicted or dropped seat) - its share is the other's
    const unearned = at([a, b], [...game, ...settle, g[0], g[2]]);
    assert.equal(owed(unearned, 'gateway', a), gwPool, `v${v}: an unearned seat's share goes to the other seat`);
    assert.equal(owed(unearned, 'gateway', b), 0n);
    assert.equal(unearned.pools.gateway, gwPool);

    // NO GATEWAY SEATED, or both unearned: the whole custody pool is the guardians'
    for (const [why, t] of [['no seating', at([])], ['both seats unearned', at([b32(0x61), b32(0x62)])]]) {
      assert.equal(t.pools.gateway, undefined, `v${v} ${why}: no gateway pool`);
      assert.equal(t.pools.guardian, custody, `v${v} ${why}: the guardians keep the whole custody pool`);
      assert.equal(sum(t, GUARDIAN), custody);
      assert.equal(t.unallocated, 0n, `v${v} ${why}: nothing unallocated`);
    }

    // NO MSAT LOST: every table's shares are the fee, each pool's shares are its pool
    for (const t of [both, one, unearned]) {
      assert.equal(t.unallocated, 0n);
      assert.equal(paid(t), t.fee, `v${v}: the shares are the whole fee`);
      for (const pool of [GAME_VERIFY, SETTLEMENT, GUARDIAN, 'gateway']) assert.equal(sum(t, pool), t.pools[pool], `v${v}: ${pool} paid exactly`);
    }
  }
});

// kanban #559: P3 WITH NO ELIGIBLE GUARDIAN. fee.js splits the gateway third off the guardian pool, and with no guardian named or
// eligible there is no guardian pool: the round keeps the two-pool table (two halves of the fee, the odd msat to settlement), and a
// seated gateway is paid nothing from the fee - on every version that has gateway seats. §23A.9 does not name this case (every seat
// is a guardian, so it arises only when the round's guardian list misses the seat holders); this pins what the code does.
test('§23A.9 P3: with no eligible guardian the round keeps the two-pool table and the gateway seats get nothing', () => {
  const a = b32(0x51), b = b32(0x52);
  const ragged = [player(0xa1, 'DELIVERED', 100003n), player(0xa2, 'FAILED', 123457n), player(0xa3, 'FAILED', 98761n)];
  for (const v of [15, 16, 20]) {
    for (const [why, guardian] of [['no guardian named', []], ['guardians named, none eligible', [b32(0x53), b32(0x54)]]]) {
      const t = nodeFeeTable({ contract: { ...contract, protocolVersion: v }, entries: ragged,
        pools: { ...pools, guardian, gateway: [a, b], liquidity: [b32(0x71)] }, eligible: new Set([...game, ...settle, a, b, b32(0x71)].map(toHex)) });
      const half = t.fee / 2n;
      assert.ok(t.fee % 2n === 1n, 'the volume leaves an odd msat');
      assert.deepEqual(t.pools, { [GAME_VERIFY]: half, [SETTLEMENT]: t.fee - half, [GUARDIAN]: 0n }, `v${v} ${why}: the two-pool table`);
      assert.equal([...t.signerNodes.keys()].filter((k) => !k.startsWith(`${GAME_VERIFY}:`) && !k.startsWith(`${SETTLEMENT}:`)).length, 0,
        `v${v} ${why}: no gateway, guardian or liquidity share`);
      assert.equal(t.unallocated, 0n, `v${v} ${why}: nothing unallocated`);
      assert.equal(paid(t), t.fee, `v${v} ${why}: the committees take the whole fee`);
    }
  }
});
