// WAR_TACTICS.md §4.15: the candles are terrain. The layout from the tape, the chart band levelled to the apron, and what
// the truck and the tanks do on it - measured by driving the core, not by reading its constants back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { init, step, teleport, surfaceAt, terrainAt, setGround, candleView, bayZ, START_X, HALF_X, HALF_Z } from '../src/sim.js';
import { APRON_RADIUS } from '../src/rules/score.js';
import { GATE_X } from '../src/rules/gate.js';
import { BODY_FRONT, BODY_RADIUS } from '../src/rules/solids.js';
import * as C from '../src/rules/candles.js';
import { emplacementAt } from '../src/rules/emplacements.js';
import { heightAtWorld } from '../src/rules/ground.js';
import { mulFast } from '../src/fixed.js';
import * as L from '../src/state.js';

const Q = 65536;
const clearTheField = (st) => {
  for (let i = 0; i < L.UNITS; i++) { st.i32[L.O_UNITS + i * L.U_WORDS + L.U_HP] = 0; st.i32[L.O_UNITS + i * L.U_WORDS + L.U_STATE] = 0; }
};
const truck = (st) => ({ x: st.i32[L.O_TRUCK + L.T_X], z: st.i32[L.O_TRUCK + L.T_Z], v: st.i32[L.O_TRUCK + L.T_WHEEL] });
const body = (st, c) => { const b = c * C.CL_WORDS; return { x: st.candles[b], z0: st.candles[b + 1], z1: st.candles[b + 2] }; };
/**
 * A long candle with no berm along its centre line or its corridor, so the heights read are the candle's alone, and a z
 * in its middle that neither of the two candles west of it covers, so a truck can drive at its west face from 8 m out.
 * Heights are read against `terrainAt` (the ground under the candle layer): inside the band that ground is the pancake.
 */
function quietCandle(st) {
  for (let c = 2; c < C.CANDLES; c++) {
    const k = body(st, c);
    if (k.z1 - k.z0 < 20 * Q) continue;
    let berm = false;
    for (let z = k.z0 - 12 * Q; z < k.z1 + 12 * Q && !berm; z += Q >> 1)
      for (const x of [k.x, k.x + (C.CANDLE_SLOT >> 1)]) if (emplacementAt(x, z, st.tape, st.ground, HALF_X, HALF_Z, st.apron) > 0) berm = true;
    if (berm) continue;
    for (let z = k.z0 + 6 * Q; z <= k.z1 - 6 * Q; z += Q >> 1) {
      const clear = [1, 2].every((d) => { const w = body(st, c - d); return z + 2 * Q < w.z0 || z - 2 * Q > w.z1; });
      if (clear) return { c, ...k, zDrive: z };
    }
  }
  return null;
}
const layer = (st, x, z) => surfaceAt(st, x, z) - terrainAt(st, x, z);
function drive(st, ticks, throttle, practice = 1) {
  for (let t = 0; t < ticks; t++) { clearTheField(st); step(st, throttle(st), 0, throttle(st) === 0 ? Q : 0, 0, practice); }
}

test('32 bodies between the apron and the miner: 2.956 m bodies, 2.8 m corridors, open to close in z, at least 1 m long', () => {
  const st = init(1);
  for (let c = 0; c < C.CANDLES; c++) {
    const k = body(st, c);
    assert.equal(k.x, C.CANDLE_X0 + c * C.CANDLE_SLOT + (C.CANDLE_SLOT >> 1));
    assert.ok(k.z1 - k.z0 >= C.CANDLE_MIN_LENGTH, `candle ${c} is ${(k.z1 - k.z0) / Q} m`);
    assert.ok(Math.abs(k.z0) <= 46 * Q && Math.abs(k.z1) <= 46 * Q, `candle ${c} reaches past the seam's 45 m`);
    if (c > 0) assert.equal((k.x - C.CANDLE_BODY_HALF) - (body(st, c - 1).x + C.CANDLE_BODY_HALF), 183501, 'a 2.8 m corridor (183501 / 65536)');
  }
  const words = new Int32Array(C.CV_TOTAL);
  assert.equal(candleView(st, words), C.CV_TOTAL);
  assert.equal(words[C.CV_COUNT], 32);
  const b = C.CV_FIRST + 5 * C.CV_WORDS;
  assert.deepEqual([...words.subarray(b, b + 5)], [body(st, 5).x - C.CANDLE_BODY_HALF, body(st, 5).x + C.CANDLE_BODY_HALF, body(st, 5).z0, body(st, 5).z1, C.CANDLE_H]);
});

