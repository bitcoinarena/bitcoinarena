// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2832 (finding wf1489-r24-h2h-1; ruling 2026-11-16 (a)): the certified reveal set, the twin of the lock set - prepared at protocol 32.
import test from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { toHex } from '../src/hash.js';
import { REVEAL_SET_VERSION, speaksVersion } from '../src/constants.js';
import { revealHash, revealSetOf, encodeRevealSet, decodeRevealSet, revealSetId, revealSetSignatureId, encodeRevealSetCertificate,
  revealSetCertificateStands, revealSetToSign, encodeSignedRevealSet, twoRevealSets, certifiesRevealSet, REVEAL_GATHER_MS, REVEAL_SET_WINDOW_MS } from '../src/reveal-set.js';

const b32 = (n) => Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? n : 7));
const ROUND = b32(1);
const seats = Array.from({ length: 7 }, (_, i) => { const sk = b32(40 + i); return { sk, pk: schnorr.getPublicKey(sk) }; });
const committee = seats.map((s) => toHex(s.pk));
const verify = (sig, msg, key) => schnorr.verify(sig, msg, key);
const OPEN = 1_000_000;
const A = { entryId: toHex(b32(10)), revealHash: toHex(revealHash({ move: 1, salt: b32(20) })) };
const B = { entryId: toHex(b32(11)), revealHash: toHex(revealHash({ move: 0, salt: b32(21) })) };
const sign = (set, s, atMs) => ({ key: s.pk, atMs, sig: schnorr.sign(revealSetSignatureId({ setId: revealSetId(set), atMs }), s.sk) });

test('#2832: prepared, not spoken - protocol 32 rounds only, and no build reads it yet', () => {
  assert.equal(REVEAL_SET_VERSION, 32);
  assert.equal(speaksVersion(32), false, 'not rolled: no build speaks it');
  assert.equal(certifiesRevealSet({ protocolVersion: 32, stakeMsat: 1n }, true), true);
  assert.equal(certifiesRevealSet({ protocolVersion: 31, stakeMsat: 1n }, true), false, 'older rounds keep today\'s rule');
  assert.equal(certifiesRevealSet({ protocolVersion: 32, stakeMsat: 0n }, true), false);
});

test('#2832: the set reads back byte for byte; entries ascending; two hashes for one entry are no set', () => {
  const set = revealSetOf({ roundId: ROUND, entries: [B, A] });
  const back = decodeRevealSet(encodeRevealSet(set));
  assert.deepEqual(back.entries.map((e) => toHex(e.entryId)), [A.entryId, B.entryId]);
  assert.throws(() => revealSetOf({ roundId: ROUND, entries: [A, { ...A, revealHash: B.revealHash }] }), /two reveals/);
});

test('#2832: a certificate stands with 5 of 7 seats inside open .. open + gather + window, and not otherwise', () => {
  const set = revealSetOf({ roundId: ROUND, entries: [A, B] });
  const five = encodeRevealSetCertificate({ set, sigs: seats.slice(0, 5).map((s, i) => sign(set, s, OPEN + REVEAL_GATHER_MS + i)) });
  const st = revealSetCertificateStands(five, { roundId: ROUND, committee, threshold: 5, openMs: OPEN, verify });
  assert.equal(st.ok, true, st.why);
  assert.deepEqual(st.entries, [A, B]);
  const four = encodeRevealSetCertificate({ set, sigs: seats.slice(0, 4).map((s) => sign(set, s, OPEN + 10)) });
  assert.match(revealSetCertificateStands(four, { roundId: ROUND, committee, threshold: 5, openMs: OPEN, verify }).why, /4 good committee signatures, 5 needed/);
  const late = encodeRevealSetCertificate({ set, sigs: seats.slice(0, 5).map((s) => sign(set, s, OPEN + REVEAL_GATHER_MS + REVEAL_SET_WINDOW_MS + 1)) });
  assert.equal(revealSetCertificateStands(late, { roundId: ROUND, committee, threshold: 5, openMs: OPEN, verify }).ok, false, 'past the window: VOID');
});

test('#2832: the finding - a liar serves B\'s reveal to some honest seats only; after the gather every honest seat signs the same set', () => {
  // the liar (seat 6) served B's reveal to seats 0-2 and withheld it from 3-5; in the gather the honest seats serve each other what they hold
  const holds = (i) => (i <= 2 ? [A, B] : [A]);
  const served = (i) => [0, 1, 2, 3, 4, 5].filter((j) => j !== i).map(holds);
  const opens = () => true;   // each honest seat re-pulls a reveal a set names and checks it opens its commitment
  const sets = [0, 1, 2, 3, 4, 5].map((i) => revealSetToSign({ own: holds(i), served: served(i), opens }));
  assert.equal(new Set(sets.map((s) => JSON.stringify(s))).size, 1, 'every honest seat signs one set');
  assert.deepEqual(sets[0], [A, B], 'B\'s reveal, held by one honest seat, is in it for all - one verdict');
  // a reveal the seat cannot open is never signed; two hashes for one entry: neither
  assert.deepEqual(revealSetToSign({ own: [A], served: [[B]], opens: (e) => e !== B.entryId }), [A]);
  assert.deepEqual(revealSetToSign({ own: [A], served: [[{ ...A, revealHash: B.revealHash }]] }), []);
});

test('#2832: one key signing two reveal sets of one round is the offence', () => {
  const s1 = revealSetOf({ roundId: ROUND, entries: [A] }), s2 = revealSetOf({ roundId: ROUND, entries: [A, B] });
  const x = sign(s1, seats[6], OPEN + 1), y = sign(s2, seats[6], OPEN + 2);
  const t = twoRevealSets(encodeSignedRevealSet({ set: s1, atMs: x.atMs, sig: x.sig }), encodeSignedRevealSet({ set: s2, atMs: y.atMs, sig: y.sig }), verify);
  assert.equal(t.ok, true);
  assert.equal(t.verify(seats[6].pk), true);
  assert.equal(t.verify(seats[5].pk), false);
});
