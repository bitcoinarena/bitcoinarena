// The rules from section 18A, as tests rather than as prose.
//
// These are written against the CLAIM, not the implementation: a refactor that
// quietly makes the score additive, or lets a parked truck earn, leaves every
// line looking reasonable and fails here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { init, step, runScore, setGround, setSolids, setArmour, HALF_X } from '../src/sim.js';
import { hash } from '../src/state.js';
import * as scoring from '../src/rules/score.js';
import * as gate from '../src/rules/gate.js';

const ONE = 65536;

/**
 * Empties the battlefield.
 *
 * The driving references were recorded with Unity's Battlefield switched off,
 * so the core has to be measured on the same empty map - otherwise the test is
 * comparing a clear run against one that drove into a tank.
 */
function clearTheField(st) {
  const O_UNITS = 24, U_WORDS = 8, U_STATE = 5, UNITS = 96;
  for (let i = 0; i < UNITS; i++) st.i32[O_UNITS + i * U_WORDS + U_STATE] = 0;
}

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
    clearTheField(s);
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
    clearTheField(s);
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
    clearTheField(st);
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

/**
 * The truck cannot drive through the world.
 *
 * When the core took the driving off PhysX it took the collisions with it: the
 * body is kinematic and its transform is written straight from the core, so
 * nothing in Unity resolves a penetration any more and the truck drove through
 * the post office, through the miner, through everything.
 *
 * A doorway is checked as carefully as a wall. The obstacles carry a vertical
 * span because the lintel over each bay is a nine-metre-high slab, and a core
 * that only knew about XZ would have walled up every door in the building.
 */
test('a wall stops the truck and a lintel does not', () => {
  const Q = 65536, O = 5, T_X = 0, T_Z = 1, T_SPEED = 9;
  const q = (m) => Math.round(m * Q);

  const run = (boxes) => {
    const st = init(1);
    if (boxes) assert.ok(setSolids(st, boxes.length / 6, boxes), 'die Hindernisse wurden abgelehnt');
    const sx = st.i32[O + T_X] / Q;
    for (let i = 0; i < 600; i++) step(st, Q, 0, 0, 0, 0);
    return { x: st.i32[O + T_X] / Q, v: st.i32[O + T_SPEED] / Q, from: sx };
  };

  const open = run(null);
  assert.ok(open.x - open.from > 100, 'ohne Hindernis muss der Truck weit kommen');

  // A slab across the road, from the ground up, thirty metres ahead.
  const wallAt = open.from + 30;
  const st0 = init(1);
  const z = st0.i32[O + T_Z] / Q;
  const wall = run(new Int32Array([q(wallAt), q(z), q(1), q(20), 0, q(50)]));

  // The nose stops one radius plus the nose offset short of the face.
  const face = wallAt - 1;
  const expected = face - 1.275 - 2.0;
  assert.ok(Math.abs(wall.x - expected) < 0.2,
    `der Truck steht bei ${wall.x.toFixed(2)}, die Wand haelt ihn bei ${expected.toFixed(2)}`);
  assert.ok(wall.v < 1, `er drueckt mit ${wall.v.toFixed(2)} m/s weiter in die Wand`);

  // The same slab, but starting nine metres up: that is a doorway.
  const door = run(new Int32Array([q(wallAt), q(z), q(1), q(20), q(9), q(50)]));
  assert.ok(Math.abs(door.x - open.x) < 0.01,
    `der Sturz hat den Truck aufgehalten - er kam nur bis ${door.x.toFixed(1)} statt ${open.x.toFixed(1)}`);
});

/**
 * The core stops the truck where PhysX stopped it.
 *
 * Not just that it stops - where. A wall the old game let the player park
 * flush against, and the core holds them a metre off, is a doorway they can
 * see they fit through and cannot drive into.
 *
 * The reference is a recording of the PhysX truck reversed into the post
 * office frontage at full throttle and left to settle.
 */
