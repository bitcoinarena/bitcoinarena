// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 v1-refute-66-s3-1 (a refute of #1488 / Hexbox #011 at fd7c1b9fe): THE OBJECTION DOOR'S LOAD RULES READ A
// NUMBER THE CORE DOES NOT. inputsLoadRefusal (objection-check.js) holds a live run's inputs to loadValueRefusal, which
// asks only Number.isInteger(fee) && fee >= fewestSats(room). The inputs are free JSON, so a fee of 2^32 passes it (a
// full bed "pays" 4294967296 sats) - and the core's submitLoad takes `feeSats | 0`, which is 0. The batch door never sees
// this (a batch encodes the fee as i32), but the objection door's own rule is bypassed: Hexbox's full bed at 0 sats.
// Safe: a load whose values the core would read otherwise than the check (outside i32) is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inputsLoadRefusal } from '../src/objection-check.js';
import { loadValueRefusal } from '../src/load-checks.js';
import { init, submitLoad, heatOf, cargoOf } from '../../nextblock/src/sim.js';

const FORBIDDEN = [0, 0, 0, 393214];                    // Hexbox #011 attack 1: refused by the rules
const WRAPPED = [0, 2 ** 32, 0, 393214];                // the same bed to the core: 2^32 | 0 === 0

test('wf1489 v1-refute-66-s3-1: a live run\'s inputs cannot carry a fee the core reads as 0', () => {
  assert.ok(loadValueRefusal(FORBIDDEN), 'the rules take Hexbox\'s bed - not the case the test names');
  // the core reads both loads as the same bed
  const a = init(1), b = init(1);
  submitLoad(a, FORBIDDEN[1], FORBIDDEN[2], FORBIDDEN[3]);
  submitLoad(b, WRAPPED[1], WRAPPED[2], WRAPPED[3]);
  assert.equal(heatOf(b), heatOf(a), 'the core reads 2^32 sats otherwise than 0');
  assert.equal(cargoOf(b), cargoOf(a));
  const form = { ticks: Array.from({ length: 4 }, (_, t) => ({ tick: t, words: [0, 0, 0, 0, 0] })), liquidations: [], loads: [WRAPPED], samples: [], tapes: [] };
  const why = inputsLoadRefusal(form);
  console.log('  FACTS:', JSON.stringify({ heatForbidden: heatOf(a), heatWrapped: heatOf(b), cargo: cargoOf(b), inputsLoadRefusal: why }));
  assert.ok(why, `inputsLoadRefusal takes ${JSON.stringify(WRAPPED)}, which the core plays as ${JSON.stringify(FORBIDDEN)} (heat ${heatOf(b)})`);
});
