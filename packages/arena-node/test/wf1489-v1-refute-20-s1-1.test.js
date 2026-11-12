// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 v1-refute-20 (re-check of #1511): lnAddressWorks refuses an internal host by its NAME only. A public DNS name that resolves to
// 127.0.0.1 (127.0.0.1.nip.io, any attacker's own domain with an A record 127.0.0.1 / 10.x / 169.254.169.254) passes the name filter, and the
// faucet opens a connection to the internal address. Safe: no connection reaches a loopback / private address.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as tcpServer } from 'node:net';
import { lookup } from 'node:dns/promises';
import { lnurlFor } from '../../arena-protocol/src/bech32.js';
import { lnAddressWorks } from '../src/feedback-store.js';

test('#1489 v1-refute-20-1: a public name that resolves to 127.0.0.1 is fetched by the bounty address check', async () => {
  const name = '127.0.0.1.nip.io';
  const resolved = await lookup(name, { family: 4 }).then((r) => r.address, () => null);
  let hits = 0;
  const target = tcpServer((s) => { hits++; s.destroy(); });
  await new Promise((r) => target.listen(0, '127.0.0.1', r));
  try {
    const lnurl = lnurlFor(`https://${name}:${target.address().port}/internal/admin`);
    const w = await lnAddressWorks(lnurl, { timeoutMs: 3000 });
    console.log('  FACTS v1-refute-20-1:', JSON.stringify({ name, resolved, answer: w, internalConnections: hits }));
    assert.equal(hits, 0, `the check opened ${hits} connection(s) to 127.0.0.1 through the name ${name} (resolves to ${resolved})`);
  } finally { target.close(); }
});