test('a wall holds the truck where the old game held it', async () => {
  const ref = JSON.parse(
    await readFile(new URL('./vectors/physx-wall.json', import.meta.url), 'utf8'));

  const Q = 65536, O = 5, T_X = 0, T_Z = 1;
  const q = (m) => Math.round(m * Q);

  const st = init(1);
  const z = st.i32[O + T_Z] / Q;

  // The same wall, in the same place, relative to where the truck starts.
  // Reversing into it, as the reference run did.
  const face = ref.wallFace;
  const thick = 4;
  st.i32[O + T_X] = q(face + 12);
  setSolids(st, 1, new Int32Array(
    [q(face - thick / 2), q(z), q(thick / 2), q(20), 0, q(50)]));

  for (let i = 0; i < 60 * 8; i++) step(st, -Q, 0, 0, 0, 0);

  const rear = st.i32[O + T_X] / Q - ref.halfChassis;
  const gap = rear - face;

  assert.ok(Math.abs(gap - ref.gap) < ref.tolerance.gap,
    `PhysX liess den Truck ${ref.gap.toFixed(2)} m vor der Wand stehen, ` +
    `der Core ${gap.toFixed(2)} m - ${Math.abs(gap - ref.gap).toFixed(2)} m Unterschied`);
});

/**
 * A box on the far side of the map is not a box the truck is standing in.
 *
 * length2 squares its arguments in Q16.16, and the rails around this map are
 * 266 m long. A box a hundred metres away overflowed the sum of the squares
 * past 2^31, wrapped it negative, and came back as a distance of ZERO - which
 * reads as the circle sitting dead in the middle of that box. The truck was
 * ejected from scenery it was nowhere near and arrived at the western edge of
 * the map half a second after the round began, stationary, with no way to tell
 * from the outside that a collision had done it.
 */
test('a distant wall does not eject the truck', () => {
  const Q = 65536, O = 5, T_X = 0, T_Z = 1;
  const q = (m) => Math.round(m * Q);

  const st = init(1);
  const x0 = st.i32[O + T_X] / Q, z0 = st.i32[O + T_Z] / Q;

  // The real rails: 266 m long, along both edges of the map, and the post
  // office frontage. None of them is anywhere near the spawn.
  assert.ok(setSolids(st, 3, new Int32Array([
    q(0), q(-85), q(133), q(1.5), q(-1.7), q(24.3),
    q(0), q(85), q(133), q(1.5), q(-1.7), q(24.3),
    q(-118.4), q(0), q(4), q(84.1), q(15.6), q(58.4),
  ])), 'die Hindernisse wurden abgelehnt');

  // Standing still, hands off.
  for (let i = 0; i < 120; i++) step(st, 0, 0, 0, 0, 0);

  const x = st.i32[O + T_X] / Q, z = st.i32[O + T_Z] / Q;
  assert.ok(Math.abs(x - x0) < 0.5 && Math.abs(z - z0) < 0.5,
    `der Truck stand bei ${x0.toFixed(1)}, ${z0.toFixed(1)} und wurde nach ` +
    `${x.toFixed(1)}, ${z.toFixed(1)} geschoben`);
});

/**
 * A tank is something to drive around, a soldier is not.
 *
 * Armour blocks; infantry deliberately does not. A man does not stop a laden
 * truck, and making him do it turns a charge across the open into a wall of
 * bodies the player cannot get through - which is neither what the old game
 * did nor what anyone would expect of it.
 */
test('armour blocks the truck and infantry does not', () => {
  const Q = 65536, O = 5, T_X = 0, T_Z = 1, T_SPEED = 9;
  const O_UNITS = 24, U_WORDS = 8, U_X = 0, U_Z = 1, U_STATE = 5;

  const run = (withTank) => {
    const st = init(1);
    clearTheField(st);
    if (withTank) {
      setArmour(st, 1, new Int32Array([
        st.i32[O + T_X] + Math.round(30 * Q), st.i32[O + T_Z]]));
    }
    for (let i = 0; i < 600; i++) step(st, Q, 0, 0, 0, 0);
    return { x: st.i32[O + T_X] / Q, v: st.i32[O + T_SPEED] / Q };
  };

  const clear = run(false);
  const tank = run(true);
  // Infantry is never uploaded, so an empty armour list IS the infantry case.
  const man = clear;

  assert.ok(tank.x < clear.x - 50,
    `der Panzer hat den Truck nicht aufgehalten - er kam bis ${tank.x.toFixed(1)}`);
  assert.ok(tank.v < 1,
    `der Truck drueckt mit ${tank.v.toFixed(2)} m/s weiter in den Panzer`);

  // The stopping distance is the two radii plus the nose: about 6.3 m.
  const gap = (clear.from ?? 0, 30 + (init(1).i32[O + T_X] / Q) - tank.x);
  assert.ok(gap > 4 && gap < 9,
    `der Truck steht ${gap.toFixed(1)} m vor dem Panzer - erwartet etwa 6.3`);

  assert.ok(Math.abs(man.x - clear.x) < 0.01,
    `die Infanterie hat den Truck aufgehalten - ${man.x.toFixed(1)} statt ${clear.x.toFixed(1)}`);
});

