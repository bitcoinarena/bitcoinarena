// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE FINISH STRAIGHT IS FREE (2026-09-25 21:19: "The finish-straight passage must be completely free. A truck at
// speed crosses it with no hit and no slowdown from a collider").
//
// MEASURED before the fifteen passage boxes came out of rules/map.js (40 seeds a lane, full throttle from x 96, the same
// drive as test 2 here): the lanes at z 10.2 (the spawn bay's own), -10.2, 20, 30 and -30 delivered 0 of 40 - stopped
// on the mouth's grid columns, the cables or the walls behind them - and at -20 every run lost speed in the straight.
//
//   1. no map box the truck can reach stands in the passage - the tunnel between its ribs, |z| < 32.8, from the miner's
//      door to the gate: none whose foot is within BODY_HEIGHT of the highest ground anywhere in it (the core's own
//      reach, solids.js pushOut). The facade lintel, 26 m up, is the doorway's top and is driven under.
//   2. down every lane of it, from z -30 to 30, a truck at full throttle delivers and never loses speed between the door
//      and the gate
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { init, step, teleport, surfaceAt } from '../src/sim.js';
import { BODY_HEIGHT } from '../src/rules/solids.js';
import { O_TRUCK, T_X, T_Z, O_SCORE, S_STATE } from '../src/state.js';
import { RUN_DELIVERED } from '../src/rules/gate.js';
import { MINER_X, MINER_DOOR_X } from '../src/rules/map.js';

const ONE = 65536, M = (q) => q / ONE;
const EAST = 16384;
const PASSAGE_HALF = 32.8;          // the ribs' inner faces, tunnel_rib_*: 33.4 less their 0.6 half-width

test('1. no map box the truck can reach stands in the finish straight', () => {
  const st = init(0x51eed);
  let high = -Infinity;
  for (let x = Math.ceil(M(MINER_DOOR_X)); x <= M(MINER_X); x += 1)
    for (let z = -PASSAGE_HALF; z <= PASSAGE_HALF; z += 1) high = Math.max(high, surfaceAt(st, x * ONE, Math.round(z * ONE)));
  const inside = [];
  for (let i = 0; i < st.solids.n; i++) {
    const [cx, cz, hx, hz, yLow] = st.solids.box.subarray(i * 6, i * 6 + 5);
    if (yLow > high + BODY_HEIGHT) continue;
    const x0 = M(cx - hx), x1 = M(cx + hx), z0 = M(cz - hz), z1 = M(cz + hz);
    if (x1 > M(MINER_DOOR_X) && x0 < M(MINER_X) && z1 > -PASSAGE_HALF + 1e-3 && z0 < PASSAGE_HALF - 1e-3)
      inside.push(`box ${i} x ${x0.toFixed(2)}..${x1.toFixed(2)} z ${z0.toFixed(2)}..${z1.toFixed(2)}`);
  }
  assert.deepEqual(inside, []);
});

test('2. every lane from z -30 to 30 delivers at full throttle and never loses speed in the straight', () => {
  const failed = [];
  for (const lane of [-30, -20, -10.2, -6, 0, 6, 10.2, 20, 30]) {
    for (let k = 0; k < 8; k++) {
      const st = init((0x51eed + k * 7919) | 0);
      teleport(st, 96 * ONE, Math.round(lane * ONE), EAST);
      let prev = 0, lost = null;
      for (let t = 0; t < 600; t++) {
        const x0 = M(st.i32[O_TRUCK + T_X]), z0 = M(st.i32[O_TRUCK + T_Z]);
        step(st, ONE, 0, 0, 0, ONE);
        const x = M(st.i32[O_TRUCK + T_X]), z = M(st.i32[O_TRUCK + T_Z]);
        const v = Math.hypot(x - x0, z - z0);
        if (x > M(MINER_DOOR_X) && x < M(MINER_X) && v < prev - 1e-3 && !lost) lost = `x ${x.toFixed(2)}`;
        prev = v;
        if (st.i32[O_SCORE + S_STATE] !== 0) break;
      }
      const state = st.i32[O_SCORE + S_STATE];
      if (state !== RUN_DELIVERED || lost) failed.push(`lane ${lane} seed ${k}: state ${state}${lost ? `, slowed at ${lost}` : ''}`);
    }
  }
  assert.deepEqual(failed, []);
});

// NOTHING LEFT OR RIGHT OF IT EITHER (2026-09-26 07:18: "The collisions left and right of the finish straight are
// wrong. They come out ... A truck on the centre line is not stopped and not slowed by a side box"). The 26-box corridor
// lining stood at |z| 32.8 .. 40 between x 145 and 171 where nothing is drawn; out to the 40 m mouth, from the door to
// the gate, no box the truck can reach is left.
test('3. no map box the truck can reach stands anywhere inside the mouth, door to gate', () => {
  const st = init(0x51eed);
  const MOUTH = 40;
  let high = -Infinity;
  for (let x = Math.ceil(M(MINER_DOOR_X)); x <= M(MINER_X); x += 1)
    for (let z = -MOUTH; z <= MOUTH; z += 1) high = Math.max(high, surfaceAt(st, x * ONE, Math.round(z * ONE)));
  const inside = [];
  for (let i = 0; i < st.solids.n; i++) {
    const [cx, cz, hx, hz, yLow] = st.solids.box.subarray(i * 6, i * 6 + 5);
    if (yLow > high + BODY_HEIGHT) continue;
    const x0 = M(cx - hx), x1 = M(cx + hx), z0 = M(cz - hz), z1 = M(cz + hz);
    if (x1 > M(MINER_DOOR_X) && x0 < M(MINER_X) && z1 > -MOUTH + 1e-3 && z0 < MOUTH - 1e-3)
      inside.push(`box ${i} x ${x0.toFixed(2)}..${x1.toFixed(2)} z ${z0.toFixed(2)}..${z1.toFixed(2)}`);
  }
  assert.deepEqual(inside, []);
});
