// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// §27A.9.2 "What a slash pays in" (RULED 2026-11-02, kanban #976): spread over every OPEN federation with a reserve key, the lowest load filled up to
// the next one's, then both together, none past 80 %; a part too small to peg in joins the largest; what does not fit stays in the escrow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reserveParts, planEscrowSpend } from '../src/slash-reserves.js';

const fed = (id, reserve, cap = 100_000, over = {}) => ({ federation: id, status: 'OPEN', reserveKey: `k${id}`, reserveSats: reserve, exposureCapSats: cap, ...over });
const loads = [fed('aa', 20_000), fed('bb', 40_000), fed('cc', 70_000)];
const shape = (r) => Object.fromEntries(r.parts.map((p) => [p.federation, Number(p.sats)]));

test('the spec\'s loads of 20, 40 and 70 %: the first up to 40, the first two up to 70, then all three up to 80', () => {
  assert.deepEqual(shape(reserveParts({ amountSats: 20_000n, federations: loads })), { aa: 20_000 });
  assert.deepEqual(shape(reserveParts({ amountSats: 80_000n, federations: loads })), { aa: 50_000, bb: 30_000 });
  assert.deepEqual(shape(reserveParts({ amountSats: 110_000n, federations: loads })), { aa: 60_000, bb: 40_000, cc: 10_000 });
});

test('none past 80 %: what does not fit stays in the escrow', () => {
  const r = reserveParts({ amountSats: 200_000n, federations: loads });
  assert.deepEqual(shape(r), { aa: 60_000, bb: 40_000, cc: 10_000 });
  assert.equal(r.keptSats, 90_000n);
});

test('every sat is accounted for, in federations of different sizes', () => {
  for (const amount of [1n, 7n, 1_001n, 12_345n, 77_777n]) {
    const r = reserveParts({ amountSats: amount, federations: [fed('aa', 1_000, 300_000), fed('bb', 900, 70_000), fed('cc', 5_000, 1_000_000)] });
    assert.equal(r.parts.reduce((t, p) => t + p.sats, 0n) + r.keptSats, amount, String(amount));
  }
});

test('a federation over 80 %, as testnet\'s today, takes nothing', () => {
  const r = reserveParts({ amountSats: 5_000n, federations: [fed('aa', 90_000)] });
  assert.equal(r.parts.length, 0);
  assert.equal(r.keptSats, 5_000n);
});

test('only an OPEN federation with a reserve key takes a part, and never a retired one', () => {
  const list = [fed('aa', 0, 100_000, { status: 'DRAINING' }), fed('bb', 0, 100_000, { reserveKey: null }), fed('cc', 0), fed('dd', 0)];
  assert.deepEqual(shape(reserveParts({ amountSats: 1_000n, federations: list, retired: ['dd'] })), { cc: 1_000 });
});

test('a network with no reserve key yet keeps it all in the escrow', () => {
  const r = reserveParts({ amountSats: 1_000n, federations: [fed('aa', 0, 100_000, { reserveKey: null })] });
  assert.equal(r.parts.length, 0);
  assert.equal(r.keptSats, 1_000n);
});

test('a part too small to peg in joins the largest', () => {
  const r = reserveParts({ amountSats: 1_100n, federations: [fed('aa', 0), fed('bb', 1_000)], minPartSats: 500n });
  assert.deepEqual(shape(r), { aa: 1_100 });
  assert.equal(reserveParts({ amountSats: 100n, federations: [fed('aa', 0)], minPartSats: 500n }).keptSats, 100n);
});

test('one spend: a loss is carried first, in its own federation, and the rest is spread', () => {
  const p = planEscrowSpend({ escrowSats: 101_000n, feeSats: 1_000n, pegInFeeSats: 1_000n, federations: loads, players: [{ key: 'x', msat: 9_000_500n, federation: 'cc' }] });
  assert.equal(p.ok, true, p.why);
  const at = Object.fromEntries(p.pegIns.map((x) => [x.federation, x]));
  // 9001 sat of loss + 1000 of peg-in fee to cc; 89999 spread: 50000 + 30000 brings the first two to 70 %, then 9999 over all three
  assert.equal(at.cc.playersMsat, 9_000_500n);
  assert.equal(at.cc.sats, 10_001n + 3_333n);
  assert.equal(at.aa.sats, 53_333n);
  assert.equal(at.bb.sats, 33_333n);
  assert.equal(p.keptSats, 0n);
  assert.equal(p.pegIns.reduce((t, x) => t + x.sats, 0n), 100_000n, 'with the fee, the whole escrow');
});

test('a loss in a federation with no room is still paid there, and the rest waits in the escrow', () => {
  const p = planEscrowSpend({ escrowSats: 50_000n, feeSats: 1_000n, pegInFeeSats: 1_000n, federations: [fed('aa', 90_000)], players: [{ key: 'x', msat: 5_000_000n, federation: 'aa' }] });
  assert.deepEqual(p.pegIns.map((x) => [x.federation, x.sats]), [['aa', 6_000n]]);
  assert.equal(p.keptSats, 43_000n);
});

test('a loss in a retired federation is paid there, and the reserves go elsewhere; its peg-in names no reserve key', () => {
  const p = planEscrowSpend({ escrowSats: 50_000n, feeSats: 1_000n, pegInFeeSats: 1_000n, retired: ['bb'], federations: [fed('aa', 0), fed('bb', 0)], players: [{ key: 'x', msat: 5_000_000n, federation: 'bb' }] });
  const at = Object.fromEntries(p.pegIns.map((x) => [x.federation, x]));
  assert.equal(at.bb.sats, 6_000n);
  assert.equal(at.bb.reserveKey, null);
  assert.equal(at.aa.sats, 43_000n);
});

test('nobody owed and no room: nothing is spent', () => {
  const p = planEscrowSpend({ escrowSats: 50_000n, feeSats: 1_000n, federations: [fed('aa', 90_000)] });
  assert.equal(p.ok, false);
  assert.match(p.why, /stays/);
});

test('a bond too short shares what it has by what each federation is owed', () => {
  const p = planEscrowSpend({ escrowSats: 3_000n, feeSats: 1_000n, pegInFeeSats: 0n, federations: [], players: [{ key: 'x', msat: 3_000_000n, federation: 'aa' }, { key: 'y', msat: 1_000_000n, federation: 'bb' }] });
  assert.deepEqual(p.pegIns.map((x) => Number(x.sats)), [1500, 500]);
});
