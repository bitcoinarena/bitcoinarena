// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A REFERRAL PROGRAM'S NAME, ONE STEP (kanban #1190, the 2026-11-06 state-machine audit): the newest signed name won by `atMs` alone - two names of one
// date stood in the order a seat got them (seats kept other names), and a name dated ahead of the clock blocked every rename until its date came.
// Now: a date ahead is read as the seat's clock, and two names of one date are ordered by their record's hash, the lower first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { schnorr } from '@noble/curves/secp256k1.js';
import { keepReferralName, referralNames, referralNameStep } from '../src/referral-names.js';
import { encodeReferralName, referralNameId } from '../../arena-protocol/src/referral-name.js';
import { toHex, sha256 } from '../../arena-protocol/src/hash.js';

const secret = new Uint8Array(32).fill(9);
const site = Uint8Array.from([0x02, ...schnorr.getPublicKey(secret)]);
const verify = (sig, msg, key) => schnorr.verify(sig, msg, key);
const signed = (name, atMs) => {
  const r = { site, name, atMs: BigInt(atMs) };
  return { record: toHex(encodeReferralName(r)), signature: toHex(schnorr.sign(referralNameId(r), secret)) };
};
const nameAt = (db) => referralNames(db).get(toHex(site)).name;
const NOW = 1_800_000_000_000;

test('two names of one date: every seat keeps the same one, whatever order it got them in', () => {
  const a = signed('Alpha', NOW - 1000), b = signed('Bravo', NOW - 1000);
  const lower = toHex(sha256(Uint8Array.from(Buffer.from(a.record, 'hex')))) < toHex(sha256(Uint8Array.from(Buffer.from(b.record, 'hex')))) ? 'Alpha' : 'Bravo';
  const seat1 = new DatabaseSync(':memory:'), seat2 = new DatabaseSync(':memory:');
  keepReferralName(seat1, a, { verify, nowMs: NOW }); keepReferralName(seat1, b, { verify, nowMs: NOW });
  keepReferralName(seat2, b, { verify, nowMs: NOW }); keepReferralName(seat2, a, { verify, nowMs: NOW });
  assert.equal(nameAt(seat1), lower);
  assert.equal(nameAt(seat2), lower);
});

test('a name dated ahead of the clock does not block the next rename until its date', () => {
  const db = new DatabaseSync(':memory:');
  const ahead = signed('Ahead', NOW + 9 * 60000);     // 9 minutes ahead: taken (the 10-minute bound stays)
  assert.equal(keepReferralName(db, ahead, { verify, nowMs: NOW }).kept, 'new');
  const later = signed('Later', NOW + 60000);           // a rename a minute later, well before the first one's date
  const got = keepReferralName(db, later, { verify, nowMs: NOW + 60000 });
  assert.equal(got.kept, 'new');
  assert.equal(nameAt(db), 'Later');
});

test('the same record again is held; an older one leaves the kept name; one step decides', () => {
  const db = new DatabaseSync(':memory:');
  const one = signed('One', NOW - 5000), two = signed('Two', NOW - 1000);
  assert.equal(keepReferralName(db, two, { verify, nowMs: NOW }).kept, 'new');
  assert.equal(keepReferralName(db, two, { verify, nowMs: NOW }).kept, 'held');
  assert.equal(keepReferralName(db, one, { verify, nowMs: NOW }).kept, 'older');
  assert.equal(nameAt(db), 'Two');
  assert.equal(referralNameStep(null, { atMs: 1, hash: 'aa' }), 'new');
  assert.equal(referralNameStep({ atMs: 2, hash: 'bb' }, { atMs: 2, hash: 'aa' }), 'new');
  assert.equal(referralNameStep({ atMs: 2, hash: 'aa' }, { atMs: 2, hash: 'bb' }), 'older');
  assert.equal(referralNameStep({ atMs: 2, hash: 'aa' }, { atMs: 2, hash: 'aa' }), 'held');
});
