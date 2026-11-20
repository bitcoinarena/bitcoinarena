// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute of #3048/#3151, skeptic 2 (restart path): the last guard #3151 put on tools/chain-api.mjs swallows the server's
// EADDRINUSE. A restart whose port is still held no longer fails: the process logs "uncaught, kept running", has nothing left to run and
// ends with exit code 0 - a supervisor with Restart=on-failure takes that as a clean stop and the
// block API installer nodes read first stays down. SAFE: a listen failure ends the daemon with a non-zero code.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';

test('chain-api whose port is taken at start exits non-zero', { timeout: 30000 }, async () => {
  const holder = http.createServer((q, r) => { r.writeHead(418); r.end(); });
  const port = await new Promise((r) => holder.listen(0, '127.0.0.1', () => r(holder.address().port)));
  const child = spawn(process.execPath, [new URL('../../../tools/chain-api.mjs', import.meta.url).pathname, String(port), 'http://127.0.0.1:1', '/nonexistent-cookie'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  const code = await Promise.race([new Promise((r) => child.on('exit', (c) => r(c))), new Promise((r) => setTimeout(() => r('still running'), 8000))]);
  try {
    console.log(`  port ${port} taken: exit ${code}; ${out.split('\n').find((l) => /EADDRINUSE/.test(l))?.slice(0, 160) || ''}`);
    assert.notEqual(code, 'still running');
    assert.notEqual(code, 0, 'chain-api swallowed EADDRINUSE and exited 0: a Restart=on-failure supervisor never starts it again');
  } finally { child.kill(); holder.close(); }
});
