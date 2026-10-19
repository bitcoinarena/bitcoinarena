// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE RESERVES' TOTAL ON THE ARENA PAGE (§27A.9.2): GET /reserves on the network's nodes; the total is shown
// only when five of them answer the same one - so a node that counts too much, or one still catching up, cannot set it alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchReservesTotal } from '../src/reserves-page.js';

const answer = (totalMsat, paidIn = []) => ({ totalMsat: String(totalMsat), entries: paidIn.length, paidIn, federations: [] });
const serve = (answers) => async (url) => { const i = Number(new URL(url).port) - 9000; const a = answers[i];
  if (a === undefined) throw new Error('no answer');
  return { ok: true, async json() { return a; } }; };
const nodes = (n) => Array.from({ length: n }, (_, i) => `http://127.0.0.1:${9000 + i}`);

test('five of seven agree on 2,000 msat: shown, with their payments in; one higher and one behind do not move it', async () => {
  const pay = [{ outpoint: 'aa:4', amountMsat: '2000', game: 'Rock Paper Scissors', at: '2026-10-17T01:00:00.000Z' }];
  const r = await fetchReservesTotal({ nodes: nodes(7), fetcher: serve([answer(2000, pay), answer(2000, pay), answer(2000, pay), answer(2000, pay), answer(2000, pay), answer(999999), answer(0)]) });
  assert.equal(r.ok, true, r.why);
  assert.deepEqual([r.totalMsat, r.agreeing, r.asked, r.entries, r.paidIn[0].game], [2000n, 5, 7, 1, 'Rock Paper Scissors']);
});

test('four agreeing, a split, or no answers: no total, and why', async () => {
  const four = await fetchReservesTotal({ nodes: nodes(7), fetcher: serve([answer(2000), answer(2000), answer(2000), answer(2000), answer(4000), answer(4000), answer(4000)]) });
  assert.equal(four.ok, false); assert.match(four.why, /only 4 of 7 nodes name the same reserves, and 5 must/);
  const none = await fetchReservesTotal({ nodes: nodes(3), fetcher: serve([]) });
  assert.equal(none.ok, false); assert.match(none.why, /none of 3 nodes answered/);
  const junk = await fetchReservesTotal({ nodes: nodes(5), fetcher: serve(Array(5).fill({ totalMsat: 'lots' })) });
  assert.equal(junk.ok, false);
  const ws = await fetchReservesTotal({ nodes: ['ws://127.0.0.1:9000/', 'http://127.0.0.1:9000'], needed: 1, fetcher: serve([answer(0)]) });
  assert.deepEqual([ws.ok, ws.asked, ws.totalMsat], [true, 1, 0n], 'one node at two spellings is asked once');
});
