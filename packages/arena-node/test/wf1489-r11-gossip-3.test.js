// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 r11 (gossip): ONE BONDED NODE FLOODS EVERY SEAT THROUGH POST /node-facts. A node's record is meant once an hour
// (FACTS_EVERY_MS); offer() keeps any record newer than the one held, by one millisecond, with no rate - and server.js hands every
// kept record on to every seat it knows (everySeat()), each of which verifies it and hands it on again. One bonded node posting
// records with atMs + 1, + 2, ... costs every seat a Schnorr verify, a database write and a fan-out of S POSTs per record:
// S x S requests across the network for each one it sends.
// Safe behaviour: a node's record is kept (and so passed on) at most once per minimum interval; a burst of newer ones is not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createNodeFactsBook, signFacts } from '../src/node-facts.js';

test('a bonded node cannot have 100 records kept (and handed on to every seat) within one second', () => {
  const secret = new Uint8Array(32).fill(9);
  const node = schnorr.getPublicKey(secret);
  let now = 1_800_000_000_000;
  const book = createNodeFactsBook({ db: new DatabaseSync(':memory:'), verify: (s, m, k) => schnorr.verify(s, m, k), isBonded: () => true, nowMs: () => now });
  let kept = 0;
  for (let i = 0; i < 100; i++) {
    now += 10;
    const r = book.offer(signFacts({ node, atMs: now, facts: { load: [i] }, sign: (d) => schnorr.sign(d, secret) }));
    if (r.ok && r.kept) kept++;
  }
  assert.ok(kept <= 1, `${kept} records of one node kept within one second - each one handed on to every seat`);
});
