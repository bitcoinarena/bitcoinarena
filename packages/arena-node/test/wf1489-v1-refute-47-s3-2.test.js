// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute 3 of #1532: the relay caps count LENGTH(bytes) only. A head-to-head reveal record is any 65 bytes that start
// with a held entry id (entry id || move || salt; the door checks nothing else), so a party holding a few entries sends tiny
// records with fresh salts. Each counts 65 bytes, but its row also stores the 32-byte hash, entry_id, round_id, seen_ms, and three
// index entries (primary key, relayed_entry, relayed_round): several times what is counted. The "at most RELAY_MOST bytes in
// `relayed`" bound on the seat's disk is then several times RELAY_MOST, from the unnamed share alone.
// Safe behaviour: what the relay table takes on disk stays within RELAY_MOST.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

process.env.ARENA_RELAY_MOST = String(256 * 1024);   // entry 8 KiB, round 32 KiB, unnamed 128 KiB
const { serve } = await import('../src/server.js');
const { openStore } = await import('../src/store.js');
const { transcriptBytesHash } = await import('../../arena-protocol/src/posting.js');
const { toHex } = await import('../../arena-protocol/src/hash.js');

test('tiny reveal records make the relay table far larger on disk than RELAY_MOST', async () => {
  const db = openStore(':memory:');
  const r = (n) => new Uint8Array(randomBytes(n));
  const entries = [];
  for (let k = 0; k < 5; k++) {
    const rid = r(32);
    db.prepare('INSERT INTO rounds (round_id, contract, opened_ms) VALUES (?, ?, 0)').run(rid, r(8));
    for (let j = 0; j < 4; j++) { const e = r(32); entries.push(e); db.prepare('INSERT INTO entries (entry_id, round_id, contract, joined_ms) VALUES (?, ?, ?, 0)').run(e, rid, r(8)); }
  }
  const size = () => Number(db.prepare('PRAGMA page_count').get().page_count) * Number(db.prepare('PRAGMA page_size').get().page_size);
  const seat = await serve(db, { port: 0 });
  const before = size();   // after the seat opened: only what the door takes counts
  const put = async (bytes) => { const x = await fetch(`http://127.0.0.1:${seat.port}/transcript/${toHex(transcriptBytesHash(bytes))}`, { method: 'PUT', body: bytes }); await x.text(); return x.status; };
  try {
    let kept = 0;
    for (const e of entries) {
      for (let i = 0; i < 200; i++) {
        const rec = new Uint8Array(65); rec.set(e, 0); rec[32] = 0; rec.set(r(32), 33);
        if (await put(rec) !== 201) break;
        kept++;
      }
    }
    const counted = db.prepare('SELECT SUM(LENGTH(bytes)) AS n FROM relayed').get().n;
    const grew = size() - before;
    console.log(`reveal records kept: ${kept}, counted ${counted} bytes, the store grew ${grew} bytes, RELAY_MOST ${process.env.ARENA_RELAY_MOST}`);
    assert.ok(grew <= Number(process.env.ARENA_RELAY_MOST), `the relay table took ${grew} bytes on disk for ${counted} counted, over RELAY_MOST ${process.env.ARENA_RELAY_MOST}`);
  } finally { await seat.close(); }
});
