// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3085 (feedback #367): a tree core (Next Block v8's 7d197042: 26 .js files) is carried in a package as { entry, files } and
// checked by its tree hash - the hash core-hash.js coreTree computes from disk, recomputed here from the bytes in memory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { toHex } from '../../arena-protocol/src/hash.js';
import { encodeManifest } from '../../arena-protocol/src/manifest.js';
import { checkPackage, treeHashHex, TREE_LIMITS } from '../src/plugin-check.js';
import { coreTree } from '../src/core-hash.js';
import { verifyEd25519 } from '../src/ed25519.js';
import { testGame, testDonationSet } from './plugins/sign.js';

const ROOT = join(import.meta.dirname, '..', '..', '..', '.apps', 'arena-app-next-block', 'frozen', '7d197042');
const { hash: TREE, files } = coreTree(ROOT);
const CFG = 'bb'.repeat(32);
const asFiles = () => [...files].map(([path, bytes]) => ({ path, body: Buffer.from(bytes).toString('base64') }));

function pkgWith(core) {
  const g = testGame({ name: 'tree-game', cores: new Map([[TREE, { name: 'truck', hash: TREE, configs: new Map([[CFG, {}]]) }]]), runTicksMax: 100, dev: 'tree-dev' });
  const donationSet = testDonationSet('tree-dev').map((r) => ({ recipientPk: toHex(r.recipientPk), shareBps: r.shareBps, label: r.label }));
  const pkg = { format: 'arena-plugin/v1', name: 'tree-game', manifest: toHex(encodeManifest(g.manifest)), ancestors: [], donationSet,
    cores: [{ hash: TREE, name: 'truck', configs: [CFG], ...core }], clients: [] };
  return checkPackage(pkg, { verify: verifyEd25519, want: toHex(g.gameId) });
}

test('#3085: the tree hash from memory is coreTree\'s hash of the v8 core (26 files)', () => {
  assert.equal(TREE.slice(0, 8), '7d197042');
  assert.equal(files.size, 26);
  assert.equal(treeHashHex([...files].map(([path, bytes]) => ({ path, bytes: new Uint8Array(bytes) }))), TREE);
});

test('#3085: a package carrying the v8 tree passes the tree checks; a changed byte, a "../" path, a missing entry are refused', () => {
  const good = pkgWith({ entry: 'adapter.js', files: asFiles() });
  const tree = good.checks.find((c) => /is the tree its manifest names/.test(c.check));
  console.log('  MEASURED #3085:', JSON.stringify({ ok: good.ok, why: good.why, tree: tree && tree.ok, scan: good.checks.find((c) => /passes the scan/.test(c.check)) }).slice(0, 600));
  assert.equal(tree && tree.ok, true, good.why);
  const bent = asFiles(); const b = Buffer.from(bent[0].body, 'base64'); b[0] ^= 1; bent[0].body = b.toString('base64');
  assert.match(pkgWith({ entry: 'adapter.js', files: bent }).why, /not the tree its manifest names/);
  assert.match(pkgWith({ entry: 'adapter.js', files: [...asFiles(), { path: '../x.js', body: '' }] }).why, /segment/);
  assert.match(pkgWith({ entry: 'nope.js', files: asFiles() }).why, /entry is not one of its files/);
  assert.match(pkgWith({ entry: 'adapter.js', files: asFiles(), source: 'eA==' }).why, /not a list of files/);
  assert.ok(TREE_LIMITS.files >= files.size);
});
