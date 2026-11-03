// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// FROM AN ABANDONED ROW TO A SLASH (§23A.5, RULED 2026-11-02, kanban #1058, #1059, #1062): which rows act, what they left, what stands on them, and the proof a slash commits to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { abandonedRows, outputsLeft, abandonedSlashStands, encodeAbandonedProof, decodeAbandonedProof, ABANDONED_PROOF_HEAD_BYTES, abandonedProofId, isAbandonedProof, bondsOf, startsByCensusKey } from '../src/abandoned-slash.js';
import { GONE } from '../src/federation-record.js';
import { ABANDONED_SLASH_HEIGHT, abandonedSlashPoint, TAG } from '../src/constants.js';
import { taggedHash, toHex } from '../src/hash.js';

const NODE = new Uint8Array(32).fill(0x11), OTHER = new Uint8Array(32).fill(0x22), PEER = new Uint8Array(33).fill(0x02), PEER2 = new Uint8Array(33).fill(0x03);
const TXID = new Uint8Array(32).fill(0xcd), SINCE = 500;
const record = (gone) => ({ threshold: 3, guardians: [{ peerKey: PEER, nodePubkey: NODE }, { peerKey: PEER2, nodePubkey: OTHER }], gone });
const abandoned = (proofRef = TXID) => [{ peerKey: PEER, sinceHeight: SINCE, kind: GONE.ABANDONED, proofRef }];
const out = (byte, extra = {}) => ({ pubkey: NODE, txid: new Uint8Array(32).fill(byte), vout: 0, bondSats: 20000n, height: 400, advert: { nodePubkey: NODE, bondScriptTemplateVersion: 2 }, ...extra });
const spent = out(0xa0, { why: 'spent', spent: true, spentBy: { txid: toHex(TXID), height: SINCE } });
const left = out(0xa1, { why: 'that node\'s bonds sum to 20000' });
const hex = (b) => toHex(new Uint8Array(32).fill(b));
const stands = (over) => abandonedSlashStands({ record: record(abandoned()), nodePubkey: NODE, proofRef: TXID, vout: 0, from: 0, ...over });

test('a row acts only as ABANDONED, with a proof, on a guardian the record lists', () => {
  assert.equal(abandonedRows(record(abandoned()), 0).length, 1);
  assert.equal(toHex(abandonedRows(record(abandoned()), 0)[0].nodePubkey), toHex(NODE));
  assert.equal(abandonedRows(record([{ ...abandoned()[0], kind: GONE.DEPARTED }]), 0).length, 0, 'DEPARTED: the bond is untouched');
  assert.equal(abandonedRows(record(abandoned(new Uint8Array(32))), 0).length, 0, 'a zero proof_ref names nothing');
  assert.equal(abandonedRows(record([{ ...abandoned()[0], peerKey: new Uint8Array(33).fill(9) }]), 0).length, 0);
});

test('what is left: the unspent output, under the floor or above it; a spent, started, later or foreign one is not', () => {
  const later = out(0xa2, { height: SINCE + 1 }), started = out(0xa3, { hold: { txid: 'x' } }), foreign = out(0xa4, { pubkey: OTHER, advert: { nodePubkey: OTHER, bondScriptTemplateVersion: 2 } }), seated = out(0xa5, { bondSats: 60000n, height: SINCE });
  const got = outputsLeft([spent, left, later, started, foreign, seated], NODE, SINCE);
  assert.deepEqual(got.map((o) => [o.txid, o.sats]), [[hex(0xa1), 20000n], [hex(0xa5), 60000n]]);
  assert.deepEqual(outputsLeft([spent], NODE, SINCE), [], 'nothing left: the record is what stands');
  assert.deepEqual(outputsLeft([left, { ...left, spent: true }], NODE, SINCE), [], 'one census row saying spent is enough');
});

test('the census read gives the reader both its lists, and the same output read twice is one', () => {
  assert.equal(outputsLeft(bondsOf({ entries: [left], excluded: [left, spent] }), NODE, SINCE).length, 1);
  assert.deepEqual(bondsOf(null), []);
});

test('a row whose proof_ref is a spend the census read is the chain\'s proof', () => {
  const s = stands({ bonds: [spent, left], txid: hex(0xa1) });
  assert.deepEqual([s.ok, s.slash, s.kind, s.bondSpent, toHex(s.proofRef), s.output.sats], [true, true, 'ABANDONED', true, toHex(TXID), 20000n]);
  assert.match(s.why, /spent at 500 while seated/);
});

