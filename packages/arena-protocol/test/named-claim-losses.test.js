// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE NAMED CLAIM'S ROWS (a) AND (b) GET #976's LOSS RULE (RULED 2026-11-06, kanban #1146 B). Before, slash.js OFFENCES named neither, so a started slash
// of either could never release or fall back (measured 2026-11-05 on s28a and 2026-11-06 on s29b: five bonds started at 598 and held for good).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OFFENCES, affectedEntries, namedClaimLosses, slashDistribution, OFF_TABLE_CLAIM, FORFEIT_OF_LOST_ENTRY } from '../src/slash.js';
import { OFF_TABLE_CLAIM as ROW_A, FORFEIT_OF_LOST_ENTRY as ROW_B } from '../src/named-claim-offence.js';
import { DELIVERED, FAILED, computePayoutTable, withGoneStakes, netStakeMsat } from '../src/payout.js';
import { leftTheRound } from '../src/named-claim-payees.js';
import { refundKeyOf } from '../src/stake-lock.js';
import { toHex } from '../src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const RID = b32(0x62);
const STAKE = 100000n;
const contract = { slashRemainder: 'SPLIT', minScore: 1 };
const entry = (n, outcome, score) => ({ entryId: toHex(b32(0x10 + n)), playerPubkey: b32(0x20 + n), pubkey: b32(0x20 + n), stakeMsat: STAKE, feeMsat: 0n, donationMsat: 0n,
  netStakeMsat: STAKE, activated: true, ...(outcome ? { outcome, score } : {}) });
const W = entry(1, DELIVERED, 9), W2 = entry(4, DELIVERED, 5), L1 = entry(2, FAILED, 0), L2 = entry(3, FAILED, 0);
const key = (e) => toHex(e.playerPubkey);

test('both named rows are offences with a loss rule, under the words named-claim-offence.js files them by', () => {
  assert.ok(OFFENCES.includes(OFF_TABLE_CLAIM) && OFFENCES.includes(FORFEIT_OF_LOST_ENTRY));
  assert.equal(ROW_A, OFF_TABLE_CLAIM);
  assert.equal(ROW_B, FORFEIT_OF_LOST_ENTRY);
  assert.equal(affectedEntries({ offence: FORFEIT_OF_LOST_ENTRY, playerPubkey: L1.playerPubkey, entries: [W, L1, L2] }).ok, true);
});

test('F′ is F with the gone stake read as refunded: one loser forfeited, the winner is paid the other\'s stake only', () => {
  const f = computePayoutTable({ roundId: RID, entries: [W, L1, L2], minScore: 1 });
  const fp = computePayoutTable({ roundId: RID, entries: withGoneStakes([W, L1, L2], new Set([key(L1)])), minScore: 1 });
  const pay = (t, e) => t.table[t.activated.findIndex((x) => key(x) === key(e))].amountMsat;
  assert.equal(pay(f, W), 3n * STAKE);
  assert.equal(pay(fp, W), 2n * STAKE);
  assert.equal(fp.activated.some((x) => key(x) === key(L1)), false);
});

test('(b) level 1: every other entry\'s loss is F - F′, the forfeited entry gets nothing', () => {
  const held = { offence: FORFEIT_OF_LOST_ENTRY, playerPubkey: L1.playerPubkey };
  const got = namedClaimLosses({ held, entries: [W, L1, L2], roundId: RID, minScore: 1 });
  assert.equal(got.ok, true, got.why);
  assert.equal(got.level, 1);
  assert.deepEqual([...got.losses], [[key(W), STAKE]]);
  // the s29b shape: one winner, one loser, the loser's stake forfeited - F′ pays the winner its own stake, F both
  const two = namedClaimLosses({ held, entries: [W, L1], roundId: RID, minScore: 1 });
  assert.deepEqual([...two.losses], [[key(W), STAKE]]);
});

test('(b) at the cap with the round unsettled: each lock counts as gone back to its player, so the winner\'s loss is all of F above its stake', () => {
  const held = { offence: FORFEIT_OF_LOST_ENTRY, playerPubkey: L1.playerPubkey };
  const got = namedClaimLosses({ held, entries: [W, L1, L2], roundId: RID, minScore: 1, settled: false });
  assert.deepEqual([...got.losses], [[key(W), 2n * STAKE]]);
});

test('(b) level 2: an entry not settled - the forfeited stake to the proved qualifiers pro rata by their F′ payouts; none proved, no loss', () => {
  const held = { offence: FORFEIT_OF_LOST_ENTRY, playerPubkey: L1.playerPubkey };
  const open = entry(5, null, null);
  const got = namedClaimLosses({ held, entries: [W, W2, L1, open], roundId: RID, minScore: 1 });
  assert.equal(got.level, 2);
  const total = [...got.losses.values()].reduce((a, b) => a + b, 0n);
  assert.equal(total, netStakeMsat(L1), 'the forfeited stake, to the msat');
  assert.ok(got.losses.get(key(W)) > 0n);
  const none = namedClaimLosses({ held, entries: [L1, L2, open], roundId: RID, minScore: 1 });
  assert.equal(none.losses.size, 0);
});

