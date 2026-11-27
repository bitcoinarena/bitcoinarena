// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r40-client-1: ONE SEAT'S GET /rounds ANSWER IS READ WHOLE BY EVERY VISITOR'S LOBBY.
// fetchLobby asks every seat of the lobby's list (answerWithin: r.arrayBuffer() of the whole body, then text, then JSON.parse) and
// bounds that read only by time (SIGNER_ANSWER_MS, 10 s). A time limit is no byte limit: the browser's fetch inflates a
// Content-Encoding: gzip body before the page sees it (zeros or spaces compress ~1000:1), so one seat answers ~100 KB on the wire
// that the page holds as ~100 MB - several copies (ArrayBuffer, Response copy, UTF-16 string) - on every lobby read (every 5 s).
// Safe behaviour: a seat's listing is read up to a bound (honest listings are under 1 MB; LOBBY_PER_SERIES rounds per series)
// and a longer answer is dropped as that seat's alone - the honest seats are still listed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchLobby } from '../src/lobby.js';

const MB = 1024 * 1024;
const BAD_TOTAL = 96 * MB;      // what the bad seat would send (after the browser's gzip inflation)
const BOUND = 32 * MB;          // far above any honest listing

function hugeBody(counter) {
  const chunk = new Uint8Array(MB).fill(0x20);   // spaces: valid JSON whitespace, ~1000:1 under gzip
  let sent = 0;
  return new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode('{"node":"' + 'cd'.repeat(32) + '","nowMs":1,"rounds":[')); },
    pull(c) {
      if (sent >= BAD_TOTAL) { c.enqueue(new TextEncoder().encode(']}')); c.close(); return; }
      sent += chunk.length; counter.pulled += chunk.length; c.enqueue(chunk);
    },
  });
}

test('one seat\'s huge /rounds answer is not read whole: the lobby stops at a bound and lists the honest seats', async () => {
  const counter = { pulled: 0 };
  const fetcher = async (url) => {
    const origin = new URL(url).origin;
    if (origin === 'http://bad.test') return new Response(hugeBody(counter), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ node: 'ab'.repeat(32), nowMs: Date.now(), rounds: [] }), { status: 200 });
  };
  let got = null, threw = null;
  try { got = await fetchLobby({ nodes: ['http://a.test', 'http://bad.test', 'http://b.test'], fetcher, verify: () => true, answerMs: 10000 }); }
  catch (e) { threw = e; }
  assert.ok(counter.pulled <= BOUND,
    `the lobby read ${Math.round(counter.pulled / MB)} MB of one seat's /rounds answer (bound ${BOUND / MB} MB): no byte cap, only a 10 s timer`);
  assert.equal(threw, null, `the lobby threw: ${threw && threw.message}`);
  assert.ok(got);
});
