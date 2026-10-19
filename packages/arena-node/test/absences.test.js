// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SEAT'S ABSENCE ATTESTATIONS (spec §23A.4, kanban #322): POST /absence takes them, the newest per peer and attester.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createAbsences, absenceHex, readAbsenceHex } from '../src/absences.js';
import { signAbsence } from '../../arena-protocol/src/absence.js';

const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const FED = new Uint8Array(32).fill(0x37);
const g = { secret: new Uint8Array(32).fill(3) }; g.pubkey = schnorr.getPublicKey(g.secret);
const peer = Uint8Array.from([2, ...new Uint8Array(32).fill(0x66)]);
const att = (at) => signAbsence({ federationId: FED, peerKey: peer, lastSeenHeight: 1000, height: at, attester: g.pubkey }, (m) => schnorr.sign(m, g.secret));

test('an attestation travels as hex, is kept once per peer and attester at its newest height, and a forged one is refused', () => {
  const a = att(1300);
  assert.deepEqual(readAbsenceHex(absenceHex(a)), a);
  const h = createAbsences({ verify });
  assert.equal(h.offer(a).kept, true);
  assert.equal(h.offer(att(1200)).kept, false, 'an older one does not replace it');
  assert.equal(h.offer(att(1400)).kept, true);
  assert.equal(h.list().length, 1);
  assert.match(h.offer({ ...att(1500), signature: new Uint8Array(64) }).why, /not signed by its attester/);
  assert.throws(() => readAbsenceHex('00'), /64-byte signature/);
});

test('a departure notice travels as hex and reads back the same; a seat keeps the latest posted per guardian', async () => {
  const { signDeparture } = await import('../../arena-protocol/src/absence.js');
  const { departureHex, readDepartureHex } = await import('../src/absences.js');
  const n = (posted) => signDeparture({ federationId: FED, peerKey: peer, leaveAfterHeight: posted + 18, postedAt: posted, nodePubkey: g.pubkey }, (m) => schnorr.sign(m, g.secret));
  const one = n(100);
  assert.deepEqual(readDepartureHex(departureHex(one)), one);
  const h = createAbsences({ verify });
  assert.deepEqual([h.offerDeparture(n(100)).kept, h.offerDeparture(n(90)).kept, h.offerDeparture(n(120)).kept], [true, false, true]);
  assert.equal(h.listDepartures().length, 1);
  assert.match(h.offerDeparture({ ...n(130), signature: new Uint8Array(64) }).why, /not signed/);
});

test('notices and attestations a seat holds are there again after a restart; one altered in the file is not (kanban #326)', async () => {
  const { signDeparture } = await import('../../arena-protocol/src/absence.js');
  const notice = signDeparture({ federationId: FED, peerKey: peer, leaveAfterHeight: 156960, postedAt: 156644, nodePubkey: g.pubkey }, (m) => schnorr.sign(m, g.secret));
  let file = null;
  const store = { read: () => (file ? JSON.parse(file) : null), write: (v) => { file = JSON.stringify(v); } };
  const before = createAbsences({ verify, store });
  assert.equal(before.offerDeparture(notice).kept, true);
  assert.equal(before.offer(att(1300)).kept, true);
  // THE RESTART: a new seat on the same file
  const after = createAbsences({ verify, store });
  assert.deepEqual([after.listDepartures().length, after.list().length], [1, 1]);
  assert.equal(after.listDepartures()[0], before.listDepartures()[0], 'the same notice, byte for byte');
  // an entry altered in the file is checked like any offer and dropped
  const v = JSON.parse(file); v.departures[0] = v.departures[0].slice(0, -2) + (v.departures[0].endsWith('00') ? '01' : '00'); file = JSON.stringify(v);
  assert.equal(createAbsences({ verify, store }).listDepartures().length, 0);
  // no store: as before
  assert.equal(createAbsences({ verify }).listDepartures().length, 0);
});
