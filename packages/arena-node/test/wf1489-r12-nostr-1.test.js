// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r12-nostr-1: THE ROUNDS A BOOK SKIPS MUST NOT HOLD ITS WHOLE WINDOW.
// nostr-results.js and nostr-badges.js read their candidates with acceptedNotIn(db, table, since) - the oldest 50 ACCEPTED rows with no row
// in the book's own table. A round the book skips without writing a row (nostr-results: one whose settlement is not ACCEPTED at this seat
// yet - a round taking several federations with one part stuck - or one whose result it cannot say, kept only in the in-memory notOurs;
// nostr-badges: one whose settlement is not ACCEPTED) is returned again on every tick. Fifty of them and the window is full for good: every
// later round's signed result is never built nor published, and no later round's badge is ever awarded.
// SAFE: a later round that does settle is still published and read for its badges, whatever 50 older rounds wait for.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { nostrResults } from '../src/nostr-results.js';
import { nostrBadges } from '../src/nostr-badges.js';

const SECRET = new Uint8Array(32).fill(7);
const h = (c) => c.repeat(64);
const ridOf = (i) => i.toString(16).padStart(4, '0').repeat(16);

function db50(now) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE lock_settlements (round_id BLOB PRIMARY KEY, txid TEXT, message BLOB, signature BLOB, state TEXT, why TEXT, made_ms INTEGER);
    CREATE TABLE fed_lock_settlements (round_id BLOB, federation_id TEXT, txid TEXT, message BLOB, signature BLOB, state TEXT, why TEXT, made_ms INTEGER, PRIMARY KEY (round_id, federation_id));`);
  // 50 rounds taking two federations: federation A's part ACCEPTED, federation B's never (its row SUBMITTING) - the round is not settled here
  const stuck = [];
  for (let i = 1; i <= 50; i++) {
    const rid = ridOf(i); stuck.push(rid);
    db.prepare('INSERT INTO fed_lock_settlements VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(Buffer.from(rid, 'hex'), 'a'.repeat(64), h('9'), Buffer.alloc(1), Buffer.alloc(64), 'ACCEPTED', '', now - 100000 + i);
    db.prepare('INSERT INTO fed_lock_settlements VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(Buffer.from(rid, 'hex'), 'b'.repeat(64), h('9'), Buffer.alloc(1), Buffer.alloc(64), 'SUBMITTING', '', now - 100000 + i);
  }
  // then an honest round of one federation, ACCEPTED later
  const honest = ridOf(1000);
  db.prepare('INSERT INTO lock_settlements VALUES (?, ?, ?, ?, ?, ?, ?)').run(Buffer.from(honest, 'hex'), h('9'), Buffer.alloc(1), Buffer.alloc(64), 'ACCEPTED', '', now - 1000);
  return { db, stuck: new Set(stuck), honest };
}

test('r12-nostr-1a: 50 rounds whose settlement is not ACCEPTED here do not stop a later settled round\'s Nostr result', async () => {
  const now = 1760400000000;
  const { db, stuck, honest } = db50(now);
  const asked = [];
  const book = nostrResults({ db, secret: SECRET, relays: [], now: () => now, log: () => {},
    settled: (rid) => !stuck.has(rid),
    resultOf: (rid) => { asked.push(rid); return { ok: true, result: { game: { name: 'rock-paper-scissors', id: h('a') }, round: rid, federation: h('f'),
      stakeMsat: '1000', finalMs: now - 1000, settlement: [{ federation: h('f'), txid: h('9') }], outcome: null, entries: [] } }; } });
  for (let i = 0; i < 3; i++) await book.tick();
  book.stop();
  assert.ok(asked.includes(honest), 'the settled round was never even read: the 50 waiting rounds fill acceptedNotIn\'s window on every tick');
  assert.ok(book.row(honest), 'the settled round has its signed result kept (and so published)');
});

test('r12-nostr-1b: 50 rounds whose settlement is not ACCEPTED here do not stop a later settled round\'s badges', async () => {
  const now = 1760400000000;
  const { db, stuck, honest } = db50(now);
  const read = [];
  const book = nostrBadges({ db, secret: SECRET, on: true, relays: [], now: () => now, log: () => {},
    settled: (rid) => !stuck.has(rid),
    roundOf: (rid) => { read.push(rid); return { ok: false, status: 404, why: 'not a hosted game' }; } });
  for (let i = 0; i < 3; i++) await book.tick();
  book.stop();
  assert.ok(read.includes(honest), 'the settled round was never read for its badges: the 50 waiting rounds fill the window on every tick');
});
