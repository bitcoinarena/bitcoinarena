// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #3334 (audit 2 #3330): the Tailscale funnel path /opr and tn4.bitcoin-arena.io/opr reached the round service without the site Worker. A request
// that came through a proxy without the Worker's key is refused on every route; the Worker (its key) and direct local calls still answer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { world, openRound } from './server-helpers.mjs';

test('#3334 proxied without the Worker key: 403 on every route; with the key, or direct on this host: answered', async () => {
  const w = world({ start: '2026-11-23T01:00:00Z', cfg: { workerKey: 'wk-secret', entrySats: 0 } });
  await openRound(w);
  const srv = createServer((q, s) => w.opr.handle(q, s)); await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    for (const h of [{ 'x-forwarded-for': '203.0.113.9' }, { 'tailscale-funnel-request': '?1' }, { forwarded: 'for=203.0.113.9' }, { 'x-forwarded-for': '203.0.113.9', 'x-arena-worker': 'wrong-key!' }]) {
      for (const [m, p] of [['GET', '/round'], ['GET', '/board'], ['GET', '/rounds'], ['GET', '/me'], ['POST', '/lnaddress'], ['POST', '/x'], ['GET', '/admin/rounds'], ['GET', '/nosuch']]) {
        const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json', ...h }, body: m === 'POST' ? '{}' : undefined });
        assert.equal(r.status, 403, `${m} ${p} with ${JSON.stringify(h)}: ${r.status}`);
      }
    }
    assert.equal((await fetch(base + '/round', { headers: { 'x-forwarded-for': '203.0.113.9', 'x-arena-worker': 'wk-secret', 'x-arena-ip': '203.0.113.9' } })).status, 200, 'the Worker');
    assert.equal((await fetch(base + '/api/opr/round')).status, 200, 'direct on this host');
  } finally { srv.close(); }
});
