// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A ROUND WHOSE SEATS DO NOT ANSWER IS NOT READ AGAIN EVERY SWEEP (kanban #3914, measured 2026-11-28): a market round with two dead seats in its
// committee never heard a threshold, so every settle sweep (60 s at most, settle-backoff.js) read every other seat's GET /book-certificates again -
// 275 such rounds at seat 4, ~11 MB/min from one external seat for the seven Beelink seats. A failed read of a round now waits, doubling from
// SYNC_RETRY_FIRST_MS to SYNC_RETRY_MAX_MS, and a round that failed for SYNC_GIVE_UP_MS is not read again; a peer that failed SYNC_PEER_FAILS
// reads in a row is skipped for a while. A read that reaches the threshold clears it all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OrderBook } from '../src/order-batch.js';

const RID = new Uint8Array(32).fill(7);
const book = (peers, fetcher, clock) => {
  const ob = new OrderBook({ db: { prepare: () => ({ all: () => [] }) } }, { peersFor: () => peers, fetcher, now: () => clock.t, syncTimeoutMs: 200 });
  ob.market = () => ({ ok: true, needed: 5 });
  return ob;
};

test('a round that never hears a threshold is read with a doubling wait, then not at all; a dead peer is skipped; a heard read clears it', async () => {
  const clock = { t: 1_800_000_000_000 };
  const asked = [];
  const peers = ['http://a', 'http://b', 'http://c', 'http://d'];
  let alive = new Set(['http://a', 'http://b']);
  const fetcher = async (u) => {
    asked.push(u);
    const base = u.slice(0, u.indexOf('/book-certificates'));
    if (!alive.has(base)) throw new Error('fetch failed');
    return new Response(JSON.stringify({ certificates: [], pending: [] }), { status: 200 });
  };
  const ob = book(peers, fetcher, clock);
  // an hour of settle sweeps, one a minute (the sweep's longest wait)
  let reads = 0;
  for (let m = 0; m < 60; m++) {
    const before = asked.length;
    const r = await ob.sync(RID);
    assert.equal(r.ok, false);
    if (asked.length > before) reads += 1;
    clock.t += 60_000;
  }
  // before: 60 reads, 240 asks; now a doubling wait up to 10 min
  assert.ok(reads <= 10, `${reads} reads of the round in an hour`);
  assert.ok(asked.length <= 40, `${asked.length} asks in an hour`);
  // the two dead peers failed many reads in a row: they are skipped, the live ones still asked
  const deadAsks = asked.filter((u) => /^http:\/\/[cd]\//.test(u)).length, liveAsks = asked.filter((u) => /^http:\/\/[ab]\//.test(u)).length;
  assert.ok(deadAsks < liveAsks, `dead ${deadAsks} vs live ${liveAsks}`);
  // the refusal still names why (the sweep logs it), with no ask
  { const n = asked.length; const r = await ob.sync(RID); assert.equal(r.ok, false); assert.match(r.why, /seats' certified batches heard here/); assert.equal(asked.length, n); }
  // a whole day failing: the round is given up, no more asks at all
  for (let m = 0; m < 24 * 60; m += 10) { await ob.sync(RID); clock.t += 600_000; }
  const atDay = asked.length;
  for (let m = 0; m < 120; m++) { await ob.sync(RID); clock.t += 60_000; }
  assert.equal(asked.length, atDay, 'a round failing for a day is still read');

  // ANOTHER ROUND, ITS SEATS ANSWER AGAIN: once due it is read, and a heard read (threshold 5 of 5 here) is kept as before
  const RID2 = new Uint8Array(32).fill(9);
  alive = new Set(peers);
  const ob2 = book(peers, fetcher, clock);
  ob2.peersFor = () => ['http://a', 'http://b'];
  assert.equal((await ob2.sync(RID2)).ok, false);
  clock.t += 60_000;
  ob2.peersFor = () => peers;
  // the peers c and d answer now; the round's wait passed: read and heard
  clock.t += 600_000;
  const r2 = await ob2.sync(RID2);
  assert.equal(r2.ok, true, r2.why);
});
