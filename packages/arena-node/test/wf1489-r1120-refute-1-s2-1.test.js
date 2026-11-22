// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 refute of kanban #3082/#3090/#3093 (gaps in #2856), skeptic 2: the address book refuses a census endpoint on a loopback/private
// host, and every dial site now honours that - but only for the FIRST hop. The seat's peer fetch (main.js installFetchRoutes ->
// fetch-routes.js cappedFetch over Node's fetch, server.js `answersUpTo(globalThis.fetch)`) follows redirects. A bonded node (a peer seat,
// not a client) commits a PUBLIC endpoint the book takes and answers every door with a 302 to the honest seat's own loopback service
// (http://127.0.0.1:18777/lnurlp/tips/cb?amount=1000&x=) - the #2856 effect again, with any path and query the attacker likes, which the
// one-path-segment / no-query rule was meant to forbid. Here: federation records' gather (GET /federation-record) at a guardian.
// "evil-seat.example" stands for the attacker's public host: the seat's own ARENA_ROUTE_MAP mechanism points it at a local server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { schnorr } from '@noble/curves/secp256k1.js';
import { federationRecords } from '../src/federation-records.js';
import { createAddressBook } from '../src/address-book.js';
import { cappedFetch } from '../src/fetch-routes.js';
import { answersUpTo } from '../src/peer-read.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const FED = new Uint8Array(32).fill(0x37);
const NET = new Uint8Array(32).fill(0x10);
const INVITE = `fed:${toHex(FED)}`;
const inviteFederationId = (inv) => fromHex(String(inv).split(':')[1]);
const listen = (h) => new Promise((ok) => { const s = createServer(h); s.listen(0, '127.0.0.1', () => ok(s)); });

test('wf1489-r1120-refute-1-s2-1: a peer\'s public census endpoint that redirects is not followed to the seat\'s own loopback', async () => {
  const victimHits = [];
  const victim = await listen((req, res) => { victimHits.push(req.url); res.end('{}'); });
  const VICTIM = `http://127.0.0.1:${victim.address().port}/lnurlp/tips/cb?amount=1000&x=`;
  const attacker = await listen((req, res) => { res.writeHead(302, { location: VICTIM }); res.end(); });
  try {
    const PUBLIC = 'https://evil-seat.example';
    const nodes = Array.from({ length: 7 }, (_, i) => ({ secret: new Uint8Array(32).fill(i + 1) }));
    for (const [i, n] of nodes.entries()) { n.pubkey = schnorr.getPublicKey(n.secret); n.guardianKey = Uint8Array.from([2, ...new Uint8Array(32).fill(0x60 + i)]); n.endpoint = i === 6 ? PUBLIC : `https://seat-${i}.invalid`; }
    const census = { ok: true, entries: nodes.map((n, i) => ({ pubkey: n.pubkey, txid: new Uint8Array(32).fill(0xa0 + i), vout: 0, bondSats: 50000n,
      advert: { operatorId: `op${i}`, endpoint: n.endpoint, guardianEndpoint: `wss://g${i}.example`, guardianOf: [{ federationId: FED, guardianKey: n.guardianKey }] } })) };
    const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
    const book = createAddressBook({ db: new DatabaseSync(':memory:'), verify });   // a live seat: not localOk
    assert.equal(book.endpointOf(census.entries[6]), PUBLIC, 'the book takes the public endpoint (honest so far)');
    assert.notEqual(book.endpointOf({ pubkey: nodes[5].pubkey, advert: { endpoint: VICTIM } }), VICTIM, 'and refuses the loopback one directly');
    // the seat's own peer fetch, as main.js + server.js compose it; the route only stands in for the attacker's public host
    const seatFetch = answersUpTo(cappedFetch((...a) => globalThis.fetch(...a), { routes: [[PUBLIC, `http://127.0.0.1:${attacker.address().port}`]], timeoutMs: 5000 }));
    const store = { load: async () => [], save: () => {}, saveAt: () => {}, loadAt: () => [] };
    const seat = federationRecords({ store, round: { pubkey: nodes[0].pubkey, identity: { secret: nodes[0].secret } },
      newest: () => ({ rid: new Uint8Array(32).fill(9), contract: { censusHeight: 156036, networkId: NET } }),
      roster: { censusFor: () => census }, inviteFor: () => INVITE, networkId: NET, leavingAtMs: () => null,
      endpointOf: (e) => book.endpointOf(e), fetcher: seatFetch });
    try { await seat.gather(FED, inviteFederationId); } catch { /* the outcome does not matter, the dials do */ }
    try { await seat.closedAtGuardians(toHex(FED)); } catch { /* same */ }
    console.log('  MEASURED:', JSON.stringify({ victimHits }));
    assert.deepEqual(victimHits, [], 'the seat followed a peer\'s redirect to its own loopback service the address book refuses');
  } finally { victim.close(); attacker.close(); }
});
