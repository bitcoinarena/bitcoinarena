// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 / #1533 refute, skeptic 3 (prune is one way): a census read once without an honest node - its bond renewed (old one
// out, the new one not yet in the census at the tip), or one read of censusForAddresses falling back to fedRecords.censusNewestAt
// when the chain tip did not answer - prunes its announcement and marks the row `pruned` (5abc83854). When the census names it again
// nothing reads the row back (refill runs only when the book was full), and at the next start the load skips it: the seat dials the
// node's dead census endpoint until the node announces again - never, if its owner stopped the announcements (#1906's own case).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { signAddressAnnouncement } from '../../arena-protocol/src/address-announcement.js';
import { createAddressBook } from '../src/address-book.js';

const verify = (sig, msg, key) => { try { return schnorr.verify(sig, msg, key); } catch { return false; } };
const T0 = 1_800_000_000_000;

test('an honest node named by the census again is found at its announced address again, and after a restart', () => {
  const hs = new Uint8Array(randomBytes(32)); const hpub = schnorr.getPublicKey(hs); const honest = Buffer.from(hpub).toString('hex');
  const other = Buffer.from(schnorr.getPublicKey(new Uint8Array(randomBytes(32)))).toString('hex');
  let census = new Set([honest, other]);
  const isCensusNode = (hex) => (census ? census.has(String(hex)) : null);
  const db = new DatabaseSync(':memory:');
  const book = createAddressBook({ db, verify, nowMs: () => T0, isCensusNode });
  const moved = 'https://moved-honest.example';
  assert.equal(book.take(signAddressAnnouncement({ node: honest, endpoint: moved, atMs: T0 - 10 }, (d) => schnorr.sign(d, hs))).kept, true);
  const entry = { pubkey: hpub, advert: { endpoint: 'https://dead-census.example', timestamp: 0 } };
  assert.equal(book.endpointOf(entry), moved);
  // one census read without it (bond renewal gap, or the fallback census), then the census names it again
  census = new Set([other]); book.prune();
  census = new Set([honest, other]); book.prune();
  const now = book.endpointOf(entry);
  // and a restart
  census = null;
  const again = createAddressBook({ db, verify, nowMs: () => T0, isCensusNode });
  census = new Set([honest, other]); again.prune();
  const later = again.endpointOf(entry);
  console.log(`named again: dialed at ${now}; after a restart: ${later}; row ${JSON.stringify(db.prepare('SELECT pruned FROM address_announcements WHERE node = ?').get(honest))}`);
  assert.equal(now, moved, `named by the census again, the honest node is dialed at ${now}`);
  assert.equal(later, moved, `after a restart the honest node is dialed at ${later}`);
});
