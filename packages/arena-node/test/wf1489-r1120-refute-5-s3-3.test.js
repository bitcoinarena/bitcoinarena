// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r1120-refute-5-s3 (second copy): the owner page checks a package with its own copy of plugin-check.js, the committed bundle
// pages/owner-client.js (owner.html shortCheck -> C.checkPackage, NetworkAppsPanel). #3085, #3097/#3099/#3100 and #3112/#3113 changed
// src/plugin-check.js and the bundle was not rebuilt: it has no tree core at all, so the page refuses every honest tree package
// ("its cores are not a list of files (hash and source each)") that the seat verifies - the owner cannot install Next Block v8 from the page.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../pages/owner-client.js';
import { checkPackage } from '../src/plugin-check.js';
import { verifyEd25519 } from '../src/ed25519.js';
import { treePackage } from './wf1489-r1120-refute-5-s3-common.js';

const rule = "export const beats = (a, b) => (a - b + 3) % 3 === 1;\n";
const adapter = "import { beats } from './rules/rps.js';\nexport const DECIDE = { name: 'tree rps', decide(moves) { const out = {};\n"
  + "  for (const x of moves) { const w = moves.some((y) => y !== x && beats(x.move, y.move)), l = moves.some((y) => y !== x && beats(y.move, x.move));\n"
  + "    out[x.key] = w && !l ? 'WIN' : l && !w ? 'LOSS' : 'DRAW'; } return out; } };\n";

test('#1489 r1120-refute-5-s3-3: the owner page\'s bundled check takes the honest tree package the seat takes', () => {
  const { pkg, gameId } = treePackage('tree-page', [['adapter.js', adapter], ['rules/rps.js', rule]]);
  const seat = checkPackage(JSON.parse(JSON.stringify(pkg)), { verify: verifyEd25519, want: gameId });
  const page = C.checkPackage(JSON.parse(JSON.stringify(pkg)), { verify: C.verifyEd25519, want: gameId });
  console.log('  MEASURED seat vs page:', JSON.stringify({ seat: seat.ok, seatWhy: seat.why, page: page.ok, pageWhy: page.why }));
  assert.equal(seat.ok, true, seat.why);
  assert.equal(page.ok, true, `the page refuses what the seat takes: ${page.why}`);
});
