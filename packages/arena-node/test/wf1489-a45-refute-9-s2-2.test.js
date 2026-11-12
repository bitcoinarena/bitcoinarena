// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 a45 refute 9 skeptic 2 (honest path of #2239): the lone-round budget (SERVED_LONE_FINALS_MAX 360 FINALs per answer) also
// cuts HONEST rounds that only one answer holds - the reader's own record included (held[0]) - when the round's other committee seats
// do not answer (offline, timed out, left the network). A seat that sat on 200 rounds of a 3-seat committee in the window while its two
// committee-mates are down counts 120 of them for itself, so its funding signal and item split undercount the nodes that served.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { encodeFinalSig, joinSignedFinalSig } from '../../arena-protocol/src/final-sig.js';
import { servedNodes, mergeServedRounds } from '../../arena-protocol/src/served-nodes.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const rnd = (n = 32) => new Uint8Array(randomBytes(n));
const good = new Set();
const final = (roundId, signerPubkey, ms) => { const sig = rnd(64); good.add(toHex(sig)); return joinSignedFinalSig(encodeFinalSig({ roundId, entryId: rnd(), runId: rnd(), signerPubkey, signedAtMs: BigInt(ms) }), sig); };
const verify = (sg) => good.has(toHex(sg));

test('the reader\'s own 200 honest rounds all count when its committee-mates do not answer', () => {
  const now = Date.now();
  const committee = [rnd(), rnd(), rnd()];
  const own = Array.from({ length: 200 }, () => { const roundId = rnd(); return { roundId, committee, finals: committee.map((k) => final(roundId, k, now - 5000)) }; });
  const got = servedNodes({ rounds: mergeServedRounds([own]).rounds, fromMs: now - 86400000, toMs: now, verify });
  console.log(`own record alone: ${got.rounds} of 200 rounds counted`);
  assert.equal(got.rounds, 200);
});

test('one answering seat\'s 200 honest rounds all count when the rest of their committee is down', () => {
  const now = Date.now();
  const committee = [rnd(), rnd(), rnd()];
  const one = Array.from({ length: 200 }, () => { const roundId = rnd(); return { roundId, committee, finals: committee.map((k) => final(roundId, k, now - 5000)) }; });
  const got = servedNodes({ rounds: mergeServedRounds([[], one]).rounds, fromMs: now - 86400000, toMs: now, verify });
  console.log(`one answering seat: ${got.rounds} of 200 rounds counted`);
  assert.equal(got.rounds, 200);
});
