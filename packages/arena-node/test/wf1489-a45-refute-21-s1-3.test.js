// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2251, #2262 (#1854 made to hold): a package may carry any number of earlier versions, but checkPackage reads only
// its newest MAX_PACKAGE_ANCESTORS - each on the one before it - and takes the versions this node holds without verifying them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { toHex } from '../../arena-protocol/src/hash.js';
import { encodeManifest, gameIdOf, NO_PARENT } from '../../arena-protocol/src/manifest.js';
import { checkPackage, MAX_PACKAGE_ANCESTORS } from '../src/plugin-check.js';
import { verifyEd25519 } from '../src/ed25519.js';
import { testGame, testDonationSet } from './plugins/sign.js';

const SRC = 'export const DECIDE = () => 0;\n';
const CH = createHash('sha256').update(SRC).digest('hex'), CFG = 'bb'.repeat(32);
const oneCore = () => new Map([[CH, { name: 'c', hash: CH, configs: new Map([[CFG, {}]]) }]]);
const make = (v, parent, dev = 'long-dev') => testGame({ name: 'long-lived', cores: oneCore(), runTicksMax: 100, version: v, parentManifestId: parent, dev });

function chainTo(V) {
  const chain = []; let parent = NO_PARENT;
  for (let v = 1; v < V; v++) { const g = make(v, parent); chain.push(g.manifest); parent = gameIdOf(g.manifest); }
  return { chain, next: make(V, parent) };
}
function pkgOf(chain, next) {
  const donationSet = testDonationSet('long-dev').map((r) => ({ recipientPk: toHex(r.recipientPk), shareBps: r.shareBps, label: r.label }));
  return { format: 'arena-plugin/v1', name: 'long-lived', manifest: toHex(encodeManifest(next.manifest)),
    ancestors: chain.map((m) => toHex(encodeManifest(m))), donationSet,
    cores: [{ hash: CH, name: 'c', configs: [CFG], source: Buffer.from(SRC).toString('base64') }], clients: [] };
}

test('an honest 201st version is taken, and checking it costs at most the bound plus its own signature', () => {
  const { chain, next } = chainTo(201);
  let n = 0;
  const r = checkPackage(pkgOf(chain, next), { verify: (s, m, k) => { n++; return verifyEd25519(s, m, k); }, want: toHex(next.gameId) });
  assert.equal(r.ok, true, r.why);
  assert.equal(r.version, 201);
  assert.ok(n <= MAX_PACKAGE_ANCESTORS + 1, `${n} verifies`);
});

test('a break inside the newest versions is still refused', () => {
  const { chain, next } = chainTo(120);
  const forged = chain.slice();
  forged[100] = make(101, gameIdOf(chain[99]), 'another-dev').manifest;   // v101 by another key: v102 no longer stands on it
  const r = checkPackage(pkgOf(forged, next), { verify: verifyEd25519 });
  assert.equal(r.ok, false);
  assert.match(r.why, /does not stand/);
});

test('a short chain still needs its oldest version to stand on nothing or on what this node holds', () => {
  const { chain, next } = chainTo(40);
  const r = checkPackage(pkgOf(chain.slice(5), next), { verify: verifyEd25519 });
  assert.equal(r.ok, false);
  assert.match(r.why, /not a manifest this node holds/);
});

test('versions this node already holds are not verified again', () => {
  const { chain, next } = chainTo(70);
  const held = new Map(chain.slice(0, 60).map((m) => [toHex(gameIdOf(m)), m]));
  let n = 0;
  const r = checkPackage(pkgOf(chain, next), { verify: (s, m, k) => { n++; return verifyEd25519(s, m, k); }, parentOf: (id) => held.get(toHex(id)) || null });
  assert.equal(r.ok, true, r.why);
  assert.equal(n, 1 + 9, `${n} verifies: its own signature and the 9 versions this node does not hold`);
});
