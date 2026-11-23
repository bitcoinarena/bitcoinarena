// wf1489 r22 h2h-1: GET /lock-set (and GET /reveals, POST /reveal) of an OLD certified round re-verifies its certificate - a threshold of
// BIP-340 signatures - every time the round's in-memory room was evicted. The rooms map keeps 512 rounds (FIFO by first use), so a stranger
// who rotates GET /lock-set over 513+ held protocol-28 rounds makes every one of his requests miss the cache and cost the seat a full
// certificate check (5 schnorr verifies for 7 slots). Safe behaviour: a certificate already checked here is not checked again on every ask.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { LockSetBook } from '../src/lock-set-book.js';
import { lockSetOf, lockSetId, lockSetSignatureId, encodeLockSetCertificate } from '../../arena-protocol/src/lock-set.js';
import { receiptsNeeded } from '../../arena-protocol/src/threshold.js';

test('r22-h2h-1: rotating GET /lock-set over 600 old certified rounds does not re-verify each certificate on every ask', () => {
  const db = new DatabaseSync(':memory:');
  const hx = (b) => Buffer.from(b).toString('hex');
  const secrets = Array.from({ length: 7 }, () => schnorr.utils.randomSecretKey())
    .sort((a, b) => (hx(schnorr.getPublicKey(a)) < hx(schnorr.getPublicKey(b)) ? -1 : 1));
  const committee = secrets.map((s) => schnorr.getPublicKey(s));
  const threshold = receiptsNeeded(7);
  const close = 1_000_000n;
  let committeeReads = 0;
  const round = { db, now: () => 50_000_000, pubkey: committee[0], identity: { secret: secrets[0] },
    signerNodes: () => { committeeReads++; return committee; } };
  const book = new LockSetBook({ round, peersOf: () => [], roundOf: () => ({ entryCloseMs: close }), viewOf: () => [], fetchFn: async () => { throw new Error('no peers'); } });
  const rounds = [];
  for (let i = 0; i < 600; i++) {
    const rid = new Uint8Array(randomBytes(32));
    const set = lockSetOf({ roundId: rid, entries: [new Uint8Array(randomBytes(32)), new Uint8Array(randomBytes(32))] });
    const setId = lockSetId(set);
    const at = close + 500n;
    const sigs = secrets.slice(0, threshold).map((s, k) => ({ key: committee[k], atMs: at, sig: schnorr.sign(lockSetSignatureId({ setId, atMs: at }), s) }));
    db.prepare('INSERT INTO lock_set_certs (round_id, cert, at_ms) VALUES (?, ?, ?)').run(rid, encodeLockSetCertificate({ set, sigs }), Number(at));
    rounds.push(rid);
  }
  // first pass: every certificate is checked once (expected)
  for (const rid of rounds) assert.ok(book.state(rid).certificate);
  // second pass, the same 600 rounds: a seat that keeps what it checked does no certificate check again
  committeeReads = 0;
  const t0 = performance.now();
  for (const rid of rounds) assert.ok(book.state(rid).certificate);
  const ms = performance.now() - t0;
  assert.ok(committeeReads < 60,
    `the second pass re-verified ${committeeReads} of 600 certificates (${threshold} schnorr verifies each), ${ms.toFixed(0)} ms for 600 GETs `
    + `(${(ms / 600).toFixed(2)} ms per stranger request)`);
});
