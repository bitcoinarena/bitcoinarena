// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3901 (RULED 2026-11-28 Q1): a federation that lost 2f + 1 signs no HALTED record, so the arbitration set refused every proven halt ("a halt proof alone
// is not settled by this arbiter") and no claim was ever paid. Now liquidationFromSeats settles on a halt proof a strict majority of the seats list - re-checked
// on the arbiter's own census (haltProofFromSeats: halt-proof.js over every seat's signed observations), voided by a signed observation of a later session, its
// clocks from the proof's halt height; a signed HALTED record is settled as before, and with both the earlier halt height counts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { encodeFederationRecord, joinSignedRecord, federationRecordId, FEDERATION_STATUS, thresholdOf, splitSignedRecord } from '../../arena-protocol/src/federation-record.js';
import { REGTEST_CLOCKS } from '../../arena-protocol/src/federation-slash.js';
import { signHaltObservation, signGuardianHaltObservation, haltProof, encodeHaltObservation, encodeGuardianHaltObservation } from '../../arena-protocol/src/halt-proof.js';
import * as arbiter from '../src/arbiter.js';
import { inviteForGuardians, readInvite } from '../src/invite.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const { liquidationFromSeats, verifyHaltRecord } = arbiter;
const FED = new Uint8Array(32).fill(0x39), FID = toHex(FED);
const NET = new Uint8Array(32).fill(0x10);
const INVITE = inviteForGuardians(FED, Array.from({ length: 7 }, (_, i) => ({ peer: i, url: `wss://g${i}.example` })));
const inviteFederationId = (inv) => fromHex(readInvite(inv).federationId);
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const nodes = Array.from({ length: 10 }, (_, i) => { const secret = new Uint8Array(32).fill(i + 1); return { secret, pubkey: schnorr.getPublicKey(secret), guardianKey: Uint8Array.from([2, ...new Uint8Array(32).fill(0x60 + i)]) }; });
const guardians = nodes.slice(0, 7);
const KEYS = guardians.map((g) => g.guardianKey);
const census = nodes.map((n, i) => ({ pubkey: n.pubkey, txid: new Uint8Array(32).fill(0x20 + i), vout: 0, bondSats: 50000n,
  advert: { operatorId: `op${i}`, endpoint: `https://seat-${i}.example`, guardianOf: i < 7 ? [{ federationId: FED, guardianKey: n.guardianKey }] : [] } }));
const row = (n) => ({ peerKey: n.guardianKey, nodePubkey: n.pubkey, operatorId: '', bondTxid: new Uint8Array(32), bondVout: 0, endpoint: '' });
const body = (height, status) => ({ federationId: FED, networkId: NET, invite: INVITE, nominal: 7, threshold: thresholdOf(7),
  guardians: guardians.map(row).sort((a, b) => (toHex(a.nodePubkey) < toHex(b.nodePubkey) ? -1 : 1)), status: FEDERATION_STATUS[status],
  successorId: new Uint8Array(32), gone: [], exposureCapSats: 0n, reserveSats: 0n, height });
const signed = (b, by) => { const id = federationRecordId(b); return toHex(joinSignedRecord(encodeFederationRecord(b), by.map((n) => ({ nodePubkey: n.pubkey, signature: schnorr.sign(id, n.secret) })))); };
const OPEN = signed(body(600, 'OPEN'), guardians);
const HALTED = signed(body(1000, 'HALTED'), guardians);
const record = splitSignedRecord(fromHex(OPEN)).record;

// every census node observes the halt at session 28 from 909; guardians 0..3 still sign and see each other
const obsAt = (session, from = nodes) => from.map((s, i) => signHaltObservation({ federationId: FED, session, firstHeight: 909, height: 921 + i, answering: [], observer: s.pubkey }, (h) => schnorr.sign(h, s.secret)));
const gObs = [0, 1, 2, 3].map((i) => signGuardianHaltObservation({ federationId: FED, session: 28, firstHeight: 909, height: 925, peersSeen: [0, 1, 2, 3].map((j) => guardians[j].guardianKey), guardian: guardians[i].guardianKey },
  (h) => schnorr.sign(h, guardians[i].secret)));