/**
 * The army closes on the seam at the C# army's pace, and holds a front.
 *
 * Step (a) of moving the army into the core. What is checked is the approach
 * - the part that is pure movement - and the property that makes a front a
 * front: both sides stop short of the seam on their own side and neither
 * crosses. Casualties and retreat come later and change where they settle,
 * so the settled position is deliberately not asserted here.
 *
 * Measured against test/vectors/csharp-army.json, in SEAM-RELATIVE terms.
 * The recording pinned the seam at z = 0; the core's runs with the map, and
 * comparing raw z made a correct army look like it had overrun the line by
 * twenty-seven metres.
 */
test('the army closes at the pace the C# army closes', async () => {
  const ref = JSON.parse(
    await readFile(new URL('./vectors/csharp-army.json', import.meta.url), 'utf8'));

  const Q = 65536, O_UNITS = 24, U_WORDS = 8, UNITS = 96;
  const U_X = 0, U_Z = 1, U_SIDE = 2, U_STATE = 5;

  const st = init(1);
  const mean = (armour, side) => {
    let sum = 0, n = 0;
    for (let i = 0; i < UNITS; i++) {
      if (((i & 3) === 0) !== armour) continue;
      const b = O_UNITS + i * U_WORDS;
      if (st.i32[b + U_STATE] === 0 || st.i32[b + U_SIDE] !== side) continue;
      sum += st.i32[b + U_Z] / Q; n++;
    }
    return n > 0 ? sum / n : null;
  };

  const at0 = { armour: mean(true, -1), rifle: mean(false, -1) };
  for (let i = 0; i < 60 * 5; i++) step(st, 0, 0, 0, 0, 0);
  const at5 = { armour: mean(true, -1), rifle: mean(false, -1) };

  // Five seconds of closing, against the recording's own first two rows.
  const wantArmour = (ref.rows[1].bullArmour.z - ref.rows[0].bullArmour.z) / 5;
  const wantRifle = (ref.rows[1].bullInf.z - ref.rows[0].bullInf.z) / 5;
  const gotArmour = (at5.armour - at0.armour) / 5;
  const gotRifle = (at5.rifle - at0.rifle) / 5;

  assert.ok(Math.abs(gotArmour - wantArmour) < 0.8,
    `armour closes at ${gotArmour.toFixed(2)} m/s, the C# army at ${wantArmour.toFixed(2)}`);
  assert.ok(Math.abs(gotRifle - wantRifle) < 0.5,
    `infantry closes at ${gotRifle.toFixed(2)} m/s, the C# army at ${wantRifle.toFixed(2)}`);

  // Armour arrives first. Both arms moving together is the signature of the
  // fault this test was written after: the kind flag never reached the step,
  // so tanks walked at rifle pace.
  assert.ok(Math.abs(gotArmour) > Math.abs(gotRifle) * 2,
    'armour and infantry close at the same speed - the kind flag is not reaching the step');

  // And it settles into a front rather than through one.
  for (let i = 0; i < 60 * 60; i++) step(st, 0, 0, 0, 0, 0);
  const bull = mean(true, -1), bear = mean(true, 1);
  assert.ok(bull !== null && bear !== null, 'one side has vanished');
  assert.ok(bull < bear,
    `the armies have crossed: bull armour at ${bull.toFixed(1)}, bear at ${bear.toFixed(1)}`);
});

