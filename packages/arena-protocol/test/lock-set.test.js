// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE CERTIFIED LOCK SET (protocol 28, kanban #2561, ruling #2116 (b)): its one encoding, its vector, and when a certificate stands.
// `LOCK_SET_VECTOR=write node --test test/lock-set.test.js` writes test-vectors/protocol/lock-set.json (a deliberate protocol change only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { schnorr } from '@noble/curves/secp256k1.js';
import { toHex, fromHex } from '../src/hash.js';
import { LOCK_SET_VERSION, TYPE_LOCK_SET, TYPE_LOCK_SET_CERTIFICATE, speaksVersion } from '../src/constants.js';
import {
  encodeLockSet, decodeLockSet, lockSetId, lockSetOf, lockSetSignatureId, lockSetViewId, encodeLockSetCertificate, decodeLockSetCertificate,
  lockSetCertificateStands, lockSetToSign, certifiesLockSet, LOCK_SET_WINDOW_MS,
} from '../src/lock-set.js';

const VECTOR = new URL('../../../test-vectors/protocol/lock-set.json', import.meta.url).pathname;
const b32 = (n) => new Uint8Array(32).fill(n);
const NO_AUX = new Uint8Array(32);
const secrets = Array.from({ length: 7 }, (_, i) => b32(0x41 + i));
const keys = secrets.map((s) => schnorr.getPublicKey(s));
const committee = keys.map(toHex);
const CLOSE = 1_800_000_000_000n;
const verify = (sig, msg, key) => schnorr.verify(sig, msg, key);
const ROUND = b32(0x11);
const SET = lockSetOf({ roundId: ROUND, entries: [b32(0x33), b32(0x22)] });
const signAt = (i, set, atMs) => ({ key: keys[i], atMs: BigInt(atMs), sig: schnorr.sign(lockSetSignatureId({ setId: lockSetId(set), atMs: BigInt(atMs) }), secrets[i], NO_AUX) });
const stands = (cert, o = {}) => lockSetCertificateStands(cert, { roundId: ROUND, committee, threshold: 5, entryCloseMs: CLOSE, verify, ...o });
const byKey = (l) => [...l].sort((a, b) => (toHex(a.key) < toHex(b.key) ? -1 : 1));

test('protocol 28 is spoken, and the set reads back in its one encoding', () => {
  assert.equal(LOCK_SET_VERSION, 28);
  assert.ok(speaksVersion(28));
  const bytes = encodeLockSet(SET);
  assert.equal(bytes[0], TYPE_LOCK_SET);
  assert.deepEqual(decodeLockSet(bytes), SET);
  assert.throws(() => encodeLockSet({ roundId: ROUND, entries: [b32(0x33), b32(0x22)] }), /not sorted/);
  assert.throws(() => encodeLockSet({ roundId: ROUND, entries: [b32(0x22), b32(0x22)] }), /not sorted/);
  // a repeat written by hand is refused on read
  const twice = Uint8Array.from([...bytes.slice(0, 35), 0, 2, ...b32(0x22), ...b32(0x22)]);
  assert.throws(() => decodeLockSet(twice), /ascending and unique/);
  assert.throws(() => decodeLockSet(Uint8Array.from([...bytes, 0])), /trailing/);
});

test('only a paying head-to-head round of protocol 28 or later plays under the set', () => {
  assert.equal(certifiesLockSet({ protocolVersion: 28, stakeMsat: 1000n }, true), true);
  assert.equal(certifiesLockSet({ protocolVersion: 27, stakeMsat: 1000n }, true), false);
  assert.equal(certifiesLockSet({ protocolVersion: 28, stakeMsat: 0n }, true), false);
  assert.equal(certifiesLockSet({ protocolVersion: 28, stakeMsat: 1000n }, false), false);
});

