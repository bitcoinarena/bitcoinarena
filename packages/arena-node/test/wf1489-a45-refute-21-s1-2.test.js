// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 a45 refute #1854 (second copy): the owner page checks every network seat's package in the browser with its own
// bundle of plugin-check.js (pages/owner-entry.js re-exports checkPackage; owner.html storePanel -> shortCheck ->
// C.checkPackage). The committed bundle pages/owner-client.js was not rebuilt after #1854: its checkPackage still walks
// every ancestor, one ed25519 verify each, so a peer's package still costs the owner's tab one verify per ancestor.
import test from 'node:test';
import assert from 'node:assert/strict';
import { toHex } from '../../arena-protocol/src/hash.js';
import { encodeManifest, gameIdOf, NO_PARENT } from '../../arena-protocol/src/manifest.js';
import { verifyEd25519 } from '../src/ed25519.js';
import { testGame, testDonationSet } from './plugins/sign.js';
import * as C from '../pages/owner-client.js';

const CH = 'aa'.repeat(32), CFG = 'bb'.repeat(32);
const oneCore = () => new Map([[CH, { name: 'c', hash: CH, configs: new Map([[CFG, {}]]) }]]);

test('the owner page\'s bundled checkPackage caps a peer package\'s ancestors too', () => {
  const N = 200, chain = [];
  let parent = NO_PARENT;
  for (let v = 1; v <= N; v++) {
    const g = testGame({ name: 'chain-game', cores: oneCore(), runTicksMax: 100, version: v, parentManifestId: parent, dev: 'chain-dev' });
    chain.push(g.manifest); parent = gameIdOf(g.manifest);
  }
  const main = testGame({ name: 'chain-game', cores: oneCore(), runTicksMax: 100, version: N + 1, parentManifestId: parent, dev: 'chain-dev' });
  const forged = { ...main.manifest, signature: new Uint8Array(64) };
  const donationSet = testDonationSet('chain-dev').map((r) => ({ recipientPk: toHex(r.recipientPk), shareBps: r.shareBps, label: r.label }));
  const pkg = { format: 'arena-plugin/v1', name: 'chain-game', manifest: toHex(encodeManifest(forged)),
    ancestors: chain.map((m) => toHex(encodeManifest(m))), donationSet, cores: [], clients: [] };
  let n = 0;
  const r = C.checkPackage(pkg, { verify: (s, m, k) => { n++; return verifyEd25519(s, m, k); } });
  assert.equal(r.ok, false);
  assert.ok(n <= 64, `the owner page's checkPackage verified ${n} signatures for a ${N}-ancestor package (bundle stale, no cap)`);
});
