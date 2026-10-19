#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// FEDERATION.md REHEARSAL 13, SUCCESSION (§23A.6), the key half; tools/rehearsal-13-regtest.sh runs the federations.
//   keys                          the open lock's preimage and keys: the committee's claim key, p3's refund key, p1's (the winner's)
//   sign MESSAGE_HEX              the committee's BIP-340 signature over a settlement txid (blwp-stake-lock --mode settle)
//   records FED1 FED2 INV1 INV2   the records: the old federation DRAINING with its successor named once g3 is proven gone (3 of
//                                 3 seated attest), then CLOSED; the successor OPEN - each signed by its seated guardians and
//                                 verified as a client verifies one
// One JSON line per call.
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { signAbsence, abandonmentProof } from '../../arena-protocol/src/absence.js';
import { clocksFor } from '../../arena-protocol/src/federation-slash.js';
import { buildFederationRecord, encodeFederationRecord, federationRecordId, joinSignedRecord, verifyFederationRecord, GONE, FEDERATION_STATUS } from '../../arena-protocol/src/federation-record.js';
import { toHex, fromHex, taggedHash } from '../../arena-protocol/src/hash.js';

const out = (o) => console.log(JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? String(v) : v)));
const secretOf = (name) => taggedHash('ARENA/v1/Rehearsal13', new TextEncoder().encode(name));
const compressed = (s) => toHex(secp256k1.getPublicKey(s, true));
const verify = (sig, msg, pub) => { try { return schnorr.verify(sig, msg, pub); } catch { return false; } };
const [step, ...args] = process.argv.slice(2);

if (step === 'keys') {
  const preimage = secretOf('preimage');
  out({ preimage: toHex(preimage), hash: toHex(sha256(preimage)), committeePk: compressed(secretOf('committee')), p3Pk: compressed(secretOf('p3')),
    p3Secret: toHex(secretOf('p3')), p1Pk: compressed(secretOf('p1')), p1Secret: toHex(secretOf('p1')) });
} else if (step === 'sign') {
  out({ signature: toHex(schnorr.sign(fromHex(args[0]), secretOf('committee'))) });
} else if (step === 'records') {
  const [fed1, fed2, inv1, inv2] = args;
  const { clocks } = clocksFor('regtest');
  const node = (name) => { const secret = secretOf(`node-${name}`); return { name, secret, key: schnorr.getPublicKey(secret) }; };
  const peerKeyOf = (n) => Uint8Array.from([2, ...taggedHash('ARENA/v1/Rehearsal13Peer', n.key)]);
  const g = (names) => names.map(node).map((n, i) => ({ n, peerKey: peerKeyOf(n), nodePubkey: n.key, operatorId: n.name, bondTxid: taggedHash('ARENA/v1/Rehearsal13Bond', n.key),
    bondVout: i, endpoint: `ws://127.0.0.1:${30121 + i * 10}`, bondSats: 500000n }));
  const old = g(['g0', 'g1', 'g2', 'g3']);
  // the successor: the 3 seated first (same operators, new key shares: the same node keys) and 1 drawn
  const succ = g(['g0', 'g1', 'g2', 'drawn']);
  const census = (gs, fid) => gs.map((x) => ({ pubkey: x.nodePubkey, advert: { guardianOf: [{ federationId: fromHex(fid), guardianKey: x.peerKey }] } }));
  // g3 abandons: g0-g2 attest abandon_blocks of absence
  const rec = { federationId: fromHex(fed1), threshold: 3, guardians: old };
  const atts = old.slice(0, 3).map((a) => signAbsence({ federationId: fromHex(fed1), peerKey: old[3].peerKey, lastSeenHeight: 100, height: 100 + clocks.abandonBlocks, attester: a.nodePubkey },
    (h) => schnorr.sign(h, a.n.secret)));
  const proof = abandonmentProof(atts, { record: rec, peerKey: old[3].peerKey, abandonBlocks: clocks.abandonBlocks, verify });
  const signed = (fid, inv, gs, signers, extra) => {
    const r = buildFederationRecord({ federationId: fromHex(fid), networkId: new Uint8Array(32), invite: inv, nominal: 4, guardians: gs, height: 120, ...extra });
    const id = federationRecordId(r);
    const bytes = joinSignedRecord(encodeFederationRecord(r), signers.map((x) => ({ nodePubkey: x.nodePubkey, signature: schnorr.sign(id, x.n.secret) })));
    const v = verifyFederationRecord(bytes, { census: census(gs, fid), verify, inviteFederationId: () => fromHex(fid) });
    return { status: Object.keys(FEDERATION_STATUS).find((k) => FEDERATION_STATUS[k] === r.status), seated: r.seated, signers: signers.length, verifies: v.ok, why: v.ok ? null : v.why,
      successor: toHex(r.successorId).slice(0, 16) };
  };
  const gone = [{ peerKey: old[3].peerKey, sinceHeight: proof.sinceHeight, kind: GONE.ABANDONED, proofRef: proof.ok ? proof.id : new Uint8Array(32) }];
  out({ step: 'records', abandonment: { stands: proof.ok, signers: proof.signers, why: proof.ok ? null : proof.why },
    oldWithSuccessor: signed(fed1, inv1, old, old.slice(0, 3), { gone, successorId: fromHex(fed2) }),
    oldClosed: signed(fed1, inv1, old, old.slice(0, 3), { gone, successorId: fromHex(fed2), closed: true }),
    oldClosedTwoSigners: signed(fed1, inv1, old, old.slice(0, 2), { gone, successorId: fromHex(fed2), closed: true }),
    successorOpen: signed(fed2, inv2, succ, succ, {}) });
} else throw new Error(`step ${step}?`);
