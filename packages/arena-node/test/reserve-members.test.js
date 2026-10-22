// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A FEDERATION'S RESERVE SEATS, ONE PER NODE (kanban #397, measured 2026-10-22: a node with two bonds was listed twice in federation
// A's reserve committee, its reserve epoch refused it, and GET /reserves answered 400 on every seat).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reserveMembersOf } from '../src/reserve-members.js';
import { epochId } from '../../arena-protocol/src/dkg.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const key = (b) => new Uint8Array(32).fill(b);
const A = key(0xaa), B = key(0xbb);
const entry = (node, ...feds) => ({ pubkey: key(node), advert: { guardianOf: feds.map((f) => ({ federationId: f, guardianKey: new Uint8Array(33) })) } });

test('a node with two bond entries is one reserve seat; its federations keep every other node', () => {
  const entries = [entry(1, A), entry(2, A, B), entry(1, A), entry(3, A), entry(4, B)];
  const m = reserveMembersOf(entries);
  assert.deepEqual(m[toHex(A)].map((e) => e.pubkey[0]), [1, 2, 3], 'node 1 once, in census order');
  assert.deepEqual(m[toHex(B)].map((e) => e.pubkey[0]), [2, 4]);
  // the reserve epoch takes the members as they are now; listed twice, it refused the committee
  assert.doesNotThrow(() => epochId(m[toHex(A)].map((e) => e.pubkey)));
  assert.throws(() => epochId(entries.filter((e) => e.advert.guardianOf.some((g) => toHex(g.federationId) === toHex(A))).map((e) => e.pubkey)), /one key/);
});

test('entries without an advertisement or guardian_of name no federation', () => {
  assert.deepEqual(reserveMembersOf([{ pubkey: key(1) }, { pubkey: key(2), advert: {} }, null]), {});
  assert.deepEqual(reserveMembersOf(undefined), {});
});
