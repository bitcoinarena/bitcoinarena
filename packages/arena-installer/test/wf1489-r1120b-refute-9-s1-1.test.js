// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute of #3048 ("a request target that is no URL is answered 400 by the attestor and EVERY OTHER DAEMON"):
// tools/chain-api.mjs - the Arena's own testnet4 block API that installer nodes read first (chain-bridge.js ARENA_ESPLORA,
// https://tn4.bitcoinarena.io/esplora) - still parses `new URL(req.url, 'http://x')` unguarded inside an ASYNC handler, with no
// last guard. `GET //[` rejects the handler's promise: an unhandled rejection, and the daemon exits. SAFE: 400, still serving.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';

const freePort = () => new Promise((r) => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const raw = (port, target) => new Promise((resolve) => {
  const s = net.connect(port, '127.0.0.1', () => s.write(`GET ${target} HTTP/1.1\r\nHost: x\r\n\r\n`));
  let got = ''; s.on('data', (d) => { got += d; }); s.on('error', () => resolve(got)); s.on('close', () => resolve(got));
  setTimeout(() => { s.destroy(); resolve(got); }, 2000);
});

test('one request with target //[ does not end the chain-api daemon', { timeout: 60000 }, async () => {
  const port = await freePort();
  const child = spawn(process.execPath, [new URL('../../../tools/chain-api.mjs', import.meta.url).pathname, String(port), 'http://127.0.0.1:1', '/nonexistent-cookie'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  let exited = null, err = '';
  child.on('exit', (code) => { exited = code; });
  child.stderr.on('data', (d) => { err += d; });
  try {
    let up = '';
    for (let i = 0; i < 100 && !/^HTTP\/1\.1 405/.test(up); i++) {
      up = await new Promise((resolve) => { const q = http.request({ host: '127.0.0.1', port, path: '/', method: 'POST', timeout: 1000 }, (r) => { r.resume(); resolve(`HTTP/1.1 ${r.statusCode}`); }); q.on('error', () => resolve('')); q.end(); });
      if (!up) await new Promise((r) => setTimeout(r, 100));
    }
    assert.match(up, /405/, 'the daemon never came up');
    const answer = await raw(port, '//[');
    await new Promise((r) => setTimeout(r, 500));
    console.log(`  after GET //[ : answer ${JSON.stringify(answer.split('\r\n')[0])}, process exit code ${exited}; stderr: ${err.split('\n').find((l) => /Error/.test(l)) || ''}`);
    assert.equal(exited, null, `the chain-api daemon exited (code ${exited}) on one request whose target is no URL`);
  } finally { child.kill(); }
});
