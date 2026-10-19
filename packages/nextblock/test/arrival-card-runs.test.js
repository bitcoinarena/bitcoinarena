// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ARRIVAL CARD'S FIXTURE IS WHAT THE CORE PRODUCES NOW (2026-09-25: the card prints the core's E, T and C, and
// their product is the score). test/fixtures/arrival-card-runs.json is what the EditMode check
// TheCardsProductIsTheCoresScore feeds through the real C# formatter; if the core moved and the file did not, that check
// would be proving the card against a world nobody plays. Regenerate with tools/arrival-card-runs.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { arrivalCardRuns } from '../tools/arrival-card-runs.mjs';
import { scoreOf, exposure5, time5, cargo5, REFERENCE_TICKS, T_TICKS_MIN, T_TICKS_MAX } from '../src/rules/score.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/arrival-card-runs.json', import.meta.url), 'utf8')).runs;

// THE CARGO WORD IN THESE RUNS IS A FIXTURE WRITE, NOT A PLAYER INPUT: this core sets S_CARGO once, in init, to 45875
// (0.70), and no input changes it. And T stops at about 0.364, not the 0.25 clamp: 0.25 CANNOT be reached by a delivered
// run on this core - the block closes at BLOCK_TICKS 10800 and a miss beats an arrival, so T >= REFERENCE_TICKS/10799.
test('1. the fixture is the 72 DELIVERED runs the core produces now, with T and C both moving', () => {
  const now = arrivalCardRuns();
  assert.equal(now.length, 72);
  assert.ok(now.every((r) => r.state === 1), 'a run in the fixture did not deliver');
  assert.deepEqual(fixture, now, 'the fixture is not what this core produces - regenerate it with tools/arrival-card-runs.mjs');
  const T = (r) => REFERENCE_TICKS / Math.min(T_TICKS_MAX, Math.max(T_TICKS_MIN, r.elapsed));
  assert.ok(now.some((r) => T(r) < 1.5), 'no run has T below the 1.5 clamp');
  assert.ok(Math.min(...now.map(T)) < 0.37, 'T does not reach down near the delivered floor (about 0.364)');
  assert.ok(now.some((r) => r.cargo !== 45875), 'every run carries the default cargo word 0.70');
  assert.deepEqual([...new Set(now.map((r) => r.fixtureCargo))].sort(), [0.2, 0.45, 0.7, 0.95]);
});

test('2. each run\'s S_DELIVERED is scoreOf of its own three words', () => {
  for (const r of fixture) assert.equal(r.delivered, scoreOf(r.exposure, r.elapsed, r.cargo), `lane ${r.lane} seed ${r.seed}`);
});

test('3. on every run the product of the factors, to five decimals, IS the score (lane 0 seed 0: 7.50000, not 7 beside 7.49984)', () => {
  for (const r of fixture) {
    const e = exposure5(r.exposure), t = time5(r.elapsed), c = cargo5(r.cargo);
    assert.equal(Math.floor((2 * e * t * c + 1e7) / 2e7), r.delivered,
      `lane ${r.lane} seed ${r.seed}: ${(c / 1e5).toFixed(5)} x ${(e / 1e5).toFixed(5)} x ${(t / 1e5).toFixed(5)} x 1000 is not ${(r.delivered / 1e5).toFixed(5)}`);
  }
  const l0 = fixture.find((r) => r.lane === 0 && r.seed === 0);
  assert.equal(l0.delivered, 750000, 'lane 0 seed 0 scores 7.50000');
});

