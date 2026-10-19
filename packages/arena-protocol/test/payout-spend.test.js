// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE POOL'S PAYOUT SPEND - payout-spend.js on its own (kanban #146, third surface; plan comment 191, Go 2026-10-05). What a
// round owes each winner (winnings: the table row less the net stake that came back) and the outputs of the one transaction
// that pays them (payoutOutputs: P2TR outputs at or above the relay floor, the rest owed, the remainder the fee). Until now
// protocol's own suite covered 66.9% of its lines; no test anywhere named payoutOutputs or payableKey. Pure arithmetic and
// scripts: no curve, no cross-package import.
//
// Read from the source before this file, and measured here first: payoutOutputs never asked payableKey, so a row paying 32
// zero bytes (not a key) became an output OP_1 <zeros> nobody can spend - the winner's sats burned; and winnings with no
// stakes threw "stakes is not iterable" instead of refusing by name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { payToKey, winnings, payoutOutputs, payableKey, DUST_SATS, P2TR_BYTES } from '../src/payout-spend.js';
import { FIELD } from '../src/shares.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const hex = (b) => Buffer.from(b).toString('hex');
const ZERO = new Uint8Array(32);
const KEY_A = b32(0x0a), KEY_B = b32(0x0b), KEY_C = b32(0x0c);
const row = (pubkey, sats) => ({ pubkey, msat: BigInt(sats) * 1000n });

// THE FIRST CHECK (plan 191): a row whose key is not a key is never made an output; the payout is refused, naming it.
test('payoutOutputs refuses a row paying something that is not a key, naming it; no output to it is made', () => {
  const got = payoutOutputs({ rows: [row(ZERO, 5000), row(KEY_A, 9000)], poolSats: 20000n });
  assert.equal(got.ok, false, 'a payout to the zero key was made');
  assert.equal(got.outputs, undefined);
  assert.match(got.why, new RegExp(hex(ZERO).slice(0, 16)));
  const high = Uint8Array.from(Buffer.from(FIELD.toString(16).padStart(64, '0'), 'hex'));
  assert.equal(payoutOutputs({ rows: [row(KEY_A, 9000), row(high, 5000)], poolSats: 20000n }).ok, false, 'a payout to x = n was made');
  // an unpayable key under the dust floor is still refused: the table is broken whatever the amount
  assert.equal(payoutOutputs({ rows: [row(KEY_A, 9000), row(ZERO, 100)], poolSats: 20000n }).ok, false);
});

test('winnings with no stakes refuses by name; it does not throw', () => {
  const got = winnings({ table: [{ pubkey: KEY_A, amountMsat: 1000n }], stakes: undefined });
  assert.equal(got.ok, false);
  assert.match(got.why, /stake/);
  assert.equal(winnings({ table: [], stakes: 'x' }).ok, false);
});

test('payToKey: OP_1 <32-byte key>, 34 bytes; a 31-byte key or non-bytes is refused by name', () => {
  const s = payToKey(KEY_A);
  assert.equal(s.length, P2TR_BYTES);
  assert.equal(hex(s), '5120' + '0a'.repeat(32));
  for (const bad of [KEY_A.subarray(0, 31), undefined, '0a'.repeat(32)])
    assert.throws(() => payToKey(bad), { message: 'a payout pays to a 32-byte x-only key' });
});

test('payableKey: a key below the field order and above zero; not zero, n, 2^256-1, 31 bytes or non-bytes', () => {
  assert.equal(payableKey(KEY_A), true);
  assert.equal(payableKey(Uint8Array.from(Buffer.from((FIELD - 1n).toString(16).padStart(64, '0'), 'hex'))), true);
  assert.equal(payableKey(ZERO), false);
  assert.equal(payableKey(Uint8Array.from(Buffer.from(FIELD.toString(16).padStart(64, '0'), 'hex'))), false);
  assert.equal(payableKey(b32(0xff)), false);
  assert.equal(payableKey(KEY_A.subarray(0, 31)), false);
  assert.equal(payableKey(undefined), false);
});

test('winnings: each row less its net stake (stake - fee - donation); at or under the stake is dropped; the sum is owed', () => {
  const stakes = [
    { pubkey: KEY_A, stakeMsat: 100_000n, feeMsat: 2_000n, donationMsat: 1_000n },   // net 97 000
    { pubkey: KEY_B, stakeMsat: 100_000n, feeMsat: 0n, donationMsat: 0n },           // net 100 000
    { pubkey: KEY_C, stakeMsat: 100_000n, feeMsat: 0n, donationMsat: 0n },
  ];
  const table = [
    { pubkey: KEY_A, amountMsat: 250_000n },     // owed 153 000
    { pubkey: KEY_B, amountMsat: 100_000n },     // exactly its stake: dropped
    { pubkey: KEY_C, amountMsat: 0n },           // lost: dropped
  ];
  const got = winnings({ table, stakes });
  assert.deepEqual(got, { ok: true, rows: [{ pubkey: KEY_A, msat: 153_000n }], owedMsat: 153_000n });
  assert.deepEqual(winnings({ table: [], stakes }), { ok: true, rows: [], owedMsat: 0n });
});

