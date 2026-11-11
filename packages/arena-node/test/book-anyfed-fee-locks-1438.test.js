// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AN ORDER-BOOK ROUND THAT TAKES ANY FEDERATION PAYS OUT ITS FEE LOCKS (kanban #1438, money audit 8): bookLockSettlement pays
// every line - winners, websites, seats, donation, reserve - out of the stake and fee locks together, and splitByFederation
// split its plan by `signerNodePayouts`, which a book plan never named. Every payout was then drawn from the stake locks alone and
// each federation's fee locks were claimed with nothing paid from them: the guardians kept the fee pot and every line got ~1 % less.
// Per federation the claimed locks (stake and fee) are now paid out whole, and each key's sum over the federations is what the
// one-federation plan pays it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bookLedger, bookSettlement } from '../../arena-protocol/src/book-ledger.js';
import { YES, NO } from '../../arena-protocol/src/order-book.js';
import { bookLockSettlement } from '../../arena-protocol/src/lock-settlement.js';
import { splitByFederation } from '../../arena-protocol/src/federation-settlement.js';
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { TEST_DONATION_SET_KEYS_REGTEST } from '../../arena-protocol/src/test-donation-set-keys-regtest.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const id = (s) => s.padStart(64, '0');
const NO_FEES = { ppm: 0n, baseMsat: 0n };
const FED_A = 'aa'.repeat(32), FED_B = 'bb'.repeat(32);
const RESERVE = { [FED_A]: Uint8Array.of(0x02, ...b32(0xa7)), [FED_B]: Uint8Array.of(0x02, ...b32(0xb7)) };
const RESERVE_LATER_PK = Uint8Array.of(0x02, ...new Uint8Array(32));

// a, b, c, d: two YES, two NO; c's order fills only in part, so its fee lock is not all spent on fees and part of it comes back
function market() {
  const orders = [
    { x: 'a', outcome: YES, stake: 10_000_000n, fed: FED_A }, { x: 'b', outcome: NO, stake: 10_000_000n, fed: FED_B },
    { x: 'c', outcome: NO, stake: 6_000_000n, fed: FED_A }, { x: 'd', outcome: YES, stake: 3_000_000n, fed: FED_B },
  ].map((o, i) => ({ ...o, i, feeMsat: entryFeeMsat(o.stake, 100), pk: b32(0xa1 + i) }));
  const L = bookLedger({ batches: [{ k: 1, cutoffMs: 1000n, orders: orders.map((o) => ({ id: id(o.x), outcome: o.outcome, price: 50000n,
    stakeMsat: o.stake, feeMsat: o.feeMsat, expiryMs: 0n })) }], feeBps: 100 });
  const table = bookSettlement({ positions: L.positions, outcome: YES });
  const entries = orders.map((o) => ({ entryId: id(o.x), pubkey: o.pk }));
  const fedOf = new Map();
  const locks = new Map(), feeLocks = new Map();
  for (const o of orders) {
    const stake = { txid: b32(0x10 + o.i), outIdx: 0n }, fee = { txid: b32(0x20 + o.i), outIdx: 1n };
    locks.set(toHex(o.pk), { outpoint: stake, amountMsat: o.stake - o.feeMsat, refundPk: Uint8Array.of(0x02, ...o.pk) });
    feeLocks.set(toHex(o.pk), { outpoint: fee, amountMsat: o.feeMsat, preimage: b32(9) });
    fedOf.set(`${toHex(stake.txid)}:0`, o.fed); fedOf.set(`${toHex(fee.txid)}:1`, o.fed);
  }
  const plan = (reserveKey) => bookLockSettlement({ roundId: b32(1), table, entries, locks, feeLocks, fees: NO_FEES,
    contract: { nodes: [b32(0x11), b32(0x22), b32(0x33)] }, donation: { recipients: TEST_DONATION_SET_KEYS_REGTEST.recipients },
    nodeBps: 50, donationBps: 50, reserveBps: 10, reserveKey });
  return { table, plan, federationOf: (o) => fedOf.get(`${toHex(o.txid)}:${o.outIdx}`) || null };
}

