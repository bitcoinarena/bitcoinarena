// The rules from section 18A, as tests rather than as prose.
//
// These are written against the CLAIM, not the implementation: a refactor that
// quietly makes the score additive, or lets a parked truck earn, leaves every
// line looking reasonable and fails here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { init, step, runScore, setGround, HALF_X } from '../src/sim.js';
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

/**
 * The truck can go round a corner.
 *
 * Worth pinning with a number rather than a feel. The first yaw model
 * multiplied the steer angle by a dimensionless speed fraction and a constant,
 * which is not a yaw rate - the units did not work out, and the turning circle
 * that fell out of it was 117 m on a field 200 m wide. Nothing failed; the
 * truck simply drove almost straight while the wheel was hard over, and that
 * reads as unresponsive controls rather than as a bug.
 */
/**
 * The core drives like the PhysX truck it replaces.
 *
 * This is the test that matters for feel, and it is the one that was missing.
 * An earlier steering model was derived from the bicycle equation, was correct
 * in its own terms, and destroyed the driving - because feel was never a
 * bicycle model. It came out of WheelCollider, tyre slip and a hand-tuned lock
 * curve. So the reference is a recording of the real thing, and the core is
 * held to it within a stated tolerance rather than to anything derived.
 *
 * The protocol mirrors PhysxReferenceTests exactly: eight seconds of throttle,
 * five to settle into the turn, five of measurement.
 */
test('the core drives like the PhysX truck it replaces', async () => {
  const ref = JSON.parse(
    await readFile(new URL('./vectors/physx-reference.json', import.meta.url), 'utf8'));
  const tol = ref.tolerance;
  const O = 5, HEAD = 2, VX = 3, VZ = 4, SPEED = 9, STEER = 11, HZ = 60, Q = 65536;

  const drive = (s, n, th, st) => {
    for (let i = 0; i < n; i++) step(s, Math.round(th * Q), Math.round(st * Q), 0, 0, 0);
  };
  const headDeg = (s) => (s.i32[O + HEAD] & 65535) * 360 / Q;

  {
    const s = init(1);
    for (let t = 1; t <= 13; t++) {
      drive(s, HZ, 1, 0);
      const want = ref.accel[String(t)];
      if (want === undefined) continue;
      const got = s.i32[O + SPEED] / Q;
      assert.ok(Math.abs(got - want) / want < tol.accel,
        `at ${t}s the PhysX truck was doing ${want} m/s, the core does ${got.toFixed(2)}`);
    }
  }

  for (const t of ref.turns) {
    const s = init(1);
    drive(s, HZ * 8, 1, 0);
    drive(s, HZ * 5, 1, t.steer);

    let prev = headDeg(s), turned = 0, vsum = 0, slip = 0, wheel = 0, n = 0;
    for (let i = 0; i < HZ * 5; i++) {
      drive(s, 1, 1, t.steer);
      const h = headDeg(s);
      let d = h - prev; if (d > 180) d -= 360; if (d < -180) d += 360;
      turned += d; prev = h;

      const vx = s.i32[O + VX] / Q, vz = s.i32[O + VZ] / Q;
      const sp = Math.sqrt(vx * vx + vz * vz);
      vsum += sp;
      if (sp > 1) {
        let sl = Math.atan2(vx, vz) * 180 / Math.PI - h;
        if (sl > 180) sl -= 360; if (sl < -180) sl += 360;
        slip += sl;
      }
      wheel += s.i32[O + STEER] * 360 / Q;
      n++;
    }

    const v = vsum / n, yaw = Math.abs(turned / 5);
    const radius = v / (yaw * Math.PI / 180);
    const near = (got, want, f, what) => assert.ok(
      Math.abs(got - want) / want < f,
      `steer ${t.steer}: ${what} is ${got.toFixed(2)}, the PhysX truck was ${want}`);

    near(yaw, t.yaw, tol.yaw, 'yaw rate deg/s');
    near(v, t.v, tol.v, 'speed m/s');
    near(radius, t.radius, tol.radius, 'turn radius m');
    near(Math.abs(slip / n), t.slip, tol.slip, 'slip angle deg');
    near(Math.abs(wheel / n), t.wheel, tol.wheel, 'wheel angle deg');
  }
});