test('winnings refuses by name: no table, a key the round never assigned, a stake the net stake refuses', () => {
  const stakes = [{ pubkey: KEY_A, stakeMsat: 100_000n, feeMsat: 0n, donationMsat: 0n }];
  assert.deepEqual(winnings({ table: undefined, stakes }), { ok: false, why: 'that is not a payout table' });
  assert.deepEqual(winnings({ table: [{ pubkey: KEY_B, amountMsat: 1n }], stakes }),
    { ok: false, why: `the table pays a key this round never assigned: ${hex(KEY_B).slice(0, 16)}` });
  assert.deepEqual(winnings({ table: [], stakes: [{ pubkey: KEY_A, stakeMsat: 100, feeMsat: 0n, donationMsat: 0n }] }), { ok: false,
    why: 'stakes must be BigInt millisatoshi, and an entry names its stake, its fee and its donation: the net stake is the first less the other two (22A)' });
  assert.deepEqual(winnings({ table: [], stakes: [{ pubkey: KEY_A, stakeMsat: 100n, feeMsat: 80n, donationMsat: 30n }] }),
    { ok: false, why: 'a fee of 80 and a donation of 30 come out of a stake of 100, and cannot come to more than it' });
});

test('payoutOutputs: 330 sats is an output, 329 is owed by name; the fee is the remainder, no change output', () => {
  assert.equal(DUST_SATS, 330n);
  const got = payoutOutputs({ rows: [row(KEY_A, 330), row(KEY_B, 329), { pubkey: KEY_C, msat: 5_000_999n }], poolSats: 6000n });
  assert.equal(got.ok, true);
  assert.deepEqual(got.outputs.map((o) => [o.value, hex(o.script)]), [[330n, hex(payToKey(KEY_A))], [5000n, hex(payToKey(KEY_C))]]);
  assert.deepEqual(got.owed, [{ pubkey: KEY_B, msat: 329_000n, sats: 329n }]);
  assert.deepEqual({ paid: got.paidSats, owed: got.owedSats, fee: got.feeSats }, { paid: 5330n, owed: 329n, fee: 670n });
  // a fee asked for and covered
  assert.equal(payoutOutputs({ rows: [row(KEY_A, 5000)], poolSats: 5200n, feeSats: 200n }).feeSats, 200n);
  // a custom floor
  const low = payoutOutputs({ rows: [row(KEY_A, 100), row(KEY_B, 99)], poolSats: 500n, dustSats: 100n });
  assert.deepEqual({ outputs: low.outputs.length, owed: low.owed.map((o) => o.sats) }, { outputs: 1, owed: [99n] });
});

test('payoutOutputs refuses by name: no rows, not a pool, every row under the floor, more owed than held, too little for the fee', () => {
  const nothing = 'that round owes nobody anything, so there is nothing to spend';
  assert.deepEqual(payoutOutputs({ rows: [], poolSats: 1000n }), { ok: false, why: nothing });
  assert.deepEqual(payoutOutputs({ rows: undefined, poolSats: 1000n }), { ok: false, why: nothing });
  for (const poolSats of [0n, -1n, 1000, undefined])
    assert.deepEqual(payoutOutputs({ rows: [row(KEY_A, 500)], poolSats }), { ok: false, why: 'a payout spends a pool output, and that is not one' });
  const dust = payoutOutputs({ rows: [row(KEY_A, 100), row(KEY_B, 200)], poolSats: 1000n });
  assert.deepEqual(dust, { ok: false, owed: [{ pubkey: KEY_A, msat: 100_000n, sats: 100n }, { pubkey: KEY_B, msat: 200_000n, sats: 200n }], owedSats: 300n,
    why: 'every one of the 2 player(s) this round owes is under 330 sats, so there is no output to make: the sats stay in the pool and the debt stands' });
  assert.deepEqual(payoutOutputs({ rows: [row(KEY_A, 600), row(KEY_B, 500)], poolSats: 1000n }), { ok: false, why: 'the table owes 1100 sats and the pool holds 1000' });
  assert.deepEqual(payoutOutputs({ rows: [row(KEY_A, 900)], poolSats: 1000n, feeSats: 150n }), { ok: false, why: '100 sats are left for a fee of 150' });
});
