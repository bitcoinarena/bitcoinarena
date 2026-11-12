// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 v1 refute 48 s2 (reload / resume path of #1543 + #1720): a store from before the tags table is backfilled one INSERT at a
// time, each autocommitted, and "done" is judged by `SELECT 1 FROM tags LIMIT 1`. A relay stopped part way (a big store takes a while)
// leaves some tag rows; every later start sees a non-empty table and never fills the rest - those events are never found by any #<letter>
// filter again (badge awards by #p, zap receipts by #p, seeds by #d).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import WebSocket from 'ws';
import { startRelay } from '../src/nostr-relay.js';

const h = (s) => createHash('sha256').update(String(s)).digest('hex');
const P = h('player');
const req = async (port, f) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`); await new Promise((r) => ws.on('open', r));
  const got = [];
  await new Promise((r) => { ws.on('message', (m) => { const x = JSON.parse(String(m)); if (x[0] === 'EVENT') got.push(x[2].id); if (x[0] === 'EOSE' || x[0] === 'CLOSED') r(); }); ws.send(JSON.stringify(['REQ', 's', f])); });
  ws.terminate(); return got;
};

test('#1489-v1-refute-48-s2-3 a tag backfill cut off part way is finished on the next start', async () => {
  const path = join(mkdtempSync(join(process.cwd(), 'wf48s2b-')), 'r.db');
  // a pre-#1543 store: events only
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE events (id TEXT PRIMARY KEY, pubkey TEXT, kind INTEGER, created_at INTEGER, d TEXT, json TEXT)');
  const put = db.prepare('INSERT INTO events (id, pubkey, kind, created_at, d, json) VALUES (?, ?, ?, ?, ?, ?)');
  for (let i = 0; i < 30; i++) {
    const e = { id: h(`ev${i}`), pubkey: h('node'), created_at: 1700000000 + i, kind: 8, tags: [['p', P]], content: '', sig: '00'.repeat(64) };
    put.run(e.id, e.pubkey, e.kind, e.created_at, '', JSON.stringify(e));
  }
  // what a start of this build leaves when it is stopped after the first 3 autocommitted backfill INSERTs: the tags table it creates
  // (CREATE TABLE IF NOT EXISTS, all five columns) holding the tag rows of the first 3 events only
  db.exec('CREATE TABLE tags (id TEXT, name TEXT, value TEXT, kind INTEGER, created_at INTEGER)');
  const tag = db.prepare('INSERT INTO tags (id, name, value, kind, created_at) VALUES (?, ?, ?, ?, ?)');
  for (let i = 0; i < 3; i++) tag.run(h(`ev${i}`), 'p', P, 8, 1700000000 + i);
  db.close();
  const r = await startRelay({ port: 0, dbPath: path });
  try {
    const got = await req(r.port, { '#p': [P] });
    console.log(`  FACTS after the restart: {#p:[player]} -> ${got.length} of 30 stored events`);
    assert.equal(got.length, 30, 'events whose tags the cut backfill did not reach are never found by #p');
  } finally { await r.close(); }
});
