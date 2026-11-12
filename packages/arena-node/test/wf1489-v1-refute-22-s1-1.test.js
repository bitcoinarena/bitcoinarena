// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 v1-refute-22 (#1513): the author quota counts LENGTH(events.json) only, but every single-letter tag is also written to
// the `tags` table (#1543) with the event id and two indexes. A 54 KB event of ~6000 empty one-letter tags counts 54 KB and costs
// ~1 MB of disk, so one free key under the default 4 MB quota stores tens of MB, and the 512 MB total is many GB of real disk.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startRelay } from '../src/nostr-relay.js';
import { key, ev, publish } from './_r22-common.mjs';

test('#1513 v1-refute-22-1: the disk an event takes is about what the quota counts (tags table included)', async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'r22-1-')), 'relay.db');
  const r = await startRelay({ port: 0, dbPath });
  const socks = [];
  const a = key();
  const tags = Array.from({ length: 6000 }, (_, i) => [String.fromCharCode(97 + (i % 26)), '']);
  const evs = Array.from({ length: 2 }, (_, i) => ev(a, { at: 1_700_000_000 + i, tags, content: String(i) }));
  const t = Date.now();
  try { await publish(r.port, evs, socks); } finally { for (const w of socks) w.terminate(); await r.close(); }
  const ms = Date.now() - t;
  const db = new DatabaseSync(dbPath);
  const pg = (q) => Object.values(db.prepare(q).get())[0];
  const used = (pg('PRAGMA page_count') - pg('PRAGMA freelist_count')) * pg('PRAGMA page_size');
  const counted = pg('SELECT COALESCE(SUM(LENGTH(json)),0) FROM events');
  const tagRows = pg('SELECT COUNT(*) FROM tags');
  db.close();
  // the empty store is a few pages; what is on disk must be about what the quota counted, not many times it
  assert.ok(used <= 3 * counted + 64 * 1024, `2 events counted ${counted} bytes against the author's quota but take ${used} bytes of disk (${tagRows} tag rows, ${Math.round(used / counted)}x; ${ms} ms to store them): one key under the 4 MB quota stores ~${Math.round(4 * used / counted)} MB`);
});
