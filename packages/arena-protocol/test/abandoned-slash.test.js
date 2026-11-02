// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// FROM AN ABANDONED ROW TO A SLASH (§23A.5, RULED 2026-11-02, kanban #1058, #1059): which rows act, what they left, and what stands on them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { abandonedRows, outputsLeft, abandonedSlashStands, abandonedSlashId, bondsOf, startsByCensusKey } from '../src/abandoned-slash.js';
import { GONE } from '../src/federation-record.js';
import { toHex } from '../src/hash.js';

const NODE = new Uint8Array(32).fill(0x11), OTHER = new Uint8Array(32).fill(0x22), PEER = new Uint8Array(33).fill(0x02), PEER2 = new Uint8Array(33).fill(0x03);
const TXID = new Uint8Array(32).fill(0xcd), SINCE = 500;
const record = (gone) => ({ threshold: 3, guardians: [{ peerKey: PEER, nodePubkey: NODE }, { peerKey: PEER2, nodePubkey: OTHER }], gone });
const abandoned = (proofRef = TXID) => [{ peerKey: PEER, sinceHeight: SINCE, kind: GONE.ABANDONED, proofRef }];
const out = (byte, extra = {}) => ({ pubkey: NODE, txid: new Uint8Array(32).fill(byte), vout: 0, bondSats: 20000n, height: 400, advert: { nodePubkey: NODE, bondScriptTemplateVersion: 2 }, ...extra });
const spent = out(0xa0, { why: 'spent', spent: true, spentBy: { txid: toHex(TXID), height: SINCE } });
const left = out(0xa1, { why: 'that node\'s bonds sum to 20000' });
const hex = (b) => toHex(new Uint8Array(32).fill(b));

test('a row acts only as ABANDONED, with a proof, on a guardian the record lists', () => {
  assert.equal(abandonedRows(record(abandoned())).length, 1);
  assert.equal(toHex(abandonedRows(record(abandoned()))[0].nodePubkey), toHex(NODE));
  assert.equal(abandonedRows(record([{ ...abandoned()[0], kind: GONE.DEPARTED }])).length, 0, 'DEPARTED: the bond is untouched');
  assert.equal(abandonedRows(record(abandoned(new Uint8Array(32)))).length, 0, 'a zero proof_ref names nothing');
  assert.equal(abandonedRows(record([{ ...abandoned()[0], peerKey: new Uint8Array(33).fill(9) }])).length, 0);
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
  const s = abandonedSlashStands({ record: record(abandoned()), peerKey: PEER, bonds: [spent, left], txid: hex(0xa1), vout: 0 });
  assert.deepEqual([s.ok, s.slash, s.kind, s.bondSpent, toHex(s.proofRef), s.output.sats], [true, true, 'ABANDONED', true, toHex(TXID), 20000n]);
  assert.match(s.why, /spent at 500 while seated/);
});

test('any other proof_ref is a filed absence, standing on the record: the whole bond of a guardian who walked away', () => {
  const absent = abandonedSlashStands({ record: record(abandoned(new Uint8Array(32).fill(0x77))), peerKey: PEER, bonds: [left], txid: hex(0xa1), vout: 0 });
  assert.deepEqual([absent.ok, absent.slash, absent.bondSpent], [true, true, false]);
  assert.match(absent.why, /attested by 3/);
  const elsewhere = abandonedSlashStands({ record: record(abandoned()), peerKey: PEER, bonds: [out(0xa0, { spentBy: { txid: toHex(TXID), height: SINCE + 1 } }), left], txid: hex(0xa1), vout: 0 });
  assert.equal(elsewhere.bondSpent, false, 'a spend at another height is not the row\'s');
});

test('refused by name: no row, or an output that is not left', () => {
  assert.match(abandonedSlashStands({ record: record([]), peerKey: PEER, bonds: [left], txid: hex(0xa1), vout: 0 }).why, /no ABANDONED row/);
  assert.match(abandonedSlashStands({ record: record(abandoned()), peerKey: PEER2, bonds: [left], txid: hex(0xa1), vout: 0 }).why, /no ABANDONED row/);
  const later = out(0xa2, { height: SINCE + 1 });
  const s = abandonedSlashStands({ record: record(abandoned()), peerKey: PEER, bonds: [spent, later], txid: hex(0xa2), vout: 0 });
  assert.deepEqual([s.ok, s.slash], [false, false]);
  assert.match(s.why, /left from before 500/);
});

test('each output of a row has its own name, and only template 3 goes to the census key', () => {
  const name = (txid, vout) => toHex(abandonedSlashId({ proofRef: TXID, txid, vout }));
  assert.notEqual(name(hex(1), 0), name(hex(1), 1));
  assert.notEqual(name(hex(1), 0), name(hex(2), 0));
  assert.deepEqual([1, 2, 3].map(startsByCensusKey), [false, false, true]);
});
