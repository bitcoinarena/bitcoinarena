// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 a45 refute 9 skeptic 2 (of #1815/#2239): the #2239 budget applies only to a round that ONE answer names. Two seats
// (one operator, two bonds - or two peers that agree) that name the SAME made-up rounds with the same made-up committee make every
// such round "named by 2", and the reader then reads 18 junk FINALs per round per answer with no budget at all - inside the 32 MB
// answer bound. Safe: what two seats' answers make the reader verify is bounded by a small constant per answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { encodeFinalSig, joinSignedFinalSig } from '../../arena-protocol/src/final-sig.js';
import { servedNodes, mergeServedRounds, SERVED_ANSWER_BYTES_MAX } from '../../arena-protocol/src/served-nodes.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const rnd = (n = 32) => new Uint8Array(randomBytes(n));
const junk = (roundId, signerPubkey, ms) => joinSignedFinalSig(encodeFinalSig({ roundId, entryId: rnd(), runId: rnd(), signerPubkey, signedAtMs: BigInt(ms) }), rnd(64));

test('two colluding seats naming the same made-up rounds are not read without a budget', () => {
  const now = Date.now();
  const keys = Array.from({ length: 9 }, () => rnd());
  const ids = Array.from({ length: 2000 }, () => rnd());
  const answer = () => ids.map((roundId) => ({ roundId, committee: keys, finals: keys.flatMap((k) => [junk(roundId, k, now - 2000), junk(roundId, k, now - 1000)]) }));
  const a = answer(), b = answer();
  // what one answer weighs on the wire (GET /served?finals=1 JSON), against the reader's 32 MB bound
  const wire = JSON.stringify({ held: a.map((x) => ({ roundId: toHex(x.roundId), committee: x.committee.map(toHex), finals: x.finals.map(toHex) })) }).length;
  let checks = 0;
  servedNodes({ rounds: mergeServedRounds([[], a, b]).rounds, fromMs: now - 86400000, toMs: now, verify: () => { checks++; return false; } });
  console.log(`two colluding answers of 2,000 made-up rounds (${(wire / 1e6).toFixed(1)} MB each, bound ${SERVED_ANSWER_BYTES_MAX / 1e6} MB): ${checks} signature checks; scaled to the bound ~${Math.round(checks * SERVED_ANSWER_BYTES_MAX / wire)}`);
  assert.ok(wire < SERVED_ANSWER_BYTES_MAX);
  assert.ok(checks <= 2000, `two seats' answers made the reader check ${checks} signatures`);
});

test('the same two answers cost seconds of real BIP-340 checks on the reader', async () => {
  const { schnorr } = await import('@noble/curves/secp256k1.js');
  const now = Date.now();
  const keys = Array.from({ length: 9 }, () => schnorr.getPublicKey(rnd()));
  const ids = Array.from({ length: 300 }, () => rnd());
  const answer = () => ids.map((roundId) => ({ roundId, committee: keys, finals: keys.flatMap((k) => [junk(roundId, k, now - 2000), junk(roundId, k, now - 1000)]) }));
  let checks = 0;
  const t0 = Date.now();
  servedNodes({ rounds: mergeServedRounds([[], answer(), answer()]).rounds, fromMs: now - 86400000, toMs: now, verify: (sg, m, k) => { checks++; try { return schnorr.verify(sg, m, k); } catch { return false; } } });
  const ms = Date.now() - t0;
  console.log(`two colluding answers of 300 made-up rounds: ${checks} real checks in ${ms} ms`);
  assert.ok(checks <= 2000, `${checks} real checks, ${ms} ms`);
});
