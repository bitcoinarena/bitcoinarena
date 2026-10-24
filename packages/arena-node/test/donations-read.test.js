// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SEAT HANDS THE DEV THE SENDER AND THE ROUND, AND FORGETS BOTH ONCE THE DEV HAS THEM (measure 3; the owner
// 2026-10-05 08:15-08:17): GET /donations answers each donation's player key (the entry's) and its round id; the dev client,
// after it has written its own permanent record, sends a read receipt signed with its recipient key; the seat then DELETES
// those rows entirely. A wrong key, a forged signature, a stale receipt or another recipient's outpoint deletes nothing.
// Checked in the seat's database itself, not only through the door.
//
// The receipt: ECDSA (secp256k1, SHA-256, DER) by the recipient key over the UTF-8 of
//   "ARENA/v1/donations-read\n" + key + "\n" + atMs + "\n" + the outpoints, sorted, joined by ","
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, sign as ecdsaSign } from 'node:crypto';
import { toHex } from '../../arena-protocol/src/hash.js';
import { b32 } from './window-fixture.js';
import { joinedWithLock, CLAIM } from './lock-fixture.js';
import { newKey } from '../../arena-donor/src/donor.js';

const OUT = [{ txid: b32(0x08), outIdx: 2n }, { txid: b32(0x08), outIdx: 3n }, { txid: b32(0x09), outIdx: 1n }];
const at = (o) => `${toHex(o.txid)}:${o.outIdx}`;
const message = (key, atMs, outpoints) => Buffer.from(`ARENA/v1/donations-read\n${key}\n${atMs}\n${[...outpoints].sort().join(',')}`, 'utf8');
const sec1 = (secretHex) => createPrivateKey({ key: Buffer.concat([Buffer.from('302e0201010420', 'hex'), Buffer.from(secretHex, 'hex'), Buffer.from('a00706052b8104000a', 'hex')]), format: 'der', type: 'sec1' });
const signed = (k, atMs, outpoints) => ecdsaSign('sha256', message(k.recipientPkHex, atMs, outpoints), { key: sec1(k.secretHex), dsaEncoding: 'der' }).toString('hex');

async function seat() {
  const s = await joinedWithLock({ claimKeyFor: () => CLAIM });
  const devA = newKey(), devB = newKey();
  s.d.round.putDonationOutputs([
    { outpoint: OUT[0], entryId: s.eid, roundId: s.entry.roundId, federationId: b32(0xfe), recipientPk: Buffer.from(devA.recipientPkHex, 'hex'), amountMsat: 1334n, contractId: 'c0', senderOnContract: true },
    { outpoint: OUT[1], entryId: s.eid, roundId: s.entry.roundId, federationId: b32(0xfe), recipientPk: Buffer.from(devA.recipientPkHex, 'hex'), amountMsat: 400n, contractId: 'c1', senderOnContract: false },
    { outpoint: OUT[2], entryId: s.eid, roundId: s.entry.roundId, federationId: b32(0xfe), recipientPk: Buffer.from(devB.recipientPkHex, 'hex'), amountMsat: 666n, contractId: 'c2', senderOnContract: true },
  ]);
  const rows = () => s.d.round.db.prepare('SELECT outpoint, recipient_pk FROM donation_outputs ORDER BY outpoint').all().map((r) => [r.outpoint, r.recipient_pk.slice(0, 6)]);
  const list = async (k) => (await (await fetch(`http://127.0.0.1:${s.d.port}/donations?key=${k.recipientPkHex}`)).json()).donations;
  const read = async (body) => { const r = await fetch(`http://127.0.0.1:${s.d.port}/donations/read`, { method: 'POST', body: JSON.stringify(body) }); return [r.status, (await r.text()).trim()]; };
  return { s, devA, devB, rows, list, read };
}

test('GET /donations answers each donation\'s player key and round id, and whether the key is on the contract', async () => {
  const { s, devA, list } = await seat();
  try {
    const got = await list(devA);
    assert.deepEqual(got.map((d) => [d.outpoint, d.playerKey, d.roundId, d.senderOnContract]),
      [[at(OUT[0]), toHex(s.entry.playerPubkey), toHex(s.entry.roundId), true], [at(OUT[1]), toHex(s.entry.playerPubkey), toHex(s.entry.roundId), false]]);
  } finally { await s.close(); }
});

