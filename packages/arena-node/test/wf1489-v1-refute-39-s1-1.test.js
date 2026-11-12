// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 / #1533 refute: announcements of keys no census names, taken at POST /address-announcement while the seat has read no
// census yet (isCensusNode -> null: the first ARENA_ADDRESS_PULL_FIRST_MS = 60 s after every start, or for good on a seat with
// ARENA_ADDRESS_PULL=0 and no announcements), stay in the book once the census IS read, stay after a restart, and are served again at
// GET /address-announcements. The census check is only applied at the door, never to what the book already holds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { signAddressAnnouncement } from '../../arena-protocol/src/address-announcement.js';
import { createAddressBook } from '../src/address-book.js';

const verify = (sig, msg, key) => { try { return schnorr.verify(sig, msg, key); } catch { return false; } };
const T0 = 1_800_000_000_000;

test('junk taken before the census was read is no longer served once the census is read (and after a restart)', () => {
  const honestSecret = new Uint8Array(randomBytes(32));
  const honest = Buffer.from(schnorr.getPublicKey(honestSecret)).toString('hex');
  let census = null;   // what server.js addressCensus is before censusForAddresses ran
  const isCensusNode = (hex) => (census ? census.has(String(hex)) : null);
  const db = new DatabaseSync(':memory:');
  const book = createAddressBook({ db, verify, nowMs: () => T0, isCensusNode });
  let taken = 0;
  for (let i = 0; i < 300; i++) {
    const s = new Uint8Array(randomBytes(32));
    const node = Buffer.from(schnorr.getPublicKey(s)).toString('hex');
    const a = signAddressAnnouncement({ node, endpoint: `https://j${i}.example/${'a'.repeat(200)}`, atMs: T0 - 1000 }, (d) => schnorr.sign(d, s));
    if (book.take(JSON.parse(JSON.stringify(a))).kept) taken++;
  }
  // now the census is read: only the honest node
  census = new Set([honest]);
  const servedNow = book.list().filter((x) => !census.has(x.node)).length;
  const reopened = createAddressBook({ db, verify, nowMs: () => T0, isCensusNode });
  const servedAfterRestart = reopened.list().filter((x) => !census.has(x.node)).length;
  console.log(`taken before the census: ${taken}; non-census served after the census read: ${servedNow}; after a restart: ${servedAfterRestart}`);
  assert.equal(servedNow, 0, `${servedNow} announcements of keys no census names still served after the census was read`);
  assert.equal(servedAfterRestart, 0, `${servedAfterRestart} announcements of keys no census names loaded again after a restart`);
});
