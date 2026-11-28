// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #3901 (§23A.5 step 3, RULED 2026-11-28 Q2): a guardian the seats' halt proof names ABANDONED is slashed on a proof of its own kind - the halt proof and the
// newest record - since a federation that lost 2f + 1 signs no record row. A devnet-shaped halt: 7 guardians, 4 still signing and seeing each other, 3 gone.
// The 3 are slashed from their template-3 bonds left before the halt; a guardian that answered through the halt is not; a later session voids it; observations
// short of a quorum of the checker's census seats prove nothing; a template-2 output is not the census key's; the old AbandonedProof byte is unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { taggedHash, toHex } from '../src/hash.js';
import { signHaltObservation, signGuardianHaltObservation } from '../src/halt-proof.js';
import { BOND_TEMPLATE_V2, BOND_TEMPLATE_V3 } from '../src/bond-script.js';
import { TYPE_ABANDONED_PROOF, TYPE_HALT_ABANDONED_PROOF } from '../src/constants.js';
import { encodeHaltAbandonedProof, decodeHaltAbandonedProof, haltAbandonedSlashStands, haltAbandonedProofId, isHaltAbandonedProof } from '../src/halt-abandoned-slash.js';

const key = (s) => { const secret = taggedHash('TEST/halt3901', new TextEncoder().encode(s)); return { secret, pub: schnorr.getPublicKey(secret) }; };
const verify = (sig, msg, pub) => { try { return schnorr.verify(sig, msg, pub); } catch { return false; } };
const seats = Array.from({ length: 9 }, (_, i) => key(`seat${i}`));
const guardians = Array.from({ length: 7 }, (_, i) => key(`g${i}`));
const federationId = taggedHash('TEST/fed3901', Uint8Array.of(1));
const peer = (i) => Uint8Array.from([2, ...taggedHash('TEST/peer3901', Uint8Array.of(i))]);
const record = { federationId, nominal: 7, threshold: 5, guardians: guardians.map((g, i) => ({ peerKey: peer(i), nodePubkey: g.pub })), gone: [] };
// nine seats observe the halt at session 28 from 909 (as on the #3896 devnet), each spanning abandon_blocks 10
const observations = seats.map((s, i) => signHaltObservation({ federationId, session: 28, firstHeight: 909, height: 921 + i, answering: [], observer: s.pub }, (h) => schnorr.sign(h, s.secret)));
// guardians 0..3 still run and see each other in P2P; 4, 5, 6 sign nothing
const guardianObservations = [0, 1, 2, 3].map((i) => signGuardianHaltObservation({ federationId, session: 28, firstHeight: 909, height: 925, peersSeen: [0, 1, 2, 3].map(peer), guardian: peer(i) },
  (h) => schnorr.sign(h, guardians[i].secret)));
const txidOf = (i) => taggedHash('TEST/bond3901', Uint8Array.of(i));
const bonds = guardians.map((g, i) => ({ pubkey: g.pub, txid: txidOf(i), vout: 0, height: 300, bondSats: 500000n, advert: { bondScriptTemplateVersion: i === 6 ? BOND_TEMPLATE_V2 : BOND_TEMPLATE_V3 } }));
const proofFor = (i, extra = {}) => encodeHaltAbandonedProof({ federationId, nodePubkey: guardians[i].pub, txid: txidOf(i), vout: 0, record: Uint8Array.of(1), observations, guardianObservations, ...extra });
const judge = (bytes, o = {}) => haltAbandonedSlashStands({ record, proof: decodeHaltAbandonedProof(bytes), verify, censusSeats: seats.map((s) => s.pub), abandonBlocks: 10, bonds, from: 0, ...o });

test('#3901 the guardians a proven halt names ABANDONED are slashed on the halt proof; the ones that answered, a void halt and a short proof are not', () => {
  const bytes = proofFor(4);
  const got = [0, 1, 2, 3, 4, 5, 6].map((i) => judge(proofFor(i)));
  const voided = judge(bytes, { laterSession: 29 });
  const short = judge(encodeHaltAbandonedProof({ federationId, nodePubkey: guardians[4].pub, txid: txidOf(4), vout: 0, record: Uint8Array.of(1), observations: observations.slice(0, 4), guardianObservations }));
  const otherCensus = judge(bytes, { censusSeats: Array.from({ length: 9 }, (_, i) => key(`stranger${i}`).pub) });
  const belowPoint = judge(bytes, { from: 1000 });
  const afterHalt = haltAbandonedSlashStands({ record, proof: decodeHaltAbandonedProof(bytes), verify, censusSeats: seats.map((s) => s.pub), abandonBlocks: 10, from: 0,
    bonds: bonds.map((b) => ({ ...b, height: 950 })) });
  console.log('  MEASURED #3901:', JSON.stringify({ id: toHex(haltAbandonedProofId(bytes)).slice(0, 16), type: bytes[0], verdicts: got.map((g) => g.verdict), haltHeight: got[4].halt && got[4].halt.haltHeight,
    voided: voided.verdict, short: short.verdict, otherCensus: otherCensus.verdict, belowPoint: belowPoint.verdict, afterHalt: afterHalt.verdict }));
  assert.equal(isHaltAbandonedProof(bytes), true);
  assert.equal(bytes[0], TYPE_HALT_ABANDONED_PROOF); assert.notEqual(TYPE_HALT_ABANDONED_PROOF, TYPE_ABANDONED_PROOF);
  assert.deepEqual(got.map((g) => g.verdict), [false, false, false, false, true, true, false], got.map((g) => g.why).join(' | '));
  for (const i of [0, 1, 2, 3]) assert.match(got[i].why, /does not name that guardian ABANDONED/);
  assert.match(got[6].why, /no template-3 bond/);
  assert.equal(got[4].output.sats, 500000n); assert.equal(got[4].halt.haltHeight, 909); assert.equal(got[4].halt.session, 28);
  assert.equal(voided.verdict, false); assert.match(voided.why, /no halt proven: session 29 is after the halted session 28/);
  assert.equal(short.verdict, false); assert.match(short.why, /no halt proven/);
  assert.equal(otherCensus.verdict, false, 'observers outside the checker\'s census prove nothing');
  assert.equal(belowPoint.verdict, false); assert.match(belowPoint.why, /abandoned-slash height/);
  assert.equal(afterHalt.verdict, false, 'a bond made after the halt stood for nothing at it');
  assert.equal(decodeHaltAbandonedProof(bytes).guardianObservations.length, 4);
});
