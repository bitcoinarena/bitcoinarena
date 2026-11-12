// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 round 6 (gossip): ONE SEAT'S GET /served?finals=1 ANSWER IS MERGED WITH NO BOUND ON THE FINALS OF A ROUND, AND EACH ONE IS
// SCHNORR-VERIFIED. #1522 capped the rounds (SERVED_HELD_MAX 20,000) and the committee (9) of each held round, but not `finals`: server.js
// (servedRoundsBetween for the funding signal, POST /item-purchase) maps every listed final and protocol mergeServedRounds keeps every
// distinct one, so servedNodes runs one BIP-340 verify per padded record whose signer key is a committee key (the attacker names the real
// committee and writes junk signatures under its keys). A buyer's POST /item-purchase - any stranger - makes the seat ask every seat, so one
// seat's padded answer holds the seat's loop for the verify of every one of its made-up FINALs, on every purchase.
// Safe behaviour: what one seat's answer makes the reader verify is bounded (a round has at most one FINAL per committee seat that counts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { signFinalSig, encodeFinalSig, joinSignedFinalSig } from '../../arena-protocol/src/final-sig.js';
import { servedNodes, mergeServedRounds } from '../../arena-protocol/src/served-nodes.js';

const b32 = (n) => new Uint8Array(32).fill(n);

test('one seat\'s served answer padded with 20,000 FINALs of one round does not cost 20,000 signature checks', () => {
  const secrets = [b32(0x41), b32(0x42), b32(0x43)];
  const committee = secrets.map((s) => schnorr.getPublicKey(s));
  const rid = b32(1);
  const now = Date.now();
  // the reader's own record: the round's three honest FINALs
  const own = [{ roundId: rid, committee, finals: secrets.map((s) => signFinalSig({ roundId: rid, entryId: b32(2), runId: b32(3), signerPubkey: schnorr.getPublicKey(s), signedAtMs: BigInt(now - 1000) }, (d) => schnorr.sign(d, s))) }];
  // one seat's answer: the same round and committee, and 20,000 made-up FINALs under the committee's keys (junk signatures)
  const padded = [{ roundId: rid, committee, finals: Array.from({ length: 20000 }, (_, i) => joinSignedFinalSig(encodeFinalSig({ roundId: rid, entryId: new Uint8Array(randomBytes(32)), runId: b32(3),
    signerPubkey: committee[i % 3], signedAtMs: BigInt(now - 1000) }), new Uint8Array(randomBytes(64)))) }];
  let checks = 0;
  const verify = (sg, m, k) => { checks++; try { return schnorr.verify(sg, m, k); } catch { return false; } };
  const t0 = Date.now();
  const merged = mergeServedRounds([own, padded]);
  const got = servedNodes({ rounds: merged.rounds, fromMs: now - 86400000, toMs: now, verify });
  console.log(`one round, one padded answer: ${checks} signature checks in ${Date.now() - t0} ms; served ${JSON.stringify(got.nodes.map((n) => n.rounds))}, refused ${got.refused.length}`);
  assert.equal(got.nodes.length, 3, 'the honest three still served');
  assert.ok(checks <= 100, `one seat's answer made the reader check ${checks} signatures for one round of three seats`);
});
