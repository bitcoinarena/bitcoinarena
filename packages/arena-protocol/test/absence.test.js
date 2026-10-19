// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// ABSENCE ATTESTATIONS, ABANDONMENT PROOFS AND DEPARTURE NOTICES (spec §23A.4-5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '../../arena-node/node_modules/@noble/curves/secp256k1.js';
import { encodeAbsence, decodeAbsence, signAbsence, abandonmentProof, signDeparture, departureStands } from '../src/absence.js';

const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const FED = new Uint8Array(32).fill(0x37);
const guardians = Array.from({ length: 7 }, (_, i) => { const secret = new Uint8Array(32).fill(i + 1);
  return { secret, nodePubkey: schnorr.getPublicKey(secret), peerKey: Uint8Array.from([2, ...new Uint8Array(32).fill(0x60 + i)]) }; });
const record = { federationId: FED, threshold: 5, guardians: guardians.map(({ nodePubkey, peerKey }) => ({ nodePubkey, peerKey })) };
const ABANDON = 288;
const absent = guardians[6];
const attest = (g, { lastSeen = 1000, at = 1300, peer = absent.peerKey } = {}) =>
  signAbsence({ federationId: FED, peerKey: peer, lastSeenHeight: lastSeen, height: at, attester: g.nodePubkey }, (m) => schnorr.sign(m, g.secret));

test('an attestation is (federation, peer, last_seen_height, height, attester) and reads back the same', () => {
  const a = attest(guardians[0]);
  const { signature, ...body } = a;
  assert.deepEqual(decodeAbsence(encodeAbsence(body)), body);
  assert.throws(() => encodeAbsence({ ...body, lastSeenHeight: 1400 }), /cannot be last seen after/);
});

test('2f + 1 distinct guardians agreeing for abandon_blocks prove abandonment; fewer, shorter or forged do not', () => {
  const five = guardians.slice(0, 5).map((g) => attest(g));
  const p = abandonmentProof(five, { record, peerKey: absent.peerKey, abandonBlocks: ABANDON, verify });
  assert.deepEqual([p.ok, p.signers, p.sinceHeight], [true, 5, 1000], p.why);
  assert.equal(p.id.length, 32);
  const four = abandonmentProof(five.slice(0, 4), { record, peerKey: absent.peerKey, abandonBlocks: ABANDON, verify });
  assert.match(four.why, /4 guardian\(s\) attest the absence, the threshold is 5/);
  const twice = abandonmentProof([...five.slice(0, 4), five[0]], { record, peerKey: absent.peerKey, abandonBlocks: ABANDON, verify });
  assert.equal(twice.ok, false, 'one guardian twice is one');
  const short = guardians.slice(0, 5).map((g) => attest(g, { at: 1287 }));
  assert.match(abandonmentProof(short, { record, peerKey: absent.peerKey, abandonBlocks: ABANDON, verify }).why, /short of abandon_blocks 288/);
  const forged = { ...five[1], signature: five[0].signature };
  assert.equal(abandonmentProof([five[0], forged, ...five.slice(2)], { record, peerKey: absent.peerKey, abandonBlocks: ABANDON, verify }).ok, false);
  const self = [...five.slice(0, 4), attest(absent)];
  assert.match(abandonmentProof(self, { record, peerKey: absent.peerKey, abandonBlocks: ABANDON, verify }).why, /cannot attest its own absence/);
  const stranger = { secret: new Uint8Array(32).fill(0x99) }; stranger.nodePubkey = schnorr.getPublicKey(stranger.secret);
  assert.equal(abandonmentProof([...five.slice(0, 4), attest(stranger)], { record, peerKey: absent.peerKey, abandonBlocks: ABANDON, verify }).ok, false);
});

test('a departure notice stands when its own guardian signs it with the notice period; else it does not', () => {
  const leaver = guardians[3];
  const notice = (over = {}) => signDeparture({ federationId: FED, peerKey: leaver.peerKey, leaveAfterHeight: 2000 + 432, postedAt: 2000, nodePubkey: leaver.nodePubkey, ...over },
    (m) => schnorr.sign(m, (over.signer || leaver).secret));
  const ok = departureStands(notice(), { record, departureNotice: 432, verify });
  assert.deepEqual([ok.ok, ok.leaveAfterHeight], [true, 2432], ok.why);
  assert.match(departureStands(notice({ leaveAfterHeight: 2431 }), { record, departureNotice: 432, verify }).why, /less than departure_notice/);
  assert.match(departureStands(notice({ signer: guardians[0] }), { record, departureNotice: 432, verify }).why, /not signed by the leaving guardian/);
  assert.match(departureStands(notice({ peerKey: Uint8Array.from([3, ...new Uint8Array(32)]) }), { record, departureNotice: 432, verify }).why, /not a guardian/);
});