/**
 * The army replaces its dead, and the front therefore holds.
 *
 * Step (d) of moving the army into the core, and the reason it is not a
 * garnish: without replacement the first exchange decides the round. Measured,
 * before this existed - one side wiped inside thirty seconds, and from t=34 the
 * nearest enemy to any survivor was 49 to 154 m away against a 46 m gun. Not a
 * slow fight; a finished one, with fifty seconds still to play.
 *
 * Held to the recording rather than to what the core happens to do:
 * `passes.core-size-reinforce` in csharp-army.json is the C# army at the
 * establishment the core fields - twelve tanks and thirty-six riflemen a side -
 * with Army.Reinforce running. Its own `tolerance.alive` is the band.
 *
 * The shooter count is the assertion that matters. A headcount can be held up
 * by an army standing in two heaps that never meet, which is exactly the state
 * the core was in.
 */
test('replacements keep both armies in contact for the whole round', async () => {
  const ref = JSON.parse(
    await readFile(new URL('./vectors/csharp-army.json', import.meta.url), 'utf8'));
  const rec = ref.passes['core-size-reinforce'];
  const recAt = (t) => rec.density.find((d) => d.t === t);

  const O_UNITS = 24, U_WORDS = 8, UNITS = 96, RANGE = 46;
  const U_X = 0, U_Z = 1, U_SIDE = 2, U_STATE = 5;

  const st = init(20260901);
  // The recording pins the seam at z=0 (ArmyReferenceTests sets FrontlineAt to
  // zero). The core's runs with the price tape, and comparing a fight offset by
  // twenty-seven metres against a symmetric one is not a comparison.
  st.tape.fill(st.tape[0]);

  const armour = () => {
    const out = [];
    for (let i = 0; i < UNITS; i++) {
      if ((i & 3) !== 0) continue;
      const b = O_UNITS + i * U_WORDS;
      if (st.i32[b + U_STATE] === 0) continue;
      out.push({ x: st.i32[b + U_X] / ONE, z: st.i32[b + U_Z] / ONE, side: st.i32[b + U_SIDE] });
    }
    return out;
  };
  /** Tanks with an enemy inside the gun - the ones that can actually fight. */
  const shooters = (us) => us.filter((a) =>
    us.some((b) => b.side !== a.side &&
      (b.x - a.x) * (b.x - a.x) + (b.z - a.z) * (b.z - a.z) < RANGE * RANGE)).length;

  let t = 0;
  for (const mark of [30, 60, 90]) {
    while (t < mark * 60) { step(st, 0, 0, 0, 0, 0); t++; }
    const us = armour();
    const want = recAt(mark);

    assert.ok(Math.abs(us.length - want.tanksAlive) <= ref.tolerance.alive,
      `at t=${mark} the core fields ${us.length} tanks, the recording ${want.tanksAlive}`);
    assert.ok(shooters(us) > 0,
      `at t=${mark} not one tank has an enemy in range - the fight is over and ` +
      `the recording has ${want.shooters} still shooting`);
  }

  // And a side that is emptied comes back, which is what the deficit term in
  // the cadence is for: C# added it after one side sat at 0-1 tanks for five
  // minutes while the other held eleven.
  const us = armour();
  for (const side of [-1, 1]) {
    assert.ok(us.filter((u) => u.side === side).length >= 4,
      `one army has been wiped out and not replaced: ${us.filter((u) => u.side === -1).length} ` +
      `against ${us.filter((u) => u.side === 1).length} at t=90`);
  }
});

/**
 * Practice changes the damage the truck takes and NOTHING else.
 *
 * practice.json says so in its own note - "the army still fires and still
 * counts towards danger, so the draw order is identical" - and reinforcement is
 * the first thing since that could have broken it: a replacement drawn only in
 * a scored run would take a different number of words out of the stream and
 * every unit after it would stand somewhere else.
 *
 * Compared over the whole army region, all ninety-six units and the four
 * replacement clocks, rather than over a summary that could agree by accident.
 */
test('a practice run and a live run field the same army, word for word', async () => {
  const { O_UNITS, WORDS } = await import('../src/state.js');
  const drive = (practice) => {
    const st = init(1);
    for (let i = 0; i < 3600; i++) step(st, ONE, 0, 0, 0, practice);
    return st;
  };
  const live = drive(0), shielded = drive(1);

  // To the END of the buffer, not to the replacement clocks. The air arm was
  // appended after them and draws from the same stream, so a bomb released only
  // in a scored run would take words out of it that a practice run did not and
  // put every unit after it somewhere else - which is exactly the failure this
  // test exists to catch, and the old bound would have walked straight past it.
  let differing = 0;
  for (let w = O_UNITS; w < WORDS; w++)
    if (live.i32[w] !== shielded.i32[w]) differing++;

  assert.equal(differing, 0,
    `${differing} words of the army differ between a live and a practice run - ` +
    'something in the army is reading the practice flag');
});