test('the chart band is the pancake (apron + 0.15 x relief, within 2.2 m) away from candles, berms and craters, on every seed and an uploaded grid; the cone is 40%', () => {
  const grids = [];
  for (const seed of [1, 2, 3, 4, 5]) grids.push(init(seed));
  const up = init(1);
  const h = new Int32Array(64 * 48);
  for (let i = 0; i < h.length; i++) h[i] = ((i * 2654435761) >>> 12) % 950272;   // up to the mempool's 14.5 m
  assert.ok(setGround(up, 64, 48, h));
  grids.push(up);
  for (const st of grids) {
    let flat = 0, spots = 0, worst = 0;
    for (let x = -104 * Q; x <= 104 * Q; x += Q >> 1)
      for (let z = -54 * Q; z <= 54 * Q; z += 2 * Q) {
        spots++;
        if (C.candleHeightAt(st.candles, x, z) !== 0 || emplacementAt(x, z, st.tape, st.ground, HALF_X, HALF_Z, st.apron) !== 0) continue;
        const relief = heightAtWorld(st.ground, x, z, HALF_X, HALF_Z), got = surfaceAt(st, x, z);
        assert.equal(got, st.apron + mulFast(C.PANCAKE, relief - st.apron), `surface at ${x / Q},${z / Q}`);
        worst = Math.max(worst, Math.abs(got - st.apron));
        flat++;
      }
    assert.ok(worst <= 2.2 * Q, `the pancake stands ${worst / Q} m off the apron`);
    assert.ok(flat > spots >> 1, `only ${flat} of ${spots} spots off the candles and berms`);
    // the cone, between |z| 54 and 85 over the band's x (berms taken out): the ground stays inside 0.4 (|z| - 54) of the
    // pancake at the band's edge on every grid; on the seeds' relief no grade toward the band is steeper than 40%. An
    // uploaded grid keeps its own cell-to-cell grade inside that envelope (printed): a pointwise rule cannot smooth it.
    let steepest = 0, outside = 0;
    const bare = (x, z) => surfaceAt(st, x, z) - emplacementAt(x, z, st.tape, st.ground, HALF_X, HALF_Z, st.apron);
    for (let x = -104 * Q; x <= 104 * Q; x += Q)
      for (let z = 54 * Q; z < 85 * Q; z += Q >> 2)
        for (const s of [1, -1]) {
          steepest = Math.max(steepest, Math.abs(bare(x, s * (z + (Q >> 2))) - bare(x, s * z)) / (Q >> 2));
          const edge = st.apron + mulFast(C.PANCAKE, heightAtWorld(st.ground, x, s * 54 * Q, HALF_X, HALF_Z) - st.apron);
          if (Math.abs(bare(x, s * z) - edge) > mulFast(C.CONE, z - 54 * Q) + 1) outside++;
        }
    console.log(`  pancake within ${(worst / Q).toFixed(3)} m of the apron on ${flat} of ${spots} spots; steepest cone grade ${steepest.toFixed(4)}${st.uploadedGround ? ' (uploaded grid)' : ''}`);
    assert.equal(outside, 0, 'ground outside the cone');
    if (!st.uploadedGround) assert.ok(steepest <= 0.4 + 1e-3, `steepest grade in the cone ${steepest.toFixed(4)}`);
  }
});

