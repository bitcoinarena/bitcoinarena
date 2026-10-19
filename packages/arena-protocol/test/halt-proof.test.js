// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A HALT, PROVEN BY THE SEATS (spec §23A.5 "How a halt is proven", RULED 2026-10-14) - rehearsal 17's case:
// a federation of four (3 of 4) whose g2 and g3 left, so no 2f + 1 can sign for it; nine census seats observe it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { taggedHash } from '../src/hash.js';
import { signHaltObservation, decodeHaltObservation, encodeHaltObservation, haltProof, haltQuorum } from '../src/halt-proof.js';

const key = (s) => { const secret = taggedHash('TEST/halt', new TextEncoder().encode(s)); return { secret, pub: schnorr.getPublicKey(secret) }; };
const verify = (sig, msg, pub) => { try { return schnorr.verify(sig, msg, pub); } catch { return false; } };
const seats = Array.from({ length: 9 }, (_, i) => key(`seat${i}`));
const peer = (i) => Uint8Array.from([2, ...taggedHash('TEST/peer', Uint8Array.of(i))]);
const federationId = taggedHash('TEST/fed', Uint8Array.of(1));
const record = { federationId, guardians: [0, 1, 2, 3].map((i) => ({ peerKey: peer(i) })) };
const observe = (seat, over = {}) => signHaltObservation({ federationId, session: 41, firstHeight: 341, height: 351, answering: [peer(0), peer(1)],
  observer: seat.pub, ...over }, (h) => schnorr.sign(h, seat.secret));
const census = seats.map((s) => s.pub);
const opts = { record, censusSeats: census, abandonBlocks: 10, verify };

test('a majority of the census seats observing one session for abandon_blocks proves the halt; the guardians that answered are not slashed', () => {
  assert.equal(haltQuorum(9), 5); assert.equal(haltQuorum(4), 5); assert.equal(haltQuorum(14), 8);
  const four = haltProof(seats.slice(0, 4).map((s) => observe(s)), opts);
  assert.equal(four.ok, false); assert.match(four.why, /4 seat\(s\) observe the halt at one session, and 9 active seats need 5/);
  const p = haltProof(seats.slice(0, 5).map((s, i) => observe(s, { firstHeight: 340 + i, height: 351 + i })), opts);
  assert.equal(p.ok, true, p.why);
  assert.equal(p.session, 41); assert.equal(p.observers, 5);
  assert.equal(p.haltHeight, 344, 'the latest first_height: no seat is believed to have seen it before the others');
  assert.deepEqual(p.abandoned.map((k) => k[1]), [peer(2)[1], peer(3)[1]], 'g2 and g3 are abandoned by the halt itself');
  assert.equal(p.answered.length, 2, 'g0 and g1 answered through the halt: not slashed');
});

test('it is not a proof: a short span, a stranger, a forged signature, two sessions split, or a session after S', () => {
  const short = haltProof(seats.slice(0, 5).map((s) => observe(s, { firstHeight: 345 })), opts);
  assert.match(short.why, /spans 6 blocks, short of abandon_blocks 10/);
  const stranger = key('not a seat');
  assert.equal(haltProof([...seats.slice(0, 4).map((s) => observe(s)), observe(stranger)], opts).ok, false);
  const forged = { ...observe(seats[4]), signature: new Uint8Array(64) };
  assert.equal(haltProof([...seats.slice(0, 4).map((s) => observe(s)), forged], opts).ok, false);
  const split = haltProof([...seats.slice(0, 3).map((s) => observe(s)), ...seats.slice(3, 6).map((s) => observe(s, { session: 42 }))], opts);
  assert.equal(split.ok, false, 'three and three at two sessions: no five agree');
  const slow = haltProof(seats.slice(0, 6).map((s) => observe(s)), { ...opts, laterSession: 42 });
  assert.match(slow.why, /session 42 is after the halted session 41: the federation is slow, not halted/);
  // a seat counted once however often it posts
  assert.equal(haltProof([...Array(5)].map(() => observe(seats[0])), opts).ok, false);
});

test('an observation round-trips its bytes, its answering peers sorted', () => {
  const o = observe(seats[0], { answering: [peer(1), peer(0)] });
  const back = decodeHaltObservation(encodeHaltObservation(o));
  assert.equal(back.session, 41); assert.equal(back.answering.length, 2);
  assert.deepEqual(back.answering.map((k) => k[1]), [...o.answering].map((k) => k[1]));
  assert.throws(() => encodeHaltObservation({ ...o, firstHeight: 400 }), /first seen after/);
});
