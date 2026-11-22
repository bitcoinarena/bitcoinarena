// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #1489 r6-nostr-1: ONE REQ PARSES THE WHOLE ANSWER BEFORE IT SENDS A BYTE. stored() reads every match of every filter (10 filters x
// limit 500 = 5000 events, up to 64 KB each) and JSON.parses each one, then builds eventTagSets over all its tags, all in one synchronous
// pass - only afterwards does the send loop stop at SLOW_BYTES (#1717). A kept event may carry thousands of multi-letter tags (only
// single-letter ones are counted, MAX_TAG_ROWS), and each becomes a JS array on parse and a Set entry in eventTagSets. Keys are free and the
// per-author quota is 500 events / 4 MB, so ~100 keys keep 5000 such kind-8 awards; then one REQ (60 per 10 s per socket, sockets free) holds
// the relay's one event loop - every login, NIP-46 signing and NWC payment - for seconds, and allocates gigabytes.
// Safe: one REQ does not hold the event loop for a second (the answer is bounded in bytes/work before it is parsed, not after).
import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { startRelay } from '../src/nostr-relay.js';

test('#1489 r6-nostr-1: one REQ for kept events with many tags does not stall the relay', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-r6-nostr-1-'));
  const path = join(dir, 'relay.db');
  const r0 = await startRelay({ port: 0, dbPath: path }); await r0.close();   // the relay's schema
  // 100 keys x 50 kind-8 events, each ~63 KB of two-letter tags (inside AUTHOR_EVENTS / AUTHOR_BYTES and the event size); rows as the relay keeps them
  const tags = []; for (let i = 0; tags.length * 10 < 62000; i++) tags.push(['xx', String(i % 10)]);
  const db = new DatabaseSync(path);
  db.exec('BEGIN');
  const put = db.prepare('INSERT INTO events (id, pubkey, kind, created_at, d, json, size) VALUES (?, ?, ?, ?, ?, ?, ?)');
  let t = 1_700_000_000;
  for (let k = 0; k < 100; k++) {
    const pubkey = createHash('sha256').update(`k${k}`).digest('hex');
    for (let j = 0; j < 50; j++) {
      const e = { id: randomBytes(32).toString('hex'), pubkey, created_at: t++, kind: 8, tags, content: '', sig: '0'.repeat(128) };
      const json = JSON.stringify(e);
      put.run(e.id, pubkey, 8, e.created_at, '', json, Buffer.byteLength(json) + 320);
    }
  }
  db.exec('COMMIT'); db.close();
  const relay = await startRelay({ port: 0, dbPath: path });
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${relay.port}`); await new Promise((x) => ws.on('open', x));
    // ten filters (MAX_FILTERS), disjoint windows of 500 each: 5000 events
    const filters = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => ({ kinds: [8], since: 1_700_000_000 + i * 500, until: 1_700_000_000 + i * 500 + 499, limit: 500 }));
    let last = Date.now(), worst = 0;
    const tick = setInterval(() => { const n = Date.now(); worst = Math.max(worst, n - last); last = n; }, 10);
    const done = new Promise((x) => ws.on('message', (raw) => { const m = JSON.parse(String(raw)); if (m[0] === 'EOSE' || m[0] === 'CLOSED') x(m[0]); }));
    last = Date.now();
    ws.send(JSON.stringify(['REQ', 's', ...filters]));
    await done;
    await new Promise((x) => setTimeout(x, 50));
    clearInterval(tick);
    ws.terminate();
    console.log(`worst event-loop stall during one REQ: ${worst} ms`);
    assert.ok(worst < 1000, `one REQ held the relay's event loop ${worst} ms`);
  } finally { await relay.close(); }
});
