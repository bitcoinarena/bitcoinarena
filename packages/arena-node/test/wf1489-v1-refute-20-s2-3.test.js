// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 v1-refute-20 skeptic 2 (re-check of #1511, the same internal fetch from a SEAT, a player as the attacker): #1511 / #1689 / #1746 put
// walletUrlRefusal + publicFetch (public name, public resolved address, no redirect) on the FAUCET's wallet asks only. Every seat asks a player's
// payout address the same way when it plans the winnings (winnings-send.js payRequest/invoiceFor, server.js lnurlFetch = plain fetch; reserve-payout
// lnurlClient too): an LNURL naming http://127.0.0.1:<port>/... (any scheme, any host - urlOfLnurl checks nothing) or name@127.0.0.1:<port> is
// fetched, redirects followed, and its answer's text goes into the refusal ("... did not answer: ..."). Safe: no request reaches an internal host.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { lnurlFor } from '../../arena-protocol/src/bech32.js';
import { WinningsSend } from '../src/winnings-send.js';
import { lnurlClient } from '../src/reserve-payout.js';

test('#1489 v1-refute-20-s2-3: a seat asks a payout LNURL on 127.0.0.1 (winnings send and reserve payout)', async () => {
  const paths = [];
  const internal = createServer((req, res) => { paths.push(req.url); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ status: 'ERROR', reason: 'INTERNAL-ONLY' })); });
  await new Promise((r) => internal.listen(0, '127.0.0.1', r));
  try {
    const lnurl = lnurlFor(`http://127.0.0.1:${internal.address().port}/internal/admin`);
    const ws = new WinningsSend({ round: null, port: null, lnurlMs: 3000 });   // the seat's own defaults: lnurlFetch = fetch
    const a = await ws.payRequest(lnurl, 1000000n);
    const b = await lnurlClient({ timeoutMs: 3000 }).payRequest(lnurl, 1000000);
    console.log('  FACTS v1-refute-20-s2-3:', JSON.stringify({ winnings: a.why, reserve: b.why, internalRequests: paths }));
    assert.equal(paths.length, 0, `the seat sent ${paths.length} GET(s) to 127.0.0.1 for a payout address (${paths.join(', ')})`);
  } finally { internal.close(); }
});
