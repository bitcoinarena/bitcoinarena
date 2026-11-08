// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1328 (§0A.7a RULED 2026-11-07, #1292): "An attested round's gross is capped at a quarter of the attestors' posted bonds (gross <= Σ attestor_bond / 4)".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attestedGrossCapSats, minCap, orderWithinPool } from '../src/census-health.js';
import { NETWORK_ID_TESTNET4 } from '../src/genesis-ids.js';

test('#1328 an attested round takes orders up to a quarter of its attestors\' bonds; a test network shows no cap', () => {
  const bonds = Array(7).fill(1_000_000n);                       // seven drawn attestors, 1 M sat each
  const cap = attestedGrossCapSats({ bondsSats: bonds, networkId: null });
  assert.equal(cap, 1_750_000n);
  assert.equal(orderWithinPool({ filledSats: 1_700_000n, orderSats: 50_000n, poolSats: cap }), true);
  assert.equal(orderWithinPool({ filledSats: 1_700_000n, orderSats: 50_001n, poolSats: cap }), false);
  assert.equal(attestedGrossCapSats({ bondsSats: bonds, networkId: NETWORK_ID_TESTNET4 }), null);
  assert.equal(minCap(null, cap), cap);
  assert.equal(minCap(5_000_000n, cap), cap);
  assert.equal(minCap(1_000n, cap), 1_000n);
  assert.equal(minCap(null, null), null);
  console.log('  MEASURED #1328:', JSON.stringify({ cap: String(cap), atCap: true, overByOne: false, testnet: null }));
});

test('#1328/#1365 on mainnet a key-named attested game needs a bond for every attestor key; drawn attestors and test networks pass', async () => {
  const { attestorsBondedFor, RESULT_TYPE } = await import('../src/manifest.js');
  const keyed = { resultType: RESULT_TYPE.ATTESTED, attestors: [new Uint8Array(32).fill(0xa1), new Uint8Array(32).fill(0xa2), new Uint8Array(32).fill(0xa3)], attestThreshold: 2, gameName: 'keyed', outcomes: ['up', 'down'] };
  const drawn = { ...keyed, attestors: [], attestThreshold: 0, attestDraw: { count: 7, threshold: 5 } };
  const got = { mainnet: attestorsBondedFor(keyed, 'mainnet'), testnet4: attestorsBondedFor(keyed, 'testnet4'), drawn: attestorsBondedFor(drawn, 'mainnet'),
    allBonded: attestorsBondedFor(keyed, 'mainnet', () => true) };
  console.log('  MEASURED #1365:', JSON.stringify(Object.fromEntries(Object.entries(got).map(([k, v]) => [k, v.ok]))));
  assert.equal(got.mainnet.ok, false); assert.match(got.mainnet.why, /3 of 3/);
  assert.equal(got.testnet4.ok, true); assert.equal(got.drawn.ok, true); assert.equal(got.allBonded.ok, true);
});
