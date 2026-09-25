// THE ARRIVAL CARD'S FACTORS ARE THE CORE'S (the owner's playtest 2026-09-25 18:29). The shot: DELIVERED at tick 4596,
// SCORE +137, and the card read "load 0.85 x danger 1.00 x speed 1.50 x 1000" - 1275. The card now prints factors formed
// from the core's three score words by Unity's CoreScoreFactors (unity-proto/Assets/Scripts/Cargo/RunScore.cs). This file
// holds that C# to the core: its constants are score.js's, and its E x T x C x 1000 is scoreOf's score.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { scoreOf, EXPOSURE_REFERENCE, REFERENCE_TICKS, T_TICKS_MIN, T_TICKS_MAX } from '../src/rules/score.js';

const ONE = 65536;
const CS = readFileSync(new URL('../../../unity-proto/Assets/Scripts/Cargo/RunScore.cs', import.meta.url), 'utf8');
const constant = (name) => {
  const m = new RegExp(`const (?:float|int) ${name} = ([0-9.]+)f?;`).exec(CS);
  assert.ok(m, `RunScore.cs names no ${name}`);
  return Number(m[1]);
};
// THE C# FACTORS, as written there: E = clamp01(word / ONE / 320), T = 3900 / clamp(ticks, 2600, 15600), C = clamp01(word / ONE).
const E = (w) => Math.min(1, Math.max(0, w / ONE / constant('ExposureReferenceMetres')));
const T = (t) => constant('ReferenceTicks') / Math.min(constant('TicksMax'), Math.max(constant('TicksMin'), t));
const C = (w) => Math.min(1, Math.max(0, w / ONE));

test('CoreScoreFactors carries the core\'s own constants', () => {
  assert.deepEqual(
    { exposureMetres: constant('ExposureReferenceMetres'), referenceTicks: constant('ReferenceTicks'), ticksMin: constant('TicksMin'), ticksMax: constant('TicksMax') },
    { exposureMetres: EXPOSURE_REFERENCE / ONE, referenceTicks: REFERENCE_TICKS, ticksMin: T_TICKS_MIN, ticksMax: T_TICKS_MAX });
});

test('the 18:29 shot: the core scores 137, the card now reads load 0.70 x danger 0.23 x speed 0.85, and a danger of 1.00 would have paid 594', () => {
  const exposure = 4819968, ticks = 4596, cargo = 45875;
  const facts = { score: scoreOf(exposure, ticks, cargo), card: [C(cargo), E(exposure), T(ticks)].map((x) => x.toFixed(2)),
    product: Math.round(1000 * C(cargo) * E(exposure) * T(ticks)), atReference: scoreOf(EXPOSURE_REFERENCE, ticks, cargo) };
  console.log('  FACTS (18:29):', JSON.stringify(facts));
  assert.deepEqual(facts, { score: 137, card: ['0.70', '0.23', '0.85'], product: 137, atReference: 594 });
});

test('over a grid of runs the card\'s E x T x C x 1000 is the core\'s score, to the last point\'s rounding', () => {
  let worst = 0;
  for (let m = 0; m <= 400; m += 7) for (const ticks of [1, 2000, 2600, 3900, 4596, 9000, 15600, 20000]) for (const cargo of [0, 13107, 45875, 65536]) {
    const w = m * ONE;
    const off = Math.abs(1000 * C(cargo) * E(w) * T(ticks) - scoreOf(w, ticks, cargo));
    worst = Math.max(worst, off);
  }
  console.log(`  worst distance between the card's product and the core's score: ${worst.toFixed(4)} points`);
  assert.ok(worst <= 0.5 + 1e-6, `the card's product strays ${worst} points from the core's score`);
});
