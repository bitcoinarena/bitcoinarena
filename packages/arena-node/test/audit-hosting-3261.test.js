// kanban #3261: the card's test (audit tonight, hosting-3261)
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r21 hosting 1: A CORE'S FORM (one file or a tree) IS SIGNED BY NOBODY. The manifest names a core by one hash, and a tree's
// hash is sha256 of its stream (`path \0 bytes \0` per file, core-hash.js). So the one-file form whose `source` IS that stream hashes to
// the same value: a relaying seat hands the genuine signed tree core as { hash, source: <the stream> }. checkPackage takes it (sha256 of
// the source is the signed hash, the scan finds nothing), the trial loads 'adapter.js\0...' - a syntax error - and answers `trial: true`:
// the verdict server.js autoUpdateSweep keeps on the GENUINE game id for 24 h (trialRefused), so no honest source's copy is taken.
// Safe: a package not carrying the core the way its hash was made is refused before the trial, never as the trial's verdict.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { toHex } from '../../arena-protocol/src/hash.js';
import { encodeManifest } from '../../arena-protocol/src/manifest.js';
import { treeHashHex } from '../src/plugin-check.js';
import { verifyPackage } from '../src/plugin-package.js';
import { verifyEd25519 } from '../src/ed25519.js';
import { testHeadToHeadGame, testDonationSet } from './plugins/sign.js';

const adapter = "export const DECIDE = { name: 'one-file tree', decide(moves) { const out = {};\n"
  + "  for (const x of moves) { const w = moves.some((y) => y !== x && (x.move - y.move + 3) % 3 === 1), l = moves.some((y) => y !== x && (y.move - x.move + 3) % 3 === 1);\n"
  + "    out[x.key] = w && !l ? 'WIN' : l && !w ? 'LOSS' : 'DRAW'; } return out; } };\n";
const FILES = [['adapter.js', adapter]];
const HASH = treeHashHex(FILES.map(([path, t]) => ({ path, bytes: new TextEncoder().encode(t) })));
// the tree's hash stream, as one file
const STREAM = Buffer.concat(FILES.flatMap(([path, t]) => [Buffer.from(path), Buffer.from([0]), Buffer.from(t), Buffer.from([0])]));
const g = testHeadToHeadGame({ name: 'tree-one', core: { name: 'tree one', hash: HASH, configs: new Map([['cd'.repeat(32), {}]]) }, dev: 'tree-one-dev' });
const base = () => ({ format: 'arena-plugin/v1', name: 'tree-one', manifest: toHex(encodeManifest(g.manifest)), ancestors: [],
  donationSet: testDonationSet('tree-one-dev').map((r) => ({ recipientPk: toHex(r.recipientPk), shareBps: r.shareBps, label: r.label })), clients: [] });
const genuine = () => ({ ...base(), cores: [{ hash: HASH, name: 'tree one', configs: ['cd'.repeat(32)], entry: 'adapter.js',
  files: FILES.map(([path, t]) => ({ path, body: Buffer.from(t).toString('base64') })) }] });
const relayed = () => ({ ...base(), cores: [{ hash: HASH, name: 'tree one', configs: ['cd'.repeat(32)], source: STREAM.toString('base64') }] });
const check = (pkg) => verifyPackage(pkg, { verify: verifyEd25519, want: toHex(g.gameId) });

test('#1489 r21-hosting-1: the stream of a tree hashes to the tree hash (the one-file form carries the same signed hash)', () => {
  assert.equal(createHash('sha256').update(STREAM).digest('hex'), HASH);
});

test('#1489 r21-hosting-1: the genuine tree package is verified and passes the trial', () => {
  const r = check(genuine());
  assert.equal(r.ok, true, r.why);
});

test('#1489 r21-hosting-1: a relaying seat handing the tree as one file does not earn the genuine version a remembered trial verdict', () => {
  const r = check(relayed());
  console.log('  MEASURED one-file form of the tree:', JSON.stringify({ ok: r.ok, trial: r.trial, retry: r.retry, why: r.why }).slice(0, 400));
  assert.equal(r.ok, false);
  assert.notEqual(r.trial, true, 'an unsigned core form made the trial refuse the genuine signed game: autoUpdate keeps that verdict on its id for 24 h');
});
