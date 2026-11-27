// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r40-client-3: THE PAID JOIN READS ONE SEAT'S GET /fees AND GET /bond ANSWERS WHOLE.
// fetchFees (index.html: before the tap and in every paid join of a reserves round) takes `await r.json()` of every node's /fees answer,
// and committeeBonds (every paid join's bond proof, join.js) of every committee seat's /bond - bounded only by a 10 s / 8 s timer. One seat
// of the round answers a gzip body (~100 KB on the wire, ~100 MB inflated in the tab): the join holds and parses it while the player waits
// on PLAY; the tab of a phone dies. Safe behaviour: each answer is read up to a bound (honest ones are a few KB); a longer one is that seat's
// refusal and the other seats decide.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchFees } from '../src/fee-proposal-page.js';
import { committeeBonds } from '../src/join.js';

const MB = 1024 * 1024;
const BAD_TOTAL = 96 * MB;
const BOUND = 32 * MB;

function hugeBody(counter) {
  const chunk = new Uint8Array(MB).fill(0x20);
  let sent = 0;
  return new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode('{"x":1')); },
    pull(c) {
      if (sent >= BAD_TOTAL) { c.enqueue(new TextEncoder().encode('}')); c.close(); return; }
      sent += chunk.length; counter.pulled += chunk.length; c.enqueue(chunk);
    },
  });
}

test('fetchFees: one node\'s huge /fees answer is not read whole', async () => {
  const counter = { pulled: 0 };
  const fetcher = async (url) => (new URL(url).host === 'bad.test'
    ? new Response(hugeBody(counter), { status: 200 }) : new Response('{}', { status: 200 }));
  try { await fetchFees({ nodes: ['http://a.test', 'http://bad.test', 'http://b.test'], height: 100, needed: 1, fetcher, keys: [], verify: () => false }); } catch { /* a refusal is fine */ }
  assert.ok(counter.pulled <= BOUND, `fetchFees read ${Math.round(counter.pulled / MB)} MB of one node's /fees answer (bound ${BOUND / MB} MB)`);
});

test('committeeBonds: one seat\'s huge /bond answer is not read whole', async () => {
  const counter = { pulled: 0 };
  const fetcher = async (url) => (new URL(url).host === 'bad.test'
    ? new Response(hugeBody(counter), { status: 200 }) : new Response('{}', { status: 200 }));
  try { await committeeBonds({ nodes: ['http://a.test', 'http://bad.test'], committee: [new Uint8Array(32).fill(1)], fetcher }); } catch { /* a refusal is fine */ }
  assert.ok(counter.pulled <= BOUND, `committeeBonds read ${Math.round(counter.pulled / MB)} MB of one seat's /bond answer (bound ${BOUND / MB} MB)`);
});
