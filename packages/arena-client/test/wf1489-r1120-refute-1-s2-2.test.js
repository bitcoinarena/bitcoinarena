// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 refute of kanban #3082 (49209d4ac: "an endpoint the book refuses is not handed to the page either"), skeptic 2, the PLAYER's
// browser as the one that dials: the page learns the network's nodes on its own from every census it checks (node-discovery.js
// censusEndpoints, index.html ARENA_LEARN_NODES), takes each bond's RAW advert endpoint, keeps the list in localStorage (arena.nodes.*) and
// on its next start (reload) merges it back and asks those nodes. A bond committing 'http://127.0.0.1:18777/lnurlp/tips/cb?amount=1000&x='
// or a LAN address (192.168.1.1) is never filtered: every player's page sends GET <that>/games ... to its own machine or LAN - the query
// swallowing the door, exactly the #2856 shape the seats now refuse. A public page must leave such endpoints out, as the seat does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { censusEndpoints } from '../src/node-discovery.js';

const key = (b) => new Uint8Array(32).fill(b);

test('wf1489-r1120-refute-1-s2-2: the page does not learn a loopback / private / query census endpoint', () => {
  const entries = [
    { pubkey: key(1), advert: { endpoint: 'wss://seat.example.com/guardian-1' } },
    { pubkey: key(2), advert: { endpoint: 'http://127.0.0.1:18777/lnurlp/tips/cb?amount=1000&x=' } },
    { pubkey: key(3), advert: { endpoint: 'http://192.168.1.1/admin' } },
    { pubkey: key(4), advert: { endpoint: 'http://[::1]:8080' } },
  ];
  const found = censusEndpoints(entries);
  console.log('  MEASURED:', JSON.stringify(found));
  assert.deepEqual(found, ['https://seat.example.com/guardian-1'], 'the page learned (and keeps for its next start) endpoints the seats refuse to dial');
});