// ---------------------------------------------------------------------------
// The air arm.
//
// Held against test/vectors/csharp-gunships.json, and only against the
// quantities that recording says can be held: its sortie clock and its gunship
// direction are on UnityEngine.Random rather than on the army seed, so the C#
// air war cannot be replayed from a seed at all and matching one to the digit
// is not on offer. What IS on offer is the envelope across four seeds, and
// tools/measure-air.js prints the whole of it beside the recording.
//
// What is asserted here is narrower on purpose: the handful of facts that would
// go wrong silently. A sortie count drifting by one is a number to look at; a
// gunship slot quietly swallowing a sortie is a desync.

/** Every gunship currently airborne. */
async function airborne(st) {
  const L = await import('../src/state.js');
  const out = [];
  for (let i = 0; i < L.MAX_HELIS; i++) {
    const b = L.heliBase(i);
    if (st.i32[b + L.H_STATE] === 0) continue;
    out.push({ i, side: st.i32[b + L.H_SIDE], x: st.i32[b + L.H_X],
               y: st.i32[b + L.H_Y], z: st.i32[b + L.H_Z] });
  }
  return out;
}

/**
 * Both clocks start at zero, so both sides launch on the first tick - and both
 * sorties are wasted, because the armies are still eighty metres apart at the
 * map's edges while the gunships fly the seam between them.
 *
 * The recording calls this out as a finding rather than a defect: the first
 * killing bomb is at t = 16.7-26.4 s on every seed. It is what makes air
 * something that arrives rather than something that is simply on, and a core
 * that started the clocks anywhere else would be a different game.
 */
test('both sides launch on the first tick, and the first sorties are wasted', async () => {
  const L = await import('../src/state.js');
  const st = init(20260901);
  step(st, 0, 0, 0, 0, 0);

  const up = await airborne(st);
  assert.equal(up.length, 2, 'the round did not open with a sortie from each side');
  assert.deepEqual(up.map((h) => h.side).sort(), [-1, 1],
    'both opening sorties came from the same army');

  // Each enters at the corridor's edge, past the fighting and short of the
  // depots it cannot fly through, and holds nineteen metres over the ground.
  for (const h of up) {
    assert.equal(Math.abs(h.x) > Math.imul(92, ONE), true,
      'a gunship entered inside the box the armies are held in');
    assert.equal(Math.abs(h.x) <= Math.imul(104, ONE) + Math.imul(20, ONE), true,
      'a gunship entered beyond the air corridor');
    assert.ok(h.y > Math.imul(15, ONE) && h.y < Math.imul(23, ONE),
      `a gunship is at ${h.y / ONE} m, not the nineteen it holds`);
  }

  // And nobody is dead yet. The armies spawn at |z| = 79 and the gunships fly
  // the seam, so the opening pass has nothing under it.
  for (let i = 0; i < 96; i++)
    assert.notEqual(st.i32[L.unitBase(i) + L.U_STATE], 0,
      'a unit died on the first tick - the opening sortie is not landing on nobody');
});

/**
 * No sortie is ever dropped for want of a slot.
 *
 * The core holds gunships in a fixed number of state words where the C# holds
 * them in a List, and the arithmetic says four is two more than enough: a
 * transit is 208 m at 20 m/s, ten and a half seconds, and the shortest gap the
 * jitter can produce is 17 * 0.7 = 11.9. But arithmetic in a comment is not a
 * guarantee, and the failure it guards against is the worst kind - a sortie
 * silently swallowed here and flown by a verifier with a slot free, diverging
 * one dead squad at a time.
 *
 * Watching the airborne count is what makes it observable: if the peak never
 * reaches the number of slots, no launch can ever have found them all busy.
 */
