// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #3265: the STAGE Worker (src/website-stage/worker.js, testnet-stage.bitcoinarena.io) passes /api/opr/* on to the round service as the site Worker
// does; off without OPR_ORIGIN; the game's short address opens the page on the game; every other path is still the Pages branch `stage`.
import test from 'node:test';
import assert from 'node:assert/strict';

test('#3265 the stage Worker passes /api/opr/* on, and /orange-pill-run opens the game', async () => {
  const worker = (await import('../../../src/website-stage/worker.js')).default;
  const realFetch = globalThis.fetch, seen = [];
  globalThis.fetch = async (u, init = {}) => { const req = u instanceof Request ? u : null;
    seen.push({ u: String(req ? req.url : u), method: (req || init).method, h: Object.fromEntries(new Headers((req || init).headers)), body: init.body }); return new Response('{"ok":true}', { status: 200 }); };
  try {
    assert.equal((await worker.fetch(new Request('https://testnet-stage.bitcoinarena.io/api/opr/round'), {}, null)).status, 503);
    const env = { OPR_ORIGIN: 'https://tunnel.example/opr', OPR_WORKER_KEY: 'wk' };
    const r = await worker.fetch(new Request('https://testnet-stage.bitcoinarena.io/api/opr/attempt', { method: 'POST', body: '{"round":"test-1"}',
      headers: { authorization: 'Nostr abc', 'x-arena-admin': 'code', 'cf-connecting-ip': '198.51.100.7' } }), env, null);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.deepEqual([seen[0].u, seen[0].method, seen[0].body], ['https://tunnel.example/opr/attempt', 'POST', '{"round":"test-1"}']);
    assert.equal(seen[0].h.authorization, 'Nostr abc'); assert.equal(seen[0].h['x-arena-ip'], '198.51.100.7'); assert.equal(seen[0].h['x-arena-worker'], 'wk');
    assert.equal(seen[0].h['x-arena-admin'], undefined);
    await worker.fetch(new Request('https://testnet-stage.bitcoinarena.io/api/opr/board?round=test-1'), env, null);
    assert.equal(seen[1].u, 'https://tunnel.example/opr/board?round=test-1');
    assert.equal((await worker.fetch(new Request('https://testnet-stage.bitcoinarena.io/api/opr/round', { method: 'PUT' }), env, null)).status, 405);
    assert.equal((await worker.fetch(new Request('https://testnet-stage.bitcoinarena.io/api/opr/a%2Fb'), env, null)).status, 404);   // only plain paths
    const go = await worker.fetch(new Request('https://testnet-stage.bitcoinarena.io/orange-pill-run'), env, null);
    assert.equal(go.status, 302); assert.equal(go.headers.get('location'), 'https://testnet-stage.bitcoinarena.io/?game=orange-pill-run');
    const n = seen.length;
    await worker.fetch(new Request('https://testnet-stage.bitcoinarena.io/games/orange-pill-run/index.html'), env, null);
    assert.equal(seen[n].u, 'https://stage.bitcoin-arena-site.pages.dev/games/orange-pill-run/index.html');
  } finally { globalThis.fetch = realFetch; }
});
