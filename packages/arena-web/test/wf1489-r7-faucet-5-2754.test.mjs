// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2754, #1489 r7 faucet 5 (P1 self-declared, played counting): the played rounds in Umami are the explorer's own count - sendPlayed posts one
// 'played-round' / 'played-entry' event per real round and entry, admin and bot rounds left out (kanban #1110, the owner: "die events in umami
// muessen mit unseren gespielten runden im explorer übereinstimmen, admin und bot runden ausgenommen"). It posts them to the public
// stats.bitcoinarena.io/api/send with the site id it ships in its source, and the stats Worker passes EVERY request to Umami as it is. Anyone can
// post the same event, with any game and any timestamp, so the played-round numbers the owner reads in Umami are whatever a stranger sends.
// Safe: the stats Worker does not pass a stranger's 'played-round' / 'played-entry' event on to Umami (only the explorer's, which it can tell apart).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import stats from '../../../src/website/stats/worker.js';

test('#1489-r7-faucet-5 a stranger\'s played-round event is not counted by Umami through the stats Worker', async () => {
  const passed = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (to, o = {}) => { passed.push({ url: String(to), body: o.body ? await new Response(o.body).text() : '' }); return new Response('{"ok":true}', { status: 200 }); };
  try {
    const n = 25;
    for (let i = 0; i < n; i++) {
      const body = JSON.stringify({ type: 'event', payload: { website: '024ff09e-c3a6-4dfd-bede-3163eb8be36a', hostname: 'testnet.bitcoinarena.io', url: '/played/nextblock',
        name: 'played-round', data: { game: 'nextblock' }, timestamp: Math.floor(Date.now() / 1000) - i * 60 } });
      const r = await stats.fetch(new Request('https://stats.bitcoinarena.io/api/send', { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0' }, body }),
        { ORIGIN: 'https://umami-tunnel.example' });
      assert.ok(r);
    }
    const counted = passed.filter((p) => /\/api\/send$/.test(new URL(p.url).pathname) && /played-round/.test(p.body)).length;
    console.log('  MEASURED:', JSON.stringify({ posted: n, passedToUmami: counted }));
    assert.equal(counted, 0, `${counted} of ${n} made-up played-round events went on to Umami`);
  } finally { globalThis.fetch = realFetch; }
});

test('kanban #2754: the explorer\'s played-round event (the shared secret) and every page event still reach Umami, the secret header does not', async () => {
  const passed = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (to, o = {}) => { passed.push({ url: String(to), body: typeof o.body === 'string' ? o.body : o.body ? await new Response(o.body).text() : '', header: new Headers(o.headers).get('x-arena-played') }); return new Response('{"ok":true}', { status: 200 }); };
  const env = { ORIGIN: 'https://umami-tunnel.example', PLAYED_TOKEN: 's3cret-token' };
  const send = (name, headers = {}) => stats.fetch(new Request('https://stats.bitcoinarena.io/api/send', { method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ type: 'event', payload: { website: '024ff09e-c3a6-4dfd-bede-3163eb8be36a', hostname: 'testnet.bitcoinarena.io', url: '/x', name } }) }), env);
  try {
    assert.equal((await send('played-round', { 'x-arena-played': 's3cret-token' })).status, 200);
    assert.equal((await send('played-entry', { 'x-arena-played': 'wrong-token' })).status, 204);
    assert.equal((await send('played-entry')).status, 204);
    assert.equal((await send('page-open')).status, 200);
    await stats.fetch(new Request('https://stats.bitcoinarena.io/script.js'), env);
    assert.deepEqual(passed.map((p) => [new URL(p.url).pathname, /played-round/.test(p.body), /page-open/.test(p.body), p.header]),
      [['/api/send', true, false, null], ['/api/send', false, true, null], ['/script.js', false, false, null]]);
  } finally { globalThis.fetch = realFetch; }
});
