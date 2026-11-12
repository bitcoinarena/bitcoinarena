// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1704, #1769, #1811 (#1489 v1-refute-22-s1): a store written before the `size` column gets it filled once at start, and its quotas
// count it; an event with more than 100 single-letter tags is refused; duplicate (name, value) tags are indexed once and still match.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startRelay } from '../src/nostr-relay.js';
import { key, ev, publish, open, ask } from './_r22-common.mjs';

test('#1704: an old store is sized at start; too many tags refused; duplicate tags indexed once', async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'r22s1-4-')), 'relay.db');
  const a = key();
  const old = ev(a, { at: 1_700_000_000, tags: [['p', a.pub]], content: '€'.repeat(100) });
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE events (id TEXT PRIMARY KEY, pubkey TEXT, kind INTEGER, created_at INTEGER, d TEXT, json TEXT)');
  db.prepare('INSERT INTO events (id, pubkey, kind, created_at, d, json) VALUES (?, ?, ?, ?, ?, ?)').run(old.id, a.pub, 8, old.created_at, '', JSON.stringify(old));
  db.close();
  const r = await startRelay({ port: 0, dbPath });
  const socks = [];
  try {
    const many = ev(a, { at: 1_700_000_001, tags: Array.from({ length: 101 }, (_, i) => ['p', String(i)]) });
    const dup = ev(a, { at: 1_700_000_002, tags: Array.from({ length: 500 }, () => ['t', 'same']) });
    const oks = await publish(r.port, [many, dup], socks);
    assert.equal(oks[0][2], false); assert.match(oks[0][3], /single-letter tags/);
    assert.equal(oks[1][2], true);
    const ws = await open(r.port); socks.push(ws);
    const got = (await ask(ws, ['REQ', 's', { '#t': ['same'] }], (m) => m[0] === 'EOSE')).filter((m) => m[0] === 'EVENT');
    assert.equal(got.length, 1);
    const ps = (await ask(ws, ['REQ', 'p', { '#p': [a.pub] }], (m) => m[0] === 'EOSE')).filter((m) => m[0] === 'EVENT');
    assert.equal(ps.length, 1);   // the old row's tags were filled in at start
  } finally { for (const w of socks) w.terminate(); await r.close(); }
  const d2 = new DatabaseSync(dbPath);
  const rows = d2.prepare('SELECT id, size, json FROM events').all();
  const tagN = d2.prepare("SELECT COUNT(*) AS n FROM tags WHERE name = 't'").get().n;
  d2.close();
  assert.equal(rows.length, 2);
  for (const x of rows) assert.ok(Number.isInteger(x.size) && x.size >= Buffer.byteLength(x.json), `size ${x.size} for ${Buffer.byteLength(x.json)} bytes of JSON`);
  assert.equal(tagN, 1);
});
