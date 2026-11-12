// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1884, #1919, #1962 (re-check of #1511): the shared guard in public-fetch.js - redirects followed by hand at most REDIRECTS_MOST hops, each
// hop checked as the first; seat endpoints http/https on a public name or public IP literal; a seat's payout fetch never reaches an internal host.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { checkedFetch, REDIRECTS_MOST, seatUrlRefusal, seatPublicFetch, lnurlPublicFetch, walletUrlRefusal } from '../src/public-fetch.js';

const answer = (status, location) => ({ ok: status >= 200 && status < 300, status, headers: { get: (k) => (k === 'location' ? location : null) }, json: async () => ({}) });

test('#1962 redirects: each hop checked, at most REDIRECTS_MOST followed, never with the fetch\'s own follow', async () => {
  const asked = [];
  const loop = async (u, o) => { asked.push([u, o.redirect]); return answer(302, `https://wallet${asked.length}.example/next`); };
  const r = await checkedFetch('https://wallet0.example/start', { fetchFn: loop });
  assert.equal(r.status, 302);
  assert.equal(asked.length, REDIRECTS_MOST + 1);
  assert.ok(asked.every(([, how]) => how === 'manual'));
  const asked2 = [];
  const toInternal = async (u) => { asked2.push(u); return answer(301, 'https://127.0.0.1/admin'); };
  await assert.rejects(checkedFetch('https://wallet.example/x', { fetchFn: toInternal }), (e) => e.code === 'EINTERNALHOST');
  assert.deepEqual(asked2, ['https://wallet.example/x']);
  const toHttp = async () => answer(307, 'http://wallet.example/plain');
  await assert.rejects(checkedFetch('https://wallet.example/x', { fetchFn: toHttp }), (e) => e.code === 'EINTERNALHOST');
});

test('#1884 seat endpoints: public names and public IP literals only', () => {
  for (const u of ['http://127.0.0.1:8080/', 'http://localhost:1/', 'http://169.254.169.254/', 'http://[::1]:3/', 'http://10.1.2.3/', 'http://192.168.1.18:31221',
    'http://100.85.86.106/', 'http://seat.local/', 'http://2130706433/', 'ftp://seat.example/', 'http://u:p@seat.example/'])
    assert.ok(seatUrlRefusal(u), `${u} must be refused`);
  for (const u of ['https://seat.example.com/guardian-2', 'http://seat.example.com:31221', 'http://8.8.8.8:31221/'])
    assert.equal(seatUrlRefusal(u), null, `${u} must be taken`);
  assert.ok(walletUrlRefusal('https://8.8.8.8/'), 'a wallet is a name, never an IP literal');
});

test('#1884 #1919 the guarded fetches never reach 127.0.0.1, whatever name the URL uses', async () => {
  const hits = [];
  const internal = createServer((req, res) => { hits.push(req.url); res.writeHead(200); res.end('{}'); });
  await new Promise((r) => internal.listen(0, '127.0.0.1', r));
  const p = internal.address().port;
  try {
    for (const u of [`http://127.0.0.1:${p}/roles`, `http://localhost:${p}/owner`, `http://[::ffff:127.0.0.1]:${p}/served`])
      await assert.rejects(seatPublicFetch(u, { signal: AbortSignal.timeout(3000) }));
    for (const u of [`http://127.0.0.1:${p}/lnurlp/x`, `https://127.0.0.1:${p}/lnurlp/x`, `https://localhost:${p}/lnurlp/x`])
      await assert.rejects(lnurlPublicFetch(u, { signal: AbortSignal.timeout(3000) }));
    assert.deepEqual(hits, []);
  } finally { internal.close(); }
});
