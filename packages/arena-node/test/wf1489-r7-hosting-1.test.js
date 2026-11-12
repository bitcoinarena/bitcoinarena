// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 r7 (attack audit, game hosting): a peer's package carries its ancestors' signed manifests
// (plugin-package.js packageOf -> checkPackage). The fetch is byte-capped (server.js PEER_PACKAGE_BYTES = 32 MB,
// jsonUpTo), but checkPackage walks pkg.ancestors with NO count limit and runs one ed25519 verify + decode per
// ancestor on the node's own thread, before the cheap gates (the main manifest's signature, `want`).
//
// A game's real ancestor chain is its version count - a handful. Within a 32 MB body a malicious seat can pack tens of
// thousands of validly self-signed ancestors, then a main manifest that fails (its signature is not the game's dev
// key). checkPackage verifies every ancestor first, then refuses on the main manifest - so the attacker spends the
// honest node's main thread on an unbounded number of signature checks for nothing.
//
// This is reached WITHOUT any owner action: autoUpdate() (server.js) takes every network seat as a source, reads its
// /games, and its pre-filter checkUpdate() compares only the self-declared devKey/version strings (no signature). A
// listing naming a hosted game's dev pubkey (public) as the parent passes the pre-filter, so takeGame() fetches the
// 32 MB package and runs checkPackage on it every ARENA_AUTO_UPDATE_MS (default 10 min), per malicious source.
//
// SAFE BEHAVIOUR: an untrusted package's ancestor chain is bounded - checkPackage must not perform an unbounded number
// of ancestor signature verifications. This test hands it a chain far larger than any real game's and asserts the work
// is capped. It FAILS on 85f803d70 (one verify per ancestor, no cap).
import test from 'node:test';
import assert from 'node:assert/strict';
import { toHex } from '../../arena-protocol/src/hash.js';
import { encodeManifest, gameIdOf, NO_PARENT, manifestStands } from '../../arena-protocol/src/manifest.js';
import { checkPackage } from '../src/plugin-check.js';
import { verifyEd25519 } from '../src/ed25519.js';
import { testGame, testDonationSet } from './plugins/sign.js';

const CH = 'aa'.repeat(32), CFG = 'bb'.repeat(32);
const oneCore = () => new Map([[CH, { name: 'c', hash: CH, configs: new Map([[CFG, {}]]) }]]);

test('checkPackage caps a peer package\'s ancestor chain instead of verifying every one (wf1489 r7)', () => {
  // A long, fully valid ancestor chain under one developer key (v1..vN), each standing on the one before it.
  const N = 200;
  const chain = [];
  let parent = NO_PARENT;
  for (let v = 1; v <= N; v++) {
    const g = testGame({ name: 'chain-game', cores: oneCore(), runTicksMax: 100, version: v, parentManifestId: parent, dev: 'chain-dev' });
    chain.push(g.manifest);
    parent = gameIdOf(g.manifest);
  }
  // Sanity: the chain really stands end to end (so, left unbounded, checkPackage verifies all N).
  const byId = new Map();
  for (const m of chain) {
    assert.equal(manifestStands(m, { verify: verifyEd25519, parentOf: (id) => byId.get(toHex(id)) || null }).ok, true);
    byId.set(toHex(gameIdOf(m)), m);
  }

  // The main manifest: a would-be update whose signature is NOT the dev key's -> it cannot stand. checkPackage reaches
  // it only AFTER the ancestors, so on an unbounded node every ancestor is verified before this refusal.
  const main = testGame({ name: 'chain-game', cores: oneCore(), runTicksMax: 100, version: N + 1, parentManifestId: parent, dev: 'chain-dev' });
  const forged = { ...main.manifest, signature: new Uint8Array(64) };
  const donationSet = testDonationSet('chain-dev').map((r) => ({ recipientPk: toHex(r.recipientPk), shareBps: r.shareBps, label: r.label }));
  const pkg = { format: 'arena-plugin/v1', name: 'chain-game', manifest: toHex(encodeManifest(forged)),
    ancestors: chain.map((m) => toHex(encodeManifest(m))), donationSet, cores: [], clients: [] };

  let verifyCount = 0;
  const countingVerify = (sig, msg, key) => { verifyCount++; return verifyEd25519(sig, msg, key); };
  const r = checkPackage(pkg, { verify: countingVerify });

  // The package is refused either way; what matters is the WORK spent getting there.
  assert.equal(r.ok, false);
  // A real game's chain is its version count. No untrusted package should cost the node 200 signature verifies.
  assert.ok(verifyCount <= 64,
    `checkPackage verified ${verifyCount} signatures for a ${N}-ancestor package; an untrusted chain must be bounded (one verify per ancestor is an unbounded main-thread cost under the 32 MB body cap)`);
});
