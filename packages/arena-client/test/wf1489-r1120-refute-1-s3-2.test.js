// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 refute of #3108 (skeptic 3, a second copy in the page): node-discovery.js nodeEndpointRefusal now keeps a census endpoint on a
// LAN/loopback host or with a query out of the page's node list, but the page's OTHER door to a node's advert endpoint - directory.js
// reach()/isSocketAddress, which Client.at uses to pick `base` for the round it plays (client.js: base = seen.endpoint) - takes any
// wss:// endpoint (private host, many path segments, a query that swallows every door) and ws:// to loopback with any path and query.
// A committee node's bond committing 'wss://192.168.1.1/admin/cgi?x=' makes the player's browser send <that>/round/... to its own LAN.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSocketAddress } from '../src/directory.js';
import { nodeEndpointRefusal } from '../src/node-discovery.js';

const BAD = [
  'wss://192.168.1.1/admin/cgi?x=',
  'wss://10.0.0.1:8443/x',
  'wss://127.0.0.1:18777/lnurlp/tips/cb?amount=1000&x=',
  'wss://router.lan/admin',
  'ws://127.0.0.1:18777/lnurlp/tips/cb?amount=1000&x=',
];

test('s3-2: the round door (isSocketAddress) refuses what the page\'s node list refuses', () => {
  const taken = [];
  for (const u of BAD) {
    assert.ok(nodeEndpointRefusal(u), `${u}: the page's node list refuses it`);
    if (isSocketAddress(u)) taken.push(u);
  }
  assert.deepEqual(taken, []);
});

test('s3-2: an honest wss endpoint still passes both', () => {
  for (const u of ['wss://node.example:443', 'wss://tn4.example.io/guardian-3']) {
    assert.equal(nodeEndpointRefusal(u), null, u);
    assert.equal(isSocketAddress(u), true, u);
  }
});
