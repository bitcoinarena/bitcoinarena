// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 round 4 (hosting): loadInstalled (main.js, every start) runs the whole plugin trial again on every installed
// package, one after another in directory order (game id hex). The trial has ONE wall-clock deadline (TRIAL_MS, 1.5 s) and,
// since #1880/#1913, refuses at once with `retry` ("an earlier trial's core thread is still ending") while an earlier trial's
// thread lingers in an uninterruptible builtin. autoUpdate treats `retry` as "no verdict yet"; loadInstalled treats it as a
// refusal: the game is left out of the seat for the whole process, nothing tries it again. So one installed game whose trial
// thread lingers at start - an adapter tuned to finish its trial in ~1.2 s on an idle seat (it is installed) and to miss the
// 1.5 s deadline inside one long sort under start-up load (its developer grinds its game id to sort first) - takes every
// installed game after it off the seat at each restart: their rounds refused, their head-to-head closes unsigned.
// Safe behaviour: an honest installed package is hosted at start whatever the trial of the package before it did.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadInstalled, installPackage } from '../src/plugin-package.js';
import { verifyEd25519 } from '../src/ed25519.js';
import { lingeringCores } from '../src/core-sandbox.js';
import { testHeadToHeadGame, testDonationSet } from './plugins/sign.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { encodeManifest } from '../../arena-protocol/src/manifest.js';

const sha = (b) => createHash('sha256').update(b).digest('hex');
function pkgOf(src, { name, moveCount = 3 }) {
  const core = { name, hash: sha(Buffer.from(src)), configs: new Map([['11'.repeat(32), {}]]) };
  const game = testHeadToHeadGame({ name, core, moveCount });
  const pkg = { format: 'arena-plugin/v1', name, manifest: toHex(encodeManifest(game.manifest)),
    donationSet: testDonationSet(name).map((r) => ({ recipientPk: toHex(r.recipientPk), shareBps: r.shareBps, label: r.label })),
    cores: [{ hash: core.hash, name, configs: ['11'.repeat(32)], source: Buffer.from(src).toString('base64') }], clients: [] };
  return { pkg, id: toHex(game.gameId) };
}

const LCG = `let s = 12345; const rnd = () => (s = (Math.imul(s, 1103515245) + 12345) >>> 0);`;
// the attacker's adapter: its first decide runs ONE long default sort (not interrupted by terminate()) - here sized past the
// trial's deadline, as a sort sized near it misses the deadline on a busy seat
const SORT = `${LCG} const a = new Array(6e6); for (let i = 0; i < a.length; i++) a[i] = rnd(); a.sort();`;
const LINGER = (tag) => `let done = 0;\nexport const DECIDE = { name: "${tag}", decide(moves) { if (!done) { done = 1; ${SORT} }\nconst out = {}; for (const m of moves) out[m.key] = "DRAW"; return out; } };`;
const HONEST = `export const DECIDE = { name: "honest", decide(moves) { const out = {}; for (const m of moves) out[m.key] = moves[0].move === moves[1].move ? "DRAW" : "WIN"; if (moves[0].move !== moves[1].move) out[moves[1].key] = "LOSS"; return out; } };`;

test('an honest installed game is hosted at start even when the installed game before it lingers in its trial', async () => {
  const honest = pkgOf(HONEST, { name: 'honest-installed' });
  // the attacker grinds a game id that sorts before the honest one (readdir order)
  let bad = null;
  for (let i = 0; i < 400 && !bad; i++) { const p = pkgOf(LINGER(`g${i}`), { name: `grind-${i}` }); if (p.id < honest.id) bad = p; }
  assert.ok(bad, 'found an id that sorts first');
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-r4-hosting-7-'));
  installPackage(dir, bad.pkg, bad.id);
  installPackage(dir, honest.pkg, honest.id);
  const { registrations, refused } = await loadInstalled(dir, { verify: verifyEd25519 });
  console.log('refused at start:', refused.map((r) => `${r.dir.slice(-16)}: ${String(r.why).slice(0, 140)}`));
  const hosted = registrations.map((r) => toHex(r.gameId));
  assert.ok(hosted.includes(honest.id), `the honest installed game was left out at start: ${(refused.find((r) => r.dir.endsWith(honest.id)) || {}).why}`);
  for (let t = Date.now(); lingeringCores() && Date.now() - t < 60000;) await new Promise((r) => setTimeout(r, 50));
});
