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

// KANBAN #1204 RES-1 (audit 2): guardian_of is a node's own word. One bonded node naming federation A joined A's reserve committee, the
// epoch moved and the DKG waited for a share it never dealt: no reserve key for A, every paid entry into A refused. With the guardians of
// A's held record, only a node the record names, with the guardian key the record gives it, is a reserve seat.
test('#1204 RES-1 a node naming a federation it does not guard is no reserve seat; the record\'s guardians keep the same epoch', () => {
  const peer = (b) => new Uint8Array(33).fill(b);
  const g = (node, f, pk) => ({ pubkey: key(node), advert: { guardianOf: [{ federationId: f, guardianKey: pk }] } });
  const real = [1, 2, 3, 4, 5, 6, 7].map((n) => g(n, A, peer(0x10 + n)));
  const record = { [toHex(A)]: real.map((e, i) => ({ nodePubkey: e.pubkey, peerKey: peer(0x11 + i) })) };
  const guardiansOf = (f) => record[f] || null;
  const base = reserveMembersOf(real, { guardiansOf })[toHex(A)];
  assert.equal(base.length, 7);
  const variants = {
    'a stranger with any key': g(9, A, peer(0x99)),
    'a stranger with a real guardian\'s key': g(9, A, peer(0x13)),
    'a real guardian\'s node with another guardian\'s key': g(2, A, peer(0x15)),
  };
  for (const [name, extra] of Object.entries(variants)) {
    const m = reserveMembersOf([...real, extra], { guardiansOf })[toHex(A)];
    assert.deepEqual(m.map((e) => toHex(e.pubkey)), base.map((e) => toHex(e.pubkey)), name);
    assert.equal(toHex(epochId(m.map((e) => e.pubkey))), toHex(epochId(base.map((e) => e.pubkey))), `${name}: the same epoch`);
  }
  // the stranger first in census order, before the real one with that key: still the real one
  const first = reserveMembersOf([g(9, A, peer(0x13)), ...real], { guardiansOf })[toHex(A)];
  assert.deepEqual(first.map((e) => e.pubkey[0]), [1, 2, 3, 4, 5, 6, 7]);
  // a federation whose record this seat does not hold is read as before
  assert.deepEqual(reserveMembersOf([g(9, B, peer(0x99))], { guardiansOf })[toHex(B)].map((e) => e.pubkey[0]), [9]);
});
