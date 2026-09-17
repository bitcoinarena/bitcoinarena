// WAR_TACTICS.md §4.15: the candles are terrain. The layout from the tape, the chart band levelled to the apron, and what
// the truck and the tanks do on it - measured by driving the core, not by reading its constants back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { init, step, teleport, surfaceAt, setGround, candleView, HALF_X, HALF_Z } from '../src/sim.js';
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
/** A long candle with no berm along its centre line or its corridor, so the heights read are the candle's alone. */
function quietCandle(st) {
  for (let c = 0; c < C.CANDLES; c++) {
    const k = body(st, c);
    if (k.z1 - k.z0 < 20 * Q) continue;
    let berm = false;
    for (let z = k.z0 - 12 * Q; z < k.z1 + 12 * Q && !berm; z += Q >> 1)
      for (const x of [k.x, k.x + (C.CANDLE_SLOT >> 1)]) if (emplacementAt(x, z, st.tape, st.ground, HALF_X, HALF_Z, st.apron) > 0) berm = true;
    if (!berm) return { c, ...k };
  }
  return null;
}
function drive(st, ticks, throttle, practice = 1) {
  for (let t = 0; t < ticks; t++) { clearTheField(st); step(st, throttle(st), 0, throttle(st) === 0 ? Q : 0, 0, practice); }
}

test('32 bodies over x -104..+104: 3.7 m bodies, 2.8 m corridors, open to close in z, at least 1 m long', () => {
  const st = init(1);
  for (let c = 0; c < C.CANDLES; c++) {
    const k = body(st, c);
    assert.equal(k.x, C.CANDLE_X0 + c * C.CANDLE_SLOT + (C.CANDLE_SLOT >> 1));
    assert.ok(k.z1 - k.z0 >= C.CANDLE_MIN_LENGTH, `candle ${c} is ${(k.z1 - k.z0) / Q} m`);
    assert.ok(Math.abs(k.z0) <= 46 * Q && Math.abs(k.z1) <= 46 * Q, `candle ${c} reaches past the seam's 45 m`);
    if (c > 0) assert.equal((k.x - C.CANDLE_BODY_HALF) - (body(st, c - 1).x + C.CANDLE_BODY_HALF), 183500, 'a 2.8 m corridor (183500 / 65536)');
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
  assert.equal(surfaceAt(st, p.x, p.z) - st.apron, C.CANDLE_H);
});

test('an x-face stops a truck and keeps it stopped', () => {
  const st = init(1), k = quietCandle(st);
  const face = k.x - C.CANDLE_BODY_HALF, mid = (k.z0 + k.z1) >> 1;
  teleport(st, face - 8 * Q, mid, 16384);
  const held = [];
  for (let t = 0; t < 600; t++) { drive(st, 1, () => Q); if (t >= 150) held.push(truck(st).x); }
  const stop = (face - 83558 - 131072) / Q;
  for (const x of held) {
    assert.ok(Math.abs(x / Q - stop) < 0.01, `x ${x / Q} against a face that holds the nose at ${stop}`);
    assert.equal(surfaceAt(st, x, mid), st.apron, 'still on the ground, not up the face');
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
    assert.equal(surfaceAt(st, p.x, p.z), st.apron);
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
    assert.ok(crossings > 20, `seed ${seed}: ${crossings} x-face crossings in 60 s`);
    assert.ok(stepUps > 20, `seed ${seed}: ${stepUps} step-ups onto a plateau`);
    assert.ok(onPlateau > 0);
  }
});
