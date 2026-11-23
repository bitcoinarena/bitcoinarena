// wf1489 r23 h2h-1: POST /lock-set (LockSetBook.take) is open to anyone and checks every signature a body names before it knows the body
// is worth anything: up to committee-size views, committee-size set signatures, and two certificates (certificate + conflict) of up to 9
// signatures each - all under the committee's public keys, with random signature bytes. A failed signature never marks its key, so the
// same keys are verified again on every request. Safe behaviour: one stranger's POST of forged signatures costs the seat no more than a
// committee's worth (7) of BIP-340 verifies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { LockSetBook } from '../src/lock-set-book.js';
import { lockSetOf, encodeLockSetCertificate, lockSetSignatureId, lockSetId } from '../../arena-protocol/src/lock-set.js';

test('r23-h2h-1: a POST /lock-set of forged committee signatures costs at most a committee of verifies', () => {
  const db = new DatabaseSync(':memory:');
  const hx = (b) => Buffer.from(b).toString('hex');
  const secrets = Array.from({ length: 7 }, () => schnorr.utils.randomSecretKey());
  const committee = secrets.map((s) => schnorr.getPublicKey(s));
  const close = 1_000_000n;
  const round = { db, now: () => Number(close) + 500, pubkey: committee[0], identity: { secret: secrets[0] }, signerNodes: () => committee };
  const book = new LockSetBook({ round, peersOf: () => [], roundOf: () => ({ entryCloseMs: close }), viewOf: () => [], fetchFn: async () => { throw new Error('no peers'); } });
  const rid = new Uint8Array(randomBytes(32));
  const at = Number(close) + 400;
  const forged = (k) => ({ key: hx(committee[k]), atMs: at, entries: [hx(randomBytes(32))], sig: hx(randomBytes(64)) });
  const sorted = [...committee].sort((a, b) => (hx(a) < hx(b) ? -1 : 1));
  const cert = () => hx(encodeLockSetCertificate({ set: lockSetOf({ roundId: rid, entries: [randomBytes(32)] }),
    sigs: sorted.map((key) => ({ key, atMs: BigInt(at), sig: randomBytes(64) })) }));
  const body = () => ({ views: committee.map((_, k) => forged(k)), signatures: committee.map((_, k) => forged(k)), certificate: cert(), conflict: cert() });

  // one BIP-340 verify, measured here
  const id = lockSetSignatureId({ setId: lockSetId(lockSetOf({ roundId: rid, entries: [] })), atMs: BigInt(at) });
  const N = 300, junk = randomBytes(64);
  for (let i = 0; i < 50; i++) schnorr.verify(junk, id, committee[0]);
  let t0 = performance.now();
  for (let i = 0; i < N; i++) schnorr.verify(junk, id, committee[i % 7]);
  const perVerify = (performance.now() - t0) / N;

  const bodies = Array.from({ length: 60 }, body);
  for (let i = 0; i < 5; i++) book.take(rid, bodies[i]);
  t0 = performance.now();
  for (const b of bodies) { const got = book.take(rid, b); assert.equal(got.ok, true); assert.equal(got.signatures + got.views, 0); }
  const perPost = (performance.now() - t0) / bodies.length;
  const verifies = perPost / perVerify;
  assert.ok(verifies <= 8,
    `one stranger POST /lock-set of forged signatures cost ${perPost.toFixed(2)} ms = ~${verifies.toFixed(1)} BIP-340 verifies (${perVerify.toFixed(3)} ms each); `
    + `nothing was taken, and the same body shape can be sent again at once`);
});