/**
 * A hill costs the core what it costs Unity.
 *
 * The core had the mempool relief ported and never read it, so a climb was
 * free and a descent gave nothing back - the truck drove over the map as
 * though it were a table.
 *
 * The reference is a PAIR of PhysX runs down the same line: one over the map's
 * own relief, one with the relief zeroed. The difference between them is what
 * a hill does, and that is what this compares against - not the raw speed.
 * Comparing raw traces measured the hill response and every other difference
 * at once, and the core is a shade quick off the mark, so that bias swamped
 * the number being looked for. Subtracting each side's own flat control
 * removes it and leaves the hills.
 */
test('a hill costs the core what it costs Unity', async () => {
  const ref = JSON.parse(
    await readFile(new URL('./vectors/physx-hills.json', import.meta.url), 'utf8'));

  const Q = 65536, O = 5, T_X = 0, T_Z = 1, T_SPEED = 9;
  const COLS = 160, ROWS = 96, HALFX = 130;

  // The recorded line laid across the whole field: the truck drives straight
  // up +X, so relief varying only with x is the ground it actually met.
  const drive = (profile) => {
    const heights = new Int32Array(COLS * ROWS);
    for (let c = 0; c < COLS; c++) {
      const worldX = (c / (COLS - 1) - 0.5) * (HALFX * 2);
      const f = (worldX - ref.profileFromX) / ref.profileStep;
      const i = Math.max(0, Math.min(profile.length - 2, Math.floor(f)));
      const t = Math.max(0, Math.min(1, f - i));
      const h = profile[i] + (profile[i + 1] - profile[i]) * t;
      for (let r = 0; r < ROWS; r++) heights[r * COLS + c] = Math.round(h * Q);
    }

    const st = init(1);
    assert.ok(setGround(st, COLS, ROWS, heights), 'the relief was refused');
    st.i32[O + T_X] = Math.round(ref.startX * Q);
    st.i32[O + T_Z] = Math.round(ref.lane * Q);

    const out = [];
    for (let k = 0; k < 60 * 22; k++) {
      step(st, Q, 0, 0, 0, 0);
      out.push([st.i32[O + T_X] / Q, st.i32[O + T_SPEED] / Q]);
    }
    return out;
  };

  // Speed where the truck passed a given x, on either side.
  const speedAt = (rows, x, xi, vi) => {
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][xi] >= x) {
        const a = rows[i - 1], b = rows[i];
        const t = (x - a[xi]) / Math.max(1e-6, b[xi] - a[xi]);
        return a[vi] + (b[vi] - a[vi]) * t;
      }
    }
    return null;
  };

  const coreRelief = drive(ref.relief.profile);
  const coreFlat = drive(ref.flat.profile);

  let sum = 0, n = 0, worst = 0, worstAt = null, sawAHill = 0;
  for (let x = -110; x <= 110; x += 10) {
    const unity = speedAt(ref.relief.trace, x, 1, 2) - speedAt(ref.flat.trace, x, 1, 2);
    const core = speedAt(coreRelief, x, 0, 1) - speedAt(coreFlat, x, 0, 1);
    const d = Math.abs(core - unity);
    if (d > worst) { worst = d; worstAt = { x, unity, core }; }
    sum += d; n++;
    sawAHill = Math.max(sawAHill, Math.abs(core));
  }

  // Guards against passing by doing nothing: a core that ignored the ground
  // would score zero difference against its own flat control.
  assert.ok(sawAHill > 0.4,
    `the relief changed the core's speed by at most ${sawAHill.toFixed(2)} m/s - it is not reading the ground`);

  assert.ok(worst < ref.tolerance.hillEffect,
    `at x=${worstAt.x} the relief cost Unity ${worstAt.unity.toFixed(2)} m/s and ` +
    `the core ${worstAt.core.toFixed(2)} m/s`);
  assert.ok(sum / n < ref.tolerance.hillEffect * 0.7,
    `the hill response is ${(sum / n).toFixed(2)} m/s out on average`);
});
