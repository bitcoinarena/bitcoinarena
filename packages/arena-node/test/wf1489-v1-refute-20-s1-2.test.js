// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 v1-refute-20 (re-check of #1511): lnAddressWorks checks only the FIRST URL's host; fetch follows redirects (no redirect: 'manual'
// or 'error'). A public wallet host answers 302 Location: http://127.0.0.1:<port>/internal/admin and the faucet fetches the internal URL - and
// echoes its status and up to 120 chars of its JSON 'reason'. Safe: no request reaches the internal host.
// The test's fetchFn stands in for DNS + TLS of the attacker's public host only (wallet.example -> a local plain-HTTP server); the redirect is
// followed by the real global fetch exactly as in production.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { lnurlFor } from '../../arena-protocol/src/bech32.js';
import { lnAddressWorks } from '../src/feedback-store.js';

test('#1489 v1-refute-20-2: a redirect from a public wallet host takes the bounty address check to an internal host', async () => {
  let internalHits = 0;
  const internal = createServer((req, res) => { internalHits++; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ status: 'ERROR', reason: 'INTERNAL-ADMIN-SECRET-PAGE' })); });
  await new Promise((r) => internal.listen(0, '127.0.0.1', r));
  const pub = createServer((req, res) => { res.writeHead(302, { location: `http://127.0.0.1:${internal.address().port}/internal/admin` }); res.end(); });
  await new Promise((r) => pub.listen(0, '127.0.0.1', r));
  try {
    const lnurl = lnurlFor('https://wallet.example/.well-known/lnurlp/alice');
    const fetchFn = (u, o) => fetch(String(u).replace('https://wallet.example', `http://127.0.0.1:${pub.address().port}`), o);
    const w = await lnAddressWorks(lnurl, { fetchFn, timeoutMs: 3000 });
    console.log('  FACTS v1-refute-20-2:', JSON.stringify({ answer: w, internalHits }));
    assert.equal(internalHits, 0, `the check followed a redirect to 127.0.0.1 (${internalHits} request(s)) and answered: ${w.why}`);
  } finally { internal.close(); pub.close(); }
});
