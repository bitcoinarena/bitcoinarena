// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 a45 refute 9 (of #1815): the #1815 cap is per ROUND ENTRY of one seat's answer (9 signers x 2 FINALs = 18), but an answer
// may hold SERVED_HELD_MAX (20,000) round entries. The same padding spread over rounds - made-up rounds with a made-up 9-key committee,
// or the SAME real round listed again and again - still makes the reader run one BIP-340 verify per padded FINAL, on every POST
// /item-purchase (any stranger) and every funding decision. Safe: what one seat's answer makes the reader verify is bounded, in all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { signFinalSig, encodeFinalSig, joinSignedFinalSig } from '../../arena-protocol/src/final-sig.js';
import { servedNodes, mergeServedRounds } from '../../arena-protocol/src/served-nodes.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const rnd = () => new Uint8Array(randomBytes(32));
const junk = (roundId, signerPubkey, ms) => joinSignedFinalSig(encodeFinalSig({ roundId, entryId: rnd(), runId: b32(3), signerPubkey, signedAtMs: BigInt(ms) }), new Uint8Array(randomBytes(64)));

function honest(now) {
  const secrets = [b32(0x41), b32(0x42), b32(0x43)];
  const committee = secrets.map((s) => schnorr.getPublicKey(s));
  const rid = b32(1);
  const own = [{ roundId: rid, committee, finals: secrets.map((s) => signFinalSig({ roundId: rid, entryId: b32(2), runId: b32(3), signerPubkey: schnorr.getPublicKey(s), signedAtMs: BigInt(now - 1000) }, (d) => schnorr.sign(d, s))) }];
  return { committee, rid, own };
}
function run(held, now) {
  let checks = 0;
  const verify = (sg, m, k) => { checks++; return false; };             // counts the checks; a junk signature never verifies
  const got = servedNodes({ rounds: mergeServedRounds(held).rounds, fromMs: now - 86400000, toMs: now, verify });
  return { checks, got };
}

test('one answer of 1,200 made-up rounds, each 9 made-up keys x 2 junk FINALs, does not cost 21,600 signature checks', () => {
  const now = Date.now();
  const { own } = honest(now);
  const keys = Array.from({ length: 9 }, () => rnd());
  const padded = Array.from({ length: 1200 }, () => { const rid = rnd(); return { roundId: rid, committee: keys, finals: keys.flatMap((k) => [junk(rid, k, now - 2000), junk(rid, k, now - 1000)]) }; });
  const { checks } = run([own, padded], now);
  console.log(`1,200 made-up rounds in one answer: ${checks} signature checks`);
  assert.ok(checks <= 1000, `one seat's answer made the reader check ${checks} signatures`);
});

test('one answer listing the same real round 2,000 times, each 3 committee keys x 2 junk FINALs, does not cost 12,000 checks', () => {
  const now = Date.now();
  const { own, committee, rid } = honest(now);
  const padded = Array.from({ length: 2000 }, () => ({ roundId: rid, committee, finals: committee.flatMap((k) => [junk(rid, k, now - 2000), junk(rid, k, now - 1500)]) }));
  const { checks, got } = run([own, padded], now);
  console.log(`one real round listed 2,000 times in one answer: ${checks} signature checks, served ${got.nodes.length}`);
  assert.ok(checks <= 1000, `one seat's answer made the reader check ${checks} signatures for one round of three seats`);
});