const asHex = (o) => ({ observation: toHex(encodeHaltObservation(o)), signature: toHex(o.signature) });
const asHexG = (o) => ({ observation: toHex(encodeGuardianHaltObservation(o)), signature: toHex(o.signature) });
const proofId = toHex(haltProof(obsAt(28), { record, censusSeats: nodes.map((n) => n.pubkey), abandonBlocks: 10, verify, guardianObservations: gObs }).id);
const listing = (extra = {}) => ({ federation: FID, haltRecord: null, record: OPEN, haltProof: { session: 28, id: proofId }, spentSet: null, ...extra });
const verifyHalt = (bytes) => verifyHaltRecord(bytes, { fid: FID, keys: KEYS, census, tip: 1012, networkId: NET, inviteFederationId });
const checkerOf = (said, censusSeats = nodes.map((n) => n.pubkey)) => (typeof arbiter.haltProofFromSeats === 'function'
  ? () => arbiter.haltProofFromSeats({ said, record, censusSeats, abandonBlocks: REGTEST_CLOCKS.abandonBlocks })
  : null);
const settle = (rows, verifyHaltProof) => liquidationFromSeats(FID, rows, { seatCount: rows.length, clocks: REGTEST_CLOCKS, verifyHalt, ...(verifyHaltProof ? { verifyHaltProof } : {}) });

test('#3901 a halt proven by the seats alone is settled, on the arbiter\'s own check; a later session, a foreign census and a minority listing are refused', async () => {
  const said = nodes.map(() => ({ observations: obsAt(28).map(asHex), guardianObservations: gObs.map(asHexG) }));
  const rows = nodes.slice(0, 7).map(() => listing());
  const ok = await settle(rows, checkerOf(said));
  // a recovery: one seat signed an observation of session 29 - progress voids the halt
  const later = await settle(rows, checkerOf([...said, { observations: obsAt(29, nodes.slice(0, 1)).map(asHex) }]));
  const foreign = await settle(rows, checkerOf(said, Array.from({ length: 10 }, (_, i) => schnorr.getPublicKey(new Uint8Array(32).fill(0x90 + i)))));
  const minority = await settle([...nodes.slice(0, 3).map(() => listing()), ...nodes.slice(3, 7).map(() => listing({ haltProof: null }))], checkerOf(said));
  // a signed HALTED record at 1000 beside the proof at 909: the earlier halt height counts
  const both = await settle(rows.map((r) => ({ ...r, haltRecord: HALTED })), checkerOf(said));
  const recordOnly = await settle(rows.map((r) => ({ ...r, haltRecord: HALTED, haltProof: null })), checkerOf(said));
  console.log('  MEASURED #3901:', JSON.stringify({ ok: [ok.ok, ok.haltHeight, ok.liquidatesAt, ok.claimWindowCloses, ok.haltBy, ok.ok ? null : ok.why],
    later: [later.ok, later.why], foreign: [foreign.ok, (foreign.why || '').slice(0, 120)], minority: [minority.ok, minority.why], both: [both.ok, both.haltHeight, both.haltBy], recordOnly: [recordOnly.ok, recordOnly.haltHeight] }));
  assert.equal(ok.ok, true, ok.why);
  assert.equal(ok.haltHeight, 909); assert.equal(ok.haltBy, 'proof');
  assert.equal(ok.liquidatesAt, 909 + REGTEST_CLOCKS.abandonBlocks);
  assert.equal(later.ok, false); assert.match(later.why, /session 29 is after the halted session 28/);
  assert.equal(foreign.ok, false); assert.match(foreign.why, /does not stand on this arbiter's census/);
  assert.equal(minority.ok, false); assert.match(minority.why, /3 of 7 seats/);
  assert.equal(both.ok, true); assert.equal(both.haltHeight, 909);
  assert.equal(recordOnly.ok, true); assert.equal(recordOnly.haltHeight, 1000);
});
