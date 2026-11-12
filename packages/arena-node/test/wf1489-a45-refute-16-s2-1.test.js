// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute of #1829 / #2244 (skeptic 2, retry path): entry-relay.js handLocks reads a committee peer's GET /order-locks with
// `await r.json()`, no byte limit, and asks again up to TRIES (3) times while the peer answers 404 to the lock it is handed. Every lock a
// client posts at an honest seat starts such a pass. One peer seat answers tens of MB of valid JSON ('{}' + whitespace) and every honest
// committee seat buffers and parses all of it, three times per lock.
// SAFE: the answer is read only up to a small cap (peer-read.js jsonUpTo, as seatView does since #2244).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEntryRelay } from '../src/entry-relay.js';

const PADDED = 48 * 1024 * 1024;
const CAP = 4 * 1024 * 1024;
const st = { pulled: 0, asked: 0 };
function padded(total) {
  const chunk = new Uint8Array(256 * 1024).fill(0x20);
  let sent = 0;
  return new Response(new ReadableStream({
    pull(ctrl) {
      if (sent === 0) { const h = new TextEncoder().encode('{}'); sent += h.length; st.pulled += h.length; ctrl.enqueue(h); return; }
      if (sent >= total) { ctrl.close(); return; }
      sent += chunk.length; st.pulled += chunk.length; ctrl.enqueue(chunk);
    },
  }, { highWaterMark: 0 }), { status: 200 });
}

test('wf1489-a45-refute-16-s2-1: one committee seat\'s padded GET /order-locks is not read whole, on every retry, by handLocks', async () => {
  const fetcher = async (url, init = {}) => {
    const u = new URL(url);
    if ((init.method || 'GET') === 'GET' && u.pathname === '/order-locks') { st.asked++; return padded(PADDED); }
    return new Response('no such entry yet', { status: 404 });   // the lock is "short", so the seat asks again
  };
  const relay = createEntryRelay({ peersOf: () => ['http://bad.test'], entryOf: () => new Uint8Array([1]), handoutOf: () => null,
    locksOf: () => ({ stake: { s: 1 }, fee: null }), fetcher, log: () => {}, lockAfterMs: 0, spreadMs: 0, againMs: 5 });
  relay.lockTaken(new Uint8Array(32), 'ef'.repeat(32));
  const t0 = Date.now();
  while (st.asked < 3 && Date.now() - t0 < 60000) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 500));
  console.log(`  FACTS: GET /order-locks asked ${st.asked} times; the bad seat sent ${PADDED} bytes per answer; the honest seat pulled ${st.pulled} in all`);
  assert.ok(st.pulled <= CAP, `the honest seat read ${st.pulled} bytes of one peer's GET /order-locks answers (${st.asked} asks, cap ${CAP})`);
});
