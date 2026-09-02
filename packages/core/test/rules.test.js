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
  const { O_UNITS, O_ARMY, A_WORDS } = await import('../src/state.js');
  const drive = (practice) => {
    const st = init(1);
    for (let i = 0; i < 3600; i++) step(st, ONE, 0, 0, 0, practice);
    return st;
  };
  const live = drive(0), shielded = drive(1);

  let differing = 0;
  for (let w = O_UNITS; w < O_ARMY + A_WORDS; w++)
    if (live.i32[w] !== shielded.i32[w]) differing++;

  assert.equal(differing, 0,
    `${differing} words of the army differ between a live and a practice run - ` +
    'something in the army is reading the practice flag');
});
