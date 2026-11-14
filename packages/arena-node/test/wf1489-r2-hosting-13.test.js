// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r2 hosting-13: THE DEPTH INSTRUMENTATION RUNS IN THE NODE'S OWN THREAD, QUADRATIC IN THE CORE'S FUNCTIONS
// (bypass of #1538's "one deadline, TRIAL_MS, for the whole trial", via #2220/#2476's instrumentCore).
// loadCore (core-sandbox.js) hands every core file to core-depth.js instrumentCore before any thread is started - in the seat's
// main thread, before the trial's deadline is looked at - and instrumentCore applies its edits one by one with
// out.slice(0, at) + s + out.slice(at): every edit copies the whole growing text, so N functions cost O(N x length). Measured:
// 5k arrows 142 ms, 10k 647 ms, 20k 2162 ms. A package's core is up to 16 MB (PEER_PACKAGE_BYTES): `()=>0,` six bytes a
// function. The scan passes such a source (it names nothing it refuses), so verifyPackage - an owner's install, autoUpdate on
// any signed next version of a hosted game, every restart's loadInstalled, every reload after the idle sweep - holds the seat's
// event loop for as long as the developer likes, and a new sibling version every sweep does it again.
// Safe behaviour: checking a package holds the node's thread no longer than the trial's bound (ASK_MS) - the instrumentation is
// linear, bounded, or done off the node's thread inside the deadline.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { verifyPackage } from '../src/plugin-package.js';
import { ASK_MS } from '../src/core-sandbox.js';
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

test('#1489 r2 hosting-13: checking a package with many small functions does not hold the seat\'s thread past the trial\'s bound', async () => {
  const N = 30000;   // 180 kB of `()=>0,` - a 16 MB package carries ninety times as many
  const src = `export const DECIDE = { name: 'many', decide(moves) { const out = {}; for (const m of moves) out[m.key] = 'DRAW'; return out; } };
export const SPARE = [${'()=>0,'.repeat(N)}];\n`;
  const { pkg, gameId } = pkgOf(src, { name: 'many' });
  let ticks = 0; const iv = setInterval(() => { ticks++; }, 10);
  const t0 = Date.now();
  const v = verifyPackage(pkg, { verify: verifyEd25519, want: gameId });
  const held = Date.now() - t0;
  clearInterval(iv);
  console.log(`source ${src.length} bytes, ${N} functions: verifyPackage held the node's thread ${held} ms (ticks meanwhile ${ticks}); ok=${v.ok} ${String(v.why || '').slice(0, 160)}`);
  assert.ok(held <= ASK_MS, `checking one ${Math.round(src.length / 1024)} kB core held the seat's thread ${held} ms (ASK_MS ${ASK_MS})`);
});
