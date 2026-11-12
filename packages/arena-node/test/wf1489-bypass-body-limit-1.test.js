// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 BYPASS of the #1469 body limit: the fix capped read() in server.js, but serveArbiter (src/arbiter.js) is a
// SECOND http server with its own body reader - `req.on('data', d => s += d)` with NO cap - on its open POST doors
// (/musig/nonce, /musig/partial). A stranger POSTs one body far above ARENA_BODY_MOST and the arbiter buffers all of it
// before any check, the exact memory-exhaustion effect #001/#1469 was meant to stop. FAILS on f64efd1bb (body read whole).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';

process.env.ARENA_BODY_MOST = '65536';   // the #1469 limit is 64 KiB here; the arbiter ignores it entirely
const { arbitrationMembers, serveArbiter } = await import('../src/arbiter.js');

const post = (port, path, bytes) => new Promise((res) => {
  const r = request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': bytes.length } }, (x) => {
    let t = ''; x.on('data', (c) => { t += c; }); x.on('end', () => res(`${x.statusCode} ${t.slice(0, 80)}`)); });
  r.on('error', (e) => res(`closed (${e.code || e.message})`)); r.end(bytes);
});

test('#1469 bypass: the arbiter buffers an unbounded POST body (no 413, no close) - memory exhausted on an open door the fix never touched', async () => {
  const set = arbitrationMembers('regtest');
  const arb = await serveArbiter({ set, allow: () => ({ ok: false, why: 'no' }) });
  try {
    const big = Buffer.alloc(8 * 1024 * 1024, 0x61);   // 8 MiB, 128x the 64 KiB ARENA_BODY_MOST limit
    const heapBefore = process.memoryUsage().heapUsed;
    const gotBig = await post(arb.port, '/musig/nonce', big);
    const gotSmall = await post(arb.port, '/musig/nonce', Buffer.from('{"not":"a record"}'));
    const alive = await new Promise((res) => request({ host: '127.0.0.1', port: arb.port, path: '/status' }, (x) => { x.resume(); res(x.statusCode); }).on('error', () => res(0)).end());
    console.log('  ARBITER (wf1489):', JSON.stringify({ big: gotBig, small: gotSmall, alive, heapGrowthMB: Math.round((process.memoryUsage().heapUsed - heapBefore) / 1e5) / 10 }));
    // The fix's own assertion, applied to the arbiter door: a body past the limit must be refused (413) or the connection ended.
    assert.match(gotBig, /^(413 |closed )/, `an 8 MiB body past a 64 KiB limit was read whole at the arbiter: ${gotBig}`);
  } finally { await arb.close(); }
});
