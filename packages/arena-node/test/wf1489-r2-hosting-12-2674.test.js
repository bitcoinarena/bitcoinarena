// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r2 hosting-12: THE TRIAL NEVER ASKS THE QUESTION THE SEAT ASKS (bypass of #1538 / #1694 by the call's input).
// plugin-trial.js calls every decide adapter as decide({ moves }) with keys 'p0', 'p1', ... and no config; the seat calls it
// (verify.js #headToHeadClose) as decide({ moves, config }) with each entry's 64-hex id and the installed config ({}). An
// adapter that spins only when a config is handed passes the scan and the trial, is installed (an owner's click, or autoUpdate
// unattended on the developer's next signed version), and then holds the seat's own thread ASK_MS (Atomics.wait) on every
// decide - and a decide that fails is not stored, so the finality watch retries it every 2 s, once per entry of the round:
// a ten-entry round holds the seat about 20 s of every 2 s tick through its objection window, every game's rounds with it.
// Safe behaviour: what passed the trial answers the seat's own call shape inside the trial's bound (TRIAL_MS), or the trial
// refuses it - the seat never holds its thread longer for a core than the trial allowed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyPackage, installPackage, registrationFromPackage } from '../src/plugin-package.js';
import { TRIAL_MS } from '../src/plugin-trial.js';
import { sandboxFor } from '../src/core-sandbox.js';
import { verifyEd25519 } from '../src/ed25519.js';
import { testHeadToHeadGame, testDonationSet } from './plugins/sign.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { encodeManifest, gameIdOf } from '../../arena-protocol/src/manifest.js';

const sha = (b) => createHash('sha256').update(b).digest('hex');
function pkgOf(src, { name, moveCount = 3 }) {
  const core = { name, hash: sha(Buffer.from(src)), configs: new Map([['11'.repeat(32), {}]]) };
  const game = testHeadToHeadGame({ name, core, moveCount });
  return { gameId: toHex(gameIdOf(game.manifest)), hash: core.hash, pkg: { format: 'arena-plugin/v1', name, manifest: toHex(encodeManifest(game.manifest)),
    donationSet: testDonationSet(name).map((r) => ({ recipientPk: toHex(r.recipientPk), shareBps: r.shareBps, label: r.label })),
    cores: [{ hash: core.hash, name, configs: ['11'.repeat(32)], source: Buffer.from(src).toString('base64') }], clients: [] } };
}

test('#1489 r2 hosting-12: an adapter that passed the trial answers the seat\'s own decide inside the trial\'s bound', async () => {
  const src = `export const DECIDE = { name: 'config-faced', decide(moves, config) {
  if (config !== undefined) { let n = 0; for (let i = 0; i < 1e12; i++) n += i; }
  const out = {}; const best = Math.max(...moves.map((m) => m.move)); const w = moves.filter((m) => m.move === best).length;
  for (const m of moves) out[m.key] = w === moves.length ? 'DRAW' : m.move === best ? 'WIN' : 'LOSS'; return out; } };\n`;
  const { pkg, gameId, hash } = pkgOf(src, { name: 'config-faced' });
  const v = verifyPackage(pkg, { verify: verifyEd25519, want: gameId });
  console.log(`checks + trial: ok=${v.ok} ${v.why || ''} ${(v.checks || []).at(-1)?.detail || ''}`);
  if (!v.ok) return;   // refused by the trial: safe
  const at = installPackage(mkdtempSync(join(tmpdir(), 'wf1489-r2-hosting-12-')), pkg, gameId);
  const reg = await registrationFromPackage(at, pkg);
  const core = reg.cores.get(hash);
  const box = sandboxFor(core);
  const config = core.configs.get('11'.repeat(32));
  // the call verify.js makes at a round's close, and again at each retry of each entry (two entries here)
  const moves = [{ key: 'aa'.repeat(32), move: 0 }, { key: 'bb'.repeat(32), move: 1 }];
  const held = [];
  for (let i = 0; i < 2; i++) {
    const t0 = Date.now(); let why = 'answered';
    try { box.call('decide', { moves, config }); } catch (e) { why = e.message; }
    held.push(Date.now() - t0);
    console.log(`seat decide #${i + 1}: held the node's thread ${held[i]} ms - ${String(why).slice(0, 120)}`);
  }
  assert.ok(held.every((ms) => ms <= TRIAL_MS), `an adapter the trial passed held the seat's thread ${held.join(' + ')} ms on its own decide (TRIAL_MS ${TRIAL_MS})`);
});
