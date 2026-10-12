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
