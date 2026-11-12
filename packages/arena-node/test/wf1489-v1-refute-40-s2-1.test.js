// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 refute 2 of #1537: the global cap counts address CHECKS, not outbound fetches. lnAddressWorks fetches with the default
// redirect: 'follow', so one check of a caller's address follows up to 20 redirects the caller's host answers - to any host, an internal one too
// (the #1511 public-name guard is applied only to the first URL). One counted check = many fetches, and the cap is not a hard limit on fetches.
// Safe: one check makes exactly one request, and a redirect to an internal host is never followed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { lnAddressWorks } from '../src/feedback-store.js';

const listen = (h) => new Promise((ok) => { const s = createServer(h); s.listen(0, '127.0.0.1', () => ok(s)); });
test('#1489 refute #1537: one counted address check follows the caller host\'s redirects to an internal host', async () => {
  let inner = 0, outer = 0;
  const internal = await listen((req, res) => { inner++; res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"status":"ERROR","reason":"internal"}'); });
  const ip = internal.address().port;
  const evil = await listen((req, res) => { outer++; const n = Number(String(req.url).split('/').pop()) || 0;
    res.writeHead(302, { location: n < 15 ? `/hop/${n + 1}` : `http://127.0.0.1:${ip}/admin/secret` }); res.end(); });
  const ep = evil.address().port;
  // the caller's public host (wallet.example.com) is served by the local "evil" server; every option lnAddressWorks passes reaches the real fetch
  const fetchFn = (url, opts) => fetch(String(url).replace(/^https:\/\/wallet\.example\.com/, `http://127.0.0.1:${ep}`), opts);
  try {
    const w = await lnAddressWorks('x@wallet.example.com', { fetchFn });
    console.log('  MEASURED:', JSON.stringify({ answer: w, requestsToCallerHost: outer, requestsToInternalHost: inner }));
    assert.equal(inner, 0, `one check reached an internal host (http://127.0.0.1:${ip}/admin/secret) through the caller's redirect`);
    assert.ok(outer <= 1, `one check made ${outer} requests to the caller's host`);
  } finally { evil.close(); internal.close(); }
});