test('a read receipt signed by the recipient key deletes exactly those rows, in the database; nothing else is touched', async () => {
  const { s, devA, rows, read, list } = await seat();
  try {
    const now = Date.now();
    const [st, said] = await read({ key: devA.recipientPkHex, atMs: now, outpoints: [at(OUT[0])], signature: signed(devA, now, [at(OUT[0])]) });
    assert.equal(st, 200, said);
    assert.deepEqual(JSON.parse(said), { deleted: 1 });
    assert.deepEqual(rows().map((r) => r[0]), [at(OUT[1]), at(OUT[2])], 'the read row is still in the database, or another went');
    assert.deepEqual((await list(devA)).map((d) => d.outpoint), [at(OUT[1])]);
    // the same receipt again deletes nothing more
    assert.deepEqual(JSON.parse((await read({ key: devA.recipientPkHex, atMs: now, outpoints: [at(OUT[0])], signature: signed(devA, now, [at(OUT[0])]) }))[1]), { deleted: 0 });
  } finally { await s.close(); }
});

test('a wrong key, a forged signature, a stale receipt or another recipient\'s outpoint deletes nothing', async () => {
  const { s, devA, devB, rows, read } = await seat();
  try {
    const now = Date.now();
    const before = rows();
    const one = [at(OUT[0])];
    // signed by dev B, for dev A's key
    assert.equal((await read({ key: devA.recipientPkHex, atMs: now, outpoints: one, signature: signed(devB, now, one) }))[0], 403);
    // a signature over other outpoints
    assert.equal((await read({ key: devA.recipientPkHex, atMs: now, outpoints: one, signature: signed(devA, now, [at(OUT[1])]) }))[0], 403);
    // garbage
    assert.equal((await read({ key: devA.recipientPkHex, atMs: now, outpoints: one, signature: 'ab'.repeat(70) }))[0], 403);
    // stale: an hour old
    assert.equal((await read({ key: devA.recipientPkHex, atMs: now - 3600000, outpoints: one, signature: signed(devA, now - 3600000, one) }))[0], 409);
    // not a key, no outpoints, not JSON
    assert.equal((await read({ key: '04' + 'aa'.repeat(32), atMs: now, outpoints: one, signature: '00' }))[0], 400);
    assert.equal((await read({ key: devA.recipientPkHex, atMs: now, outpoints: [], signature: signed(devA, now, []) }))[0], 400);
    const notJson = await fetch(`http://127.0.0.1:${s.d.port}/donations/read`, { method: 'POST', body: 'nope' });
    assert.equal(notJson.status, 400);
    assert.deepEqual(rows(), before, 'a refused receipt deleted a row');
    // dev A, validly signed, names dev B's outpoint too: only dev A's own row goes
    const mixed = [at(OUT[0]), at(OUT[2])];
    const [st, said] = await read({ key: devA.recipientPkHex, atMs: now, outpoints: mixed, signature: signed(devA, now, mixed) });
    assert.equal(st, 200, said);
    assert.deepEqual(JSON.parse(said), { deleted: 1 });
    assert.deepEqual(rows().map((r) => r[0]), [at(OUT[1]), at(OUT[2])], 'another recipient\'s row was deleted');
  } finally { await s.close(); }
});

test('a recipient\'s rows are read once per change of the table: the same rows again, a new one and a deleted one seen at once (kanban #576)', async () => {
  const { s, devA, devB } = await seat();
  try {
    const r = s.d.round; let decoded = 0; const entry = r.entry.bind(r); r.entry = (id) => { decoded++; return entry(id); };
    const first = r.donationsFor(devA.recipientPkHex);
    assert.equal(first.length, 2); const n = decoded;
    first.pop();   // a caller's array is its own
    assert.equal(r.donationsFor(devA.recipientPkHex).length, 2);
    assert.equal(decoded, n, 'no entry decoded again while the table is unchanged');
    r.putDonationOutputs([{ outpoint: { txid: b32(0x0a), outIdx: 0n }, entryId: s.eid, roundId: s.entry.roundId, federationId: b32(0xfe), recipientPk: Buffer.from(devA.recipientPkHex, 'hex'), amountMsat: 5n, contractId: 'c3', senderOnContract: false }]);
    assert.equal(r.donationsFor(devA.recipientPkHex).length, 3, 'a new row is seen');
    assert.equal(r.deleteDonationsRead(devB.recipientPkHex, [at(OUT[2])]), 1);
    assert.equal(r.donationsFor(devB.recipientPkHex).length, 0, 'a deleted row is gone');
    assert.equal(r.donationsFor(devA.recipientPkHex, 1).length, 3, 'a read from a time is not kept, and reads the table');
  } finally { await s.close(); }
});