test('any other proof_ref is a filed absence, standing on the record: the whole bond of a guardian who walked away', () => {
  const absent = stands({ record: record(abandoned(new Uint8Array(32).fill(0x77))), proofRef: new Uint8Array(32).fill(0x77), bonds: [left], txid: hex(0xa1) });
  assert.deepEqual([absent.ok, absent.slash, absent.bondSpent], [true, true, false]);
  assert.match(absent.why, /attested by 3/);
  const elsewhere = stands({ bonds: [out(0xa0, { spentBy: { txid: toHex(TXID), height: SINCE + 1 } }), left], txid: hex(0xa1) });
  assert.equal(elsewhere.bondSpent, false, 'a spend at another height is not the row\'s');
});

test('refused by name: no row, or an output that is not left', () => {
  assert.match(stands({ record: record([]), bonds: [left], txid: hex(0xa1) }).why, /no ABANDONED row/);
  assert.match(stands({ nodePubkey: OTHER, bonds: [left], txid: hex(0xa1) }).why, /no ABANDONED row/);
  const later = out(0xa2, { height: SINCE + 1 });
  const s = stands({ bonds: [spent, later], txid: hex(0xa2) });
  assert.deepEqual([s.ok, s.slash], [false, false]);
  assert.match(s.why, /left from before 500/);
});

test('only template 3 goes to the census key', () => assert.deepEqual([1, 2, 3].map(startsByCensusKey), [false, false, true]));

test('a row with another proof_ref than the proof names is no row of that proof', () => {
  assert.match(stands({ proofRef: new Uint8Array(32).fill(0x55), bonds: [left], txid: hex(0xa1) }).why, /no ABANDONED row/);
});

test('old rows stand as records and move no money: a row acts from the network\'s point, and a network that names none acts on none', () => {
  assert.equal(abandonedRows(record(abandoned()), SINCE).length, 1, 'at the point it acts');
  assert.equal(abandonedRows(record(abandoned()), SINCE + 1).length, 0, 'below it, not');
  assert.equal(abandonedRows(record(abandoned()), null).length, 0);
  const s = stands({ bonds: [spent, left], txid: hex(0xa1), from: SINCE + 1 });
  assert.deepEqual([s.ok, s.slash], [false, false]);
  assert.match(s.why, /no ABANDONED row/);
  assert.deepEqual(ABANDONED_SLASH_HEIGHT, { mainnet: 0, testnet4: 157492, regtest: 0, devnet: 0 });
  assert.equal(abandonedSlashPoint('testnet'), 157492, 'testnet reads as testnet4');
  assert.equal(abandonedSlashPoint('nowhere'), null);
  assert.equal(abandonedSlashPoint('mainnet'), 0, 'mainnet from genesis');
});

test('the proof: its bytes round trip, it is tagged as every slash proof, and the hash covers the signed record (ruling #1065)', () => {
  const FEDERATION = new Uint8Array(32).fill(0x37), signedRecord = Uint8Array.from({ length: 300 }, (_, i) => i & 255);
  const p = { federationId: FEDERATION, nodePubkey: NODE, proofRef: TXID, txid: new Uint8Array(32).fill(0xa1), vout: 7, record: signedRecord };
  const bytes = encodeAbandonedProof(p), back = decodeAbandonedProof(bytes);
  assert.equal(bytes.length, ABANDONED_PROOF_HEAD_BYTES + 300);
  assert.deepEqual([toHex(back.federationId), toHex(back.nodePubkey), toHex(back.proofRef), toHex(back.txid), back.vout, toHex(back.record)], [toHex(FEDERATION), toHex(NODE), toHex(TXID), toHex(p.txid), 7, toHex(signedRecord)]);
  assert.equal(toHex(abandonedProofId(bytes)), toHex(taggedHash(TAG.slashProof, bytes)));
  assert.equal(isAbandonedProof(bytes), true);
  assert.notEqual(toHex(abandonedProofId(encodeAbandonedProof({ ...p, vout: 8 }))), toHex(abandonedProofId(bytes)));
  assert.notEqual(toHex(abandonedProofId(encodeAbandonedProof({ ...p, federationId: new Uint8Array(32).fill(0x38) }))), toHex(abandonedProofId(bytes)), 'the federation is in the hash');
  const other = signedRecord.slice(); other[299] ^= 1;
  assert.notEqual(toHex(abandonedProofId(encodeAbandonedProof({ ...p, record: other }))), toHex(abandonedProofId(bytes)), 'and every byte of the record, signatures included');
  assert.throws(() => encodeAbandonedProof({ ...p, record: new Uint8Array(0) }), /signed record/);
  assert.throws(() => decodeAbandonedProof(bytes.subarray(0, ABANDONED_PROOF_HEAD_BYTES)), /signed record/, 'a proof with no record is no proof');
  assert.throws(() => decodeAbandonedProof(Uint8Array.of(0x0c, ...bytes.subarray(1))), /not a proof of an abandonment/);
});
