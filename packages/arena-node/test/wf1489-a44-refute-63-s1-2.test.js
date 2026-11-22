// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2169 (a44-refute-63): only a census row from a store written before the hash column (#1749) is LEGACY and may take the
// first hash it finds; a row the #1749 build stored with a NULL hash (read while getblockhash did not answer) is not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openStore } from '../src/store.js';
import { createFundingBook } from '../src/funding-book.js';

const verify = (s, m, k) => schnorr.verify(s, m, k);
const book = (db) => createFundingBook({ db, verify, tip: async () => 0, isBonded: () => true, activeAt: async () => null });
const legacyOf = (db) => db.prepare('SELECT proposal, hash, legacy FROM funding_vote_census ORDER BY proposal').all().map((r) => ({ ...r }));

test('a store from before the hash column: its census rows are legacy', () => {
  const db = openStore(':memory:');
  db.exec('CREATE TABLE funding_vote_census (proposal TEXT PRIMARY KEY, height INTEGER NOT NULL, census TEXT NOT NULL)');
  db.prepare("INSERT INTO funding_vote_census VALUES ('p1', 101, '[]')").run();
  book(db);
  assert.deepEqual(legacyOf(db), [{ proposal: 'p1', hash: null, legacy: 1 }]);
});

test('a store from the #1749 build: a NULL-hash row is not legacy, a hashed one stays as it is', () => {
  const db = openStore(':memory:');
  db.exec('CREATE TABLE funding_vote_census (proposal TEXT PRIMARY KEY, height INTEGER NOT NULL, census TEXT NOT NULL, hash TEXT)');
  db.prepare("INSERT INTO funding_vote_census VALUES ('p1', 101, '[]', NULL), ('p2', 101, '[]', 'ab')").run();
  book(db);
  assert.deepEqual(legacyOf(db), [{ proposal: 'p1', hash: null, legacy: 0 }, { proposal: 'p2', hash: 'ab', legacy: 0 }]);
});

test('a new store: the column is there, a second open changes nothing', () => {
  const db = openStore(':memory:');
  book(db); book(db);
  assert.ok(db.prepare('PRAGMA table_info(funding_vote_census)').all().some((c) => c.name === 'legacy'));
});
