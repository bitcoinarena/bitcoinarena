// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2239 (#1489 a45 refute 9 of #1815): the bound on what one seat's answer makes the reader verify keeps the honest path whole.
// Every round of a committee is held by more than one seat, so it is read in full however many rounds there are; a round one seat
// alone holds is still counted within its budget; and one answer naming a round twice gives its committee one vote, not two.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { encodeFinalSig, joinSignedFinalSig } from '../../arena-protocol/src/final-sig.js';
import { servedNodes, mergeServedRounds } from '../../arena-protocol/src/served-nodes.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const rnd = (n = 32) => new Uint8Array(randomBytes(n));
const good = new Set();
const final = (roundId, signerPubkey, ms, ok = true) => { const sig = rnd(64); if (ok) good.add(toHex(sig)); return joinSignedFinalSig(encodeFinalSig({ roundId, entryId: rnd(), runId: rnd(), signerPubkey, signedAtMs: BigInt(ms) }), sig); };
const verify = (sg) => good.has(toHex(sg));

test('1,500 real rounds, each held by its three seats, are all counted; a lone honest round too', () => {
  const now = Date.now();
  const keys = [rnd(), rnd(), rnd()];
  const rounds = Array.from({ length: 1500 }, () => { const roundId = rnd(); return { roundId, committee: keys, finals: keys.map((k) => final(roundId, k, now - 5000)) }; });
  const loneId = rnd();
  const lone = { roundId: loneId, committee: [keys[0]], finals: [final(loneId, keys[0], now - 4000)] };
  const answers = [rounds.map((r) => ({ ...r })), rounds.map((r) => ({ ...r })), [...rounds.map((r) => ({ ...r })), lone]];
  const got = servedNodes({ rounds: mergeServedRounds(answers).rounds, fromMs: now - 86400000, toMs: now, verify });
  const by = new Map(got.nodes.map((n) => [n.key, n.rounds]));
  assert.equal(got.rounds, 1501);
  assert.equal(by.get(toHex(keys[0])), 1501);
  assert.equal(by.get(toHex(keys[1])), 1500);
});

test('one answer listing a round twice with its own committee is one vote: the committee two seats name stands', () => {
  const now = Date.now();
  const real = [rnd(), rnd(), rnd()], fake = [rnd(), rnd(), rnd()];
  const roundId = rnd();
  const honest = { roundId, committee: real, finals: real.map((k) => final(roundId, k, now - 3000)) };
  const evil = { roundId, committee: fake, finals: fake.map((k) => final(roundId, k, now - 3000)) };
  const merged = mergeServedRounds([[evil, evil, evil], [honest], [honest]]);
  assert.deepEqual(merged.rounds[0].committee.map(toHex), real.map(toHex));
  const got = servedNodes({ rounds: merged.rounds, fromMs: now - 86400000, toMs: now, verify });
  assert.deepEqual(got.nodes.map((n) => n.key).sort(), real.map(toHex).sort());
});
