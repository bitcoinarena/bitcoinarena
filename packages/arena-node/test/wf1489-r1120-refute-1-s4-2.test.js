// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 refute of kanban #3082 (skeptic 4): #3082/#3090 hold a census node's advert `endpoint` to the address book, but the same bond
// commits a second endpoint, `guardianEndpoint` (advert.js only asks /^wss?:\/\/\S+$/ - any host, path and query). federation-records
// guardiansOf copies it raw into each guardian row's `endpoint`, and server.js reserveOf opens a WebSocket to every one of them
// (readReserve, guardians.map((g) => g.endpoint)) whenever the seat signs or gathers a federation record. A guardian committing
// ws://127.0.0.1:18777/lnurlp/tips/cb?amount=1000&x= makes every such seat send that GET (the WS upgrade) to its own loopback service.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { schnorr } from '@noble/curves/secp256k1.js';
import { guardiansOf } from '../src/federation-records.js';
import { readReserve } from '../src/federation-reserve.js';
import { createAddressBook, peerEndpointRefusal } from '../src/address-book.js';

const FED = new Uint8Array(32).fill(0x37);
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };

test('wf1489-r1120-refute-1-s4-2: a guardian endpoint on loopback is not opened by the reserve read', async () => {
  const hits = [];
  const srv = http.createServer((req, res) => { hits.push(req.url); res.end(); });
  srv.on('upgrade', (req, sock) => { hits.push(req.url); sock.destroy(); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const EVIL = `ws://127.0.0.1:${srv.address().port}/lnurlp/tips/cb?amount=1000&x=`;
  try {
    const nodes = Array.from({ length: 7 }, (_, i) => ({ pubkey: schnorr.getPublicKey(new Uint8Array(32).fill(i + 1)), guardianKey: Uint8Array.from([2, ...new Uint8Array(32).fill(0x60 + i)]) }));
    const census = { ok: true, entries: nodes.map((n, i) => ({ pubkey: n.pubkey, txid: new Uint8Array(32).fill(0xa0 + i), vout: 0, bondSats: 50000n,
      advert: { operatorId: `op${i}`, endpoint: `wss://seat-${i}.example`, guardianCapable: true, guardianEndpoint: i === 6 ? EVIL : `wss://g${i}.invalid/guardian`,
        guardianOf: [{ federationId: FED, guardianKey: n.guardianKey }] } })) };
    const book = createAddressBook({ db: new DatabaseSync(':memory:'), verify });   // a live seat: not localOk
    assert.ok(peerEndpointRefusal(EVIL), 'the seat\'s own rule refuses this endpoint');
    const guardians = guardiansOf(census, FED, null, (e) => book.endpointOf(e));
    console.log('  GUARDIAN ENDPOINTS:', JSON.stringify(guardians.map((g) => g.endpoint)));
    // what server.js reserveOf does with them
    const endpoints = guardians.map((g) => g.endpoint).filter(Boolean);
    await readReserve({ endpoints, threshold: 5, timeoutMs: 1500 });
    console.log('  MEASURED loopback hits:', JSON.stringify(hits));
    assert.deepEqual(hits, [], 'the reserve read opened the guardian endpoint the seat\'s own rule refuses, on its own loopback');
  } finally { srv.close(); }
});
