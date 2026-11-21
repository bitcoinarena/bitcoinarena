// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #2869 (2026-11-16 01:44-02:10Z): every old-Mac seat lost federation A's reserve key with its restart and named none for hours. The
// kept key now survives a restart through the seat's store, still only for its own epoch; a key let go for a moved epoch leaves the store too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { reserveKeyCache } from '../src/reserve-key-cache.js';

function sqliteStore(db) {
  db.exec('CREATE TABLE IF NOT EXISTS reserve_keys_kept (fed TEXT PRIMARY KEY, epoch TEXT, key BLOB NOT NULL)');
  const all = db.prepare('SELECT fed, epoch, key FROM reserve_keys_kept'), put = db.prepare('INSERT OR REPLACE INTO reserve_keys_kept (fed, epoch, key) VALUES (?, ?, ?)'),
    drop = db.prepare('DELETE FROM reserve_keys_kept WHERE fed = ?');
  return { load: () => all.all().map((r) => ({ fed: r.fed, epoch: r.epoch, key: new Uint8Array(r.key) })),
    save: (fed, epoch, key) => { if (key) put.run(fed, epoch, Buffer.from(key)); else drop.run(fed); } };
}

test('#2869 a reserve key found before a restart is kept after it, for its own epoch only', () => {
  const db = new DatabaseSync(':memory:');
  const key = Uint8Array.from([2, ...Array(32).fill(7)]);
  const a = reserveKeyCache({ store: sqliteStore(db) });
  a.setFor('aa', 'e1', key);
  const b = reserveKeyCache({ store: sqliteStore(db) });   // the restart
  assert.deepEqual(b.getFor('aa', 'e1'), key);
  assert.equal(b.getFor('aa', 'e2'), null, 'not for another epoch');
  assert.deepEqual(b.dropMoved(() => 'e2'), ['aa']);
  const c = reserveKeyCache({ store: sqliteStore(db) });
  assert.equal(c.get('aa'), undefined, 'a key let go is not loaded again');
  assert.equal(reserveKeyCache().get('aa'), undefined, 'no store: memory only, as before');
});
