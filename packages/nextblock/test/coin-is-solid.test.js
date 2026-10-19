// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE COIN STACKS ARE SOLID, AND THE FINISH IS STILL DRIVEABLE (2026-09-20 18:56).
//
// Photographed twice: the truck nose-deep inside a gold coin stack at the miner, the camera inside the coins.
// "The gold coin construct at the miner blocks the finish. the owner cannot drive through to DELIVERED ... the
// truck must not clip through this construct from either side. The finish line / DeliveryGate must stay fully
// driveable. Do not grow the coin box over the gate. Do not leave the coin as air."
//
// Those are three separate claims and this drives all three, from the core and never from PhysX:
//   1. the centre line still reaches the gate and still says DELIVERED
//   2. a truck driving east into a stack stops west of it
//   3. a truck driving west into the same stack stops east of it
//
// THE STACKS STAND WHERE THEY ARE DRAWN (2026-09-26 07:18: "The box is where that drawn stack stands, not where
// an old measurement put coin_stack. A truck driven into the stack stops and does not pass through it. Do not put that
// box in the driving lane"). Measured in a real Bootstrap world: x 145.6 .. 164.4, |z| 40.6 .. 59.4 - against the
// facade (x 163), outside the passage (|z| 32.8) and 30 m off the lane at z 10.2. The 2026-09-20 boxes at x 173.6 ..
// 192.4 were the model's mirror image about x 169, where nothing is drawn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { init, step, teleport } from '../src/sim.js';
import { O_TRUCK, T_X, T_Z, O_SCORE, S_STATE } from '../src/state.js';
import { RUN_DELIVERED } from '../src/rules/gate.js';
import { MINER_X, MINER_MOUTH_HALF } from '../src/rules/map.js';
import { START_X } from '../src/sim.js';
import { BODY_FRONT, BODY_REAR, BODY_RADIUS } from '../src/rules/solids.js';

const ONE = 65536, M = (q) => q / ONE;
const NORTH = 0, SOUTH = 32768;                   // heading is turns: 0 is +z, a half turn is -z
const EAST = 16384, WEST = 49152;
const COIN_W = 145.6, COIN_E = 164.4, COIN_IN = 40.6, COIN_OUT = 59.4, COIN_X = 155, COIN_Z = 50;
const PASSAGE_HALF = 32.8;

/** Full throttle from a placed pose, until it stops moving or runs out of ticks. */
function drive(st, x, z, heading, axis, ticks = 900) {
  const s = st.i32;
  teleport(st, Math.round(x * ONE), Math.round(z * ONE), heading);
  const read = () => (axis === 'x' ? M(s[O_TRUCK + T_X]) : M(s[O_TRUCK + T_Z]));
  let last = read(), stuck = 0;
  for (let t = 0; t < ticks; t++) {
    step(st, ONE, 0, 0, 0, 0);
    const now = read();
    if (Math.abs(now - last) < 0.002) { if (++stuck > 120) break; } else stuck = 0;
    last = now;
  }
  return { x: M(s[O_TRUCK + T_X]), z: M(s[O_TRUCK + T_Z]), state: s[O_SCORE + S_STATE] };
}

// WHICH FACES A PLAYER REACHES: the WEST face, driving east along |z| 50 from the open ground before the miner, and
// the face toward the passage (|z| 40.6), driving out of the finish straight toward the stack. The east face is
// against the facade and the outer face is outside the mouth; both are driven here too where a truck can stand.

test('the centre line still runs to the gate and still DELIVERS (§coin must not cover the finish)', () => {
  const st = init(1);
  const end = drive(st, M(MINER_X) - 20, 0, EAST, 'x', 2400);
  assert.equal(end.state, RUN_DELIVERED,
    `the centre line no longer delivers - it ended at x ${end.x.toFixed(2)} z ${end.z.toFixed(2)} in state ${end.state}`);
});

