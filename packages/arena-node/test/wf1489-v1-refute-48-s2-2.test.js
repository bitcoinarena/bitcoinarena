// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 v1 refute 48 s2 (reload / resume path of #1720): the old-store migration is three autocommitted statements -
// ALTER ADD kind; ALTER ADD created_at; UPDATE (fill both) - and "done" is judged only by the created_at column being there.
//   a) the relay is stopped (systemd timeout, OOM, power) while the UPDATE runs on a big store: the UPDATE rolls back, both columns
//      stay, the next start sees created_at and skips the fill - every old tag row keeps kind/created_at NULL and the tag streams
//      (created_at >= ?) never find them: a player's badges and zap receipts are gone for good;
//   b) stopped between the two ALTERs: the next start runs ALTER ADD kind again, "duplicate column name", the relay never starts.
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
// a store exactly as the build before #1720 (85f803d70) wrote it: tags (id, name, value)
const oldStore = (path, n) => {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE events (id TEXT PRIMARY KEY, pubkey TEXT, kind INTEGER, created_at INTEGER, d TEXT, json TEXT);
    CREATE TABLE tags (id TEXT, name TEXT, value TEXT); CREATE INDEX tag_value ON tags (name, value); CREATE INDEX tag_id ON tags (id);`);
  const put = db.prepare('INSERT INTO events (id, pubkey, kind, created_at, d, json) VALUES (?, ?, ?, ?, ?, ?)');
  const tag = db.prepare('INSERT INTO tags (id, name, value) VALUES (?, ?, ?)');
  for (let i = 0; i < n; i++) {
    const e = { id: h(`ev${i}`), pubkey: h('node'), created_at: 1700000000 + i, kind: 8, tags: [['a', `30009:${h('node')}:win`], ['p', P]], content: '', sig: '00'.repeat(64) };
    put.run(e.id, e.pubkey, e.kind, e.created_at, '', JSON.stringify(e));
    for (const t of e.tags) tag.run(e.id, t[0], t[1]);
  }
  return db;
};
const req = async (port, f) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`); await new Promise((r) => ws.on('open', r));
  const got = [];
  await new Promise((r) => { ws.on('message', (m) => { const x = JSON.parse(String(m)); if (x[0] === 'EVENT') got.push(x[2].id); if (x[0] === 'EOSE' || x[0] === 'CLOSED') r(); }); ws.send(JSON.stringify(['REQ', 's', f])); });
  ws.terminate(); return got;
};

test('#1489-v1-refute-48-s2-2 a migration cut off during its UPDATE: the restarted relay still finds every old event by its tag', async () => {
  const path = join(mkdtempSync(join(process.cwd(), 'wf48s2m-')), 'r.db');
  const db = oldStore(path, 40);
  // what the cut leaves: both ALTERs committed, the UPDATE rolled back
  db.exec('ALTER TABLE tags ADD COLUMN kind INTEGER; ALTER TABLE tags ADD COLUMN created_at INTEGER;'); db.close();
  const r = await startRelay({ port: 0, dbPath: path });
  try {
    const got = await req(r.port, { kinds: [8], '#p': [P] });
    const plain = await req(r.port, { kinds: [8] });
    console.log(`  FACTS after the restart: {kinds:[8], #p:[player]} -> ${got.length} events, {kinds:[8]} -> ${plain.length} events (40 stored)`);
    assert.equal(got.length, 40, 'the player\'s badge awards are not found by #p after the restart');
  } finally { await r.close(); }
});

test('#1489-v1-refute-48-s2-2 a migration cut off between its two ALTERs: the relay still starts', async () => {
  const path = join(mkdtempSync(join(process.cwd(), 'wf48s2m-')), 'r.db');
  const db = oldStore(path, 5);
  db.exec('ALTER TABLE tags ADD COLUMN kind INTEGER;'); db.close();
  let r, err;
  try { r = await startRelay({ port: 0, dbPath: path }); } catch (e) { err = e; }
  console.log(`  FACTS startRelay: ${err ? `threw ${err.message}` : 'started'}`);
  try { assert.equal(err, undefined, 'the relay does not start after a cut migration'); } finally { if (r) await r.close(); }
});
