// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE CARGO FACTOR C IS THE BED FILL (2026-10-04 08:54): empty is 0, a full bed is 1, room used over the bed from
// cargo.js roomFor. Init is empty. submitLoad writes S_CARGO and T_CARGO to the fill of the room the load carries; a load
// that carries no room (stored before it crossed) keeps 0.7; the heat stays the heat rule, untied to C.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { init, submitLoad, cargoOf, heatOf, LEGACY_CARGO, runScore } from '../src/sim.js';
import { O_SCORE, S_CARGO, O_TRUCK, T_CARGO } from '../src/state.js';
import { roomFor, fill, heat } from '../src/rules/cargo.js';
import { ONE } from '../src/fixed.js';
import { CORE } from '../src/adapter.js';

test('init is an empty bed: C = 0 in both words, not 45875', () => {
  const st = init(7);
  assert.equal(st.i32[O_SCORE + S_CARGO], 0);
  assert.equal(st.i32[O_TRUCK + T_CARGO], 0);
});

test('a load with its room sets C to the bed fill, both words', () => {
  const room = roomFor(200) + roomFor(700) + roomFor(2000);            // 0.55 + 1.05 + 1.35 of 6.0 m
  const st = init(7);
  submitLoad(st, 3000, 120, room);
  assert.equal(cargoOf(st), fill(room));
  assert.equal(st.i32[O_TRUCK + T_CARGO], fill(room));
  assert.ok(Math.abs(cargoOf(st) / ONE - 2.95 / 6) < 0.001, `C ${cargoOf(st) / ONE}`);
});

test('empty is 0 and a full bed is 1, clamped above', () => {
  const st = init(1);
  submitLoad(st, 0, 0, 0); assert.equal(cargoOf(st), 0);
  submitLoad(st, 0, 0, Math.imul(6, ONE)); assert.equal(cargoOf(st), ONE);
  submitLoad(st, 0, 0, Math.imul(9, ONE)); assert.equal(cargoOf(st), ONE, 'over the bed is still full');
  submitLoad(st, 0, 0, -5); assert.equal(cargoOf(st), 0, 'a negative room is no room');
});

test('a load that carries no room keeps the 0.7 every stored run had', () => {
  const st = init(7);
  submitLoad(st, 3000, 120);
  assert.equal(cargoOf(st), LEGACY_CARGO);
  assert.equal(LEGACY_CARGO, 45875);
  submitLoad(st, 3000, 120, null);
  assert.equal(cargoOf(st), LEGACY_CARGO);
});

test('the heat stays the heat rule, whatever the room', () => {
  for (const room of [undefined, 0, roomFor(100), Math.imul(6, ONE)]) {
    const st = init(3);
    submitLoad(st, 12000, 800, room);
    assert.equal(heatOf(st), heat(12000, 800), `room ${room}`);
  }
});

test('a replay sets the same C: the adapter hands the room on, and an old load stays 0.7', () => {
  const room = roomFor(300) * 3;
  const mk = (loads) => { const st = CORE.start(9); const ev = CORE.eventsOf({ loads }); ev.before(st, 5); return st; };
  assert.equal(cargoOf(mk([[5, 900, 40, room]])), fill(room));
  assert.equal(cargoOf(mk([[5, 900, 40]])), LEGACY_CARGO);
  assert.equal(runScore(mk([[5, 900, 40, room]])), 0, 'nothing driven, nothing scored');
});