// what each line receives, summed over the transactions, by kind and payout key (the reserve by kind: its key is per federation)
const paidBy = (payouts) => {
  const m = new Map();
  for (const p of payouts) { const k = p.reserve ? 'reserve' : `${p.kind}:${toHex(p.payoutPk)}`; m.set(k, (m.get(k) || 0n) + p.msat); }
  return m;
};

test('#1438 a book round over two federations pays out every federation\'s fee locks and pays each line what one federation pays it', () => {
  const { table, plan, federationOf } = market();
  // the fixture holds what the audit found: some fee lock is not all fees (a part fill), and fees are due
  assert.ok(table.feesDueMsat > 0n);
  assert.ok(table.claimed.some((r) => r.feeMsat > r.buyFeeMsat + r.sellFeeMsat), 'a part fill hands back part of its fee lock');
  const one = plan(RESERVE[FED_A]);
  assert.equal(one.ok, true, one.why);
  assert.equal(one.unspentMsat, 0n, 'one federation: the claimed locks are paid out whole');
  const any = plan(RESERVE_LATER_PK);
  assert.equal(any.ok, true, any.why);
  const got = splitByFederation(any, { roundId: b32(1), federationOf, feesOf: () => NO_FEES, reserveKeyOf: (fid) => RESERVE[fid] });
  assert.equal(got.ok, true, got.why);
  assert.deepEqual(got.settlements.map((s) => s.federation), [FED_A, FED_B]);
  for (const s of got.settlements) {
    const feeIn = s.claims.filter((c) => c.kind === 'fee').reduce((t, c) => t + c.amountMsat, 0n);
    const allIn = s.claims.reduce((t, c) => t + c.amountMsat, 0n);
    const out = s.payouts.reduce((t, p) => t + p.msat + p.feeMsat, 0n);
    assert.ok(feeIn > 0n, `federation ${s.federation.slice(0, 4)} holds fee locks`);
    // every claimed lock of this federation, its fee locks with them, is paid out: nothing is left to the guardians
    assert.equal(out, allIn, `federation ${s.federation.slice(0, 4)}: ${allIn} msat claimed, ${out} paid out (fee locks ${feeIn})`);
    assert.equal(s.unspentMsat + (s.feeUnspentMsat || 0n), 0n, `federation ${s.federation.slice(0, 4)} leaves nothing unspent`);
    // and its reserve part goes to its own reserve key
    for (const p of s.payouts.filter((x) => x.reserve)) assert.equal(toHex(p.payoutPk), toHex(RESERVE[s.federation]));
  }
  // each line's sum over the federations is what the one-federation plan pays it (no guardians' fee: to the msat but the
  // division's dust, under 1 msat a line in each federation, which each federation hands its first payout)
  const split = paidBy(got.settlements.flatMap((s) => s.payouts));
  const whole = paidBy(one.payouts);
  assert.deepEqual([...split.keys()].sort(), [...whole.keys()].sort());
  const dust = BigInt(one.payouts.length * got.settlements.length);
  for (const [k, msat] of whole) {
    const d = split.get(k) - msat;
    assert.ok(d >= -dust && d <= dust, `${k.slice(0, 30)}: one federation pays ${msat}, the split ${split.get(k)}`);
  }
  const total = (m) => [...m.values()].reduce((t, v) => t + v, 0n);
  assert.equal(total(split), total(whole));
});

test('#1438 with each federation\'s own fee rule, its fee locks are spent and only the rounding dust is left', () => {
  const { plan, federationOf } = market();
  const any = plan(RESERVE_LATER_PK);
  const feesOf = (fid) => (fid === FED_A ? { ppm: 1000n, baseMsat: 0n } : { ppm: 250n, baseMsat: 1000n });
  const got = splitByFederation(any, { roundId: b32(1), federationOf, feesOf, reserveKeyOf: (fid) => RESERVE[fid] });
  assert.equal(got.ok, true, got.why);
  for (const s of got.settlements) {
    const feeIn = s.claims.filter((c) => c.kind === 'fee').reduce((t, c) => t + c.amountMsat, 0n);
    const left = s.unspentMsat + (s.feeUnspentMsat || 0n);
    assert.ok(left >= 0n && left < 1000n, `federation ${s.federation.slice(0, 4)}: ${left} msat of its locks unspent (fee locks ${feeIn})`);
  }
});
