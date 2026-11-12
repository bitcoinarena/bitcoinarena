// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 / #1533 refute: the load path. createAddressBook reads every stored row back with checkAddressAnnouncement only - no
// ADDRESS_ENDPOINT_MAX, no ADDRESS_BOOK_MAX, no census. A seat whose store was filled before the fix (the attack #1533 measured: 2000
// rows, 8.5 MB from one peer's answer) keeps every row after the update and serves them all again at GET /address-announcements.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { signAddressAnnouncement } from '../../arena-protocol/src/address-announcement.js';
import { createAddressBook, ADDRESS_ENDPOINT_MAX } from '../src/address-book.js';

const verify = (sig, msg, key) => { try { return schnorr.verify(sig, msg, key); } catch { return false; } };
const T0 = 1_800_000_000_000;

test('rows stored before the fix (oversized endpoints, keys no census names) are not served again after the update', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE IF NOT EXISTS address_announcements (node TEXT PRIMARY KEY, body TEXT NOT NULL)');
  const ins = db.prepare('INSERT INTO address_announcements (node, body) VALUES (?, ?)');
  for (let i = 0; i < 200; i++) {   // what the pre-fix pullAnnouncements stored from one peer's answer
    const s = new Uint8Array(randomBytes(32));
    const node = Buffer.from(schnorr.getPublicKey(s)).toString('hex');
    const a = signAddressAnnouncement({ node, endpoint: `https://x${i}.example/${'a'.repeat(4000)}`, atMs: T0 - 1000 }, (d) => schnorr.sign(d, s));
    ins.run(a.node, JSON.stringify(a));
  }
  const census = new Set(['11'.repeat(32)]);
  const book = createAddressBook({ db, verify, nowMs: () => T0, isCensusNode: (h) => census.has(h) });
  const long = book.list().filter((x) => x.endpoint.length > ADDRESS_ENDPOINT_MAX);
  const bytes = JSON.stringify({ announcements: book.list() }).length;
  console.log(`after the update: ${book.list().length} served, ${long.length} over ${ADDRESS_ENDPOINT_MAX} chars, GET answer ${bytes} bytes`);
  assert.equal(long.length, 0, `${long.length} stored endpoints over ${ADDRESS_ENDPOINT_MAX} characters served again after the update`);
  assert.equal(book.list().filter((x) => !census.has(x.node)).length, 0, 'keys no census names served again after the update');
});