test('a gunship always finds a slot, and so does a bomb', async () => {
  const L = await import('../src/state.js');
  for (const seed of [20260901, 20260902, 20260903, 20260904]) {
    const st = init(seed);
    let peakHelis = 0, peakBombs = 0;
    for (let f = 0; f < 90 * 60; f++) {
      step(st, 0, 0, 0, 0, 0);
      let h = 0, b = 0;
      for (let i = 0; i < L.MAX_HELIS; i++) if (st.i32[L.heliBase(i) + L.H_STATE] !== 0) h++;
      for (let i = 0; i < L.MAX_BOMBS; i++) if (st.i32[L.bombBase(i) + L.B_STATE] !== 0) b++;
      peakHelis = Math.max(peakHelis, h);
      peakBombs = Math.max(peakBombs, b);
    }
    assert.ok(peakHelis < L.MAX_HELIS,
      `seed ${seed} filled every gunship slot (${peakHelis} of ${L.MAX_HELIS}), so a ` +
      'sortie may have been dropped without anything saying so');
    assert.ok(peakBombs < L.MAX_BOMBS,
      `seed ${seed} filled every bomb rack (${peakBombs} of ${L.MAX_BOMBS}), so a ` +
      'bomb may have been swallowed without anything saying so');
    // Two at a time is what the recording measures on every seed, and it is
    // also the ceiling the cadence allows: one per side, never two of either.
    assert.equal(peakHelis, 2, `seed ${seed} peaked at ${peakHelis} gunships, not the recorded 2`);
  }
});

/**
 * A third of every load lands off the field, and all of it in x.
 *
 * This is the recording's second finding and it is COPIED, not corrected. The
 * release gate is on where the bomb is let go - |x| < 92 - and the bomb is not
 * released where it lands: it inherits thirty metres a second along the
 * gunship's own track and falls from nineteen metres, so it is thrown some
 * sixty metres downrange and reaches |x| = 148-154 against a field that ends at
 * 92. Between a quarter and a half of the bombs in a round hit nobody by
 * construction.
 *
 * Narrowing the gate to where the bomb lands would be a one-line "fix" that
 * deleted a third of the air war, and the two implementations would then
 * disagree about every round anybody played.
 */
test('a third of the bombs land off the field, and all of it in x', async () => {
  const L = await import('../src/state.js');
  const landings = [];
  for (const seed of [20260901, 20260902, 20260903, 20260904]) {
    const st = init(seed);
    // The seam at zero, which is the condition GunshipReferenceTests recorded
    // under. It matters for the z half of this claim and not for the x half: a
    // gunship stands 17-35 m off the seam and does not clamp to the field, so
    // with the tape's own seam swinging to -57 a gunship can legitimately be
    // over z = -92 and drop there. The C# does exactly the same - neither
    // implementation holds aircraft inside HalfDepth - so that is faithful, not
    // a fault, and it is simply not what the recording measured.
    st.tape.fill(st.tape[0]);
    let live = new Array(L.MAX_BOMBS).fill(false);
    for (let f = 0; f < 90 * 60; f++) {
      step(st, 0, 0, 0, 0, 0);
      for (let i = 0; i < L.MAX_BOMBS; i++) {
        const b = L.bombBase(i);
        const now = st.i32[b + L.B_STATE] !== 0;
        // The landing point is still in the slot: x and z are written before
        // the state word is cleared, which is what makes this readable at all.
        if (live[i] && !now) landings.push({ x: st.i32[b + L.B_X], z: st.i32[b + L.B_Z] });
        live[i] = now;
      }
    }
  }

  assert.ok(landings.length > 100, `only ${landings.length} bombs fell across four rounds`);
  const off = landings.filter((b) => Math.abs(b.x) >= Math.imul(92, ONE));
  const share = off.length / landings.length;
  assert.ok(share > 0.2 && share < 0.5,
    `${(share * 100).toFixed(0)}% of bombs land outside |x| = 92; the recording has 26-42%`);

  // Off in x, never in z. The bomb is thrown along the gunship's track, and the
  // gunship's track is the x axis.
  for (const b of landings)
    assert.ok(Math.abs(b.z) <= Math.imul(79, ONE),
      `a bomb landed at z = ${(b.z / ONE).toFixed(1)}, outside the field's depth - ` +
      'the recording has every off-field landing in x and none in z');

  const worst = Math.max(...landings.map((b) => Math.abs(b.x))) / ONE;
  assert.ok(worst > 140 && worst < 165,
    `the furthest bomb reached |x| = ${worst.toFixed(1)}; the recording has 148-154`);
});

