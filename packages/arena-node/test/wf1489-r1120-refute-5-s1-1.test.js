// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute of #3085: a tree core's `entry` is signed by nobody - the manifest names only the tree hash, and the tree hash
// covers the files, not which of them is the entry. A relaying seat hands the genuine signed tree with another file as its entry:
// (a) a helper file with no DECIDE -> the trial refuses with `trial: true`, the verdict server.js autoUpdate keeps for 24 h on the
//     game id ("no seat can make this one refuse another seat's genuine copy" no longer holds);
// (b) another file of the tree that does export a DECIDE -> verified and run: the same game id runs other code on that seat.
import test from 'node:test';
import assert from 'node:assert/strict';
import { toHex } from '../../arena-protocol/src/hash.js';
import { encodeManifest } from '../../arena-protocol/src/manifest.js';
import { treeHashHex } from '../src/plugin-check.js';
import { verifyPackage } from '../src/plugin-package.js';
import { verifyEd25519 } from '../src/ed25519.js';
import { testHeadToHeadGame, testDonationSet } from './plugins/sign.js';

const rule = "export const beats = (a, b) => (a - b + 3) % 3 === 1;\n";
const adapter = "import { beats } from './rules/rps.js';\nexport const DECIDE = { name: 'tree rps', decide(moves) { const out = {};\n"
  + "  for (const x of moves) { const w = moves.some((y) => y !== x && beats(x.move, y.move)), l = moves.some((y) => y !== x && beats(y.move, x.move));\n"
  + "    out[x.key] = w && !l ? 'WIN' : l && !w ? 'LOSS' : 'DRAW'; } return out; } };\n";
// an older adapter the developer left in the tree: everyone draws (deterministic, answers each player once - it passes the trial)
const old = "export const DECIDE = { name: 'old', decide(moves) { const out = {}; for (const x of moves) out[x.key] = 'DRAW'; return out; } };\n";
const FILES = [['adapter.js', adapter], ['rules/rps.js', rule], ['old/adapter.js', old]];
const HASH = treeHashHex(FILES.map(([path, t]) => ({ path, bytes: new TextEncoder().encode(t) })));
const g = testHeadToHeadGame({ name: 'tree-rps', core: { name: 'tree rps', hash: HASH, configs: new Map([['cc'.repeat(32), {}]]) }, dev: 'tree-rps-dev' });
const pkgWith = (entry) => ({ format: 'arena-plugin/v1', name: 'tree-rps', manifest: toHex(encodeManifest(g.manifest)), ancestors: [],
  donationSet: testDonationSet('tree-rps-dev').map((r) => ({ recipientPk: toHex(r.recipientPk), shareBps: r.shareBps, label: r.label })),
  cores: [{ hash: HASH, name: 'tree rps', configs: ['cc'.repeat(32)], entry, files: FILES.map(([path, t]) => ({ path, body: Buffer.from(t).toString('base64') })) }], clients: [] });
const check = (entry) => verifyPackage(pkgWith(entry), { verify: verifyEd25519, want: toHex(g.gameId) });

test('#1489 r1120-refute-5-s1: the honest tree package (entry adapter.js) is verified', () => {
  const r = check('adapter.js');
  assert.equal(r.ok, true, r.why);
});

test('#1489 r1120-refute-5-s1 (a): a relaying seat swapping the entry to a helper file earns the genuine version a remembered trial verdict', () => {
  const r = check('rules/rps.js');
  console.log('  MEASURED entry swapped to rules/rps.js:', JSON.stringify({ ok: r.ok, trial: r.trial, why: r.why }).slice(0, 300));
  assert.equal(r.ok, false);
  // a refusal caused by an unsigned field must not be the verdict on the signed bytes (server.js trialRefused keeps `trial: true` 24 h)
  assert.notEqual(r.trial, true, 'an unsigned entry made the trial refuse the genuine signed tree: autoUpdate keeps that verdict for the game id');
});

test('#1489 r1120-refute-5-s1 (b): a relaying seat swapping the entry to another DECIDE file of the tree gets other code verified under the same id', () => {
  const r = check('old/adapter.js');
  console.log('  MEASURED entry swapped to old/adapter.js:', JSON.stringify({ ok: r.ok, why: r.why }).slice(0, 300));
  assert.equal(r.ok, false, 'the same signed game id verified with another entry: this seat runs code the developer did not name');
});
