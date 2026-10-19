// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE LIQUIDITY SEATING (§23A.10): guardians list the federation's providers with weights floored to L and sign it; a list
// stands at the threshold; a provider below the deposit or without a channel to the federation is not on it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { liquiditySeatingFrom, signLiquiditySeating, standingLiquiditySeating } from '../src/liquidity-seating.js';
import { toHex } from '../src/hash.js';

const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const fid = 'f0'.repeat(32);
const fedKey = '03' + '99'.repeat(32), other = '03' + '88'.repeat(32);
const claim = (n, free, ch) => ({ node: String(n).repeat(64).slice(0, 64), freeSats: String(free), channels: ch });

test('the list: providers with a channel to the federation, at or above the deposit, weights floored to L', () => {
  const list = liquiditySeatingFrom({ federationLnKeys: [fedKey], claims: [
    claim(1, 612345, [{ peer: fedKey, capacitySats: '100000' }]),            // 712,345 -> 700,000
    claim(2, 399999, [{ peer: fedKey, capacitySats: '100000' }]),            // free + given 499,999, below the deposit: out
    claim(3, 900000, [{ peer: other, capacitySats: '100000' }]),             // no channel to this federation: out
    claim(4, 500000, [{ peer: fedKey, capacitySats: '99999' }]),             // channel below L: out
  ] });
  assert.deepEqual(list.map((p) => [p.node.slice(0, 2), p.weight]), [['11', 700000n]]);
});

test('a seating stands at the threshold of seated guardians signing the same list', () => {
  const g = [1, 2, 3].map((n) => { const s = new Uint8Array(32).fill(0x40 + n); return { s, hex: toHex(schnorr.getPublicKey(s)) }; });
  const seating = { federationId: fid, epoch: 1090, providers: [{ node: '11'.repeat(32), weight: 700000n }, { node: '22'.repeat(32), weight: 300000n }] };
  const signed = g.slice(0, 2).map((x) => signLiquiditySeating(seating, x.hex, (h) => schnorr.sign(h, x.s)));
  const st = standingLiquiditySeating({ signed, federationId: fid, epoch: 1090, seated: g.map((x) => x.hex), threshold: 2, verify });
  assert.equal(st.ok, true);
  assert.deepEqual(st.seating.providers.map((p) => p.weight), ['700000', '300000']);
  const odd = signLiquiditySeating({ ...seating, providers: [{ node: '11'.repeat(32), weight: 800000n }] }, g[1].hex, (h) => schnorr.sign(h, g[1].s));
  assert.equal(standingLiquiditySeating({ signed: [signed[0], odd], federationId: fid, epoch: 1090, seated: g.map((x) => x.hex), threshold: 2, verify }).ok, false, 'different weights do not add up');
  assert.equal(standingLiquiditySeating({ signed, federationId: fid, epoch: 1090, seated: [g[2].hex], threshold: 1, verify }).ok, false, 'only seated guardians count');
});
