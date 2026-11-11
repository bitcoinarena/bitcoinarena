// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 round 2 (gossip): ONE PEER'S GET /address-announcements IS TAKEN WHOLE. pullAnnouncements keeps every entry a seat lists,
// and the book keeps an announcement from any key that signs its own - no census node, no bound, no endpoint length. A stranger (or one
// seat) lists thousands of self-signed announcements with long endpoints; every seat that pulls it keeps them all, stores them, and serves
// them again at its own GET /address-announcements, so the junk spreads to the whole network.
// Safe behaviour: what one peer's answer adds is bounded, and a single announcement's endpoint is bounded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { signAddressAnnouncement } from '../../arena-protocol/src/address-announcement.js';
import { createAddressBook, pullAnnouncements } from '../src/address-book.js';

const verify = (sig, msg, key) => { try { return schnorr.verify(sig, msg, key); } catch { return false; } };
const T0 = 1_800_000_000_000;

test('one peer listing 2000 self-signed announcements of keys no census names does not grow every pulling seat by 2000 rows', async () => {
  const junk = [];
  for (let i = 0; i < 2000; i++) {
    const secret = new Uint8Array(randomBytes(32));
    const node = Buffer.from(schnorr.getPublicKey(secret)).toString('hex');
    junk.push(signAddressAnnouncement({ node, endpoint: `https://x${i}.example/${'a'.repeat(4000)}`, atMs: T0 - 1000 }, (d) => schnorr.sign(d, secret)));
  }
  const db = new DatabaseSync(':memory:');
  const book = createAddressBook({ db, verify, nowMs: () => T0 });
  // the census holds one honest peer; its answer is the attacker's list
  const peer = { pubkey: Buffer.alloc(32, 7), advert: { endpoint: 'https://evil-seat.example', timestamp: 0n } };
  const p = await pullAnnouncements({ entries: [peer], book, ownKey: 'ff'.repeat(32), get: async () => ({ announcements: junk }) });
  const rows = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(body)), 0) AS bytes FROM address_announcements').get();
  console.log(`kept from one peer's answer: ${p.kept}, rows ${rows.n}, ${rows.bytes} bytes stored, served again: ${book.list().length}`);
  assert.ok(p.kept < 2000, `one peer's answer added ${p.kept} announcements of keys no census names`);
  assert.ok(rows.bytes < 1_000_000, `one peer's answer stored ${rows.bytes} bytes in the address book`);
});
