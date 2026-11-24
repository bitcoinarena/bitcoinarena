// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// audit-2026-11-24 settle round 1, finding 2 (gap in the #3363 fix): GET /season?scope=network now drops game ids this seat neither hosts
// nor stores, but the network board's cache (seasonNetworkNow, seasonNetKept) is still keyed by `${ids}|${days}` and holds 32 queries.
// days= takes every whole number 1..90, so a stranger cycling the hosted game's id through 33+ day counts misses the cache on every
// request: each one is a whole-store seasonRounds read on the seat's thread and a paged GET /season-rounds to every network seat.
// #2725 fixed exactly this days= spelling for GET /season-rounds (one read over SEASON_DAYS_MAX, a window is a filter); #3363 named the
// days= variant in its attack text, but its fix filtered the ids only.
// SAFE: one hosted game asked under many day counts costs a bounded number of whole-store reads and peer fan-outs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { serve } from '../src/server.js';
import { openStore } from '../src/store.js';
import { opts, b32 } from './window-fixture.js';
import { HOSTED, NEXTBLOCK_GAME_ID } from './plugins/hosted.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { SEASON_ROUNDS_SQL } from '../src/season-read.js';

test('a hosted game asked on GET /season?scope=network under 60 day counts does not each cost a whole-store read and a peer fan-out', async () => {
  const peers = ['http://127.0.0.1:9/seat-a', 'http://127.0.0.1:9/seat-b', 'http://127.0.0.1:9/seat-c'];
  let asked = 0;
  const seasonFetch = async (u) => {
    if (/\/identity\?/.test(u)) return new Response('no', { status: 404 });
    if (/\/season-rounds/.test(u)) asked++;
    return new Response(JSON.stringify({ node: toHex(schnorr.getPublicKey(b32(0xa1))), rounds: [], roundKeys: true }), { status: 200 });
  };
  const store = openStore(':memory:');
  let fullReads = 0;
  const prep = store.prepare.bind(store);
  // the whole-store season read: its query since #3562 (season-read.js SEASON_ROUNDS_SQL), or the one before it
  store.prepare = (sql) => { if (sql === SEASON_ROUNDS_SQL || /FROM rounds r WHERE EXISTS \(SELECT 1 FROM entries e/.test(sql)) fullReads++; return prep(sql); };
  const d = await serve(store, { plugins: HOSTED, port: 0, peers, seasonFetch, ...opts });
  try {
    const id = toHex(NEXTBLOCK_GAME_ID);
    const DAYS = 60;
    const beforeReads = fullReads, beforeAsked = asked;
    for (let days = 1; days <= DAYS; days++) {
      const r = await fetch(`http://127.0.0.1:${d.port}/season?game=${id}&scope=network&days=${days}`);
      assert.equal(r.status, 200, await r.text());
    }
    const reads = fullReads - beforeReads, fan = asked - beforeAsked;
    console.log(`# ${DAYS} day counts of one hosted game: ${fan} peer /season-rounds asks, ${reads} whole-store season reads`);
    assert.ok(fan <= 2 * peers.length, `${DAYS} day counts of one hosted game made ${fan} peer /season-rounds asks (a fan-out to every seat per day count)`);
    assert.ok(reads <= 2, `${DAYS} day counts of one hosted game made ${reads} whole-store season reads`);
  } finally { await d.close(); }
});

// kanban #3570: the fix asks every seat once per game set over SEASON_DAYS_MAX and answers a days= as a filter of that one account, so a
// shorter window must still leave out what started before it - by the rounds' start, not by a second ask
test('one network account answers each day count with only the rounds started inside it', async () => {
  const peers = ['http://127.0.0.1:9/seat-a', 'http://127.0.0.1:9/seat-b', 'http://127.0.0.1:9/seat-c'];
  const game = toHex(NEXTBLOCK_GAME_ID), now = Date.now(), DAY = 86400000;
  const X = toHex(b32(0x5a)), Y = toHex(b32(0x5b));
  const round = (id, startMs, player) => ({ roundId: id.repeat(32), gameId: game, startMs: String(startMs), void: false,
    entries: [{ player, name: null, stakeMsat: '0', payoutMsat: '0', outcome: 'DELIVERED', score: 7 }] });
  const rounds = [round('e1', now - 3600000, X), round('e2', now - 5 * DAY, Y)];
  let asked = 0;
  const seasonFetch = async (u) => {
    if (/\/identity\?/.test(u)) return new Response('no', { status: 404 });
    if (/\/season-rounds/.test(u)) asked++;
    const n = peers.findIndex((p) => u.startsWith(`${p}/`));
    return new Response(JSON.stringify({ node: toHex(schnorr.getPublicKey(b32(0xa1 + n))), rounds }), { status: 200 });
  };
  const d = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, peers, seasonFetch, ...opts });
  try {
    const ask = async (days) => (await fetch(`http://127.0.0.1:${d.port}/season?game=${game}&scope=network&days=${days}`)).json();
    const week = await ask(7), three = await ask(3), again = await ask(7);
    assert.deepEqual(week.rows.map((r) => r.player).sort(), [X, Y].sort(), 'the week holds both rounds');
    assert.equal(week.days, 7);
    assert.deepEqual(three.rows.map((r) => r.player), [X], 'three days leave out the round started five days back');
    assert.equal(three.days, 3);
    assert.equal(three.rounds, 1);
    assert.deepEqual(again, week, 'the week asked again is the same answer');
    assert.equal(asked, peers.length, 'each seat asked once for all three answers');
  } finally { await d.close(); }
});
