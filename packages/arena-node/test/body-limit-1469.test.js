// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// EVERY BODY HAS A LIMIT (kanban #1469, feedback #001 by Hexbox Tools 2026-11-11): read() kept a body of any size before any check, on doors anyone may call.
// Now a body past ARENA_BODY_MOST (8 MiB by default) is dropped and the door answers 413 or ends the connection; a small body is still read; the node stays up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';

process.env.ARENA_BODY_MOST = '65536';   // set before server.js loads: a small limit, so the test sends 1 MiB, not 8
const { openStore } = await import('../src/store.js');
const { serve } = await import('../src/server.js');

const post = (port, path, bytes) => new Promise((res) => {
  const r = request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': bytes.length } }, (x) => {
    let t = ''; x.on('data', (c) => { t += c; }); x.on('end', () => res(`${x.statusCode} ${t.slice(0, 80)}`)); });
  r.on('error', (e) => res(`closed (${e.code || e.message})`)); r.end(bytes);
});

test('#1469 a body past the limit is refused at an open door (413 or the connection ended); a small one is still read; the node keeps answering', async () => {
  const b = await serve(openStore(':memory:'), { plugins: [], port: 0 });
  try {
    const big = Buffer.alloc(1024 * 1024, 0x61);
    const heapBefore = process.memoryUsage().heapUsed;
    const gotBig = await post(b.port, '/node-facts', big);
    const gotSmall = await post(b.port, '/node-facts', Buffer.from('{"not":"a record"}'));
    const alive = await new Promise((res) => request({ host: '127.0.0.1', port: b.port, path: '/identity' }, (x) => { x.resume(); res(x.statusCode); }).on('error', () => res(0)).end());
    console.log('  FACTS (#1469):', JSON.stringify({ big: gotBig, small: gotSmall, alive, heapGrowthMB: Math.round((process.memoryUsage().heapUsed - heapBefore) / 1e5) / 10 }));
    assert.match(gotBig, /^(413 |closed )/, `a 1 MiB body past a 64 KiB limit was read: ${gotBig}`);
    assert.doesNotMatch(gotSmall, /^413|^closed/, 'a small body was refused as too large');
    assert.equal(alive, 200);
  } finally { await b.close(); }
});
