// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A transcript replays to the same round the inputs did.
//
// This is the property M2.1 step 2 exists for, and it is the reason the
// transcript carries the liquidations and the LOAD as well as the five words:
// a verifier hands the object to `step`, `submitLiquidation` and `submitLoad`
// and must land where the player landed, or a result cannot be checked by
// anyone. The load is the newest of the three (letter 40) and the one that was
// missing longest - heat was written straight into the page's own core, so
// every replay of every run was hunted at zero.
//
// It lives here rather than in the node because the NODE DOES NOT STEP. The
// core owns replaying; the node owns storing. Keeping the proof next to the
// simulator is what lets that stay true.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { init, step, submitLiquidation, submitLoad } from '../src/sim.js';
import { hash } from '../src/state.js';
import { encodeInputBatch, batchId } from '../../arena-protocol/src/batch.js';
import {
  encodeTranscript, decodeTranscript, checkTranscript, flatten, GENESIS,
} from '../../arena-protocol/src/transcript.js';

const b32 = (n) => new Uint8Array(32).fill(n);

/** Re-links a chain after any batch has been altered. */
function rechain(t) {
  let prev = GENESIS;
  for (const b of t.batches) { b.previousHash = prev; prev = batchId(b); }
}

/**
 * A round of `n` batches of `per` ticks, with one liquidation in the second
 * and the bed declared in the first, which is where roll-out declares it.
 */
function played(n, per) {
  const batches = [];
  let prev = GENESIS;
  for (let k = 0; k < n; k++) {
    const first = k * per;
    const b = {
      roundId: b32(1), entryId: b32(2), previousHash: prev, firstTick: first,
      ticks: Array.from({ length: per }, (_, i) => {
        const t = first + i;
        return [65536, ((t / 45) | 0) % 2 ? 22000 : -22000, 0, 0, 0];
      }),
      liquidations: k === 1 ? [[first + 20, 500 * 65536]] : [],
      loads: k === 0 ? [[first, 17314, 42]] : [],
    };
    batches.push(b);
    prev = batchId(b);
  }
  return { roundId: b32(1), entryId: b32(2), batches };
}

/** The round as the player played it: inputs straight into the core. */
function direct(t, seed) {
  const st = init(seed);
  for (const b of t.batches) {
    for (let i = 0; i < b.ticks.length; i++) {
      const at = b.firstTick + i;
      for (const [when, fee, btc] of (b.loads || [])) if (when === at) submitLoad(st, fee, btc);
      for (const [when, size] of b.liquidations) if (when === at) submitLiquidation(st, size);
      step(st, ...b.ticks[i]);
    }
  }
  return hash(st);
}

/** The round as a verifier replays it: only the encoded transcript. */
function fromTranscript(bytes, seed) {
  const t = decodeTranscript(bytes);
  const chain = checkTranscript(t);
  assert.ok(chain.ok, 'a verifier checks the chain before it spends a tick on it');
  const { ticks, liquidations, loads } = flatten(t);
  const due = new Map(liquidations.map(([at, size]) => [at, size]));
  const bed = new Map(loads.map(([at, fee, btc]) => [at, [fee, btc]]));
  const st = init(seed);
  for (let i = 0; i < ticks.length; i++) {
    if (bed.has(i)) submitLoad(st, ...bed.get(i));
    if (due.has(i)) submitLiquidation(st, due.get(i));
    step(st, ...ticks[i]);
  }
  return { digest: hash(st), ticks: ticks.length, loads: loads.length };
}

test('replaying the transcript lands where the inputs landed', () => {
  const t = played(5, 60);
  const replayed = fromTranscript(encodeTranscript(t), 1);
  assert.equal(replayed.ticks, 300);
  assert.equal(replayed.digest, direct(t, 1),
    'the object a node hands over IS the round');
});

test('the load is in it - without it the replay is hunted at zero', () => {
  // THE FAULT LETTER 40 CLOSED, in this file's own terms. Heat was written
  // into the page's core by `ArenaSetHeat` and travelled nowhere, so every
  // verifier stepped the run with an empty bed while the player was being
  // hunted for a full one.
  const t = played(20, 60);
  const carried = fromTranscript(encodeTranscript(t), 1);
  assert.equal(carried.loads, 1, 'the transcript did not carry the bed');
  assert.equal(carried.digest, direct(t, 1));

  const stripped = { ...t, batches: t.batches.map((b) => ({ ...b, loads: [] })) };
  rechain(stripped);
  assert.notEqual(fromTranscript(encodeTranscript(stripped), 1).digest, direct(t, 1),
    'a transcript with the bed removed replays to the same world, so the load costs nothing');
});

test('the liquidation is in it - without it the replay is a different round', () => {
  const t = played(5, 60);
  const stripped = {
    ...t,
    batches: t.batches.map((b) => ({ ...b, liquidations: [] })),
  };
  rechain(stripped);   // dropping a field changes every id after it
  assert.notEqual(fromTranscript(encodeTranscript(stripped), 1).digest, direct(t, 1),
    'a transcript with the strike removed replays to a different world');
});

test('a changed input changes the round - but it has to last', () => {
  // MEASURED, because the first version of this test asserted that ANY one
  // word moves the digest, and that is false. The steering has a rate, so a
  // single tick of a different input is pulled back before it has turned the
  // wheel: 1024 units of steer for one tick leaves the round identical, so
  // does five ticks of it, and so does FULL lock for three. Thirteen ticks of
  // 1024 changes it. What this pins is that a verifier replaying a transcript
  // feels a real difference - not that the digest is a hash of input bytes.
  const before = fromTranscript(encodeTranscript(played(3, 40)), 1).digest;

  const brief = played(3, 40);
  brief.batches[1].ticks[7][1] += 1024;
  rechain(brief);
  assert.equal(fromTranscript(encodeTranscript(brief), 1).digest, before,
    'one tick of 1.6% lock is below what the wheel can carry');

  const sustained = played(3, 40);
  for (let i = 7; i < 20; i++) sustained.batches[1].ticks[i][1] += 1024;
  rechain(sustained);
  assert.notEqual(fromTranscript(encodeTranscript(sustained), 1).digest, before,
    'thirteen ticks of it does move the world');
});

test('the same transcript replays the same way twice', () => {
  const bytes = encodeTranscript(played(4, 50));
  assert.equal(fromTranscript(bytes, 7).digest, fromTranscript(bytes, 7).digest);
});
