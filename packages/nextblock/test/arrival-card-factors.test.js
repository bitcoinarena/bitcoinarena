// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ARRIVAL CARD'S FACTORS ARE THE CORE'S (the owner's playtest 2026-09-25 18:29). The shot: DELIVERED at tick 4596,
// SCORE +137, and the card read "load 0.85 x danger 1.00 x speed 1.50 x 1000" - 1275. The card now prints factors formed
// from the core's three score words by Unity's CoreScoreFactors (unity-proto/Assets/Scripts/Cargo/RunScore.cs). This file
// holds that C# to the core: its constants are score.js's, and its E x T x C x 1000 is scoreOf's score.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { scoreOf, exposure5, time5, cargo5, FACTOR_SCALE, SCORE_SCALE, EXPOSURE_REFERENCE, REFERENCE_TICKS, T_TICKS_MIN, T_TICKS_MAX } from '../src/rules/score.js';
// THE CORE THAT SHOT WAS PLAYED ON (2069b4c2, par 3900 ticks), kept frozen: its score is history and does not move with par
import * as then from '../frozen/2069b4c2/rules/score.js';

const ONE = 65536;
const CS = readFileSync(new URL('../../../unity-proto/Assets/Scripts/Cargo/RunScore.cs', import.meta.url), 'utf8');
const constant = (name) => {
  const m = new RegExp(`const (?:float|int) ${name} = ([0-9.]+)f?;`).exec(CS);
  assert.ok(m, `RunScore.cs names no ${name}`);
  return Number(m[1]);
};
// THE C# FACTORS, as written there (2026-09-25: the core's score is the product of its factors): each an integer
// count of 1e-5, rounded once half up - DivRound(n, d) = (2n + d) / (2d) - exactly score.js's exposure5, time5, cargo5.
const SCALE = constant('FactorScale');
const divRound = (n, d) => Math.floor((2 * n + d) / (2 * d));
const E5 = (w) => divRound(Math.min(Math.max(w, 0), constant('ExposureReferenceMetres') * ONE) * SCALE, constant('ExposureReferenceMetres') * ONE);
const T5 = (t) => divRound(constant('ReferenceTicks') * SCALE, Math.min(constant('TicksMax'), Math.max(constant('TicksMin'), t)));
const C5 = (w) => divRound(Math.min(Math.max(w, 0), ONE) * SCALE, ONE);

test('CoreScoreFactors carries the core\'s own constants', () => {
  assert.deepEqual(
    { exposureMetres: constant('ExposureReferenceMetres'), referenceTicks: constant('ReferenceTicks'), ticksMin: constant('TicksMin'), ticksMax: constant('TicksMax'),
      factorScale: constant('FactorScale'), scoreScale: constant('ScoreScale') },
    { exposureMetres: EXPOSURE_REFERENCE / ONE, referenceTicks: REFERENCE_TICKS, ticksMin: T_TICKS_MIN, ticksMax: T_TICKS_MAX,
      factorScale: FACTOR_SCALE, scoreScale: SCORE_SCALE });
});

test('the 18:29 shot: the card reads load 0.70000 x danger 0.23091 x speed 0.84856, and the core\'s score is that product, 137.15869', () => {
  // THE CORE'S WORDS OF THAT RUN, measured: round 6f2d00c2..., entry 66d99bb6..., the pinned fleet core stepped over the
  // transcript and beacon in a copy of the Daily's store.
  // ON THE CORE IT WAS PLAYED ON (2069b4c2): the card's factors are that core's, and its score their product.
  const exposure = 4842601, ticks = 4596, cargo = 45875;
  const facts = { score: then.scoreOf(exposure, ticks, cargo),
    card: [then.cargo5(cargo), then.exposure5(exposure), then.time5(ticks)].map((x) => (x / 1e5).toFixed(5)),
    atReference: then.scoreOf(then.EXPOSURE_REFERENCE, ticks, cargo) };
  console.log('  FACTS (18:29):', JSON.stringify(facts));
  assert.deepEqual(facts, { score: 13715869, card: ['0.70000', '0.23091', '0.84856'], atReference: 59399200 });
  // AND THE SAME WORDS TODAY (T sinks from 20 s, par 1800, the owner 09:17): the C# card and the core still agree, at the new T.
  assert.deepEqual([C5(cargo), E5(exposure), T5(ticks)], [cargo5(cargo), exposure5(exposure), time5(ticks)]);
  assert.equal(divRound(C5(cargo) * E5(exposure) * T5(ticks), 1e7), scoreOf(exposure, ticks, cargo));
});

test('over a grid of runs the card\'s factors are the core\'s, and their product is the core\'s score exactly', () => {
  for (let m = 0; m <= 400; m += 7) for (const ticks of [1, 2000, 2600, 3900, 4596, 9000, 15600, 20000]) for (const cargo of [0, 13107, 45875, 65536]) {
    const w = m * ONE;
    assert.deepEqual([E5(w), T5(ticks), C5(cargo)], [exposure5(w), time5(ticks), cargo5(cargo)], `m ${m} ticks ${ticks} cargo ${cargo}`);
    assert.equal(divRound(E5(w) * T5(ticks) * C5(cargo), 1e7), scoreOf(w, ticks, cargo), `m ${m} ticks ${ticks} cargo ${cargo}`);
  }
});
