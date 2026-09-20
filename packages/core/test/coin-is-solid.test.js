// THE COIN STACKS ARE SOLID, AND THE FINISH IS STILL DRIVEABLE (the owner 2026-09-20 18:56).
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
// The stacks stand at x 173.6 .. 192.4 and |z| 40.6 .. 59.4, measured off the .glb through DeliveryGate's own
// turn and height scale. The gate is at MINER_X 169 on the centre line with a 40 m mouth either side, so the
// boxes begin PAST the gate and 0.6 m OUTSIDE the mouth: test 1 is what proves they did not grow over it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { init, step, teleport } from '../src/sim.js';
import { O_TRUCK, T_X, T_Z, O_SCORE, S_STATE } from '../src/state.js';
import { RUN_DELIVERED } from '../src/rules/gate.js';
import { MINER_X, MINER_MOUTH_HALF } from '../src/rules/map.js';

const ONE = 65536, M = (q) => q / ONE;
const NORTH = 0, SOUTH = 32768;                   // heading is turns: 0 is +z, a half turn is -z
const EAST = 16384;
const COIN_N = 59.4, COIN_S = -59.4, COIN_X = 183;

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

// WHICH SIDES ARE ACTUALLY REACHABLE, because two of these tests were first written against poses a truck can
// never hold and passed for the wrong reason. Measured: the WEST approach at z 50 is stopped 10 m earlier by
// the miner's own facade (x 163..171, z 40..84.4), and x 171..173.6 is a 2.6 m gap the truck does not fit
// through; EAST of the stack is past HALF_X 185, where a placed truck is clamped and drives off the other way.
// The open faces are NORTH of the left stack and SOUTH of the right one, and those are what these drive.

test('the centre line still runs to the gate and still DELIVERS (§coin must not cover the finish)', () => {
  const st = init(1);
  const end = drive(st, M(MINER_X) - 20, 0, EAST, 'x', 2400);
  assert.equal(end.state, RUN_DELIVERED,
    `the centre line no longer delivers - it ended at x ${end.x.toFixed(2)} z ${end.z.toFixed(2)} in state ${end.state}`);
});

test('a truck driving SOUTH into the north coin stack is stopped short of it (§not air)', () => {
  const st = init(1);
  const end = drive(st, COIN_X, 72, SOUTH, 'z');
  assert.ok(end.z > COIN_N,
    `the truck drove into the coin stack: it reached z ${end.z.toFixed(2)}, and the stack starts at ${COIN_N}`);
  assert.ok(end.z < 72 - 2,
    `the truck never set off at all - it is still at z ${end.z.toFixed(2)}`);
});

test('a truck driving NORTH into the south coin stack is stopped short of it (§from either side)', () => {
  const st = init(1);
  const end = drive(st, COIN_X, -72, NORTH, 'z');
  assert.ok(end.z < COIN_S,
    `the truck drove into the south coin stack: it reached z ${end.z.toFixed(2)}, the stack starts at ${COIN_S}`);
  assert.ok(end.z > -72 + 2,
    `the truck never set off at all - it is still at z ${end.z.toFixed(2)}`);
});

test('the coin boxes stand clear of the gate and of the mouth (§do not grow the box over the gate)', () => {
  assert.ok(173.6 > M(MINER_X),
    `the coin stack starts at x 173.6, which is west of the gate at ${M(MINER_X)} - it would cover the finish`);
  assert.ok(40.6 > M(MINER_MOUTH_HALF),
    `the coin stack starts at |z| 40.6, inside the ${M(MINER_MOUTH_HALF)} m mouth - it would narrow the way in`);
});
