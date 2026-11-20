// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 refute of kanban #3082 (skeptic 4, edge values): #3124 refuses names that lead to loopback by a fixed list (nip.io, localtest.me,
// localho.st ...). Any public name whose DNS answers 127.0.0.1 and is not on the list passes: x.lacolhost.com (wildcard -> 127.0.0.1) and
// localh.st (-> 127.0.0.1, one letter from the listed localho.st), or the attacker's own domain with an A record 127.0.0.1. The address
// book takes the bond's endpoint, roster endpointsOf hands it to every seat's peer reads, and the GET lands on the seat's own loopback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { lookup } from 'node:dns/promises';
import { DatabaseSync } from 'node:sqlite';
import { schnorr } from '@noble/curves/secp256k1.js';
import { endpointsOf } from '../src/roster.js';
import { createAddressBook } from '../src/address-book.js';

const keyOf = (b) => ({ pubkey: schnorr.getPublicKey(new Uint8Array(32).fill(b)) });
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };

test('wf1489-r1120-refute-1-s4-1: a bond endpoint on a public name that resolves to 127.0.0.1 is not dialed', async () => {
  const hits = [];
  const srv = http.createServer((req, res) => { hits.push(req.headers.host + req.url); res.end('{}'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    const names = ['x.lacolhost.com', 'localh.st'];
    const resolved = {};
    for (const n of names) { try { resolved[n] = (await lookup(n, { family: 4 })).address; } catch (e) { resolved[n] = e.code; } }
    console.log('  RESOLVED:', JSON.stringify(resolved));
    const me = keyOf(1);
    const committee = [{ ...me, advert: { endpoint: 'https://me.example' } },
      ...names.map((n, i) => ({ ...keyOf(2 + i), advert: { endpoint: `http://${n}:${port}/lnurlp` } }))];
    const book = createAddressBook({ db: new DatabaseSync(':memory:'), verify, nowMs: () => 1_800_000_000_000 });   // a live seat: not localOk
    const bases = endpointsOf(committee, me.pubkey, book.endpointOf);
    console.log('  PEER LIST:', JSON.stringify(bases));
    for (const b of bases) { try { await fetch(`${b}/gateway-seating?federation=00&epoch=1`, { redirect: 'error', signal: AbortSignal.timeout(5000) }); } catch { /* no answer */ } }
    console.log('  MEASURED loopback hits:', JSON.stringify(hits));
    assert.deepEqual(hits, [], 'a seat dialed its own loopback service through a bond endpoint whose name resolves to 127.0.0.1');
  } finally { srv.close(); }
});
