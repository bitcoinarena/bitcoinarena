// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 refute of #3082/#3107/#3108 (skeptic 3, second copies): three copies of "is this endpoint local" disagree. The page's
// nodeEndpointRefusal (#3108) and public-fetch internalByName refuse local-only names (*.local, *.lan, *.internal, a single label) and
// names that resolve to loopback by design (*.nip.io, localtest.me ...); the seat's peerEndpointRefusal (address-book.js) refuses IP
// literals and localhost only. A bond committing one of these names is taken by every seat's address book and dialed (roster endpointsOf,
// federation records, duty poster, gateway reads) - e.g. http://127.0.0.1.nip.io:18777/lnurlp lands on the seat's own loopback service.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { schnorr } from '@noble/curves/secp256k1.js';
import { endpointsOf } from '../src/roster.js';
import { createAddressBook, peerEndpointRefusal } from '../src/address-book.js';
import { internalByName } from '../src/public-fetch.js';
import { nodeEndpointRefusal } from '../../arena-client/src/node-discovery.js';

const keyOf = (b) => ({ pubkey: schnorr.getPublicKey(new Uint8Array(32).fill(b)) });
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };

const LOCAL = [
  'http://127.0.0.1.nip.io:18777/lnurlp',      // resolves to 127.0.0.1 (a rebinding service)
  'http://localtest.me:18777/lnurlp',           // resolves to 127.0.0.1
  'http://host.docker.internal:18777/lnurlp',   // the docker host from a container
  'http://router.lan/admin',                    // the LAN router
  'http://printer.local:631/x',                 // mDNS
  'http://router/admin',                        // a single-label LAN name
];

test('s3-1: the page and public-fetch call these endpoints local', () => {
  for (const u of LOCAL) {
    const pageSays = nodeEndpointRefusal(u) !== null, nameSays = internalByName(new URL(u).hostname);
    assert.ok(pageSays || nameSays, `${u}: page or public-fetch refuses it`);
  }
});

test('s3-1: the seat\'s address book refuses what the page and public-fetch call local, and no seat dials it', () => {
  const me = keyOf(1);
  const book = createAddressBook({ db: new DatabaseSync(':memory:'), verify, nowMs: () => 1_800_000_000_000 });
  const taken = [];
  LOCAL.forEach((u, i) => {
    const e = { ...keyOf(10 + i), advert: { endpoint: u } };
    if (peerEndpointRefusal(u) === null || book.endpointOf(e) !== null) taken.push(u);
  });
  const committee = [{ ...me, advert: { endpoint: 'https://me.example' } }, ...LOCAL.map((u, i) => ({ ...keyOf(10 + i), advert: { endpoint: u } }))];
  const dialed = endpointsOf(committee, me.pubkey, book.endpointOf);
  assert.deepEqual({ taken, dialed }, { taken: [], dialed: [] });
});

test('s3-1: measured - a seat dials its own loopback service through a census endpoint named localtest.me', async (t) => {
  const { createServer } = await import('node:http');
  const { lookup } = await import('node:dns/promises');
  let resolved = null; try { resolved = (await lookup('localtest.me')).address; } catch { resolved = null; }
  if (resolved !== '127.0.0.1') { t.skip('localtest.me does not resolve to 127.0.0.1 here'); return; }
  const hits = [];
  const victim = createServer((req, res) => { hits.push(req.url); res.end('{}'); });
  await new Promise((r) => victim.listen(0, '127.0.0.1', r));
  try {
    const port = victim.address().port;
    const me = keyOf(1);
    const book = createAddressBook({ db: new DatabaseSync(':memory:'), verify, nowMs: () => 1_800_000_000_000 });
    const committee = [{ ...me, advert: { endpoint: 'https://me.example' } }, { ...keyOf(9), advert: { endpoint: `wss://localtest.me:${port}/lnurlp`.replace('wss:', 'ws:') } }];
    for (const base of endpointsOf(committee, me.pubkey, book.endpointOf)) {
      try { await fetch(`${base}/games`, { signal: AbortSignal.timeout(3000) }); } catch { /* answered or not */ }
    }
    assert.deepEqual(hits, [], 'the seat sent nothing to its own loopback service');
  } finally { victim.close(); }
});
