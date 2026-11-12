// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute of #1829: the same unbounded read of a peer seat's GET /round-result answer lives on in entry-relay.js
// seatView (membersKnown's viewOf, asked of every committee peer every ~2 s until the result window): `await r.json()` with no
// byte limit. One committee seat answers tens of MB and every honest committee seat buffers and JSON-parses all of it.
// SAFE: the answer is read only up to a small cap (as game-market.js bytesUpTo does since #1829).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seatView } from '../src/entry-relay.js';

const PADDED = 48 * 1024 * 1024;
const CAP = 4 * 1024 * 1024;
function padded(total, first) {
  const st = { pulled: 0 };
  const chunk = new Uint8Array(64 * 1024).fill(0x20);
  let sent = 0;
  const body = new ReadableStream({
    pull(ctrl) {
      if (sent >= total) { ctrl.close(); return; }
      const c = sent === 0 && first ? first : chunk;
      sent += c.length; st.pulled += c.length; ctrl.enqueue(c);
    },
  }, { highWaterMark: 0 });
  return { res: new Response(body, { status: 200 }), st };
}

test('wf1489-a45-refute-16-s1-1: one committee seat\'s padded GET /api/round-result is not read whole by seatView', async () => {
  let bad = null;
  const view = seatView(async () => { bad = padded(PADDED, new TextEncoder().encode('{"players":[],"pad":"')); return bad.res; });
  let err = null;
  try { await view('http://bad.test', 'ab'.repeat(32)); } catch (e) { err = e; }
  console.log(`  FACTS: the bad seat sent ${PADDED} bytes; the honest seat pulled ${bad.st.pulled}; seatView ${err ? 'threw ' + err.message.slice(0, 60) : 'answered'}`);
  assert.ok(bad.st.pulled <= CAP, `the honest seat read ${bad.st.pulled} bytes of one peer's GET /api/round-result (cap ${CAP})`);
});
