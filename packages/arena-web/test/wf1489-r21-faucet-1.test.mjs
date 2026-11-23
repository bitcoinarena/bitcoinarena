// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #1489 r21 faucet 1 (P1, bypass of the #2754 fix): the stats Worker checks 'played-' events only on POST /api/send. Umami 3.4.1 (the live
// container arena-umami) also takes POST /api/batch - an array of { type, payload } items, each handed to the /api/send handler, no sign-in.
// Safe: a stranger's played-round event does not reach Umami through /api/batch either.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import stats from '../../../src/website/stats/worker.js';

test('#1489-r21-faucet-1 made-up played-round events in one POST /api/batch do not reach Umami', async () => {
  const passed = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (to, o = {}) => { passed.push({ url: String(to), body: typeof o.body === 'string' ? o.body : o.body ? await new Response(o.body).text() : '' }); return new Response('{"ok":true}', { status: 200 }); };
  try {
    const n = 25;
    const items = Array.from({ length: n }, (_, i) => ({ type: 'event', payload: { website: '024ff09e-c3a6-4dfd-bede-3163eb8be36a', hostname: 'testnet.bitcoinarena.io', url: '/played/nextblock',
      name: 'played-round', data: { game: 'nextblock' }, timestamp: Math.floor(Date.now() / 1000) - i * 60 } }));
    await stats.fetch(new Request('https://stats.bitcoinarena.io/api/batch', { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0' }, body: JSON.stringify(items) }),
      { ORIGIN: 'https://umami-tunnel.example', PLAYED_TOKEN: 's3cret-token' });
    const counted = passed.filter((p) => /played-round/.test(p.body)).reduce((s, p) => s + (p.body.match(/played-round/g) || []).length, 0);
    console.log('  MEASURED:', JSON.stringify({ posted: n, passedToUmami: counted, paths: passed.map((p) => new URL(p.url).pathname) }));
    assert.equal(counted, 0, `${counted} of ${n} made-up played-round events went on to Umami via /api/batch`);
  } finally { globalThis.fetch = realFetch; }
});