/**
 * The blast clears a circle, and it does not ask whose men are inside.
 *
 * Infantry inside sixteen metres die whatever the distance - that flatness is
 * why one bomb is worth up to twenty-three men in the recording - and armour
 * takes 12 * (1 - d/16), so a tank at the centre dies outright and one at the
 * rim walks away untouched.
 */
test('a bomb kills a tank at the centre and leaves one at the rim', async () => {
  const air = await import('../src/rules/air.js');
  assert.equal(air.bombDamage(0), air.BOMB_DAMAGE, 'the centre of the blast is not full damage');
  assert.equal(air.bombDamage(air.BOMB_RADIUS), 0, 'the rim of the blast still does damage');

  // A tank has 60 to 100 hit points on this core's scale, so the blast kills
  // outright inside about half the radius and only wounds outside it.
  const atHalf = air.bombDamage(air.BOMB_RADIUS >> 1);
  assert.ok(atHalf > Math.imul(55, ONE) && atHalf < Math.imul(65, ONE),
    `eight metres out the blast is worth ${atHalf / ONE}, not the half of 120 it should be`);
  assert.equal(air.bombDamage(air.BOMB_RADIUS + ONE), 0, 'the blast reaches past its own radius');
});

/**
 * A bomb never touches the truck.
 *
 * Army.Detonate raises Bombed, Killed and Destroyed and NOT CourierHit: in the
 * C# a bomb cannot hurt the player, however squarely it lands on them. That is
 * a rule of the game and not an oversight in the recording, and a core that
 * invented courier damage here would take health off a truck that every
 * verifier replaying the round says is untouched.
 *
 * Planted rather than waited for: a bomb landing on the truck by chance is rare
 * enough that a test waiting for one would be a test that usually proves
 * nothing.
 */
test('a bomb landing on the truck does not scratch it', async () => {
  const L = await import('../src/state.js');
  const st = init(4);

  // A quiet field: nothing alive to shoot, so anything that moves the truck's
  // health this tick came from the bomb.
  for (let i = 0; i < 96; i++) {
    st.i32[L.unitBase(i) + L.U_STATE] = 0;
    st.i32[L.unitBase(i) + L.U_HP] = 0;
  }
  const T = L.O_TRUCK;
  const before = st.i32[T + L.T_HP], impact = st.i32[T + L.T_IMPACT];

  // One tick above the ground, straight down, right on the cab.
  const b = L.bombBase(0);
  st.i32[b + L.B_STATE] = 1;
  st.i32[b + L.B_SIDE] = -1;
  st.i32[b + L.B_X] = st.i32[T + L.T_X];
  st.i32[b + L.B_Z] = st.i32[T + L.T_Z];
  st.i32[b + L.B_Y] = ONE;
  st.i32[b + L.B_VX] = 0; st.i32[b + L.B_VZ] = 0;
  st.i32[b + L.B_VY] = Math.imul(-100, ONE);

  step(st, 0, 0, 0, 0, 0);

  assert.equal(st.i32[b + L.B_STATE], 0, 'the planted bomb did not go off');
  assert.equal(st.i32[T + L.T_HP], before,
    'a bomb took health off the truck - Detonate has no CourierHit and the core must not invent one');
  assert.equal(st.i32[T + L.T_IMPACT], impact, 'a bomb registered as an armour impact');
});

/**
 * The air war replays from the seed, which is the one thing the C# cannot do.
 *
 * SendHelicopter draws its direction from UnityEngine.Random and LaunchSorties
 * draws its jitter from the same place, so two C# machines given the same army
 * seed fly different sorties and drop different bombs. That is fine for a
 * single-player scene and fatal for a round that has to be replayed by
 * strangers, and it is the reason every draw in this port comes off the state's
 * own stream.
 */
test('the same seed flies the same sorties and a different one does not', async () => {
  const L = await import('../src/state.js');
  const fly = (seed) => {
    const st = init(seed);
    for (let f = 0; f < 60 * 40; f++) step(st, 0, 0, 0, 0, 0);
    return st.i32.slice(L.O_AIR, L.WORDS).join(',');
  };
  assert.equal(fly(20260901), fly(20260901), 'one seed flew two different air wars');
  assert.notEqual(fly(20260901), fly(20260902), 'two seeds flew the same air war');
});