test('a certificate stands on a threshold of committee signatures inside [close, close + 3 s]; its time is the latest signer\'s', () => {
  const sigs = byKey([0, 1, 2, 3, 4].map((i) => signAt(i, SET, Number(CLOSE) + 100 * (i + 1))));
  const cert = encodeLockSetCertificate({ set: SET, sigs });
  assert.equal(cert[0], TYPE_LOCK_SET_CERTIFICATE);
  const got = stands(cert);
  assert.equal(got.ok, true, got.why);
  assert.deepEqual(got.entries, SET.entries.map(toHex));
  assert.equal(got.atMs, Number(CLOSE) + 500);
  // four good ones are not five
  assert.equal(stands(encodeLockSetCertificate({ set: SET, sigs: sigs.slice(0, 4) })).ok, false);
  // a key outside the committee counts nothing
  const stranger = b32(0x7f);
  const outsider = { key: schnorr.getPublicKey(stranger), atMs: CLOSE + 50n, sig: schnorr.sign(lockSetSignatureId({ setId: lockSetId(SET), atMs: CLOSE + 50n }), stranger, NO_AUX) };
  assert.equal(stands(encodeLockSetCertificate({ set: SET, sigs: byKey([...sigs.slice(0, 4), outsider]) })).ok, false);
  // a signature before the close, or after close + 3 s, counts nothing (a seat with its clock behind or ahead)
  for (const at of [Number(CLOSE) - 1, Number(CLOSE) + LOCK_SET_WINDOW_MS + 1]) {
    const off = byKey([...[0, 1, 2, 3].map((i) => signAt(i, SET, Number(CLOSE) + 10)), signAt(4, SET, at)]);
    assert.equal(stands(encodeLockSetCertificate({ set: SET, sigs: off })).ok, false, `a signature at close ${at - Number(CLOSE)} counted`);
  }
  // a view signature is not a certificate signature
  const asView = byKey([...[0, 1, 2, 3].map((i) => signAt(i, SET, Number(CLOSE) + 10)),
    { key: keys[4], atMs: CLOSE + 10n, sig: schnorr.sign(lockSetViewId({ setId: lockSetId(SET), atMs: CLOSE + 10n }), secrets[4], NO_AUX) }]);
  assert.equal(stands(encodeLockSetCertificate({ set: SET, sigs: asView })).ok, false);
  // signatures over another set (one entry more: a lock added after the fact) do not stand for this one
  const more = lockSetOf({ roundId: ROUND, entries: [...SET.entries, b32(0x44)] });
  const mixed = byKey([...[0, 1, 2].map((i) => signAt(i, SET, Number(CLOSE) + 10)), ...[3, 4].map((i) => signAt(i, more, Number(CLOSE) + 10))]);
  assert.equal(stands(encodeLockSetCertificate({ set: more, sigs: mixed })).ok, false);
  // about another round
  assert.equal(stands(cert, { roundId: b32(0x12) }).ok, false);
  // a repeated key cannot be written
  assert.throws(() => encodeLockSetCertificate({ set: SET, sigs: [sigs[0], sigs[0]] }), /not sorted/);
});

test('the set a seat signs: its own entries that a threshold of views name', () => {
  const a = '22'.repeat(32), b = '33'.repeat(32), late = '44'.repeat(32);
  const views = [[a, b], [a, b], [a, b], [a, b, late], [a, b, late], [a], []];
  assert.deepEqual(lockSetToSign({ own: [a, b, late], views, threshold: 5 }), [a, b]);
  assert.deepEqual(lockSetToSign({ own: [a, b], views, threshold: 5 }), [a, b]);
  assert.deepEqual(lockSetToSign({ own: [a], views, threshold: 5 }), [a]);   // never an entry this seat did not verify
});

test('the lock set vector', () => {
  const sigs = byKey([0, 1, 2, 3, 4].map((i) => signAt(i, SET, Number(CLOSE) + 250 * (i + 1))));
  const v = {
    what: 'The certified lock set of a head-to-head round (protocol 28, kanban #2561, multiplayer_p2p.md §17A): a set, its id, a seat\'s signed message, a 5-of-7 certificate.',
    produced: 'LOCK_SET_VECTOR=write node --test packages/arena-protocol/test/lock-set.test.js (BIP-340 with 32 zero bytes of aux randomness)',
    protocolVersion: LOCK_SET_VERSION,
    fields: ['type u8 (0x50)', 'version u16', 'roundId 32', 'entries vec<32> ascending unique'],
    roundId: toHex(ROUND), entryCloseMs: String(CLOSE), committeeSecrets: secrets.map(toHex), committee,
    set: { entries: SET.entries.map(toHex), hex: toHex(encodeLockSet(SET)), id: toHex(lockSetId(SET)) },
    signatureId: { atMs: String(CLOSE + 250n), id: toHex(lockSetSignatureId({ setId: lockSetId(SET), atMs: CLOSE + 250n })) },
    viewId: { atMs: String(CLOSE + 250n), id: toHex(lockSetViewId({ setId: lockSetId(SET), atMs: CLOSE + 250n })) },
    certificate: { hex: toHex(encodeLockSetCertificate({ set: SET, sigs })), threshold: 5, atMs: String(CLOSE + 1250n) },
  };
  if (process.env.LOCK_SET_VECTOR === 'write') writeFileSync(VECTOR, JSON.stringify(v, null, 1) + '\n');
  const kept = JSON.parse(readFileSync(VECTOR, 'utf8'));
  assert.deepEqual(kept, v);
  const back = decodeLockSetCertificate(fromHex(kept.certificate.hex));
  const got = stands(back);
  assert.equal(got.ok, true, got.why);
  assert.equal(String(got.atMs), kept.certificate.atMs);
});
