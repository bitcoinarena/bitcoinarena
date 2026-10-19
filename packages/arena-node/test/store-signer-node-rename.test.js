// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A STORE ON DISK FROM BEFORE THE SIGNER NODE RENAME KEEPS EVERY ROW (2026-09-15 20:32).
//
// The Daily's two signer nodes run on SQLite files made while a signing machine was called a seat:
// a table `seats` and six columns named seat / seat_id / seats / seat_no / seat_pubkey. openStore
// renames them in place before it creates anything. Measured here on a store built with the old
// names and one row in each: after openStore every row reads back under the new names, nothing is
// created empty beside it, and a second open changes nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { openStore, renameToSignerNodes } from '../src/store.js';

test('an old store opens with its signer nodes, shares, nonces, epochs, postings and reruns under the new names', () => {
  const dir = mkdtempSync(join(tmpdir(), 'blwp-rename-'));
  const path = join(dir, 'old.db');
  try {
    const old = new DatabaseSync(path);
    old.exec(`
      CREATE TABLE rounds (round_id BLOB PRIMARY KEY, contract BLOB NOT NULL, state INTEGER NOT NULL DEFAULT 0, opened_ms INTEGER NOT NULL, closed_ms INTEGER);
      CREATE TABLE entries (entry_id BLOB PRIMARY KEY, round_id BLOB NOT NULL, contract BLOB NOT NULL, joined_ms INTEGER NOT NULL);
      CREATE TABLE seats (round_id BLOB NOT NULL, pubkey BLOB NOT NULL, PRIMARY KEY (round_id, pubkey));
      CREATE TABLE held_shares (entry_id BLOB NOT NULL, seat INTEGER NOT NULL, answer BLOB NOT NULL, seen_ms INTEGER NOT NULL, PRIMARY KEY (entry_id, seat));
      CREATE TABLE pool_nonces (round_id BLOB PRIMARY KEY, seat_id TEXT NOT NULL, sighash BLOB NOT NULL, hiding BLOB, binding BLOB,
        commit_hiding BLOB NOT NULL, commit_binding BLOB NOT NULL, spent_list BLOB, spent_share BLOB, updated_ms INTEGER NOT NULL);
      CREATE TABLE dkg_epochs (epoch_id BLOB PRIMARY KEY, seats BLOB NOT NULL, mine BLOB, share BLOB, seat_no INTEGER, group_pubkey BLOB,
        negated INTEGER NOT NULL DEFAULT 0, updated_ms INTEGER NOT NULL);
      CREATE TABLE postings (round_id BLOB NOT NULL, entry_id BLOB NOT NULL, seat_pubkey BLOB NOT NULL, bytes BLOB NOT NULL, seen_ms INTEGER NOT NULL,
        PRIMARY KEY (round_id, entry_id, seat_pubkey));
      CREATE TABLE reruns (round_id BLOB NOT NULL, entry_id BLOB NOT NULL, seat_pubkey BLOB NOT NULL, bytes BLOB NOT NULL, seen_ms INTEGER NOT NULL,
        PRIMARY KEY (round_id, entry_id, seat_pubkey));
    `);
    const k = (n) => new Uint8Array(32).fill(n);
    old.prepare('INSERT INTO seats (round_id, pubkey) VALUES (?, ?)').run(k(1), k(2));
    old.prepare('INSERT INTO seats (round_id, pubkey) VALUES (?, ?)').run(k(1), k(3));
    old.prepare('INSERT INTO held_shares (entry_id, seat, answer, seen_ms) VALUES (?, ?, ?, ?)').run(k(4), 2, k(5), 10);
    old.prepare('INSERT INTO pool_nonces (round_id, seat_id, sighash, commit_hiding, commit_binding, updated_ms) VALUES (?, ?, ?, ?, ?, ?)')
      .run(k(1), 'n2', k(6), k(7), k(8), 11);
    old.prepare('INSERT INTO dkg_epochs (epoch_id, seats, seat_no, updated_ms) VALUES (?, ?, ?, ?)').run(k(9), k(10), 2, 12);
    old.prepare('INSERT INTO postings (round_id, entry_id, seat_pubkey, bytes, seen_ms) VALUES (?, ?, ?, ?, ?)').run(k(1), k(4), k(2), k(11), 13);
    old.prepare('INSERT INTO reruns (round_id, entry_id, seat_pubkey, bytes, seen_ms) VALUES (?, ?, ?, ?, ?)').run(k(1), k(4), k(3), k(12), 14);
    old.close();

    const db = openStore(path);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
    assert.ok(tables.includes('signer_nodes'), 'no signer_nodes table');
    assert.equal(tables.includes('seats'), false, 'the old table is still there beside the new one');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM signer_nodes WHERE round_id = ?').get(k(1)).n, 2, 'the round\'s signer nodes did not carry over');
    assert.equal(db.prepare('SELECT signer_node FROM held_shares WHERE entry_id = ?').get(k(4)).signer_node, 2);
    assert.equal(db.prepare('SELECT signer_node_id FROM pool_nonces WHERE round_id = ?').get(k(1)).signer_node_id, 'n2');
    const epoch = db.prepare('SELECT signer_nodes, signer_node_no FROM dkg_epochs WHERE epoch_id = ?').get(k(9));
    assert.deepEqual([epoch.signer_nodes[0], epoch.signer_node_no], [10, 2]);
    assert.equal(db.prepare('SELECT signer_node_pubkey FROM postings WHERE entry_id = ?').get(k(4)).signer_node_pubkey[0], 2);
    assert.equal(db.prepare('SELECT signer_node_pubkey FROM reruns WHERE entry_id = ?').get(k(4)).signer_node_pubkey[0], 3);
    // A SECOND OPEN finds the new names and renames nothing.
    assert.deepEqual(renameToSignerNodes(db), []);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a new store is made with the new names and nothing to rename', () => {
  const db = openStore();
  assert.deepEqual(renameToSignerNodes(db), []);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
  assert.ok(tables.includes('signer_nodes'));
  assert.equal(tables.includes('seats'), false);
  db.close();
});
