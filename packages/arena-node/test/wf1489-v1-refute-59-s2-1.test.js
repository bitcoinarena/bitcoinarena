// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 refute of #1469 (skeptic 2): the shared BODY_BUDGET (49be47513) is taken from a DECLARED Content-Length before a
// byte arrives. A stranger opens 4 connections, each declares 8 MiB (BODY_MOST, the default door limit) and sends nothing: the
// whole 32 MiB budget is held for requestTimeout (120 s, renewable by reconnecting) with zero bytes of memory spent. Every honest
// POST with a body - a peer seat's /node-facts push, a client's entry - is now refused (503 / connection cut), retries included.
// On 85f803d70 the same honest POST is answered normally.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
const { openStore } = await import('../src/store.js');
const { serve } = await import('../src/server.js');

const post = (port, path, bytes) => new Promise((res) => {
  const r = request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': bytes.length } }, (x) => {
    let t = ''; x.on('data', (c) => { t += c; }); x.on('end', () => res(`${x.statusCode} ${t.slice(0, 80)}`)); });
  r.on('error', (e) => res(`closed (${e.code || e.message})`)); r.end(bytes);
});
const stranger = (port, n, declared) => `
const { connect } = require('node:net'); const socks = [];
(async () => { for (let i = 0; i < ${n}; i++) { const s = connect(${port}, '127.0.0.1'); s.on('error', () => {}); socks.push(s);
  await new Promise((r) => s.once('connect', r));
  s.write('POST /node-facts HTTP/1.1\\r\\nHost: x\\r\\nContent-Type: application/json\\r\\nContent-Length: ${declared}\\r\\n\\r\\n'); }
  console.log('sent'); setInterval(() => {}, 1000); })();`;

test('#1469 variant: 4 idle connections declaring 8 MiB each must not lock every honest POST out of the node', async () => {
  const b = await serve(openStore(':memory:'), { plugins: [], port: 0 });
  const body = Buffer.from('{}');
  const before = await post(b.port, '/node-facts', body);
  const child = spawn(process.execPath, ['-e', stranger(b.port, 4, 8 * 1024 * 1024)], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise((r) => child.stdout.once('data', r));
    await new Promise((r) => setTimeout(r, 500));
    const tries = [];
    for (let i = 0; i < 3; i++) { tries.push(await post(b.port, '/node-facts', body)); await new Promise((r) => setTimeout(r, 1000)); }
    const announce = await post(b.port, '/announce', Buffer.from('{"line":"x"}'));
    console.log('  FACTS (budget starvation):', JSON.stringify({ before, tries, announce }));
    for (const t of tries) assert.equal(t, before, `an honest 2-byte POST is refused while 4 idle connections hold the body budget: ${t}`);
    assert.doesNotMatch(announce, /^(503 |closed )/, `/announce refused: ${announce}`);
  } finally { child.kill('SIGKILL'); await b.close(); }
});