test('a truck climbs a ramp and stands on the plateau at 2 m', () => {
  const st = init(1), k = quietCandle(st);
  assert.ok(k, 'no long candle without a berm');
  teleport(st, k.x, k.z0 - 8 * Q, 0);
  drive(st, 330, (s) => (truck(s).z < k.z0 + C.CANDLE_RAMP + 4 * Q ? Q : 0));
  const p = truck(st);
  assert.equal(p.v, 0, 'standing');
  assert.equal(p.x, k.x, 'straight up the ramp, not pushed by a face');
  assert.ok(p.z > k.z0 + C.CANDLE_RAMP && p.z < k.z1 - C.CANDLE_RAMP, `on the plateau: z ${p.z / Q}`);
  assert.equal(layer(st, p.x, p.z), C.CANDLE_H);
  console.log(`  candle ${k.c}: truck on the plateau at z ${(p.z / Q).toFixed(3)}, candle layer ${(layer(st, p.x, p.z) / Q).toFixed(3)} m over the ground`);
});

test('an x-face stops a truck and keeps it stopped', () => {
  const st = init(1), k = quietCandle(st);
  const face = k.x - C.CANDLE_BODY_HALF, mid = k.zDrive;
  teleport(st, face - 8 * Q, mid, 16384);
  const held = [];
  for (let t = 0; t < 600; t++) { drive(st, 1, () => Q); if (t >= 150) held.push(truck(st).x); }
  const stop = (face - 83558 - 131072) / Q;
  for (const x of held) {
    assert.ok(Math.abs(x / Q - stop) < 0.01, `x ${x / Q} against a face that holds the nose at ${stop}`);
    assert.equal(layer(st, x, mid), 0, 'still on the ground, not up the face');
  }
});

test('a truck drives the 2.8 m corridor the length of a candle without touching it', () => {
  const st = init(1), k = quietCandle(st);
  const lane = k.x + (C.CANDLE_SLOT >> 1);
  teleport(st, lane, k.z0 - 8 * Q, 0);
  let past = false;
  for (let t = 0; t < 900 && !past; t++) {
    drive(st, 1, () => Q >> 1);
    const p = truck(st);
    assert.equal(p.x, lane, `pushed off the corridor's centre at z ${p.z / Q}`);
    assert.equal(layer(st, p.x, p.z), 0);
    past = p.z > k.z1 + 4 * Q;
  }
  assert.ok(past, 'did not reach the far end');
});

test('tanks cross candles: through the x-faces and up onto the plateaus, nothing pushes them back', () => {
  for (const seed of [1, 2, 3]) {
    const st = init(seed);
    const prev = new Map();
    let crossings = 0, stepUps = 0, onPlateau = 0;
    for (let t = 0; t < 3600; t++) {
      step(st, 0, 0, Q, 0, 1);
      for (let i = 0; i < L.UNITS; i += 4) {
        const b = L.O_UNITS + i * L.U_WORDS;
        if (st.i32[b + L.U_HP] <= 0 || st.i32[b + L.U_STATE] === 0) { prev.delete(i); continue; }
        const x = st.i32[b + L.U_X], z = st.i32[b + L.U_Z], h = C.candleHeightAt(st.candles, x, z);
        if (h === C.CANDLE_H) onPlateau++;
        const p = prev.get(i);
        if (p) {
          if (h === C.CANDLE_H && C.candleHeightAt(st.candles, p.x, p.z) < C.CANDLE_H) stepUps++;
          for (let c = 0; c < C.CANDLES; c++) {
            const k = body(st, c);
            for (const face of [k.x - C.CANDLE_BODY_HALF, k.x + C.CANDLE_BODY_HALF])
              if ((p.x < face) !== (x < face) && z > k.z0 && z < k.z1) crossings++;
          }
        }
        prev.set(i, { x, z });
      }
    }
    // Measured on the fitted field (spawn ruling B): 26 / 58 / 16 crossings and 18 / 29 / 13 step-ups on seeds 1 / 2 / 3
    // (on the 6.5 m field from x -104 it was 45 / 43 / 37 and 33 / 33 / 34).
    console.log(`  seed ${seed}: ${crossings} x-face crossings, ${stepUps} step-ups, ${onPlateau} tank-ticks on a plateau`);
    assert.ok(crossings >= 10, `seed ${seed}: ${crossings} x-face crossings in 60 s`);
    assert.ok(stepUps >= 10, `seed ${seed}: ${stepUps} step-ups onto a plateau`);
    assert.ok(onPlateau > 0);
  }
});

