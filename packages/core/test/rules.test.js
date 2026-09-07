// The rules from section 18A, as tests rather than as prose.
//
// These are written against the CLAIM, not the implementation: a refactor that
// quietly makes the score additive, or lets a parked truck earn, leaves every
// line looking reasonable and fails here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { init, step, restart, runScore, setGround, setSolids, groundAt, setHeat, heatOf, HALF_X } from '../src/sim.js';
// Offsets are IMPORTED, never typed. They were typed in nine places in this
// file, and when the truck block grew its thirteenth word every one of them
// had to be found - which is the same drift that let `T_IMPACT` and
// `S_EXPOSURE` share word 17 in the first place.
import {
  hash, WORDS, O_AIR, AIR_BULL, AIR_BEAR, S_PRACTICE as L_S_PRACTICE,
  O_TRUCK, T_X, T_Z, T_HP, O_SCORE, S_EXPOSURE, S_ELAPSED, S_BESTX, S_STATE,
  O_UNITS, U_WORDS, U_X, U_Z, U_HP, U_STATE, T_VX, T_VZ,
} from '../src/state.js';
import * as scoring from '../src/rules/score.js';
import * as army from '../src/rules/army.js';
import * as layout from '../src/state.js';
import * as gate from '../src/rules/gate.js';

const ONE = 65536;

/**
 * Empties the battlefield.
 *
 * The driving references were recorded with Unity's Battlefield switched off,
 * so the core has to be measured on the same empty map - otherwise the test is
 * comparing a clear run against one that drove into a tank.
 */
/**
 * Empties the battlefield - and it does NOT stay empty on its own.
 *
 * `reinforce` sees a deficit the moment this runs and refills the slots within
 * seconds. That was harmless while nothing in the core was solid; now that the
 * truck is pushed out of the core's own armour, a fixture about the vehicle or
 * the score gets shoved by tanks that walked back in. So the fixtures that are
 * not about the army hold it clear every tick with `stepAlone` rather than
 * clearing it once and hoping.
 */
function clearTheField(st) {
  const UNITS = 96;
  for (let i = 0; i < UNITS; i++) {
    // HP AS WELL AS STATE, and that is not tidiness. The core is of two minds
    // about what "alive" means: `reinforce`, `fillArmour` and the crowding
    // scan skip on `U_STATE`, but `stepUnit` returns early on `u.hp <= 0` and
    // the firing code guards on `hp > 0`. Zeroing only the state left every
    // unit walking and shooting - so a fixture that said "empty battlefield"
    // was measuring a truck under fire, and the vehicle fixtures below were
    // quietly comparing a damaged truck against the PhysX recording.
    st.i32[O_UNITS + i * U_WORDS + U_HP] = 0;
    st.i32[O_UNITS + i * U_WORDS + U_STATE] = 0;
  }
}


/** One tick on an empty battlefield. See `clearTheField` for why every tick. */
const stepAlone = (st, throttle, steer, brake) => {
  clearTheField(st);
  step(st, throttle, steer, brake | 0, 0, 0);
};

const driveAlone = (st, ticks, throttle, steer) => {
  for (let t = 0; t < ticks; t++) stepAlone(st, throttle, steer, 0);
  return st;
};

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
  // On an empty field: this is a test of the SCORING rule, and a truck parked
  // in a live battlefield is shoved around by armour that is solid now, so the
  // fixture could no longer come to rest at all.
  driveAlone(st, 400, ONE, 0);                  // get clear of the apron

  // Brake to a STOP before measuring. A truck rolling to a halt is still
  // gaining ground and is supposed to be paid for it - measuring from the
  // moment the brake goes on measures the coast, not the standing still.
  for (let t = 0; t < 900; t++) stepAlone(st, 0, 0, ONE);
  const settled = st.i32[O_TRUCK + T_X];
  const before = st.i32[O_SCORE + S_EXPOSURE];

  for (let t = 0; t < 600; t++) stepAlone(st, 0, 0, ONE);
  assert.equal(st.i32[O_TRUCK + T_X], settled, 'the fixture never came to rest');
  assert.equal(st.i32[O_SCORE + S_EXPOSURE], before,
    'a parked truck accrued exposure');
});

