// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3067: a core that runs out of its thread's heap WHILE V8 COMPILES IT aborted the whole seat process (SIGABRT,
// FatalProcessOutOfMemory in CompileModule - the worker's resourceLimits end JS, not a compile). The package of #3052: a valid DECIDE
// adapter plus 1.8M `()=>0` functions, within PEER_PACKAGE_BYTES. Safe: verifyPackage, run in a child process standing in for the seat,
// answers a refusal and the process exits normally - it is not killed by a signal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CHILD = `
import { createHash } from 'node:crypto';
import { verifyPackage } from '../src/plugin-package.js';
import { PEER_PACKAGE_BYTES } from '../src/peer-read.js';
import { verifyEd25519 } from '../src/ed25519.js';
import { testHeadToHeadGame, testDonationSet } from './plugins/sign.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { encodeManifest, gameIdOf } from '../../arena-protocol/src/manifest.js';
const sha = (b) => createHash('sha256').update(b).digest('hex');
const N = 1800000, name = 'many';
const src = "export const DECIDE = { name: 'many', decide(moves) { const out = {}; for (const m of moves) out[m.key] = 'DRAW'; return out; } };\\nexport const SPARE = [" + '()=>0,'.repeat(N) + "];\\n";
const core = { name, hash: sha(Buffer.from(src)), configs: new Map([['11'.repeat(32), {}]]) };
const game = testHeadToHeadGame({ name, core, moveCount: 3 });
const pkg = { format: 'arena-plugin/v1', name, manifest: toHex(encodeManifest(game.manifest)),
  donationSet: testDonationSet(name).map((r) => ({ recipientPk: toHex(r.recipientPk), shareBps: r.shareBps, label: r.label })),
  cores: [{ hash: core.hash, name, configs: ['11'.repeat(32)], source: Buffer.from(src).toString('base64') }], clients: [] };
if (Buffer.byteLength(JSON.stringify(pkg)) > PEER_PACKAGE_BYTES) throw new Error('package over the peer bound');
const v = verifyPackage(pkg, { verify: verifyEd25519, want: toHex(gameIdOf(game.manifest)) });
await new Promise((r) => setTimeout(r, 3000));   // a thread that dies after the answer still takes the process
console.log('RESULT ' + JSON.stringify({ ok: v.ok, why: String(v.why || '').slice(0, 200) }));
`;

test('#3067 a core that runs out of heap while it compiles is refused, and the seat process lives', { timeout: 240000 }, () => {
  const dir = fileURLToPath(new URL('.', import.meta.url));
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', CHILD], { cwd: dir, encoding: 'utf8', timeout: 200000, maxBuffer: 1 << 24 });
  const said = (r.stdout.match(/RESULT (.*)/) || [])[1];
  console.log(`  MEASURED: status ${r.status} signal ${r.signal} said ${said} stderr ${String(r.stderr).split('\n').filter((l) => /memory|Error/i.test(l)).slice(0, 2).join(' | ')}`);
  assert.equal(r.signal, null, `the seat process was killed by ${r.signal}`);
  assert.equal(r.status, 0, 'the seat process exits normally');
  assert.ok(said && JSON.parse(said).ok === false, 'the package is refused');
});
