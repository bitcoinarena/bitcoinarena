// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute of #1829 / #2244 (skeptic 2, a stranger triggers it): server.js learnRoundApps caps a peer's GET /round since #2244,
// but the loop right after it reads the same seats' GET /entry?id= with `await x.arrayBuffer()`, no byte limit. GET /owner/dev is public
// (no owner signature), so any stranger who loads it makes the node ask the census / dev-client seats; one of them answers tens of MB
// and the node buffers all of it.
// SAFE: GET /entry is read only up to a small cap (an EntryContract is a few hundred bytes).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { HOSTED } from './plugins/hosted.js';

const PADDED = 48 * 1024 * 1024;
const CAP = 4 * 1024 * 1024;

test('wf1489-a45-refute-16-s2-2: a seat\'s padded GET /entry is not read whole when a stranger loads GET /owner/dev', async () => {
  const st = { sent: 0, asked: 0 };
  const bad = createServer((req, res) => {
    if (!req.url.startsWith('/entry')) { res.writeHead(404); res.end(); return; }
    st.asked++;
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    const chunk = Buffer.alloc(256 * 1024, 0x20);
    const more = () => {
      while (st.sent < PADDED) {
        st.sent += chunk.length;
        if (!res.write(chunk)) { res.once('drain', more); return; }
      }
      res.end();
    };
    res.on('close', () => { st.closed = true; });
    more();
  });
  await new Promise((r) => bad.listen(0, '127.0.0.1', r));
  const badBase = `http://127.0.0.1:${bad.address().port}`;
  const m = { owner: null, code: null };
  const store = { read: () => m.owner, write: (o) => { m.owner = o; }, writeCode: (c) => { m.code = c; } };
  const devClients = { keyOf: () => null, list: () => [], rowsAndSeats: () => ({ rows: [{ entryId: 'ab'.repeat(32) }], seats: [badBase] }) };
  const node = await serve(openStore(), { plugins: HOSTED, port: 0, owner: { store }, devClients });
  try {
    const r = await fetch(`http://127.0.0.1:${node.port}/owner/dev`);   // no signature: a stranger
    await r.text();
    console.log(`  FACTS: GET /owner/dev ${r.status}; the bad seat was asked GET /entry ${st.asked} time(s) and sent ${st.sent} of ${PADDED} bytes before the node stopped reading`);
    assert.ok(st.asked >= 1, 'the node asked the seat');
    assert.ok(st.sent <= CAP + 8 * 1024 * 1024, `the node read ${st.sent} bytes of one seat's GET /entry answer (cap ${CAP})`);
  } finally { await node.close(); bad.closeAllConnections?.(); bad.close(); }
});
