// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1236 (audit 2 #1204 RES-4): the arbiter paid liquidation claims against the first copy of the spent set the first seat listed,
// unchecked - an older session (notes spent since, claimed again), a copy nobody of the federation signed, or none. Now every seat is read,
// every copy checked against the record most seats list, and the newest session signed wins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { spentSetFromSeats } from '../src/arbiter.js';
import { signSpentSet, encodeSpentSet } from '../../arena-protocol/src/spent-set.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const FED = new Uint8Array(32).fill(0x37);
const guardians = Array.from({ length: 7 }, (_, i) => { const secret = new Uint8Array(32).fill(i + 1); return { secret, nodePubkey: schnorr.getPublicKey(secret) }; });
const stranger = { secret: new Uint8Array(32).fill(0x55), nodePubkey: schnorr.getPublicKey(new Uint8Array(32).fill(0x55)) };
const RECORDS = { good: { federationId: FED, guardians: guardians.map(({ nodePubkey }) => ({ nodePubkey })) },
  forged: { federationId: FED, guardians: [{ nodePubkey: stranger.nodePubkey }] } };
const readRecord = (hex) => RECORDS[hex];
const nonce = (i) => Uint8Array.from([2, ...new Uint8Array(32).fill(i)]);
const said = (g, session, ids) => { const c = signSpentSet({ federationId: FED, session, nonces: ids.map(nonce), signer: g.nodePubkey }, (m) => schnorr.sign(m, g.secret));
  return { spentSet: toHex(encodeSpentSet(c)), signature: toHex(c.signature) }; };
const listing = (record, copies) => ({ federation: toHex(FED), record, spentSet: copies.length ? { copies } : null });

test('#1236 the newest session any seat lists wins, not the first seat\'s copy', () => {
  // seat 1 still holds session 40 (notes 1, 2 spent); seat 2 has session 41, where note 3 was spent too
  const got = spentSetFromSeats([listing('good', [said(guardians[0], 40, [1, 2])]), listing('good', [said(guardians[1], 41, [1, 2, 3]), said(guardians[2], 41, [1, 2, 3])])], { verify, readRecord });
  console.log('  MEASURED #1236 newest:', JSON.stringify({ session: got.session, signers: got.signers, nonces: got.spentNonces.length }));
  assert.equal(got.session, 41); assert.equal(got.signers, 2);
  assert.ok(got.spentNonces.includes(toHex(nonce(3))), 'the note spent in session 41 cannot be claimed');
});

test('#1236 a copy no guardian of the federation signed is refused, even as the only and newest one', () => {
  const got = spentSetFromSeats([listing('good', [said(stranger, 99, [])]), listing('good', [said(guardians[0], 41, [1, 2, 3])])], { verify, readRecord });
  assert.equal(got.session, 41);
  const alone = spentSetFromSeats([listing('good', [said(stranger, 99, [])])], { verify, readRecord });
  assert.equal(alone.spentNonces, null); assert.match(alone.why, /no copy stands/);
  // a tampered copy: the bytes of one guardian's set with another's nonces
  const a = said(guardians[0], 42, [1]), b = said(guardians[0], 42, [1, 2, 3]);
  const tampered = spentSetFromSeats([listing('good', [{ spentSet: a.spentSet, signature: b.signature }])], { verify, readRecord });
  assert.equal(tampered.spentNonces, null);
});

test('#1236 one seat listing another record does not outvote the rest; no record, no copy: null with the reason', () => {
  const copies = [said(guardians[0], 41, [1, 2, 3])];
  const got = spentSetFromSeats([listing('forged', [said(stranger, 50, [])]), listing('good', copies), listing('good', copies)], { verify, readRecord });
  assert.equal(got.session, 41, 'the record most seats list: the stranger\'s copy does not stand on it');
  assert.match(spentSetFromSeats([{ federation: toHex(FED), spentSet: null }], { verify, readRecord }).why, /no seat lists the federation's record/);
  assert.match(spentSetFromSeats([listing('good', [])], { verify, readRecord }).why, /no guardian published/);
});
