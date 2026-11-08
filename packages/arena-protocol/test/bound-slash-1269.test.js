// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1269 (§5A.3 offence row, RULED #1262): "Signing a spent-set or issued-set copy naming a session above the halt's bound" - the copy and the halt proof.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { taggedHash, toHex } from '../src/hash.js';
import { signHaltObservation } from '../src/halt-proof.js';
import { signSpentSet } from '../src/spent-set.js';
import { BOND_TEMPLATE_V3 } from '../src/bond-script.js';
import { encodeBoundProof, decodeBoundProof, boundSlashStands, boundProofId, isBoundProof } from '../src/bound-slash.js';

const key = (s) => { const secret = taggedHash('TEST/bound1269', new TextEncoder().encode(s)); return { secret, pub: schnorr.getPublicKey(secret) }; };
const verify = (sig, msg, pub) => { try { return schnorr.verify(sig, msg, pub); } catch { return false; } };
const seats = Array.from({ length: 9 }, (_, i) => key(`seat${i}`));
const guardians = Array.from({ length: 7 }, (_, i) => key(`g${i}`));
const federationId = taggedHash('TEST/fed1269', Uint8Array.of(1));
const peer = (i) => Uint8Array.from([2, ...taggedHash('TEST/peer1269', Uint8Array.of(i))]);
const record = { federationId, nominal: 7, threshold: 5, guardians: guardians.map((g, i) => ({ peerKey: peer(i), nodePubkey: g.pub })), gone: [] };
// five seats observe the halt at session 41 (bound 42)
const observations = seats.slice(0, 5).map((s, i) => signHaltObservation({ federationId, session: 41, firstHeight: 340 + i, height: 351 + i, answering: [], observer: s.pub }, (h) => schnorr.sign(h, s.secret)));
const bondTxid = taggedHash('TEST/bond1269', Uint8Array.of(0));
const bonds = [{ pubkey: guardians[3].pub, txid: bondTxid, vout: 0, height: 100, bondSats: 500000n, advert: { bondScriptTemplateVersion: BOND_TEMPLATE_V3 } }];
const copyAt = (session, g = guardians[3]) => signSpentSet({ federationId, session, nonces: [], signer: g.pub }, (h) => schnorr.sign(h, g.secret));
const proofOf = (copy, accused = guardians[3]) => decodeBoundProof(encodeBoundProof({ federationId, nodePubkey: accused.pub, txid: bondTxid, vout: 0, record: Uint8Array.of(1), copy, observations }));
const judge = (p) => boundSlashStands({ record, proof: p, verify, censusSeats: seats.map((s) => s.pub), abandonBlocks: 10, bonds, atHeight: 500 });

test('#1269 a guardian\'s spent-set copy above the halt\'s bound is slashed from its own bond; one within the bound, or another\'s copy, is not', () => {
  const bytes = encodeBoundProof({ federationId, nodePubkey: guardians[3].pub, txid: bondTxid, vout: 0, record: Uint8Array.of(1), copy: copyAt(0xffffffff), observations });
  const high = judge(decodeBoundProof(bytes));
  const atBound = judge(proofOf(copyAt(42)));
  const above = judge(proofOf(copyAt(43)));
  const notHis = judge(proofOf(copyAt(0xffffffff, guardians[4])));
  const forged = (() => { const c = copyAt(0xffffffff); c.signature = new Uint8Array(64); return judge(proofOf(c)); })();
  const noHalt = boundSlashStands({ record, proof: decodeBoundProof(bytes), verify, censusSeats: seats.map((s) => s.pub), abandonBlocks: 50, bonds, atHeight: 500 });
  const got = { type: isBoundProof(bytes), id: toHex(boundProofId(bytes)).slice(0, 16), session0xffffffff: [high.verdict, high.bound], atBound42: atBound.verdict, above43: above.verdict, notHis: notHis.verdict, forged: forged.verdict, noHalt: noHalt.verdict };
  console.log('  MEASURED #1269:', JSON.stringify(got));
  assert.equal(high.verdict, true, high.why); assert.equal(high.bound, 42); assert.equal(high.output.sats, 500000n);
  assert.equal(atBound.verdict, false, 'session 42 is the bound itself'); assert.match(atBound.why, /within the halt's bound 42/);
  assert.equal(above.verdict, true);
  assert.equal(notHis.verdict, false); assert.match(notHis.why, /not signed by the guardian the proof accuses/);
  assert.equal(forged.verdict, false);
  assert.equal(noHalt.verdict, false, 'observations short of abandon_blocks prove no halt'); assert.match(noHalt.why, /no halt proven/);
});