for (const [name, side] of [['the circled (right, z -50) stack', -1], ['the left (z +50) stack', 1]]) {
  test(`a truck driving EAST into ${name} stops west of it (§not air)`, () => {
    const st = init(1);
    const end = drive(st, 110, side * COIN_Z, EAST, 'x');
    const nose = end.x + M(BODY_FRONT) + M(BODY_RADIUS);
    assert.ok(nose <= COIN_W + 0.05, `the truck drove into the stack: its nose reached x ${nose.toFixed(2)}, the stack starts at ${COIN_W}`);
    assert.ok(nose > COIN_W - 0.6, `the truck stopped at nose x ${nose.toFixed(2)}, short of the stack's face ${COIN_W}`);
    assert.notEqual(end.state, RUN_DELIVERED);
  });
  test(`a truck driving out of the straight into ${name} stops at its face (§not air)`, () => {
    const st = init(1);
    const end = drive(st, COIN_X, side * 20, side > 0 ? NORTH : SOUTH, 'z');
    const nose = Math.abs(end.z) + M(BODY_FRONT) + M(BODY_RADIUS);
    assert.ok(nose <= COIN_IN + 0.05, `the truck drove into the stack: its nose reached |z| ${nose.toFixed(2)}, the stack starts at ${COIN_IN}`);
    assert.ok(nose > COIN_IN - 0.6, `the truck stopped at nose |z| ${nose.toFixed(2)}, short of the stack's face ${COIN_IN} - something else stands between`);
  });
}

test('the coin boxes stand out of the driving lane and the passage (§do not put that box in the driving lane)', () => {
  const st = init(1);
  const coins = [];
  for (let i = 0; i < st.solids.n; i++) {
    const [cx, cz, hx, hz] = st.solids.box.subarray(i * 6, i * 6 + 4);
    if (Math.abs(M(cx) - COIN_X) < 0.01 && Math.abs(Math.abs(M(cz)) - COIN_Z) < 0.01) coins.push([M(cx - hx), M(cx + hx), M(Math.abs(cz) - hz), M(Math.abs(cz) + hz)]);
  }
  assert.equal(coins.length, 4, 'two stacks, a plinth and a tier box each');
  for (const [x0, x1, zIn, zOut] of coins) {
    assert.ok(zIn >= COIN_IN - 1e-3 && zIn > PASSAGE_HALF, `a coin box reaches |z| ${zIn.toFixed(2)}, into the passage`);
    assert.ok(x0 >= COIN_W - 1e-3 && x1 <= COIN_E + 1e-3 && zOut <= COIN_OUT + 1e-3, 'a coin box stands outside the drawn stack');
  }
  assert.ok(COIN_IN > M(MINER_MOUTH_HALF), 'the stacks start outside the 40 m mouth');
});

// ---------------------------------------------------------------- THE MEMPOOL FACADE
//
// THE BAY MOUTHS WERE HOLES RIGHT THROUGH THE POST OFFICE (2026-09-20 18:59, photographed: the truck
// among the facade pillars). The shell was pillars BETWEEN the mouths and a lintel OVER them, so each mouth
// stood open from the ground to 9.2 m. The truck spawns at START_X -100.40, z 10.20 - bay 13's own centre - so
// driving WEST it went straight out of the back of the building and across the map to x -180.22, the west edge.
//
// The mouths are closed on the shell's own plane now, so the face a truck meets is the wall's east face at
// POST_X -114.40. That is where the yellow marks stand: every part drawn in `bumper_guard_yellow` on this
// facade, the `port_guard_post_*` at each mouth, spans x -114.95 .. -113.94. The line did not move.

test('driving WEST from the spawn stops on the yellow line, not inside the building (§mempool facade)', () => {
  const LINE = -114.40, POST_W = -114.95, POST_E = -113.94;
  for (const z of [10.2, 3.4, -5.0, 30.0, -78.2]) {
    const st = init(1);
    const end = drive(st, M(START_X), z, WEST, 'x');
    const nose = end.x - M(BODY_FRONT) - M(BODY_RADIUS);
    assert.ok(nose > -120,
      `at z ${z} the truck went through the post office to x ${end.x.toFixed(2)} (nose ${nose.toFixed(2)}) - the mouth is a hole`);
    assert.ok(nose >= POST_W && nose <= POST_E + 0.6,
      `at z ${z} the nose stopped at ${nose.toFixed(2)}, off the yellow marks at ${POST_W} .. ${POST_E}`);
    assert.ok(Math.abs(nose - LINE) < 0.05,
      `at z ${z} the nose stopped at ${nose.toFixed(2)}, not on the wall face ${LINE}`);
  }
});

test('the spawn is still outside the wall, by more than the truck is long (§bay stays driveable)', () => {
  const clear = M(START_X) - (-114.40);
  const length = M(BODY_FRONT) - M(BODY_REAR) + 2 * M(BODY_RADIUS);
  assert.ok(clear > length,
    `the truck spawns ${clear.toFixed(2)} m east of the wall and is ${length.toFixed(2)} m long - it would start inside it`);
});
