// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Audit r4 hosting-1 (gap in the #2675 fix): instrumentCore was made linear, but it still runs in the seat's own thread, before
// the trial's deadline is looked at, on a core as large as a peer's package may carry (PEER_PACKAGE_BYTES 16 MB, about 12 MB of
// source), and its output is ~18x its input. #2675's own test uses 30k functions (180 kB); at the package bound (about 1.9M
// `()=>0,`) one verifyPackage holds the node's thread for seconds and builds a ~200 MB string in it.
// Safe behaviour (the #2675 claim): checking one package holds the node's thread no longer than the trial's bound (ASK_MS).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { verifyPackage } from '../src/plugin-package.js';
import { ASK_MS } from '../src/core-sandbox.js';
import { PEER_PACKAGE_BYTES } from '../src/peer-read.js';
import { verifyEd25519 } from '../src/ed25519.js';
import { testHeadToHeadGame, testDonationSet } from './plugins/sign.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { encodeManifest, gameIdOf } from '../../arena-protocol/src/manifest.js';

const sha = (b) => createHash('sha256').update(b).digest('hex');
function pkgOf(src, { name, moveCount = 3 }) {
  const core = { name, hash: sha(Buffer.from(src)), configs: new Map([['11'.repeat(32), {}]]) };
  const game = testHeadToHeadGame({ name, core, moveCount });
  return { gameId: toHex(gameIdOf(game.manifest)), pkg: { format: 'arena-plugin/v1', name, manifest: toHex(encodeManifest(game.manifest)),
    donationSet: testDonationSet(name).map((r) => ({ recipientPk: toHex(r.recipientPk), shareBps: r.shareBps, label: r.label })),
    cores: [{ hash: core.hash, name, configs: ['11'.repeat(32)], source: Buffer.from(src).toString('base64') }], clients: [] } };
}

test('audit r4 hosting-1: a package at the peer size bound does not hold the seat\'s thread past ASK_MS (gap in #2675)', async () => {
  const N = 1800000;
  const src = `export const DECIDE = { name: 'many', decide(moves) { const out = {}; for (const m of moves) out[m.key] = 'DRAW'; return out; } };
export const SPARE = [${'()=>0,'.repeat(N)}];\n`;
  const { pkg, gameId } = pkgOf(src, { name: 'many' });
  const bytes = Buffer.byteLength(JSON.stringify(pkg));
  assert.ok(bytes <= PEER_PACKAGE_BYTES, `the package is ${bytes} bytes, within the ${PEER_PACKAGE_BYTES} a seat reads from a peer`);
  const t0 = Date.now();
  const v = verifyPackage(pkg, { verify: verifyEd25519, want: gameId });
  const held = Date.now() - t0;
  console.log(`package ${bytes} bytes, ${N} functions: verifyPackage held the node's thread ${held} ms; ok=${v.ok} ${String(v.why || '').slice(0, 160)}`);
  assert.ok(held <= ASK_MS, `checking one ${Math.round(bytes / 1048576)} MB package held the seat's thread ${held} ms (ASK_MS ${ASK_MS})`);
});
