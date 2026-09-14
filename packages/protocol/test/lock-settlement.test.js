// W4: A LOSER'S STAKE LOCK IS CLAIMED INTO THE ROUND'S ONE SETTLEMENT, AND THE
// QUALIFIERS ARE PAID FROM IT (the owner 2026-09-14 07:22; FEDERATION.md step 5).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { lockSettlement, lnv2FeeMsat, largestPayoutMsat, settlementNonce } from '../src/lock-settlement.js';
import { DELIVERED, FAILED, FORFEIT, VOID } from '../src/payout.js';
import { toHex } from '../src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const pk = (n) => { const k = new Uint8Array(32); k[0] = n; k[31] = n; return k; };
const refund = (n) => { const k = new Uint8Array(33); k[0] = 0x02; k[1] = n; k[32] = n; return k; };
const RID = b32(0x5f);
const NO_FEES = { ppm: 0n, baseMsat: 0n };

/** An entry at 100 sat, 2% fee, and the given donation. */
const entry = (n, outcome, score, donationMsat = 0n) => ({ pubkey: pk(n), stakeMsat: 100000n, feeMsat: 2000n, donationMsat, outcome, score });
const lockFor = (e, n, amountMsat = 100000n - 2000n - e.donationMsat) =>
  [toHex(e.pubkey), { outpoint: { txid: b32(0x40 + n), outIdx: BigInt(n) }, amountMsat, refundPk: refund(n) }];

test('round 5\'s outcomes on locks: the 0% loser\'s 98000 msat is claimed, the 0% winner is paid 98000 from it, the 2% winner is owed nothing on top', () => {
  const D2 = entry(1, DELIVERED, 1, 2000n);
  const Z0 = entry(2, DELIVERED, 3);
  const PAGE = entry(3, FAILED, 0);
  const locks = new Map([lockFor(D2, 1), lockFor(Z0, 2), lockFor(PAGE, 3)]);
  const s = lockSettlement({ roundId: RID, entries: [D2, Z0, PAGE], minScore: 1, locks, fees: NO_FEES });
  assert.equal(s.ok, true, s.why);
  assert.deepEqual(s.claims.map((c) => [toHex(c.pubkey), c.amountMsat]), [[toHex(PAGE.pubkey), 98000n]]);
  assert.deepEqual(s.payouts.map((p) => [toHex(p.payoutPk), p.owedMsat, p.msat]), [[toHex(refund(2)), 98000n, 98000n]]);
  assert.deepEqual(s.forfeits.map(toHex).sort(), [toHex(D2.pubkey), toHex(Z0.pubkey)].sort(), 'both winners\' own locks are forfeited back');
  assert.deepEqual([s.poolMsat, s.paidMsat, s.unspentMsat], [98000n, 98000n, 0n]);
});

test('the guardians\' fees come out of the pool: 0.1% on the claimed lock and on the payout, to the millisatoshi', () => {
  const fees = { ppm: 1000n, baseMsat: 0n };
  assert.equal(lnv2FeeMsat(fees, 98000n), 98n);
  assert.equal(largestPayoutMsat(fees, 97902n), 97805n, '97805 + 97 = 97902, and 97806 + 97 is one too many');
  const W = entry(1, DELIVERED, 3);
  const L = entry(2, FAILED, 0);
  const s = lockSettlement({ roundId: RID, entries: [W, L], minScore: 1, locks: new Map([lockFor(W, 1), lockFor(L, 2)]), fees });
  assert.equal(s.ok, true, s.why);
  assert.deepEqual([s.poolMsat, s.inputFeesMsat, s.spendableMsat], [98000n, 98n, 97902n]);
  assert.deepEqual(s.payouts.map((p) => [p.owedMsat, p.msat, p.feeMsat]), [[98000n, 97805n, 97n]]);
  assert.equal(s.unspentMsat, 0n);
});