test('w1: a wick collides only where it stands past the body - body 2 m, wick 9 m, never through the body; the truck hits it', () => {
  // Today's tape has two samples a candle, so its low and high are the body's ends: no wick stands past a body.
  const st0 = init(1);
  let past = 0;
  for (let c = 0; c < C.CANDLES; c++) past += C.wickSegments(st0.candles, c, new Int32Array(4));
  assert.equal(past, 0, 'a two-sample candle has a wick past its body');
  assert.equal(st0.candleSolids.n, 64, 'two x-faces a candle and no wick collider');

  // One candle given a high 10 m past its body and a low 6 m past it, as a candle with more samples would have.
  const st = init(1), k = quietCandle(st), l = k.c * C.CL_WORDS;
  st.candles[l + C.CL_HIGH] = k.z1 + 10 * Q;
  st.candles[l + C.CL_LOW] = k.z0 - 6 * Q;
  st.candleSolids = C.candleWalls(st.candles, st.apron);
  const boxes = [];
  for (let i = 0; i < st.candleSolids.n; i++) {
    const b = i * 6, x = st.candleSolids.box[b];
    if (Math.abs(x - k.x) > C.CANDLE_BODY_HALF) continue;
    boxes.push({ x0: x - st.candleSolids.box[b + 2], x1: x + st.candleSolids.box[b + 2], z0: st.candleSolids.box[b + 1] - st.candleSolids.box[b + 3],
                 z1: st.candleSolids.box[b + 1] + st.candleSolids.box[b + 3], y: st.candleSolids.box[b + 5] - st.apron });
  }
  const m = (q) => (q / Q).toFixed(2);
  console.log(`  candle ${k.c}: body z ${m(k.z0)}..${m(k.z1)}, low ${m(k.z0 - 6 * Q)}, high ${m(k.z1 + 10 * Q)}`);
  for (const b of boxes) console.log(`    collider x ${m(b.x0)}..${m(b.x1)} z ${m(b.z0)}..${m(b.z1)} height ${m(b.y)} m`);
  const faces = boxes.filter((b) => b.y === C.CANDLE_H), wicks = boxes.filter((b) => b.y === C.WICK_HEIGHT);
  assert.equal(faces.length, 2);
  assert.equal(wicks.length, 2);
  for (const w of wicks) assert.ok(w.z1 <= k.z0 + 1 || w.z0 >= k.z1 - 1, `a wick collider ${m(w.z0)}..${m(w.z1)} runs through the body ${m(k.z0)}..${m(k.z1)}`);
  assert.deepEqual(wicks.map((w) => [w.z0, w.z1]).sort((a, b) => a[0] - b[0]), [[k.z0 - 6 * Q, k.z0], [k.z1, k.z1 + 10 * Q]]);

  // Driven up the centre line from the south: the low wick stops the truck before the ramp.
  teleport(st, k.x, k.z0 - 14 * Q, 0);
  const trace = [];
  for (let t = 0; t < 600; t++) { drive(st, 1, () => Q); trace.push(truck(st).z); }
  const stopLow = k.z0 - 6 * Q - 83558 - 131072;
  console.log(`    from the south: stopped at z ${m(truck(st).z)} (wick foot ${m(k.z0 - 6 * Q)}, nose held at ${m(stopLow)})`);
  assert.ok(Math.abs(truck(st).z - stopLow) < 0.01 * Q);
  // Down the plateau toward the high end: the high wick stops it at the ramp's foot.
  const st2 = init(1);
  st2.candles.set(st.candles);
  st2.candleSolids = st.candleSolids;
  teleport(st2, k.x, (k.z0 + k.z1) >> 1, 0);
  drive(st2, 600, () => Q >> 1);
  const stopHigh = k.z1 - 83558 - 131072;
  console.log(`    along the plateau north: stopped at z ${m(truck(st2).z)} (high wick from ${m(k.z1)}, nose held at ${m(stopHigh)}), surface ${m(surfaceAt(st2, truck(st2).x, truck(st2).z) - st2.apron)} m`);
  assert.ok(Math.abs(truck(st2).z - stopHigh) < 0.01 * Q);
  // The corridor beside the wick is still a corridor.
  const st3 = init(1);
  st3.candles.set(st.candles);
  st3.candleSolids = st.candleSolids;
  const lane = k.x + (C.CANDLE_SLOT >> 1);
  teleport(st3, lane, k.z0 - 14 * Q, 0);
  for (let t = 0; t < 900 && truck(st3).z < k.z1 + 14 * Q; t++) { drive(st3, 1, () => Q >> 1); assert.equal(truck(st3).x, lane); }
  assert.ok(truck(st3).z >= k.z1 + 14 * Q, 'the corridor past a wick is blocked');
});

