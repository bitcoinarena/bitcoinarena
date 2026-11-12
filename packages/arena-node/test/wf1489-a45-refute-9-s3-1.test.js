// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 a45 refute 9 skeptic 3 (of #1815/#2239/#2312): #2312 (edca2e0b9) replaced the #2239 per-answer lone-round budget by a
// budget on FINALs that FAIL to verify. But a FINAL that verifies costs the reader the same BIP-340 check, and making one needs no
// seat key: ONE seat answers made-up rounds whose made-up committee is keys it generated, each signing a valid FINAL. Nothing ties
// those keys to the census before servedNodes, so every such FINAL is checked (and counted as "served"). At f60df2bdf the lone budget
// capped this at ~363 checks per answer; at edca2e0b9 it is one check per padded FINAL again, up to the 32 MB answer bound.
// Safe: what ONE seat's answer makes the reader verify is bounded by a small constant, whatever its signatures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { signFinalSig, encodeFinalSig, joinSignedFinalSig } from '../../arena-protocol/src/final-sig.js';
import { servedNodes, mergeServedRounds, SERVED_ANSWER_BYTES_MAX } from '../../arena-protocol/src/served-nodes.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const rnd = (n = 32) => new Uint8Array(randomBytes(n));

test('one seat padding with VALID FINALs under keys it made up is bounded (verify answers true)', () => {
  const now = Date.now();
  const keys = Array.from({ length: 9 }, () => rnd());
  const ids = Array.from({ length: 2000 }, () => rnd());
  // the signature bytes do not matter here: the counting verifier answers true, as a real one does for a self-signed FINAL
  const fin = (roundId, k) => joinSignedFinalSig(encodeFinalSig({ roundId, entryId: rnd(), runId: rnd(), signerPubkey: k, signedAtMs: BigInt(now - 1000) }), rnd(64));
  const answer = ids.map((roundId) => ({ roundId, committee: keys, finals: keys.map((k) => fin(roundId, k)) }));
  const wire = JSON.stringify({ held: answer.map((x) => ({ roundId: toHex(x.roundId), committee: x.committee.map(toHex), finals: x.finals.map(toHex) })) }).length;
  let checks = 0;
  const got = servedNodes({ rounds: mergeServedRounds([[], answer]).rounds, fromMs: now - 86400000, toMs: now, verify: () => { checks++; return true; } });
  console.log(`one answer of 2,000 made-up rounds with valid FINALs (${(wire / 1e6).toFixed(1)} MB): ${checks} checks, ${got.nodes.length} made-up nodes "served"; scaled to the 32 MB bound ~${Math.round(checks * SERVED_ANSWER_BYTES_MAX / wire)}`);
  assert.ok(wire < SERVED_ANSWER_BYTES_MAX);
  assert.ok(checks <= 2000, `one seat's answer made the reader check ${checks} signatures`);
});

test('the same with real BIP-340 signatures costs the reader seconds', () => {
  const now = Date.now();
  const secrets = Array.from({ length: 9 }, () => rnd());
  const keys = secrets.map((s) => schnorr.getPublicKey(s));
  const ids = Array.from({ length: 300 }, () => rnd());
  const answer = ids.map((roundId) => ({ roundId, committee: keys, finals: secrets.map((s, i) => signFinalSig({ roundId, entryId: rnd(), runId: rnd(), signerPubkey: keys[i], signedAtMs: BigInt(now - 1000) }, (d) => schnorr.sign(d, s))) }));
  let checks = 0;
  const t0 = Date.now();
  const got = servedNodes({ rounds: mergeServedRounds([[], answer]).rounds, fromMs: now - 86400000, toMs: now, verify: (sg, m, k) => { checks++; try { return schnorr.verify(sg, m, k); } catch { return false; } } });
  const ms = Date.now() - t0;
  console.log(`one answer of 300 made-up rounds, real signatures: ${checks} real checks in ${ms} ms; ${got.nodes.length} made-up nodes counted as served, ${got.rounds} rounds`);
  assert.ok(checks <= 2000, `${checks} real checks, ${ms} ms`);
});
