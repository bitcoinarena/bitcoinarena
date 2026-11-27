// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r40-client-2: THE COLLECT LOOP READS ONE SEAT'S /stake-lock, /lock-settlement AND /forfeit ANSWERS WHOLE.
// findLock (every stake return, refund, look and expiry path), settlementOf (every payout / stake-back) and forfeitOf take `await r.json()`
// of each round seat's answer, bounded only by SEAT_READ_MS (15 s). #1531 caps how many LOCKS of the answer count, #1496 its shape - not
// its bytes. A seat of the player's round answers a gzip body (~1000:1: ~100 KB on the wire, ~100 MB in the tab) and the page holds and
// parses it on every pass over that round, on every load; on a phone the tab dies before any stake, payout or refund is collected.
// Safe behaviour: each of these answers is read up to a bound (honest ones are a few KB) and a longer one counts as that seat's refusal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { findLock, settlementOf, forfeitOf } from '../src/page-lock.js';

const MB = 1024 * 1024;
const BAD_TOTAL = 96 * MB;
const BOUND = 32 * MB;

function hugeBody(counter, open = '[') {
  const chunk = new Uint8Array(MB).fill(0x20);
  let sent = 0;
  return new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode(open)); },
    pull(c) {
      if (sent >= BAD_TOTAL) { c.enqueue(new TextEncoder().encode(open === '[' ? ']' : '}')); c.close(); return; }
      sent += chunk.length; counter.pulled += chunk.length; c.enqueue(chunk);
    },
  });
}
const roundId = new Uint8Array(32).fill(7);
const playerPubkey = new Uint8Array(32).fill(9);

test('findLock: one seat\'s huge /stake-lock answer is not read whole', async () => {
  const counter = { pulled: 0 };
  const fetcher = async (url) => (new URL(url).host === 'bad.test'
    ? new Response(hugeBody(counter), { status: 200 }) : new Response('[]', { status: 200 }));
  try { await findLock({ roundId, playerPubkey, nodes: ['http://a.test', 'http://bad.test'], fetcher }); } catch { /* a refusal is fine */ }
  assert.ok(counter.pulled <= BOUND, `findLock read ${Math.round(counter.pulled / MB)} MB of one seat's /stake-lock answer (bound ${BOUND / MB} MB)`);
});

test('settlementOf: one seat\'s huge /lock-settlement answer is not read whole', async () => {
  const counter = { pulled: 0 };
  const fetcher = async (url) => (new URL(url).host === 'bad.test'
    ? new Response(hugeBody(counter, '{"x":1'), { status: 200 }) : new Response('{"state":"NONE"}', { status: 200 }));
  try { await settlementOf({ roundId, nodes: ['http://a.test', 'http://bad.test'], fetcher }); } catch { /* a refusal is fine */ }
  assert.ok(counter.pulled <= BOUND, `settlementOf read ${Math.round(counter.pulled / MB)} MB of one seat's /lock-settlement answer (bound ${BOUND / MB} MB)`);
});

test('forfeitOf: one seat\'s huge /forfeit answer is not read whole', async () => {
  const counter = { pulled: 0 };
  const fetcher = async (url) => (new URL(url).host === 'bad.test'
    ? new Response(hugeBody(counter, '{"x":1'), { status: 200 }) : new Response('nope', { status: 409 }));
  try { await forfeitOf({ roundId, entryId: 'ef'.repeat(32), nodes: ['http://bad.test', 'http://a.test'], fetcher }); } catch { /* a refusal is fine */ }
  assert.ok(counter.pulled <= BOUND, `forfeitOf read ${Math.round(counter.pulled / MB)} MB of one seat's /forfeit answer (bound ${BOUND / MB} MB)`);
});
