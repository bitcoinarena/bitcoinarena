// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 refute of kanban #3082 (feedback #361, a gap in #2856): the address book refuses a census node's loopback advert endpoint, and
// #3082 made roster.js endpointsOf and three server.js paths honour that. federation-records.js still dials a guardian's RAW census advert
// endpoint (guardiansOf -> advertEndpoint) in gather (GET /federation-record), mirror (GET /federations) and closedAtGuardians: a bond
// committing 'http://127.0.0.1:18777/lnurlp/tips/cb?amount=1000&x=' as its endpoint and claiming a guardian seat of a federation makes
// every seat that gathers or mirrors that federation send a request to the honest seat's own loopback service - the #2856 attack, other door.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { schnorr } from '@noble/curves/secp256k1.js';
import { federationRecords } from '../src/federation-records.js';
import { createAddressBook } from '../src/address-book.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const FED = new Uint8Array(32).fill(0x37);
const NET = new Uint8Array(32).fill(0x10);
const INVITE = `fed:${toHex(FED)}`;
const inviteFederationId = (inv) => fromHex(String(inv).split(':')[1]);
const EVIL = 'http://127.0.0.1:18777/lnurlp/tips/cb?amount=1000&x=';

test('wf1489-r1120-refute-1-s1-1: a guardian\'s loopback census endpoint the address book refuses is not dialed by federation records', async () => {
  const nodes = Array.from({ length: 7 }, (_, i) => ({ secret: new Uint8Array(32).fill(i + 1) }));
  for (const [i, n] of nodes.entries()) { n.pubkey = schnorr.getPublicKey(n.secret); n.guardianKey = Uint8Array.from([2, ...new Uint8Array(32).fill(0x60 + i)]); n.endpoint = i === 6 ? EVIL : `wss://seat-${i}.example`; }
  const census = { ok: true, entries: nodes.map((n, i) => ({ pubkey: n.pubkey, txid: new Uint8Array(32).fill(0xa0 + i), vout: 0, bondSats: 50000n,
    advert: { operatorId: `op${i}`, endpoint: n.endpoint, guardianEndpoint: `wss://g${i}.example`, guardianOf: [{ federationId: FED, guardianKey: n.guardianKey }] } })) };
  // the address book (not localOk, a live seat) refuses the attacker's endpoint: what #2856/#3082 rely on
  const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
  const book = createAddressBook({ db: new DatabaseSync(':memory:'), verify });
  assert.equal(book.endpointOf(census.entries[6]), null, 'the book refuses the loopback endpoint');
  const dialed = [];
  const store = { load: async () => [], save: () => {}, saveAt: () => {}, loadAt: () => [] };
  const seat = federationRecords({ store, round: { pubkey: nodes[0].pubkey, identity: { secret: nodes[0].secret } },
    newest: () => ({ rid: new Uint8Array(32).fill(9), contract: { censusHeight: 156036, networkId: NET } }),
    roster: { censusFor: () => census }, inviteFor: () => INVITE, networkId: NET, leavingAtMs: () => null,
    fetcher: async (url) => { dialed.push(String(url)); return new Response('{}', { status: 404 }); } });
  try { await seat.gather(FED, inviteFederationId); } catch { /* the outcome does not matter, the dials do */ }
  try { await seat.closedAtGuardians(toHex(FED)); } catch { /* same */ }
  const loopback = dialed.filter((u) => u.startsWith('http://127.0.0.1:18777'));
  console.log('  MEASURED:', JSON.stringify({ dialed: dialed.length, loopback }));
  assert.deepEqual(loopback, [], 'a seat sent requests to the census endpoint its own address book refuses');
});
