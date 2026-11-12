// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 v1-refute-20 skeptic 2 (re-check of #1511, the HONEST path): the fix follows no redirect at all (publicFetch never, an injected fetch
// with redirect: 'error'). A Lightning address on one's own domain is very often a redirect (the usual set-up: name@mydomain.com, mydomain.com's
// /.well-known/lnurlp/* 301 to the wallet provider's public endpoint). Such an address now "does not work", and POST /feedback refuses the whole
// report ("That Lightning address does not work: its wallet could not be reached"). Safe: a redirect to another PUBLIC wallet host is followed (each
// hop checked as the first), so the address works. The fetchFn stands for DNS + TLS of two public hosts only; how redirects are handled is left to
// the code under test (fetch's own `redirect` option, as asked).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { lnAddressWorks } from '../src/feedback-store.js';

test('#1489 v1-refute-20-s2-2: a Lightning address whose domain redirects to its public wallet provider is refused', async () => {
  const provider = createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ tag: 'payRequest', callback: 'https://getalby.example/lnurlp/alice/callback', minSendable: 1000, maxSendable: 1e9, metadata: '[["text/plain","alice"]]' })); });
  await new Promise((r) => provider.listen(0, '127.0.0.1', r));
  const own = createServer((req, res) => { res.writeHead(301, { location: 'https://getalby.example/.well-known/lnurlp/alice' }); res.end(); });
  await new Promise((r) => own.listen(0, '127.0.0.1', r));
  const hosts = { 'alice.example': own.address().port, 'getalby.example': provider.address().port };
  const fetchFn = (u, o = {}) => { const x = new URL(String(u)); const p = hosts[x.hostname]; if (!p) return Promise.reject(Object.assign(new Error('no such host'), { code: 'ENOTFOUND' }));
    return fetch(`http://127.0.0.1:${p}${x.pathname}${x.search}`, o); };
  try {
    const w = await lnAddressWorks('alice@alice.example', { fetchFn, timeoutMs: 3000 });
    console.log('  FACTS v1-refute-20-s2-2:', JSON.stringify(w));
    assert.equal(w.ok, true, `an address redirecting to a public wallet provider was refused: ${w.why}`);
  } finally { own.close(); provider.close(); }
});
