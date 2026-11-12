// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 / #1533 refute, skeptic 2 (the reload path, a stranger): the junk taken in the window before the census is read is
// pruned from the map but its rows stay in the store (4865c6ccf: "skipped, never deleted"). At the next start the load reads rows in
// store order, before any census is read, and stops at ADDRESS_BOOK_MAX: the stranger's 4096 rows fill the book first and an honest
// census node's announcement stored after them is never read back. Once the census is read the junk goes - and so does the honest
// node's address: the seat dials its stale census endpoint (the #757/#577 outage the book exists for).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { signAddressAnnouncement } from '../../arena-protocol/src/address-announcement.js';
import { createAddressBook, ADDRESS_BOOK_MAX } from '../src/address-book.js';

const verify = (sig, msg, key) => { try { return schnorr.verify(sig, msg, key); } catch { return false; } };
const T0 = 1_800_000_000_000;

test('a stranger\'s rows from the first minute do not push an honest census node\'s address out of the book after a restart', () => {
  const hs = new Uint8Array(randomBytes(32)); const hpub = schnorr.getPublicKey(hs); const honest = Buffer.from(hpub).toString('hex');
  let census = null;
  const isCensusNode = (hex) => (census ? census.has(String(hex)) : null);
  const db = new DatabaseSync(':memory:');
  const book = createAddressBook({ db, verify, nowMs: () => T0, isCensusNode });
  // the first minute after a start: no census read yet; one stranger fills the book
  const js = new Uint8Array(randomBytes(32));
  for (let i = 0; i < ADDRESS_BOOK_MAX; i++) {
    const s = new Uint8Array(randomBytes(32)); const node = Buffer.from(schnorr.getPublicKey(s)).toString('hex');
    book.take(signAddressAnnouncement({ node, endpoint: `https://j${i}.example`, atMs: T0 - 1000 }, (d) => schnorr.sign(d, s)));
  }
  census = new Set([honest]); book.prune();
  // the honest node, bonded, announces its new quick tunnel
  const moved = 'https://moved-honest.example';
  const t = book.take(signAddressAnnouncement({ node: honest, endpoint: moved, atMs: T0 - 10 }, (d) => schnorr.sign(d, hs)));
  assert.equal(t.kept, true);
  const entry = { pubkey: hpub, advert: { endpoint: 'https://dead-census.example', timestamp: 0 } };
  assert.equal(book.endpointOf(entry), moved);
  // a restart: the load runs before the census is read
  census = null;
  const again = createAddressBook({ db, verify, nowMs: () => T0, isCensusNode });
  census = new Set([honest]); again.prune();
  const at = again.endpointOf(entry);
  console.log(`rows ${db.prepare('SELECT COUNT(*) AS n FROM address_announcements').get().n}; after the restart the honest node is found at ${at}`);
  assert.equal(at, moved, `the honest node's announced address lost at the restart: dialed at ${at}`);
});