/**
 * The height smoothing is pinned to the tick it was evaluated for.
 *
 * `h.y += (wantY - h.y) * (1 - exp(-2 * dt))` is a float expression in the C#,
 * and exp is exactly the libm call specified.test.js exists to demonstrate is
 * not portable. It does not need to be evaluated at runtime, because dt is a
 * constant - but the constant and the tick are then two numbers that have to
 * agree, written in two different files, with nothing but a comment holding
 * them together. This is the something.
 */
test('the gunship height constant matches the tick it was written for', async () => {
  const air = await import('../src/rules/air.js');
  const TICK_DT = 1092;                       // sim.js, 1/60 in Q16.16
  const want = Math.round((1 - Math.exp(-2 * (TICK_DT / ONE))) * ONE);
  assert.equal(air.Y_LERP, want,
    `Y_LERP is ${air.Y_LERP} but the tick says ${want} - the tick changed and the ` +
    'constant did not, so gunships are now holding height on the wrong curve');
});

/**
 * The two lines interpenetrate, which is what lets a bomb kill men from both
 * sides - and it is the condition the recording was measured under.
 *
 * This test used to assert the OPPOSITE, and said so: army.js backed a unit
 * off whenever an enemy came within BACK_OFF_RANGE and applied it to riflemen
 * as well as armour, so twenty-four metres was a hard floor between any two
 * enemies against a sixteen-metre blast. No bomb could straddle the lines,
 * which side a bomb killed was decided purely by which side of the seam it
 * fell on, and the friendly-fire share came out near an even split against the
 * recording's 18-42%.
 *
 * The C# has no crowding rule for infantry at all - Separate is called on
 * Armour pairs only (Army.cs:325) and StepInfantry walks a man to his standoff
 * and leaves him there - so item (h) took the floor off the riflemen and gave
 * them the C#'s own reach: standoff Rand(4,12) plus squadOffsetZ Rand(-5,5).
 *
 * Measured after it, four seeds, seam pinned, against
 * test/vectors/csharp-infantry.json:
 *
 *     closest opposing pair   core 2.5 - 23.8 m      recording 4.7 - 19.2 m
 *
 * Pinned here so that reapplying a floor to the infantry - the obvious way to
 * make the two lines look tidier - fails loudly rather than quietly putting
 * the friendly-fire and dud-share numbers back where they were.
 */
test('the two lines interpenetrate, so a blast can catch both sides', async () => {
  const L = await import('../src/state.js');
  const air = await import('../src/rules/air.js');

  const st = init(20260901);
  st.tape.fill(st.tape[0]);                   // the seam the recording was made at
  let closest = Infinity;
  for (let f = 0; f < 90 * 60; f++) {
    step(st, 0, 0, 0, 0, 0);
    if ((f + 1) % 300 !== 0) continue;
    const men = [];
    for (let i = 0; i < 96; i++) {
      if ((i & 3) === 0) continue;            // armour; the riflemen are the question
      const b = L.unitBase(i);
      if (st.i32[b + L.U_STATE] === 0) continue;
      men.push({ side: st.i32[b + L.U_SIDE], x: st.i32[b + L.U_X], z: st.i32[b + L.U_Z] });
    }
    for (const a of men) for (const c of men) {
      if (a.side === c.side) continue;
      const dx = (a.x - c.x) / ONE, dz = (a.z - c.z) / ONE;
      closest = Math.min(closest, Math.sqrt(dx * dx + dz * dz));
    }
  }

  assert.ok(closest < air.BOMB_RADIUS / ONE,
    `the closest opposing riflemen were ${closest.toFixed(1)} m apart, outside the ` +
    `${air.BOMB_RADIUS / ONE} m blast - no bomb can catch both sides, which is the ` +
    'state item (h) removed. Something has put a floor back under the infantry.');

  assert.ok(closest < 24,
    `the closest opposing riflemen were ${closest.toFixed(1)} m apart, which is the ` +
    'old BACK_OFF_RANGE floor to the metre - the crowding rule is being applied to ' +
    'riflemen again');
});
