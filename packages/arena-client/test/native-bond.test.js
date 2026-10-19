// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SEAT BONDED ON TESTNET4 ITSELF IS REACHED AT THE PLAYER'S DOOR (2026-10-16 06:24Z on his phone, live UI 143:
// "Not joined PAID · 100 sats round e8003e9e: no proven endpoint: that transaction has no dust output to BOND_MARKER"). The door,
// `discover`, proved the seat's bond with acceptAdvert and never told it the round's network, so acceptAdvert looked for REGTEST's
// marker - and every seat bonded natively on testnet4 (bond template 2, 580d64fc) was refused at PLAY. The fixture is real: seat 1's
// bond d4a317b8 in testnet4 block 156038, the headers from the anchor (154000) to it, read off the testnet4 node.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { discover, reach } from '../src/directory.js';
import { fromHex } from '../../arena-protocol/src/hash.js';
import { NETWORK_ID_TESTNET4 } from '../../arena-protocol/src/genesis-ids.js';
import { TESTNET4_ANCHOR, blockHashOf, paysBondMarker } from '../../arena-protocol/src/chain.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';

const F = JSON.parse(readFileSync(new URL('./fixtures/tn4-native-bond.json', import.meta.url), 'utf8'));
const H = fromHex(F.headers);
const chain = Array.from({ length: H.length / 80 }, (_, i) => H.subarray(i * 80, i * 80 + 80));
const bond = { transaction: fromHex(F.bond.hex), branch: F.bond.merkle.map(fromHex), position: F.bond.pos };
const KEY = fromHex(F.key);
const headerSource = (tag) => Object.assign(async () => chain, { tag });
const seat = Object.assign(async () => ({ ...bond }), { tag: 'seat-1' });

test('the fixture: a real testnet4 bond, paying testnet4\'s marker and not regtest\'s, in a chain from the anchor', () => {
  assert.deepEqual(blockHashOf(chain[0]), TESTNET4_ANCHOR);
  const tx = parseTransaction(bond.transaction);
  assert.equal(paysBondMarker(tx, 'testnet4'), true);
  assert.equal(paysBondMarker(tx, 'regtest'), false, 'which is why a door that does not say the network refuses it');
});

test('the door proves a seat bonded on testnet4 for a testnet4 round: its endpoint, on its committee', async () => {
  const seen = await discover({ headers: [headerSource('a'), headerSource('b')], bonds: [seat], committee: [KEY], networkId: NETWORK_ID_TESTNET4 });
  assert.equal(seen.ok, true, seen.why);
  assert.match(seen.endpoint, /^wss:\/\//);
  assert.deepEqual(seen.nodePubkey, KEY);
});

test('the bond check itself: the round\'s network decides the marker; regtest\'s refuses the testnet4 bond by the words the phone showed', () => {
  const asTestnet4 = reach({ chain, ...bond, committee: [KEY], network: 'testnet4' });
  assert.equal(asTestnet4.ok, true, asTestnet4.why);
  const asRegtest = reach({ chain, ...bond, committee: [KEY] });
  assert.equal(asRegtest.ok, false);
  assert.equal(asRegtest.why, 'that transaction has no dust output to BOND_MARKER');
});
