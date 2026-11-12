// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 a45 refute #1854 (honest path): MAX_PACKAGE_ANCESTORS = 64 counts the ancestors a package carries, and an
// honest seat always packs the WHOLE chain (server.js hostSplit: packageOf(g, { ancestors: [...chainOf(g), g.manifest] }),
// adoptPackage keeps [...chainOf(replaces), replaces.manifest], GET /plugin serves chainOf(g)). Every new split is a new
// version (signSplit -> nextVersionWithSplit). So the 66th version of a game carries 65 genuine ancestors and is refused
// by its own seat and by every peer - the game can never be updated again, nothing prunes the chain.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { toHex } from '../../arena-protocol/src/hash.js';
import { encodeManifest, gameIdOf, NO_PARENT } from '../../arena-protocol/src/manifest.js';
import { checkPackage } from '../src/plugin-check.js';
import { verifyEd25519 } from '../src/ed25519.js';
import { testGame, testDonationSet } from './plugins/sign.js';

const SRC = 'export const DECIDE = () => 0;\n';
const CH = createHash('sha256').update(SRC).digest('hex'), CFG = 'bb'.repeat(32);
const oneCore = () => new Map([[CH, { name: 'c', hash: CH, configs: new Map([[CFG, {}]]) }]]);

function honest(V) {
  const chain = [];
  let parent = NO_PARENT;
  for (let v = 1; v < V; v++) {
    const g = testGame({ name: 'long-lived', cores: oneCore(), runTicksMax: 100, version: v, parentManifestId: parent, dev: 'long-dev' });
    chain.push(g.manifest); parent = gameIdOf(g.manifest);
  }
  const next = testGame({ name: 'long-lived', cores: oneCore(), runTicksMax: 100, version: V, parentManifestId: parent, dev: 'long-dev' });
  const donationSet = testDonationSet('long-dev').map((r) => ({ recipientPk: toHex(r.recipientPk), shareBps: r.shareBps, label: r.label }));
  const pkg = { format: 'arena-plugin/v1', name: 'long-lived', manifest: toHex(encodeManifest(next.manifest)),
    ancestors: chain.map((m) => toHex(encodeManifest(m))), donationSet,
    cores: [{ hash: CH, name: 'c', configs: [CFG], source: Buffer.from(SRC).toString('base64') }], clients: [] };
  return checkPackage(pkg, { verify: verifyEd25519, want: toHex(next.gameId) });
}

test('control: the honest 65th version (64 ancestors) is taken', () => { const r = honest(65); assert.equal(r.ok, true, r.why); });

test('an honest game\'s 66th version (65 genuine ancestors, as hostSplit packs it) is still taken', () => {
  const r = honest(66);
  const lenCheck = r.checks.find((c) => /real chain's length/.test(c.check));
  assert.ok(!lenCheck || lenCheck.ok, `the honest v66 is refused by the ancestor count: ${r.why}`);
  assert.equal(r.ok, true, r.why);
});
