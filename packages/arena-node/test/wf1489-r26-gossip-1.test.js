// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 r26 gossip-1: ONE census node's signed address announcement may name ANY http(s) URL - a loopback or private host, with a path and
// an open query - and every honest seat then sends its peer reads and posts for that node there (announceOwn, pullAnnouncements, every
// committee read through peerEndpointsOf). The node steers each honest seat's requests into the seat's OWN machine: e.g. its zap address
// server, which counts a loopback caller as "this node's own tool" and skips the per-asker mint limits, or signal-cli / OpenClaw ports.
// Safe behaviour: an announcement of another node naming a loopback / private host is not taken as that node's endpoint.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { schnorr } from '@noble/curves/secp256k1.js';
import { signAddressAnnouncement } from '../../arena-protocol/src/address-announcement.js';
import { createAddressBook, announceOwn, pullAnnouncements } from '../src/address-book.js';

const verify = (sig, msg, key) => { try { return schnorr.verify(sig, msg, key); } catch { return false; } };
const keyOf = (b) => { const secret = new Uint8Array(32).fill(b); return { secret, hex: Buffer.from(schnorr.getPublicKey(secret)).toString('hex') }; };
const HONEST = keyOf(3), BAD = keyOf(4);
const sign = (k) => (d) => schnorr.sign(d, k.secret);
const T0 = 1_800_000_000_000;

test('a census node cannot point the honest seats at their own loopback services', async () => {
  const db = new DatabaseSync(':memory:');
  const census = new Set([HONEST.hex, BAD.hex]);
  const book = createAddressBook({ db, verify, nowMs: () => T0, isCensusNode: (k) => (k === '' ? true : census.has(k)), ownKey: HONEST.hex });
  const entries = [
    { pubkey: Buffer.from(HONEST.hex, 'hex'), advert: { endpoint: 'https://honest.example', timestamp: BigInt(T0 - 60000) } },
    { pubkey: Buffer.from(BAD.hex, 'hex'), advert: { endpoint: 'https://bad.example', timestamp: BigInt(T0 - 60000) } },
  ];
  // the bad node's announcement: the honest seat's own zap address callback on loopback, its suffix swallowed by the query
  const evil = signAddressAnnouncement({ node: BAD.hex, endpoint: 'http://127.0.0.1:18777/lnurlp/tips/cb?amount=1000&x=', atMs: T0 }, sign(BAD));
  book.take(evil);
  const hit = [];
  await announceOwn({ announcement: {}, entries, book, ownKey: HONEST.hex, post: async (u) => { hit.push(u); return true; } });
  await pullAnnouncements({ entries, book, ownKey: HONEST.hex, get: async (u) => { hit.push(u); return { announcements: [] }; } });
  const local = hit.filter((u) => /^https?:\/\/(127\.|localhost|10\.|192\.168\.|\[::1\])/.test(u));
  assert.deepEqual(local, [], `the honest seat dialed its own loopback for the bad node: ${local.join(' , ')}`);
});
