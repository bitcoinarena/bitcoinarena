// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE PRICE FEED READS THE OPEN ROUNDS AGAIN ONLY WHEN THEY MOVED (kanban #576): a beat while round.openSeq stands keeps the list
// it read; a round opened, closed or with its contract changed moves openSeq, and the next beat reads the open ids again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PriceFeed } from '../src/price-feed.js';
import { Round } from '../src/round.js';
import { openStore } from '../src/store.js';

test('beats read the open ids once while openSeq stands, and again once it moves', async () => {
  let reads = 0;
  const round = { openSeq: 0, openRoundIds: () => { reads++; return [new Uint8Array(32).fill(1)]; }, get: () => null };
  const feed = new PriceFeed(round, { priceRound: () => false, readPrice: async () => null, now: () => 0 });
  await feed.beat(); await feed.beat(); await feed.beat();
  assert.equal(reads, 1, 'three beats, the open set unmoved: one read');
  round.openSeq++;
  await feed.beat();
  assert.equal(reads, 2, 'a round opened or closed: read again');
  await feed.beat();
  assert.equal(reads, 2);
});

test('a round without openSeq is read on every beat, as before', async () => {
  let reads = 0;
  const round = { openRoundIds: () => { reads++; return []; }, get: () => null };
  const feed = new PriceFeed(round, { priceRound: () => false, readPrice: async () => null, now: () => 0 });
  await feed.beat(); await feed.beat();
  assert.equal(reads, 2);
});

test('Round.openSeq moves on close, and not on a second close of the same round', () => {
  const round = new Round(openStore(), () => 1234);
  const id = new Uint8Array(32).fill(7);
  round.db.prepare('INSERT INTO rounds (round_id, contract, state, opened_ms) VALUES (?, ?, 0, 0)').run(id, new Uint8Array(0));
  const before = round.openSeq;
  round.get = () => ({ state: 0 });
  assert.equal(round.close(id), true);
  assert.equal(round.openSeq, before + 1);
  round.get = () => ({ state: 1 });
  assert.equal(round.close(id), false);
  assert.equal(round.openSeq, before + 1);
});