// TWO PAYING RANKS NEED FIVE QUALIFIERS: K = ceil(qualifiers / 4), and under 22A
// pick A one paying rank takes the whole pool - the others get their own stake
// back by the forfeit and nothing on top.
test('two paying ranks share the fees pro rata to what each is owed, and every millisatoshi of the pool is accounted for', () => {
  const fees = { ppm: 2500n, baseMsat: 7n };
  const qualifiers = [900, 800, 700, 600, 500].map((score, i) => entry(i + 1, DELIVERED, score));
  const losers = [6, 7, 8].map((n) => entry(n, FAILED, 0));
  const all = [...qualifiers, ...losers];
  const locks = new Map(all.map((e, i) => lockFor(e, i + 1)));
  const s = lockSettlement({ roundId: RID, entries: all, minScore: 1, locks, fees });
  assert.equal(s.ok, true, s.why);
  assert.equal(s.claims.length, 3);
  assert.equal(s.poolMsat, 3n * 98000n);
  assert.equal(s.payouts.length, 2, 'five qualifiers make two paying ranks');
  assert.equal(s.forfeits.length, 5, 'every qualifier\'s own lock is forfeited back');
  assert.equal(s.payouts.reduce((t, p) => t + p.owedMsat, 0n), s.poolMsat, 'the table hands out exactly the claimed pool');
  assert.equal(s.inputFeesMsat + s.paidMsat + s.outputFeesMsat + s.unspentMsat, s.poolMsat, 'a millisatoshi was created or lost');
  assert.ok(s.unspentMsat >= 0n && s.unspentMsat < 2n, `the floors left ${s.unspentMsat} msat`);
  const [a, b] = [...s.payouts].sort((x, y) => (x.owedMsat > y.owedMsat ? -1 : 1));
  assert.ok(a.msat > b.msat, 'the higher rank is not paid more');
  for (const p of s.payouts) assert.ok(p.msat + p.feeMsat <= (p.owedMsat * s.spendableMsat) / s.poolMsat, 'a payout took more than its part');
  console.log(`  two qualifiers: pool ${s.poolMsat}, input fees ${s.inputFeesMsat}, payouts ${s.payouts.map((p) => `${p.msat}+${p.feeMsat}`).join(', ')}, unspent ${s.unspentMsat}`);
});

test('a loser whose lock no seat verified, or whose lock holds another amount, is refused - nothing is claimed on a guess', () => {
  const W = entry(1, DELIVERED, 3);
  const L = entry(2, FAILED, 0);
  const missing = lockSettlement({ roundId: RID, entries: [W, L], minScore: 1, locks: new Map([lockFor(W, 1)]), fees: NO_FEES });
  assert.equal(missing.ok, false);
  assert.match(missing.why, /never verified/);
  const wrong = lockSettlement({ roundId: RID, entries: [W, L], minScore: 1, locks: new Map([lockFor(W, 1), lockFor(L, 2, 99000n)]), fees: NO_FEES });
  assert.equal(wrong.ok, false);
  assert.match(wrong.why, /holds 99000 msat and its entry's net stake is 98000/);
});

test('a VOID entry\'s lock is never claimed, and a FORFEIT loser\'s is', () => {
  const W = entry(1, DELIVERED, 3);
  const F = entry(2, FORFEIT, 0);
  const V = entry(3, VOID, 0);
  const s = lockSettlement({ roundId: RID, entries: [W, F, V], minScore: 1, locks: new Map([lockFor(W, 1), lockFor(F, 2), lockFor(V, 3)]), fees: NO_FEES });
  assert.equal(s.ok, true, s.why);
  assert.deepEqual(s.claims.map((c) => toHex(c.pubkey)), [toHex(F.pubkey)]);
  assert.deepEqual(s.payouts.map((p) => p.msat), [98000n]);
});

test('every seat rebuilds the same transaction: the order of the entries it was handed changes nothing, and the nonce is the round\'s', () => {
  const fees = { ppm: 1000n, baseMsat: 3n };
  const all = [entry(1, DELIVERED, 900), entry(2, DELIVERED, 50), entry(3, FAILED, 0), entry(4, FORFEIT, 0)];
  const locks = new Map(all.map((e, i) => lockFor(e, i + 1)));
  const one = lockSettlement({ roundId: RID, entries: all, minScore: 1, locks, fees });
  const two = lockSettlement({ roundId: RID, entries: [...all].reverse(), minScore: 1, locks, fees });
  const shape = (s) => JSON.stringify({ c: s.claims.map((c) => [toHex(c.outpoint.txid), String(c.outpoint.outIdx), String(c.amountMsat)]),
    p: s.payouts.map((p) => [toHex(p.payoutPk), String(p.msat)]), n: toHex(s.nonce) });
  assert.equal(shape(two), shape(one));
  assert.equal(settlementNonce(RID).length, 8);
  assert.equal(toHex(settlementNonce(RID)), toHex(settlementNonce(b32(0x5f))));
  assert.notEqual(toHex(settlementNonce(RID)), toHex(settlementNonce(b32(0x60))));
});

test('a round with losers and no qualifier: what the hold verdict decides, the lock settlement decides too', () => {
  const L1 = entry(1, FAILED, 0);
  const L2 = entry(2, FORFEIT, 0);
  const s = lockSettlement({ roundId: RID, entries: [L1, L2], minScore: 1, locks: new Map([lockFor(L1, 1), lockFor(L2, 2)]), fees: NO_FEES });
  // The hold path's verdict refuses this round ("the operator would keep ..."):
  // there is nobody to pay, so no hold is settled and each expires back. The lock
  // settlement refuses it the same way - nothing is claimed, each lock expires back
  // to its player. Whether a no-winner round's stakes should go anywhere else is
  // not decided here.
  console.log(`  no qualifier: ok ${s.ok}, why ${s.why || '-'}`);
  assert.equal(s.ok, false, 'a settlement with nobody to pay was built');
  assert.match(s.why, /operator would keep 196000 msat: a pool of 196000 against 0 handed out/);
});
