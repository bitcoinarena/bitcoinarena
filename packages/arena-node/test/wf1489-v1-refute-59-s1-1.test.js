// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 refute of #1469 (every request body has a limit): the arbiter's doors (serveArbiter: POST /musig/nonce,
// /musig/partial, /liquidation-claims - pages call them, CORS *) still buffer a body of any size before any check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { serveArbiter } from '../src/arbiter.js';

const post = (port, path, bytes) => new Promise((res) => {
  const r = request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': bytes.length } }, (x) => {
    let t = ''; x.on('data', (c) => { t += c; }); x.on('end', () => res(`${x.statusCode} ${t.slice(0, 80)}`)); });
  r.on('error', (e) => res(`closed (${e.code || e.message})`)); r.end(bytes);
});

test('#1469 variant: the arbiter refuses a 64 MiB body (413 or the connection ended), it does not read it whole', async () => {
  const arb = await serveArbiter({ set: { network: 'regtest', k: 5, members: [], keys: [] }, allow: () => ({ ok: false }) });
  try {
    const big = Buffer.alloc(64 * 1024 * 1024, 0x61);
    const got = await post(arb.port, '/musig/nonce', big);
    console.log('  FACTS (arbiter):', JSON.stringify({ got }));
    assert.match(got, /^(413 |closed )/, `a 64 MiB body was read whole by the arbiter: ${got}`);
  } finally { await arb.close(); }
});
