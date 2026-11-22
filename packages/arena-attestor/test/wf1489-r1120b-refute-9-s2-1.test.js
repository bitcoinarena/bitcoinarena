// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute of #3048, skeptic 2 (restart path): the last guard #3048 added to arena-attestor.mjs (uncaughtException logged,
// "kept running") also swallows the HTTP server's own 'error' event. On a restart whose port is still held (the old process not yet gone,
// another daemon on it), `listen` fails with EADDRINUSE: before #3048 the daemon exited 1 and its supervisor started it again; now it keeps
// sampling, signing and posting with NO HTTP server - peers can never pull its word (/attestation) and /status is gone, while the
// supervisor sees a live process and never restarts it. SAFE: a listen failure still ends the daemon (non-zero exit).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attestorKey } from '../src/attestor.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const SEED = new Uint8Array(32).fill(0x52);
const ME = attestorKey(SEED);

test('an attestor whose port is taken at start exits instead of running on with no HTTP server', { timeout: 60000 }, async () => {
  const holder = http.createServer((q, r) => { r.writeHead(418); r.end(); });
  const port = await new Promise((r) => holder.listen(0, '0.0.0.0', () => r(holder.address().port)));
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-r1120b-9-s2-1-'));
  writeFileSync(join(dir, 'key'), SEED);
  writeFileSync(join(dir, 'samples'), '[]');
  const child = spawn(process.execPath, [new URL('../bin/arena-attestor.mjs', import.meta.url).pathname,
    '--name', 'T', '--key', join(dir, 'key'), '--sources', 'none,none', '--game', 'btc-updown-15m',
    '--attestors', toHex(ME.pubkey), '--threshold', '1', '--port', String(port), '--samples-file', join(dir, 'samples')],
  { stdio: ['ignore', 'pipe', 'pipe'] });
  let exited = null, out = '';
  child.on('exit', (code) => { exited = code; });
  child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  try {
    for (let i = 0; i < 80 && exited === null; i++) await new Promise((r) => setTimeout(r, 100));
    console.log(`  port ${port} taken: exit code ${exited}; ${out.split('\n').find((l) => /EADDRINUSE/.test(l))?.slice(0, 200) || 'no EADDRINUSE line'}`);
    assert.notEqual(exited, null, 'the attestor kept running 8 s after its listen failed (EADDRINUSE swallowed by the last guard) - no HTTP server, no restart');
    assert.notEqual(exited, 0);
  } finally { child.kill(); holder.close(); }
});