test('a lap earns nothing - exposure is ground made good, not time', () => {
  const st = init(12);
  // Full condition throughout, and the army deliberately NOT cleared: this
  // fixture is about the scoring rule, which needs a live army for there to
  // be any danger to accrue, and an empty field would leave it asserting that
  // zero equals zero. What it must not have is the DRIVING changing under it -
  // a hurt truck loses up to 45% of its throttle and takes a steering pull,
  // and in reverse that ran the fixture past its own 6000 tick guard without
  // ever reaching the mark it drives back to.
  const T_HP_ = 6;
  const healthy = (ticks, throttle, brake) => {
    for (let t = 0; t < ticks; t++) {
      st.i32[O_TRUCK + T_HP_] = ONE * 100;
      step(st, throttle, 0, brake | 0, 0, 0);
    }
  };
  healthy(600, ONE, 0);

  // Come to rest BEFORE taking the reading. A truck rolling to a halt covers
  // new ground and is paid for it, so a mark taken at the moment the brake
  // goes on is seven metres short of where the run actually reached - and the
  // test then blames the lap for exposure the coast had earned.
  healthy(900, 0, ONE);
  const mark = st.i32[O_SCORE + S_BESTX];
  const after = st.i32[O_SCORE + S_EXPOSURE];

  // Back up thirty metres, driven by POSITION rather than a tick count: at
  // fifteen metres a second, five seconds of reverse thrust only cancels the
  // forward motion, which is correct physics and a useless fixture.
  const target = mark - ONE * 30;
  let guard = 0;
  while (st.i32[O_TRUCK + T_X] > target && guard++ < 6000) healthy(1, -ONE, 0);
  assert.ok(guard < 6000, 'the truck never reversed');

  // forward again, but stopping short of the mark
  guard = 0;
  while (st.i32[O_TRUCK + T_X] < mark - ONE * 4 && guard++ < 4000) healthy(1, ONE, 0);
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

  // Scales its inputs to Q16.16, unlike the file-level `drive` - and holds the
  // field clear every tick, because this fixture is the VEHICLE against the
  // PhysX recording and the core's armour is solid now.
  const drive = (s, n, th, st) => {
    for (let i = 0; i < n; i++) {
      clearTheField(s);
      step(s, Math.round(th * Q), Math.round(st * Q), 0, 0, 0);
    }
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
    clearTheField(st);
    assert.ok(setGround(st, COLS, ROWS, heights), 'the relief was refused');
    st.i32[O + T_X] = Math.round(ref.startX * Q);
    st.i32[O + T_Z] = Math.round(ref.lane * Q);

    const out = [];
    for (let k = 0; k < 60 * 22; k++) {
      stepAlone(st, Q, 0, 0);
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
/**
 * Under the wheels, and only above a walking pace.
 *
 * `Army.RunOver` takes a radius of 3.6 m and a `minSpeed` of 2.5 m/s: a truck
 * edging forward must not mow down a line it is merely touching, and a parked
 * one must not clear a space around itself.
 *
 * A UNIT TEST AND NOT A DRIVE, deliberately. Driven routes could not make this
 * rule fire at all: chasing the nearest man turns the truck until it scrubs its
 * speed away (757 ticks with a man inside 3.6 m, not one of them above
 * 2.5 m/s), and ploughing at the infantry centroid holds 17.89 m/s but is
 * stopped by armour before it reaches anybody (98 ticks inside 3.6 m, again
 * none above the threshold, closest 2.48 m at 0.02 m/s). That is a real
 * finding about the world and it is written up in PRIORITIES; it is not a
 * reason to loosen either number until a route happens to produce a kill.
 */
/**
 * Incoming fire costs condition, and enough of it writes the truck off.
 *
 * These two came out of PlayMode, where they hurt the truck by calling
 * `Field.Army.CourierHit.Invoke(...)` - the C# damage line, which is being
 * cut. The claim is not a Unity claim: damage is an outcome and outcomes come
 * from the core, so the assertion belongs where `T_HP` lives. Same setup the
 * measurements use: the truck parked on the seam at (0, 0) where the fighting
 * is, and the air held off so the only thing hurting it is the army's own
 * courier fire.
 *
 * The air is pinned by writing the SORTIE CLOCKS, which are state words at
 * `O_AIR`, and not by setting a property on `st` - a helper that did the
 * latter held nothing off at all and every row it captioned "air off" was
 * measured with bombs falling.
 */
const parkedUnderFire = (seed, ticks) => {
  const Q = 65536, O = 5, T_X = 0, T_Z = 1, T_HP = 6;
  const st = init(seed);
  const hold = () => {
    st.i32[O_AIR + AIR_BULL] = 1 << 30;
    st.i32[O_AIR + AIR_BEAR] = 1 << 30;
    st.i32[O + T_X] = 0;
    st.i32[O + T_Z] = 0;
  };
  hold();
  for (let t = 0; t < ticks; t++) { step(st, 0, 0, 0, 0, 0); hold(); }
  return { hp: st.i32[O + T_HP] / Q, state: st.i32[O_SCORE + S_STATE] };
};

test('incoming fire costs the truck condition', () => {
  for (const seed of [20260901, 20268820, 20276739]) {
    // Ten seconds: long enough for the army to reach it, short enough that
    // none of the three has spent all hundred points yet - the corrected
    // death times are 34.3 / 17.5 / 19.8 s.
    const r = parkedUnderFire(seed, 60 * 10);
    assert.ok(r.hp < 100, `seed ${seed}: der Truck steht nach 10 s unbeschaedigt da`);
    assert.ok(r.hp > 0, `seed ${seed}: nach 10 s schon zerstoert - hp ${r.hp.toFixed(2)}`);
  }
});

test('enough fire writes the truck off', () => {
  for (const seed of [20260901, 20268820, 20276739]) {
    const r = parkedUnderFire(seed, 60 * 90);
    assert.equal(r.hp, 0, `seed ${seed}: haelt neunzig Sekunden Beschuss aus`);
    assert.equal(r.state, gate.RUN_WRECKED,
      `seed ${seed}: hp ist 0, aber der Lauf steht auf ${r.state} statt RUN_WRECKED`);
  }
});

/**
 * A crash costs condition, and a hard one writes the truck off.
 *
 * `TruckHealth` held this and the client is not allowed to: `rammed >=
 * crashSpeed` wrote it off, otherwise `Damage(rammed * 6f)`, and `Damage`
 * divided by the armour. The quantity is a speed - `TakeImpact` is
 * `T_IMPACT / ONE`, set in `resolveArmour` from the truck's velocity along
 * the contact normal - so the six is points per metre per second.
 *
 * Driven into a pinned tank rather than poked at, because the impact word is
 * only written when the collision actually resolves.
 */
test('crashing into armour costs condition, and hard enough writes it off', () => {
  const Q = 65536, O = 5, T_X = 0, T_Z = 1, T_HP = 6;

  const driveInto = (ticks, throttle) => {
    const st = init(1);
    st.i32[O + T_X] = 0;
    st.i32[O + T_Z] = 0;
    const at = Math.round(14 * Q);
    for (let t = 0; t < ticks; t++) {
      clearTheField(st);
      const b = O_UNITS + 0 * U_WORDS;          // slot 0 is armour
      st.i32[b + U_X] = at;
      st.i32[b + U_Z] = st.i32[O + T_Z];
      st.i32[b + U_HP] = Math.round(60 * Q);
      st.i32[b + U_STATE] = 1;
      step(st, throttle, 0, 0, 0, 0);
    }
    return { hp: st.i32[O + T_HP] / Q, state: st.i32[O_SCORE + S_STATE] };
  };

  const hard = driveInto(180, Q);
  assert.equal(hard.hp, 0, `voll in den Panzer gefahren und noch ${hard.hp.toFixed(1)} Punkte`);
  assert.equal(hard.state, gate.RUN_WRECKED, 'hart aufgefahren, aber der Lauf laeuft weiter');

  // Nothing to hit: the same drive with no tank must cost nothing at all, or
  // the test above is measuring the road rather than the crash.
  const st = init(1);
  st.i32[O + T_X] = 0; st.i32[O + T_Z] = 0;
  for (let t = 0; t < 180; t++) { clearTheField(st); step(st, Q, 0, 0, 0, 0); }
  assert.equal(st.i32[O + T_HP] / Q, 100, 'der Truck verliert Punkte ohne etwas zu treffen');
});

test('a truck at speed rides a rifleman down, and a crawling one does not', () => {
  const Q = 65536, O = 5, T_X = 0, T_Z = 1, T_VX = 3, T_VZ = 4;

  // Slot 1 is a rifleman: `isArmour(i)` is `(i & 3) === 0`.
  const run = (vx) => {
    const st = init(1);
    clearTheField(st);
    // BOTH INSIDE THE ARMY'S OWN FIELD. The truck starts in the bay at
    // x = -100.4, and a unit is clamped to |x| < FrontX - 4 = 88 on its first
    // tick - so a man placed beside the truck there is snapped 12 m away
    // before the rule ever looks at him. That is what made the first version
    // of this test report a survivor.
    st.i32[O + T_X] = 0;
    st.i32[O + T_Z] = 0;
    const b = O_UNITS + 1 * U_WORDS;
    st.i32[b + U_X] = st.i32[O + T_X] + Math.round(1.0 * Q);
    st.i32[b + U_Z] = st.i32[O + T_Z];
    st.i32[b + U_HP] = Q;
    st.i32[b + U_STATE] = 1;
    // The velocity the rule reads is the truck's own, not a wheel reading.
    st.i32[O + T_VX] = Math.round(vx * Q);
    st.i32[O + T_VZ] = 0;
    step(st, 0, 0, 0, 0, 0);
    return st.i32[b + U_STATE];
  };

  assert.equal(run(12), 0, 'ein Mann unter den Raedern bei 12 m/s steht noch');
  assert.equal(run(-12), 0, 'rueckwaerts ueberfaehrt niemanden - die Regel liest einen Betrag');
  assert.equal(run(2.4), 1, 'bei 2.4 m/s wurde jemand ueberfahren');
  assert.equal(run(0), 1, 'der stehende Truck raeumt sich Platz');
});

test('armour blocks the truck and infantry does not', () => {
  const Q = 65536, O = 5, T_X = 0, T_Z = 1, T_SPEED = 9;

  // A real unit of the core's own, not a list handed in from outside.
  //
  // This used to place its tank with `setArmour`, which no longer exists: the
  // solid armour is built inside `step()` from the core's units now, so a test
  // that wants a tank in the road puts a TANK in the road. That is also what
  // finally lets the infantry half of this test be a real case instead of an
  // assumption - it used to say "infantry is never uploaded, so an empty
  // armour list IS the infantry case", which asserted nothing about infantry.
  //
  // Slot 0 is armour and slot 1 is a rifleman: `isArmour(i)` is `(i & 3) === 0`.
  const place = (st, slot, atX) => {
    const b = O_UNITS + slot * U_WORDS;
    st.i32[b + U_X] = atX;
    st.i32[b + U_Z] = st.i32[O + T_Z];
    st.i32[b + U_STATE] = 1;
    st.i32[b + U_HP] = Math.round(60 * Q);
  };

  // Pinned every tick, because the obstacle is the point. Placed once, a core
  // unit walks off to its holding line within a second and the fixture stops
  // being about a truck meeting a tank. The old version of this test got a
  // standing obstacle for free by handing a position list in from outside;
  // that route is gone, so the fixture has to say plainly that it wants the
  // tank to stay where it was put.
  const run = (slot) => {
    const st = init(1);
    const at = st.i32[O + T_X] + Math.round(30 * Q);
    for (let i = 0; i < 600; i++) {
      clearTheField(st);
      if (slot >= 0) place(st, slot, at);
      step(st, Q, 0, 0, 0, 0);
    }
    return { x: st.i32[O + T_X] / Q, v: st.i32[O + T_SPEED] / Q };
  };

  const clear = run(-1);
  const tank = run(0);
  const man = run(1);

  assert.ok(tank.x < clear.x - 50,
    `der Panzer hat den Truck nicht aufgehalten - er kam bis ${tank.x.toFixed(1)}`);
  assert.ok(tank.v < 1,
    `der Truck drueckt mit ${tank.v.toFixed(2)} m/s weiter in den Panzer`);

  // The stopping distance is the two radii plus the nose: about 6.3 m.
  const gap = 30 + (init(1).i32[O + T_X] / Q) - tank.x;
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

  const Q = 65536, UNITS = 96;
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

  const UNITS = 96, RANGE = 46;
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
/**
 * Nothing but the truck's condition reads the practice flag.
 *
 * This used to drive two runs and demand the army match WORD FOR WORD. That
 * held while practice could only change hit points and nothing read them - and
 * it stopped holding the moment condition reached the driving, because a
 * shielded truck keeps its throttle, drives somewhere else, and then clears
 * and rides down different men. Measured: 429 army words and all four RNG
 * words differ over sixty seconds. The army is diverging through the truck's
 * POSITION, which is the game's own behaviour and not a leak of the flag.
 *
 * So the claim is stated as what it was always defending: the flag is read in
 * exactly one place. Both runs are given a truck pinned to the same spot with
 * the same hit points, so neither position nor condition can carry a
 * difference, and then EVERY word of the state must agree except `S_PRACTICE`
 * itself. A rule that branched on the flag anywhere - in the army, the air,
 * the score - would show up here.
 */
/**
 * No two blocks share a word.
 *
 * They did. `O_TRUCK` was declared as twelve words while its fields ran 0..12,
 * so `O_TRUCK + T_IMPACT` and `O_SCORE + S_EXPOSURE` were both word 17 and a
 * contact hard enough to beat the exposure so far overwrote the run's score
 * with a collision speed. Nothing caught it because the offsets were typed
 * rather than derived, and the fields and the size could disagree in silence.
 *
 * This walks the blocks the offsets actually declare and asserts each field
 * lands inside its own.
 */
test('no two blocks share a word', async () => {
  const L = await import('../src/state.js');
  const blocks = [
    ['tick', L.O_TICK, 1],
    ['rng', L.O_RNG, L.RNG_WORDS],
    ['truck', L.O_TRUCK, L.TRUCK_WORDS],
    ['score', L.O_SCORE, L.SCORE_WORDS],
  ];
  for (let i = 1; i < blocks.length; i++) {
    const [pn, po, pw] = blocks[i - 1], [n, o] = blocks[i];
    assert.ok(po + pw <= o, `${pn} runs to word ${po + pw - 1} and ${n} starts at ${o}`);
  }

  const widest = (prefix, block, size) => {
    let top = -1, name = '';
    for (const [k, v] of Object.entries(L))
      if (k.startsWith(prefix) && typeof v === 'number' && v > top) { top = v; name = k; }
    assert.ok(top < size,
      `${name} is field ${top} of a ${size}-word ${block} block`);
  };
  widest('T_', 'truck', L.TRUCK_WORDS);
  widest('S_', 'score', L.SCORE_WORDS);
});

test('nothing but the truck reads the practice flag', async () => {
  const { WORDS, O_SCORE, S_PRACTICE, O_TRUCK, T_X, T_Z, T_VX, T_VZ, T_HP } =
    await import('../src/state.js');

  const drive = (practice) => {
    const st = init(1);
    const pin = () => {
      st.i32[O_TRUCK + T_X] = 0;
      st.i32[O_TRUCK + T_Z] = 0;
      st.i32[O_TRUCK + T_VX] = 0;
      st.i32[O_TRUCK + T_VZ] = 0;
      st.i32[O_TRUCK + T_HP] = ONE * 100;
    };
    pin();
    for (let i = 0; i < 3600; i++) { step(st, ONE, 0, 0, 0, practice); pin(); }
    return st;
  };
  const live = drive(0), shielded = drive(1);

  const differ = [];
  for (let w = 0; w < WORDS; w++)
    if (live.i32[w] !== shielded.i32[w]) differ.push(w);

  assert.deepEqual(differ, [O_SCORE + S_PRACTICE],
    `words ${differ.join(', ')} differ between a live and a practice run - ` +
    'only the practice word itself may, or something is reading the flag');
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

test('a second round starts where the first one did', () => {
  const SEED = 0x5eed1234;              // CoreDrivenTruck.seed, the browser's own

  // A round is played out: the truck drives, men die, danger accrues, the
  // replacement and sortie clocks run.
  const a = init(SEED);
  const relief = new Int32Array(33 * 33).fill(Math.imul(3, ONE));
  setGround(a, 33, 33, relief);
  const solids = new Int32Array([0, 0, 4 * ONE, 4 * ONE, 0, 6 * ONE]);
  setSolids(a, 1, solids);
  for (let f = 0; f < 900; f++) step(a, ONE, 0, 0, 0, 0);
  assert.ok(a.i32[O_SCORE + S_EXPOSURE] > 0, 'the fixture never got into danger');

  const b = restart(a, SEED);
  const fresh = init(SEED);

  // EVERY word, not the six a reader would think to check. The browser dump
  // that found this listed twelve differences and the twelfth was a sortie
  // clock nobody would have named in advance.
  for (let w = 0; w < WORDS; w++) {
    assert.equal(b.i32[w], fresh.i32[w],
      `word ${w} carries the old round: ${b.i32[w]} instead of ${fresh.i32[w]}`);
  }
  assert.equal(hash(b), hash(fresh), 'a restarted round does not hash as a fresh one');

  // The world the host uploaded is round setup, not round state, and survives.
  // Dropping it would put the truck on a flat table for as long as it took
  // Unity to notice and send the relief again.
  assert.equal(groundAt(b, 0, 0), groundAt(a, 0, 0),
    'the restart threw away the relief the host had uploaded');
  assert.equal(b.solids.n, 1, 'the restart threw away the solids the host had uploaded');

  // And the point of all of it: the same inputs after a restart produce the
  // same round, tick for tick, as they did the first time.
  const first = init(SEED);
  setGround(first, 33, 33, relief);
  setSolids(first, 1, solids);
  const second = restart(a, SEED);
  for (let f = 0; f < 300; f++) {
    step(first, ONE, ONE >> 2, 0, 0, 0);
    step(second, ONE, ONE >> 2, 0, 0, 0);
  }
  assert.equal(hash(second), hash(first),
    'the second round diverges from the first on identical inputs');
});

test('practice shields the truck in the core, not in the client', () => {
  // What `TruckHealth.IsInvulnerable` used to guarantee, asserted where the
  // guarantee actually lives. C# read that flag a second time, AFTER the core
  // had already decided, and refused a write-off the core had made: the same
  // injection in a browser showed WASTED on the road and an intact truck on
  // the apron. The veto is gone, so what stands behind it is stated here.
  //
  // Practice holds on every seed. The apron does NOT, and this test does not
  // pretend otherwise - see the note in PRIORITIES: parked in the bay with
  // live fire, seed 13572468 starts losing condition at tick 812 and ends
  // thirty seconds at 96.2. That is a core gap and it is now reachable,
  // which is a reason to close it in the core, not to keep a second gate in
  // C# that hid it.
  for (const seed of [0x5eed1234, 0xabcdef01, 0x13572468]) {
    const shielded = init(seed);
    for (let f = 0; f < 1800; f++) step(shielded, ONE, 0, 0, 0, 1);
    assert.equal(shielded.i32[O_TRUCK + T_HP], Math.imul(100, ONE),
      `seed ${seed.toString(16)}: practice did not shield the truck in the core`);
    assert.equal(shielded.i32[O_SCORE + L_S_PRACTICE], 1,
      `seed ${seed.toString(16)}: the practice flag was not recorded in the hashed state`);
  }
});

// ---------------------------------------------------------------------------
// A HUNTED LOAD IS SHOT AT HARDER. M1.a13.
//
// The retired C# army carried this rule, documented as the whole point of
// choosing freight - "without this the freight choice had no consequence at
// all" - on a field nothing that shipped ever assigned. So a fat load was
// hunted exactly as hard as an empty one, in every build, for the life of the
// game. The rule is the core's now and this is what pins it.
//
// Parked on purpose. A driven truck confounds the measurement with where it
// went; standing still, the only thing that changes between these runs is
// what is on the bed.
// ---------------------------------------------------------------------------

/** Seconds a parked truck lasts at a given heat, and what hit it. */
function survives(heatQ, z) {
  const st = init(0x5eed1234);
  const s = st.i32;
  setHeat(st, heatQ);
  let ticks = 0;
  for (let t = 0; t < 90 * 60; t++) {
    if (s[O_SCORE + S_STATE] !== 0) break;
    s[O_TRUCK + T_X] = 0;
    s[O_TRUCK + T_Z] = Math.round(z * ONE);
    s[O_TRUCK + T_VX] = 0;
    s[O_TRUCK + T_VZ] = 0;
    step(st, 0, 0, 0, 0, 0);
    ticks++;
  }
  return ticks / 60;
}

test('a hunted load is written off sooner than an empty one', () => {
  const cold = survives(0, -25);
  const hot = survives(65536, -25);
  assert.ok(hot < cold * 0.8,
    `heat has to cost something: empty lasted ${cold.toFixed(2)} s and a full `
    + `load ${hot.toFixed(2)} s`);
});

test('and it tells further and further behind the line', () => {
  // The reach is where heat does most of its work, so the gap has to WIDEN
  // with distance: at the seam a tank is already in range of everything.
  const near = survives(0, -25) / survives(65536, -25);
  const far = survives(0, -50) / survives(65536, -50);
  assert.ok(far > near,
    `heat should matter more at fifty metres than at twenty-five: `
    + `${far.toFixed(2)}x against ${near.toFixed(2)}x`);
});

test('an untold core hunts exactly as the recordings do', () => {
  // Zero is the default and the recordings were taken at it, so a core nobody
  // has spoken to must be bit-identical to one told zero.
  const quiet = init(0x5eed1234);
  const told = init(0x5eed1234);
  setHeat(told, 0);
  for (let t = 0; t < 600; t++) { step(quiet, 40000, 0, 0, 0, 0); step(told, 40000, 0, 0, 0, 0); }
  assert.equal(hash(quiet), hash(told));
});

test('the core clamps a heat it is handed rather than trusting it', () => {
  const st = init(1);
  setHeat(st, 4 * 65536);
  assert.equal(heatOf(st), 65536);
  setHeat(st, -9);
  assert.equal(heatOf(st), 0);
});

test('heat widens the reach the truck is noticed at, by arm', () => {
  assert.equal(army.courierReach(0, true), 34 * ONE);
  assert.equal(army.courierReach(0, false), 26 * ONE);
  // 34 x 2.4 and 26 x 1.8 - the tank's widening is the larger, as in the C#.
  //
  // THE EXACT WORD, not a rounded metre. 1.4 and 0.8 are not representable in
  // Q16.16 - 91750/65536 is 1.3999939 - so the product lands a few units under
  // the real number, and both facts are asserted: the integer the rule
  // actually produces, which any change to the factor moves, and that it is
  // within a thousandth of a metre of what the C# meant.
  assert.equal(army.courierReach(ONE, true), 5347724);
  assert.ok(Math.abs(army.courierReach(ONE, true) - 34 * 2.4 * ONE) < 66);
  assert.equal(army.courierReach(ONE, false), 3067090);
  assert.ok(Math.abs(army.courierReach(ONE, false) - 26 * 1.8 * ONE) < 66);
  assert.ok(army.courierReach(ONE / 2, true) > army.courierReach(0, true));
  assert.equal(army.courierReach(4 * ONE, true), army.courierReach(ONE, true));
});

test('heat lets the truck outrank a foe that is nearer than it', () => {
  const truck = 20 * ONE, foe = 10 * ONE;
  assert.equal(army.outranksTheFoe(truck, foe, 0), false);   // plainly farther
  assert.equal(army.outranksTheFoe(truck, foe, ONE), true);  // 10 x 3.5 = 35
  assert.equal(army.outranksTheFoe(36 * ONE, foe, ONE), false);
  // and at zero it is exactly the old strict "nearer than the foe"
  assert.equal(army.outranksTheFoe(foe, foe, 0), false);
});

test('heat multiplies the shell and the arithmetic is the C#s', () => {
  assert.equal(army.shellForHeat(10 * ONE, 0), 10 * ONE);
  // x1.6, to the word: 39322/65536 is 0.6000061, so ten points become a
  // sixteenth of a thousandth over sixteen.
  assert.equal(army.shellForHeat(10 * ONE, ONE), 1048580);
  assert.ok(Math.abs(army.shellForHeat(10 * ONE, ONE) - 16 * ONE) < 8);
  assert.ok(Math.abs(army.shellForHeat(10 * ONE, ONE / 2) - 13 * ONE) < 8);
});

// ---------------------------------------------------------------------------
// THE THREE RULES THE UNITY TESTS WERE USING A C# FORMULA TO CHECK.
//
// `RunScore.Projected` had a second scoring formula for when no core is
// answering, and in the editor no core ever is - so three PlayMode tests were
// measuring Unity's arithmetic and calling it the score. The formula is being
// deleted, so the rules move here, where the core actually runs.
//
// `scoreOf(full, REFERENCE_TICKS, 0) === 0` above already states the empty bed
// as arithmetic. What that does not say is what the PlayMode test said: that a
// score already BUILT collapses when the bed is emptied. These are the
// whole-run forms.
// ---------------------------------------------------------------------------

/** Drive east at full throttle for a while and hand back the state. */
function driven(ticks, practice = 1) {
  const st = init(0x5eed1234);
  for (let t = 0; t < ticks; t++) step(st, ONE, 0, 0, 0, practice);
  return st;
}

test('an empty bed collapses a score that was already built', () => {
  const st = driven(1200);
  const s = st.i32;
  assert.ok(s[O_SCORE + S_EXPOSURE] > 0, 'the drive built no exposure to lose');
  const before = runScore(st);
  assert.ok(before > 0, `the drive scored ${before}, so there is nothing to collapse`);

  s[O_SCORE + layout.S_CARGO] = 0;
  assert.equal(runScore(st), 0,
    `an empty bed scored ${runScore(st)} after ${before} - the factors are not `
    + 'multiplicative');
});

test('nothing accrues while the truck is still on the apron', () => {
  // DRIVING, not parked. The first cut of this held the truck still and was
  // green with the apron rule deleted - `accrue` pays only for ground made
  // good, so a stationary truck earns nothing whatever `earning` says. It
  // proved the wrong thing.
  //
  // The apron is 22 m. Measured from a standstill at full throttle: 16.8 m out
  // at tick 180 with exposure 0, and 22.3 m out at tick 210 with exposure
  // 4290. So the boundary is driven across, and both sides are asserted.
  const st = init(0x5eed1234);
  const s = st.i32;
  const x0 = s[O_TRUCK + T_X];
  for (let t = 0; t < 180; t++) step(st, ONE, 0, 0, 0, 1);

  const inside = (s[O_TRUCK + T_X] - x0) / ONE;
  assert.ok(inside > 10 && inside < 22,
    `the fixture drove ${inside.toFixed(1)} m, which is not inside the apron`);
  assert.equal(s[O_SCORE + S_EXPOSURE], 0,
    `gaining ground inside the apron banked ${s[O_SCORE + S_EXPOSURE]} of exposure`);
  assert.equal(runScore(st), 0, 'the apron paid a score');

  for (let t = 0; t < 40; t++) step(st, ONE, 0, 0, 0, 1);
  const outside = (s[O_TRUCK + T_X] - x0) / ONE;
  assert.ok(outside > 22, `the fixture never left the apron - ${outside.toFixed(1)} m`);
  assert.ok(s[O_SCORE + S_EXPOSURE] > 0,
    'past the apron the same driving still banked nothing, so this measured nothing');
});

test('a wreck banks nothing, however much the run had earned', () => {
  const st = driven(1200);
  const s = st.i32;
  const standing = runScore(st);
  assert.ok(standing > 0, 'the drive earned nothing to lose');
  assert.equal(s[O_SCORE + layout.S_DELIVERED], 0, 'a live run had already banked');

  // Written off where it stands. The outcome word turns over on the next tick
  // and `S_DELIVERED` is only ever written on an ARRIVAL.
  s[O_TRUCK + T_HP] = 0;
  step(st, 0, 0, 0, 0, 1);

  assert.equal(s[O_SCORE + S_STATE], gate.RUN_WRECKED, 'the write-off did not land');
  assert.equal(s[O_SCORE + layout.S_DELIVERED], 0,
    `a wreck banked ${s[O_SCORE + layout.S_DELIVERED] / ONE} after standing at ${standing}`);
});

test('the seam banks more than the quiet lane for the same ground made good', () => {
  // THE FOURTH RULE the deleted C# formula was carrying. It compared
  // `_score.Projected` down two routes and asserted 1.8x - a number measured
  // against Unity's own arithmetic and its own fixture, which is exactly the
  // sort of constant that must not be transplanted.
  //
  // Measured here instead, at the SAME ground made good so the comparison is
  // not confounded by distance - the first cut let each lane run for a fixed
  // number of ticks and one of them only reached x=15.5 while another reached
  // 130, which compares nothing:
  //
  //   lane z=70 (edge)  exposure 110.4  score 362
  //   lane z=45         exposure 145.9  score 479
  //   lane z=20         exposure 155.7  score 511
  //   lane z= 0 (seam)  exposure 178.9  score 587
  //
  // Monotonic, and the seam pays 1.62x the edge. The bound is 1.5x: room for
  // the map's own drift, and nowhere near enough to survive a flattened threat
  // scale, which is the failure it guards.
  const TARGET = 60 * ONE;
  const lane = (z) => {
    const st = init(0x5eed1234);
    const s = st.i32;
    let ticks = 0;
    while (s[O_TRUCK + T_X] < TARGET && ticks < 5400) {
      s[O_TRUCK + T_Z] = Math.round(z * ONE);
      s[O_TRUCK + T_VZ] = 0;
      step(st, ONE, 0, 0, 0, 1);
      ticks++;
    }
    assert.ok(s[O_TRUCK + T_X] >= TARGET, `lane z=${z} never made the ground`);
    return { exposure: s[O_SCORE + S_EXPOSURE], score: runScore(st) };
  };

  const edge = lane(70), mid = lane(45), inner = lane(20), seam = lane(0);

  assert.ok(seam.exposure > edge.exposure * 1.5,
    `the seam banked ${(seam.exposure / ONE).toFixed(1)} against the edge's `
    + `${(edge.exposure / ONE).toFixed(1)} - the quiet lane is competitive`);
  assert.ok(seam.score > edge.score * 1.5,
    `the seam scored ${seam.score} against the edge's ${edge.score}`);
  assert.ok(mid.exposure > edge.exposure && inner.exposure > mid.exposure
            && seam.exposure > inner.exposure,
    'the gradient is not monotonic across the four lanes: '
    + [edge, mid, inner, seam].map(l => (l.exposure / ONE).toFixed(1)).join(' '));
});

test('heat raises what a metre of ground is worth', () => {
  // The fifth rule the deleted C# formula carried: a hotter load earns more
  // for the same metre through the same danger. `accrue` is
  // `exposure += threat * (1 + heat) * gained`, so this is exact arithmetic
  // and gets an exact assertion rather than a ratio.
  const gained = 10 * ONE, threat = ONE / 2;          // half danger, ten metres
  const cold = scoring.accrue(0, 0, gained, threat, 0);
  const warm = scoring.accrue(0, 0, gained, threat, ONE);

  assert.equal(cold, 5 * ONE, `half danger over ten metres paid ${cold / ONE}`);
  assert.equal(warm, 10 * ONE, `at full heat the same metre paid ${warm / ONE}`);
  assert.equal(warm, cold * 2, 'full heat must double the rate, not add to it');

  // and it is a MULTIPLIER on danger, not a floor under it: no danger pays
  // nothing however hot the load.
  assert.equal(scoring.accrue(0, 0, gained, 0, ONE), 0,
    'a hot load earned something out of the fighting');
});
