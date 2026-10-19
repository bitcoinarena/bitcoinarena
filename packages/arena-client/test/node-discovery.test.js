// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE NODES, FOUND ON THE FLY: a checked census names the network's nodes by their advertised endpoints.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { endpointRoot, censusEndpoints, mergeNodes } from '../src/node-discovery.js';

const k = (n) => new Uint8Array(32).fill(n);
test('every node of a census by its advertised endpoint, once per key; wss becomes https', () => {
  const entries = [
    { pubkey: k(2), advert: { endpoint: 'wss://seat.example.com/fed2-1' } },
    { pubkey: k(1), advert: { endpoint: 'wss://seat.example.com/guardian-1/' } },
    { pubkey: k(1), advert: { endpoint: 'wss://elsewhere.example/second-bond-of-one-key' } },
    { pubkey: k(3), advert: { endpoint: '' } },
    { pubkey: k(4), advert: { endpoint: 'ftp://nope' } },
  ];
  assert.deepEqual(censusEndpoints(entries), ['https://seat.example.com/guardian-1', 'https://seat.example.com/fed2-1']);
  assert.equal(endpointRoot('ws://127.0.0.1:6221'), 'http://127.0.0.1:6221');
  assert.equal(endpointRoot('nothing'), null);
});

test('the nodes the page knows keep their place; the census adds what they lack', () => {
  const known = ['https://a.example/guardian-1', 'https://a.example/guardian-2/'];
  assert.deepEqual(mergeNodes(known, ['https://a.example/guardian-2', 'https://a.example/fed2-1']),
    ['https://a.example/guardian-1', 'https://a.example/guardian-2/', 'https://a.example/fed2-1']);
  assert.deepEqual(mergeNodes([], ['https://x.example']), ['https://x.example']);
});
