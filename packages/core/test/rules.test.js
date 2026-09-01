// The rules from section 18A, as tests rather than as prose.
//
// These are written against the CLAIM, not the implementation: a refactor that
// quietly makes the score additive, or lets a parked truck earn, leaves every
// line looking reasonable and fails here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { init, step, runScore, HALF_X } from '../src/sim.js';
import { hash } from '../src/state.js';
import * as scoring from '../src/rules/score.js';
import * as gate from '../src/rules/gate.js';

const ONE = 65536;
const O_TRUCK = 5, T_X = 0, T_Z = 1, T_HP = 6;
const O_SCORE = 17, S_EXPOSURE = 0, S_ELAPSED = 1, S_BESTX = 2, S_STATE = 5;

const drive = (st, ticks, throttle, steer) => {
  for (let t = 0; t < ticks; t++) step(st, throttle, steer, 0, 0, 0);
  return st;
};

test('the score is multiplicative - any factor at zero collapses it', () => {
  const full = scoring.EXPOSURE_REFERENCE;
  assert.equal(scoring.scoreOf(full, scoring.REFERENCE_TICKS, ONE), 1000);
  assert.equal(scoring.scoreOf(full, scoring.REFERENCE_TICKS, 0), 0, 'empty bed must score nothing');
  assert.equal(scoring.scoreOf(0, scoring.REFERENCE_TICKS, ONE), 0, 'no danger must score nothing');
});

test('standing still earns nothing, wherever it stands', () => {
  const st = init(11);
  drive(st, 400, ONE, 0);                       // get clear of the apron

  // Brake to a STOP before measuring. A truck rolling to a halt is still
  // gaining ground and is supposed to be paid for it - measuring from the
  // moment the brake goes on measures the coast, not the standing still.
  for (let t = 0; t < 900; t++) step(st, 0, 0, ONE, 0, 0);
  const settled = st.i32[O_TRUCK + T_X];
  const before = st.i32[O_SCORE + S_EXPOSURE];

  for (let t = 0; t < 600; t++) step(st, 0, 0, ONE, 0, 0);
  assert.equal(st.i32[O_TRUCK + T_X], settled, 'the fixture never came to rest');
  assert.equal(st.i32[O_SCORE + S_EXPOSURE], before,
    'a parked truck accrued exposure');
});

test('a lap earns nothing - exposure is ground made good, not time', () => {
  const st = init(12);
  drive(st, 600, ONE, 0);

  // Come to rest BEFORE taking the reading. A truck rolling to a halt covers
  // new ground and is paid for it, so a mark taken at the moment the brake
  // goes on is seven metres short of where the run actually reached - and the
  // test then blames the lap for exposure the coast had earned.
  for (let t = 0; t < 900; t++) step(st, 0, 0, ONE, 0, 0);
  const mark = st.i32[O_SCORE + S_BESTX];
  const after = st.i32[O_SCORE + S_EXPOSURE];

  // Back up thirty metres, driven by POSITION rather than a tick count: at
  // fifteen metres a second, five seconds of reverse thrust only cancels the
  // forward motion, which is correct physics and a useless fixture.
  const target = mark - ONE * 30;
  let guard = 0;
  while (st.i32[O_TRUCK + T_X] > target && guard++ < 6000) step(st, -ONE, 0, 0, 0, 0);
  assert.ok(guard < 6000, 'the truck never reversed');

  // forward again, but stopping short of the mark
  guard = 0;
  while (st.i32[O_TRUCK + T_X] < mark - ONE * 4 && guard++ < 4000) step(st, ONE, 0, 0, 0, 0);
  assert.ok(st.i32[O_TRUCK + T_X] < mark, 'the fixture got past its own mark');
  assert.equal(st.i32[O_SCORE + S_EXPOSURE], after,
    'ground already covered was paid for twice');
});

test('the apron pays nothing however close the fighting comes', () => {
  const st = init(13);
  for (let t = 0; t < 200; t++) step(st, 0, 0, ONE, 0, 0);
  assert.equal(st.i32[O_SCORE + S_EXPOSURE], 0,
    'the spawn apron accrued exposure');
});

test('the time factor is floored and capped', () => {
  assert.equal(scoring.timeFactor(scoring.REFERENCE_TICKS), ONE);
  assert.equal(scoring.timeFactor(1), scoring.T_CEIL, 'an instant run is capped');
  assert.equal(scoring.timeFactor(1000000), scoring.T_FLOOR, 'dawdling is floored');
});

test('the block closing ends a run that is still out there', () => {
  const st = init(14);
  // Health is held up throughout: this test is about the clock, and a truck
  // driven straight through a battle for two and a half minutes is destroyed
  // long before the block closes - which is correct behaviour and a useless
  // fixture for the thing under test.
  for (let t = 0; t < gate.BLOCK_TICKS + 10; t++) {
    st.i32[O_TRUCK + T_HP] = ONE * 100;
    step(st, 0, 0, ONE, 0, 0);                      // parked, so it never arrives
  }
  assert.equal(st.i32[O_SCORE + S_STATE], gate.RUN_MISSED,
    'the run survived past the end of its block');
});

test('the same seed replays exactly, a different one does not', () => {
  const run = (seed) => hash(drive(init(seed), 1200, ONE, 4096));
  assert.equal(run(21), run(21));
  assert.notEqual(run(21), run(22));
});

test('a delivered run banks a score and a wrecked one does not', () => {
  const st = init(15);
  // put it through the gate by hand: the rules, not the driving, are under test
  for (let t = 0; t < 60; t++) step(st, ONE, 0, 0, 0, 0);
  st.i32[O_TRUCK + T_X] = gate.GATE_X + ONE;
  st.i32[O_TRUCK + T_Z] = 0;
  step(st, 0, 0, 0, 0, 0);
  assert.equal(st.i32[O_SCORE + S_STATE], gate.RUN_DELIVERED);

  const wreck = init(16);
  for (let t = 0; t < 60; t++) step(wreck, ONE, 0, 0, 0, 0);
  wreck.i32[O_TRUCK + T_HP] = 0;
  step(wreck, 0, 0, 0, 0, 0);
  assert.equal(wreck.i32[O_SCORE + S_STATE], gate.RUN_WRECKED);
});
