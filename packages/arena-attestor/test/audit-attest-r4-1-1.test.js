// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Audit 2026-11-19 r4, module attest, round 1, finding 1: THE FIXED ATTESTOR DAEMON DIES ON ONE MALFORMED REQUEST TARGET.
// arena-attestor.mjs serves GET /attestation and /status on 0.0.0.0 (its peers pull words from it over the network), and its
// request handler starts with `new URL(req.url, 'http://x')` outside any try. A request target such as `//[` is accepted by
// Node's HTTP parser and makes `new URL` throw ERR_INVALID_URL inside the 'request' listener: an uncaught exception, and the
// daemon process exits. The seat (#1261) and the faucet (#2284) were fixed for exactly this; the attestor daemon was not.
// A stranger who knows an attestor's address repeats it: the attestor signs and posts no word, its words in memory are lost,
// and with two of the three attestors down past the signing hour every Up/Down round goes VOID - a refund the attacker can
// choose after watching the price. SAFE: the daemon answers 400 (or drops the socket) and keeps serving.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attestorKey } from '../src/attestor.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const SEED = new Uint8Array(32).fill(0x51);
const ME = attestorKey(SEED);
const freePort = () => new Promise((r) => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const status = (port) => new Promise((resolve) => {
  const q = http.get({ host: '127.0.0.1', port, path: '/status', timeout: 2000 }, (r) => { r.resume(); r.on('end', () => resolve(r.statusCode)); });
  q.on('error', () => resolve(null)); q.on('timeout', () => { q.destroy(); resolve(null); });
});
const raw = (port, target) => new Promise((resolve) => {
  const s = net.connect(port, '127.0.0.1', () => s.write(`GET ${target} HTTP/1.1\r\nHost: x\r\n\r\n`));
  let got = ''; s.on('data', (d) => { got += d; }); s.on('error', () => resolve(got)); s.on('close', () => resolve(got));
  setTimeout(() => { s.destroy(); resolve(got); }, 2000);
});

test('one request with target //[ does not end the attestor daemon', { timeout: 60000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-attest-r4-1-1-'));
  writeFileSync(join(dir, 'key'), SEED);
  writeFileSync(join(dir, 'samples'), '[]');
  const port = await freePort();
  const child = spawn(process.execPath, [new URL('../bin/arena-attestor.mjs', import.meta.url).pathname,
    '--name', 'T', '--key', join(dir, 'key'), '--sources', 'none,none', '--game', 'btc-updown-15m',
    '--attestors', toHex(ME.pubkey), '--threshold', '1', '--port', String(port), '--samples-file', join(dir, 'samples')],
  { stdio: ['ignore', 'pipe', 'pipe'] });
  let exited = null, err = '';
  child.on('exit', (code) => { exited = code; });
  child.stderr.on('data', (d) => { err += d; });
  try {
    let up = null;
    for (let i = 0; i < 100 && up !== 200; i++) { up = await status(port); if (up !== 200) await new Promise((r) => setTimeout(r, 100)); }
    assert.equal(up, 200, 'the daemon never came up');
    await raw(port, '//[');
    await new Promise((r) => setTimeout(r, 500));
    const after = await status(port);
    console.log(`  after GET //[ : process exit code ${exited}, GET /status -> ${after}${err ? `; stderr: ${err.split('\n').find((l) => /Error/.test(l)) || ''}` : ''}`);
    assert.equal(exited, null, `the attestor daemon exited (code ${exited}) on one request whose target is no URL`);
    assert.equal(after, 200, 'the attestor daemon no longer answers GET /status after one malformed request');
  } finally { child.kill(); }
});