const spendOf = (e, { stake = true, outputs = [] } = {}) => ({ kind: 'claim', txid: 'aa'.repeat(32), outpoint: `${toHex(b32(0x40 + e.playerPubkey[0]))}:0`, agg_key: 'bb'.repeat(32),
  lock: { refund_pk: toHex(refundKeyOf(e.playerPubkey)), amount_msat: String(STAKE), round_id: toHex(RID), ...(stake ? {} : { payment_image: { hash: '00' } }) }, outputs });

test('(a) level 1: a claim that took the winner\'s lock and paid a thief - the winner\'s loss is all F owed it; a claimed loser lost nothing', () => {
  const thief = '02' + 'ee'.repeat(32);
  const outputs = [{ out_idx: 0, kind: 'outgoing', refund_pk: thief, claim_pk: thief, amount_msat: String(3n * STAKE) }];
  const spends = [spendOf(W, { outputs }), spendOf(L1, { outputs }), spendOf(L2, { outputs })];
  const held = { offence: OFF_TABLE_CLAIM, spends, truth: [W, L1, L2].map((e) => ({ pubkey: e.playerPubkey, outcome: e.outcome, score: e.score })) };
  const got = namedClaimLosses({ held, entries: [W, L1, L2], roundId: RID, minScore: 1 });
  assert.equal(got.level, 1);
  assert.deepEqual([...got.losses], [[key(W), 3n * STAKE]]);
  // a claim of the losers' locks only, paying the winner half: the winner's lock was not claimed, so it is not affected (the ruling's set)
  const half = [{ out_idx: 0, kind: 'outgoing', refund_pk: toHex(refundKeyOf(W.playerPubkey)), claim_pk: toHex(refundKeyOf(W.playerPubkey)), amount_msat: String(STAKE) }];
  const only = namedClaimLosses({ held: { ...held, spends: [spendOf(L1, { outputs: half }), spendOf(L2, { outputs: half })] }, entries: [W, L1, L2], roundId: RID, minScore: 1 });
  assert.equal(only.losses.size, 0);
});

test('(a) level 2: what left the round, owed to the entries whose locks were claimed, pro rata by what was claimed of each', () => {
  const thief = '02' + 'ee'.repeat(32);
  const outputs = [{ out_idx: 0, kind: 'outgoing', refund_pk: thief, claim_pk: thief, amount_msat: '90001' },
    { out_idx: 1, kind: 'outgoing', refund_pk: toHex(refundKeyOf(W.playerPubkey)), claim_pk: toHex(refundKeyOf(W.playerPubkey)), amount_msat: String(STAKE * 2n - 90001n) }];
  const spends = [spendOf(L1, { outputs }), spendOf(L2, { outputs })];
  const left = leftTheRound({ spends, entryKeys: new Set([W, L1, L2].map((e) => toHex(refundKeyOf(e.playerPubkey)))), payees: { nodeKeys: [], donationKeys: [], reserveKeys: [] } });
  assert.equal(left.msat, 90001n);
  const got = namedClaimLosses({ held: { offence: OFF_TABLE_CLAIM, spends, leftMsat: left.msat }, entries: [W, L1, L2], roundId: RID, minScore: 1 });
  assert.equal(got.level, 2);
  assert.equal([...got.losses.values()].reduce((a, b) => a + b, 0n), 90001n);
  assert.deepEqual([...got.losses.keys()].sort(), [key(L1), key(L2)].sort());
});

test('five whole bonds in ascending node key: the first pays each loss, the next only what is still owed, every rest to the reserves', () => {
  const losses = new Map([[key(W), STAKE * 1000n]]);   // 100,000 sat owed
  const bonds = [60000n, 60000n, 60000n, 60000n, 60000n];
  const paid = new Map();
  const out = bonds.map((sats) => {
    const d = slashDistribution({ escrowSats: sats, roundId: RID, contract, losses, paid });
    for (const [k, v] of d.players) paid.set(k, (paid.get(k) || 0n) + v);
    return d;
  });
  assert.equal(out[0].playersMsat, 60000000n);
  assert.equal(out[1].playersMsat, 40000000n);
  assert.equal(out[1].reservesMsat, 20000000n);
  for (const d of out.slice(2)) { assert.equal(d.playersMsat, 0n); assert.equal(d.reservesMsat, 60000000n); }
});