test('spawn ruling B: the truck leaves the apron before any x-face; 32 bodies stand before the miner, none in the gate', () => {
  const st = init(1), m = (q) => (q / Q).toFixed(3), MINER = Math.round(108.4 * Q);
  const first = body(st, 0).x - C.CANDLE_BODY_HALF, last = body(st, C.CANDLES - 1).x + C.CANDLE_BODY_HALF;
  const plateau = 2 * C.CANDLE_BODY_HALF, corridor = C.CANDLE_SLOT - plateau, truckW = 2 * BODY_RADIUS;
  console.log(`  pitch ${m(C.CANDLE_SLOT)} m, body ${m(plateau)} m, corridor ${m(corridor)} m, plateau margin for a ${m(truckW)} m truck ${m((plateau - truckW) >> 1)} m a side`);
  console.log(`  spawn centre ${m(START_X)} -> first face ${m(first)}: ${m(first - START_X)} m (nose ${m(first - START_X - BODY_FRONT - BODY_RADIUS)} m, apron ${m(APRON_RADIUS)} m); last face ${m(last)}, miner face 108.400, delivery x ${m(GATE_X)}`);
  assert.ok(first - START_X >= 26 * Q, 'the first face is under 26 m from the spawn centre');
  assert.ok(first - START_X - BODY_FRONT - BODY_RADIUS > APRON_RADIUS, 'the nose meets the chart on the apron');
  assert.ok(last <= MINER, 'a body stands past the miner face: in the gate throat');
  assert.ok(last < GATE_X, 'a body stands across the delivery line');
  assert.ok(corridor >= Math.round(2.8 * Q) && plateau - truckW >= Math.round(0.4 * Q), 'corridor or plateau too narrow for the truck');
  // Every bay, straight out at full throttle: nothing stops the truck before the apron's end.
  const hits = [];
  for (let bay = 0; bay < 24; bay++) {
    const s2 = init(1);
    teleport(s2, START_X, bayZ(bay), 16384);
    let prev = START_X, stuck = null;
    for (let t = 0; t < 600 && stuck === null; t++) {
      drive(s2, 1, () => Q, 0);
      const x = truck(s2).x;
      if (t > 60 && x - prev < 64) stuck = x;         // under 1 mm a tick at full throttle: against something
      prev = x;
    }
    if (stuck !== null) hits.push({ bay, z: bayZ(bay), x: stuck, out: stuck - START_X });
    if (stuck !== null) assert.ok(stuck - START_X > APRON_RADIUS, `bay ${bay}: stopped ${m(stuck - START_X)} m out, on the apron`);
  }
  console.log(`  straight +x from each bay, stopped by an x-face: ${hits.map((h) => `bay ${h.bay} (z ${m(h.z)}) at x ${m(h.x)} = ${m(h.out)} m out`).join('; ') || 'none within 600 ticks'}`);
});
