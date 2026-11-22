// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #3248: the site Worker's /api/opr/* door (src/website/worker.js): off without OPR_ORIGIN; passes the sign-in, the caller's address under the
// Worker's key, the admin code on admin paths only.
import test from 'node:test';
import assert from 'node:assert/strict';

test('#3248 the Worker passes /api/opr/* on to the round service', async () => {
  const worker = (await import('../../../src/website/worker.js')).default;
  const realFetch = globalThis.fetch, seen = [];
  globalThis.fetch = async (u, init = {}) => { seen.push({ u: String(u), method: init.method, h: Object.fromEntries(new Headers(init.headers)), body: init.body }); return new Response('{"ok":true}', { status: 200 }); };
  try {
    const off = await worker.fetch(new Request('https://testnet-stage.bitcoinarena.io/api/opr/round'), {}, null);
    assert.equal(off.status, 503);
    const env = { OPR_ORIGIN: 'http://opr.internal', OPR_WORKER_KEY: 'wk' };
    const r = await worker.fetch(new Request('https://testnet-stage.bitcoinarena.io/api/opr/submit', { method: 'POST', body: '{"a":1}',
      headers: { authorization: 'Nostr abc', 'x-arena-admin': 'code', 'cf-connecting-ip': '198.51.100.7' } }), env, null);
    assert.equal(r.status, 200);
    assert.equal(seen[0].u, 'http://opr.internal/submit');
    assert.equal(seen[0].h.authorization, 'Nostr abc'); assert.equal(seen[0].h['x-arena-ip'], '198.51.100.7'); assert.equal(seen[0].h['x-arena-worker'], 'wk');
    assert.equal(seen[0].h['x-arena-admin'], undefined);   // the admin code only on admin paths
    assert.equal(seen[0].body, '{"a":1}');
    await worker.fetch(new Request('https://testnet-stage.bitcoinarena.io/api/opr/admin/lists?round=test-1', { headers: { 'x-arena-admin': 'code' } }), env, null);
    assert.equal(seen[1].u, 'http://opr.internal/admin/lists?round=test-1'); assert.equal(seen[1].h['x-arena-admin'], 'code');
    assert.equal((await worker.fetch(new Request('https://testnet-stage.bitcoinarena.io/api/opr/round', { method: 'PUT' }), env, null)).status, 405);
  } finally { globalThis.fetch = realFetch; }
});
