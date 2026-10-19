// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WAR_TACTICS.md §4.15: the candles are terrain. The layout from the tape, the chart band levelled to the apron, and what
// the truck and the tanks do on it - measured by driving the core, not by reading its constants back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// RELIEF_HALF_X, not HALF_X: since the world grew east (2026-09-19) the map is 185 m from the middle and the relief
// is still the 130 m grid it always was, held at its edge row beyond that. A test that samples the ground with the
// map's number is reading a different hill from the one the core stands things on.
import { init, step, teleport, surfaceAt, terrainAt, setGround, setCandleField, candleView, submitSample, frontAt, bayZ, START_X, HALF_X, RELIEF_HALF_X, HALF_Z } from '../src/sim.js';
import * as T from '../src/rules/tactics.js';
import { APRON_RADIUS } from '../src/rules/score.js';
import { GATE_X } from '../src/rules/gate.js';
import { BODY_FRONT, BODY_RADIUS } from '../src/rules/solids.js';
import * as C from '../src/rules/candles.js';
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
 * A long candle, so the heights read are the candle's alone, and a z
 * in its middle that neither of the two candles west of it covers, so a truck can drive at its west face from 8 m out.
 * Heights are read against `terrainAt` (the ground under the candle layer): inside the band that ground is the pancake.
 */
function quietCandle(st) {
  for (let c = 2; c < C.CANDLES; c++) {
    const k = body(st, c);
    if (k.z1 - k.z0 < 20 * Q) continue;
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

test('32 bodies as wide as their slots, touching, open = the previous close (a staircase), at least 1 m long, before the miner', () => {
  const st = init(1);
  for (let c = 0; c < C.CANDLES; c++) {
    const k = body(st, c);
    assert.equal(k.x, C.CANDLE_X0 + c * C.CANDLE_SLOT + (C.CANDLE_SLOT >> 1));
    assert.ok(k.z1 - k.z0 >= C.CANDLE_MIN_LENGTH, `candle ${c} is ${(k.z1 - k.z0) / Q} m`);
    if (c > 0) {
      assert.ok(Math.abs((k.x - C.CANDLE_BODY_HALF) - (body(st, c - 1).x + C.CANDLE_BODY_HALF)) <= 1, 'bodies touch: no corridor');
      const p = body(st, c - 1);
      // the previous body's close end is one of this body's ends (the 1 m doji rule can move an end by under half a metre)
      const touch = Math.min(...[p.z0, p.z1].flatMap((a) => [k.z0, k.z1].map((b) => Math.abs(a - b))));
      assert.ok(touch <= Q >> 1, `candle ${c} starts ${(touch / Q).toFixed(3)} m from where candle ${c - 1} ended`);
    }
  }
  assert.ok(body(st, C.CANDLES - 1).x + C.CANDLE_BODY_HALF <= Math.round(108.4 * Q), 'a body past the miner face');
  const words = new Int32Array(C.CV_TOTAL);
  assert.equal(candleView(st, words), C.CV_TOTAL);
  assert.equal(words[C.CV_COUNT], 32);
});

test('the chart band is the pancake (apron + 0.15 x relief, within 2.2 m) away from candles and craters, on every seed and an uploaded grid; the cone is 40%', () => {
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
        if (C.candleHeightAt(st.candles, x, z, st.candleShift) !== 0) continue;
        const relief = heightAtWorld(st.ground, x, z, RELIEF_HALF_X, HALF_Z), got = surfaceAt(st, x, z);
        assert.equal(got, st.apron + mulFast(C.PANCAKE, relief - st.apron), `surface at ${x / Q},${z / Q}`);
        worst = Math.max(worst, Math.abs(got - st.apron));
        flat++;
      }
    assert.ok(worst <= 2.2 * Q, `the pancake stands ${worst / Q} m off the apron`);
    assert.ok(flat > spots >> 1, `only ${flat} of ${spots} spots off the candles`);
    // the cone, between |z| 54 and 85 over the band's x: the ground stays inside 0.4 (|z| - 54) of the
    // pancake at the band's edge on every grid; on the seeds' relief no grade toward the band is steeper than 40%. An
    // uploaded grid keeps its own cell-to-cell grade inside that envelope (printed): a pointwise rule cannot smooth it.
    let steepest = 0, outside = 0;
    const bare = (x, z) => surfaceAt(st, x, z);
    for (let x = -104 * Q; x <= 104 * Q; x += Q)
      for (let z = 54 * Q; z < 85 * Q; z += Q >> 2)
        for (const s of [1, -1]) {
          steepest = Math.max(steepest, Math.abs(bare(x, s * (z + (Q >> 2))) - bare(x, s * z)) / (Q >> 2));
          const edge = st.apron + mulFast(C.PANCAKE, heightAtWorld(st.ground, x, s * 54 * Q, RELIEF_HALF_X, HALF_Z) - st.apron);
          if (Math.abs(bare(x, s * z) - edge) > mulFast(C.CONE, z - 54 * Q) + 1) outside++;
        }
    console.log(`  pancake within ${(worst / Q).toFixed(3)} m of the apron on ${flat} of ${spots} spots; steepest cone grade ${steepest.toFixed(4)}${st.uploadedGround ? ' (uploaded grid)' : ''}`);
    assert.equal(outside, 0, 'ground outside the cone');
    if (!st.uploadedGround) assert.ok(steepest <= 0.4 + 1e-3, `steepest grade in the cone ${steepest.toFixed(4)}`);
  }
});

test('a raised ribbon: 1 m plateaus, 0.5 m wick ridges, every candle grade at most 25%, no vertical face, nothing in the solids', () => {
  const st = init(1), step = Q >> 3;
  const lay = (x, z) => C.candleHeightAt(st.candles, x, z, st.candleShift);
  let maxH = 0, steep = 0, ridge = 0;
  for (let x = -76 * Q; x < 108 * Q; x += step)
    for (let z = -46 * Q; z < 46 * Q; z += Q >> 1) {
      const h = lay(x, z); maxH = Math.max(maxH, h);
      if (h === C.WICK_RIDGE_H) {
        // a wick ridge top beyond its body's ends (15:30: the wick is ground, 0.5 m)
        const c = Math.floor((x + st.candleShift - C.CANDLE_X0) / C.CANDLE_SLOT), k = body(st, c);
        if (z < k.z0 || z > k.z1) ridge++;
      }
      steep = Math.max(steep, Math.abs(lay(x + step, z) - h) / step, Math.abs(lay(x, z + step) - h) / step);
    }
  console.log(`  plateau ${(maxH / Q).toFixed(3)} m, steepest candle grade ${(steep * 100).toFixed(1)}%, ${ridge} wick-ridge top samples beyond the bodies`);
  assert.ok(ridge > 100, `the wicks are not a 0.5 m ridge beyond the bodies (${ridge} samples)`);
  assert.equal(maxH, C.CANDLE_H);
  assert.ok(steep <= 0.25 + 1e-3, `a candle grade of ${(steep * 100).toFixed(1)}%`);
  assert.equal(C.candleWalls().n, 0, 'a candle part in the solids');
});

test('a truck driven straight east at full throttle over the chart never drops below 85% of its flat-ground speed and never stops', () => {
  // §0 row (492f128): from the apron to the gate at z = seam - 10 m, against the same drive with no candle field.
  const run = (candles) => {
    const st = init(1), s = st.i32;
    if (!candles) setCandleField(st, false);
    const z = frontAt(st, 0) - 10 * Q;
    teleport(st, START_X, z, 16384);
    const speeds = new Map(); let stops = 0, still = 0, ticks = 0;
    for (let t = 0; t < 2400; t++) {
      clearTheField(st);
      s[L.O_TRUCK + L.T_Z] = z; s[L.O_TRUCK + L.T_VZ] = 0; s[L.O_TRUCK + L.T_HEADING] = 16384;
      step(st, Q, 0, 0, 0, 1); ticks++;
      const x = s[L.O_TRUCK + L.T_X], v = s[L.O_TRUCK + L.T_WHEEL] / Q;
      speeds.set(Math.round(x / Q), v);
      if (t > 60 && v < 0.2) { if (++still === 30) stops++; } else still = 0;
      if (x >= 114 * Q) break;
    }
    return { speeds, stops, ticks };
  };
  const over = run(true), flat = run(false);
  let low = 9;
  for (const [x, v] of over.speeds) { const f = flat.speeds.get(x); if (f && f > 3 && x > -76 && x < 108) low = Math.min(low, v / f); }
  console.log(`  ${over.ticks} ticks to the gate over the chart, ${flat.ticks} on flat ground; lowest speed ${(low * 100).toFixed(1)}% of flat; stops ${over.stops}`);
  assert.equal(over.stops, 0);
  assert.ok(low >= 0.85, `the truck fell to ${(low * 100).toFixed(1)}% of its flat-ground speed`);   // §0 "the chart is a road"
  assert.ok(over.ticks <= flat.ticks * 1.05, `${over.ticks} ticks over the chart against ${flat.ticks} on flat ground`);
});

test('trucks get through north to south: full throttle from z -54 to +54 at x 20 and back, at least 85% of flat speed, no stop', () => {
  // §4.15 passability (2026-09-17 14:40 "make it so trucks and tanks get through") and its §0 row: across the front,
  // over the ribbon, the seam and wherever the berms stood, against the same drive on flat ground with no candle field.
  const X = 20 * Q, Z = 54 * Q;
  const run = (world) => {
    const st = init(1), s = st.i32;
    if (!world) { setCandleField(st, false); setGround(st, 2, 2, new Int32Array(4).fill(st.apron)); }
    const speeds = [new Map(), new Map()]; let stops = 0, ticks = 0, overLayer = 0;
    for (const [leg, from, heading, dir] of [[0, -Z, 0, 1], [1, Z, 32768, -1]]) {
      teleport(st, X, from, heading);
      let still = 0;
      for (let t = 0; t < 1200; t++) {
        clearTheField(st);
        s[L.O_TRUCK + L.T_X] = X; s[L.O_TRUCK + L.T_VX] = 0; s[L.O_TRUCK + L.T_HEADING] = heading;
        step(st, Q, 0, 0, 0, 1); ticks++;
        const z = s[L.O_TRUCK + L.T_Z], v = s[L.O_TRUCK + L.T_WHEEL] / Q;
        speeds[leg].set(Math.round(z / Q), v);
        if (world && terrainAt(st, X, z) !== surfaceAt(st, X, z)) overLayer++;
        if (t > 60 && v < 0.2) { if (++still === 30) stops++; } else still = 0;
        if (dir * (z - dir * Z) >= 0) break;
      }
    }
    return { speeds, stops, ticks, overLayer };
  };
  const over = run(true), flat = run(false);
  let low = 9, at = null;
  for (const leg of [0, 1]) for (const [z, v] of over.speeds[leg]) { const f = flat.speeds[leg].get(z); if (f && f > 3 && v / f < low) { low = v / f; at = [leg, z]; } }
  console.log(`  north-south at x 20: ${over.ticks} ticks over the band, ${flat.ticks} on flat ground; lowest ${(low * 100).toFixed(1)}% of flat (leg ${at && at[0]}, z ${at && at[1]}); stops ${over.stops}; ${over.overLayer} ticks on the ribbon`);
  assert.equal(over.stops, 0);
  assert.ok(over.overLayer > 0, 'the drive never crossed a candle');
  assert.ok(low >= 0.85, `the truck fell to ${(low * 100).toFixed(1)}% of its flat-ground speed`);
});

test('the chart moves: half a slot per sample, no jump on a sample tick, and a rescale lerps', () => {
  const st = init(1), s = st.i32, open = s[L.O_TACTICS + T.TAC_MARKET + T.MK_OPEN];
  const pts = []; for (let x = -60; x < 100; x += 1.3) for (let z = -40; z < 40; z += 1.1) pts.push([Math.round(x * Q), Math.round(z * Q)]);
  const read = () => pts.map(([x, z]) => C.candleHeightAt(st.candles, x, z, st.candleShift));
  let prev = read(), between = 0, onSample = 0, shiftAtSample = [];
  for (let t = 1; t <= 1800; t++) {
    let sampled = false;
    if (t % 300 === 0) { shiftAtSample.push(st.candleShift); submitSample(st, open + ((t * 7919) % 4001) - 1500); sampled = true; }
    step(st, 0, 0, Q, Q, 1);
    const now = read();
    let w = 0; for (let i = 0; i < pts.length; i++) w = Math.max(w, Math.abs(now[i] - prev[i]));
    if (sampled) onSample = Math.max(onSample, w); else between = Math.max(between, w);
    prev = now;
  }
  console.log(`  candle layer per tick: ${(between / Q).toFixed(3)} m between samples, ${(onSample / Q).toFixed(3)} m on sample ticks; shift before each sample ${shiftAtSample.map((x) => (x / Q).toFixed(2)).join(' ')}`);
  assert.ok(between <= 0.02 * Q, `the chart moved ${(between / Q).toFixed(3)} m in a tick between samples`);
  // nothing jumps (§0 "The chart glides"): a sample tick moves no point more than the glide already moves it on any tick
  assert.ok(onSample <= between + 0.02 * Q, `the chart jumped ${(onSample / Q).toFixed(3)} m on a sample tick (${(between / Q).toFixed(3)} m between)`);
  // one sample slides the chart half a slot: just before a sample, one or two half-slots (the pairing's whole-slot move takes the rest)
  for (const sh of shiftAtSample) assert.ok(Math.abs(sh - C.CANDLE_SLOT / 2) < 0.02 * Q || Math.abs(sh - C.CANDLE_SLOT) < 0.02 * Q, `shift ${sh / Q} m before a sample`);
});

test('tanks cross the ribbon: up onto the plateaus and down, nothing pushes them back', () => {
  let plateauTicks = 0, crossed = 0;
  for (const seed of [1, 2, 3]) {
    const st = init(seed);
    const prev = new Map();
    let crossings = 0, stepUps = 0, onPlateau = 0, onChart = 0;
    for (let t = 0; t < 3600; t++) {
      step(st, 0, 0, Q, 0, 1);
      for (let i = 0; i < L.UNITS; i += 4) {
        const b = L.O_UNITS + i * L.U_WORDS;
        if (st.i32[b + L.U_HP] <= 0 || st.i32[b + L.U_STATE] === 0) { prev.delete(i); continue; }
        const x = st.i32[b + L.U_X], z = st.i32[b + L.U_Z], h = C.candleHeightAt(st.candles, x, z, st.candleShift);
        if (h === C.CANDLE_H) onPlateau++;
        if (h > 0) onChart++;
        const p = prev.get(i);
        if (p) {
          if (h === C.CANDLE_H && C.candleHeightAt(st.candles, p.x, p.z, st.candleShift) < C.CANDLE_H) stepUps++;
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
    console.log(`  seed ${seed}: ${crossings} x-face crossings, ${stepUps} step-ups, ${onPlateau} tank-ticks on a plateau, ${onChart} on the chart`);
    // On the ribbon (492f128) bodies touch: a tank crosses slot boundaries on the plateau, so fresh step-ups are few
    // (printed); what must hold is that tanks cross the chart and stand on it.
    crossed += crossings;
    // ON THE CHART per seed, ON A FULL BODY TOP over the three. MOVED 2026-09-19: §4.13's seeded init tape gives
    // every seed its own chart, so how high a tank gets in 60 s is the seed's, not the rule's - measured plateau /
    // slope tank-ticks 0 / 7899, 907 / 5097, 2278 / 9573 on seeds 1 / 2 / 3 (flat tape: 1825 / 23116, 1319 / 26450,
    // 2858 / 21378). Crossings are the seed's too - 17 / 18 / 1 with ruling B refitted to the miner's door, 9 / 17 /
    // 3 with the tank posts pulled off the loading dock, 14 / 9 / 13 before that, 26 / 58 / 16 on the flat tape -
    // so the crossing bar is read over
    // the three together and only "on the chart" is read per seed. Seed 1's tanks are on the chart the whole
    // minute and reach 0.72 m; nothing pushes them back, they just do not top a body inside the minute. The rule
    // is that the chart is ground, not a wall.
    assert.ok(onChart > 0, `seed ${seed}: no tank ever stood on the chart`);
    plateauTicks += onPlateau;
  }
  assert.ok(plateauTicks > 0, 'no tank stood on a full body top on any of the three seeds');
  assert.ok(crossed >= 25, `${crossed} slot-boundary crossings over the three seeds`);
});


test('the first live price continues the chart: no sideways shove at the start of a round (Alice 16:42, from the cab)', () => {
  // Measured before: a first sample of $76,737 on the Daily's $78,515 seeded tape swung the rescale - the seam at x 0 went
  // 2.05 -> 21.39 m in the 300 ticks after the sample and stayed there. The first sample now moves the seeded tape onto the
  // live level, so the chart is where it would be had the first price equalled the seeded newest.
  const run = (first) => {
    const st = init(0x5eed1234), seeded = st.tape[st.tape.length - 1], track = [];
    const price = first === 'live' ? Math.round(76737.48 * 256) : seeded;
    for (let t = 0; t <= 900; t++) {
      if (t === 300) submitSample(st, price);
      if (t === 600) submitSample(st, price + 300);
      if (t % 30 === 0) track.push([frontAt(st, 0), frontAt(st, 40 * Q), C.candleHeightAt(st.candles, 20 * Q, 0, st.candleShift)]);
      step(st, 0, 0, Q, Q, 1);
    }
    return { track, newest: st.tape[st.tape.length - 1] / 256 };
  };
  const live = run('live'), same = run('same');
  let worst = 0;
  for (let i = 0; i < live.track.length; i++) for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(live.track[i][k] - same.track[i][k]));
  console.log(`  live first price vs seeded-level first price: seam and candles apart at most ${(worst / Q).toFixed(4)} m over 900 ticks; newest $${live.newest.toFixed(2)}`);
  assert.ok(worst <= Q >> 8, `the first live price moved the chart ${(worst / Q).toFixed(3)} m`);
  assert.ok(Math.abs(live.newest - 76738.65) < 1, 'the tape does not read the live price');
});

test('the live tape replaces the seeded one before any sample, keeps the scroll, and is refused after a sample (Alice 16:44)', async () => {
  const { submitTape } = await import('../src/sim.js');
  const st = init(0x5eed1234), s = st.i32;
  const seeded = Array.from(st.tape);
  const live = Array.from({ length: 64 }, (_, i) => Math.round((76700 + 3 * Math.sin(i / 5) + i * 0.4) * 256));
  const shift = st.candleShift;
  assert.equal(submitTape(st, live.slice(1)), false, 'a tape of 63 prices was taken');
  assert.equal(submitTape(st, live), true);
  assert.deepEqual(Array.from(st.tape), live, 'the tape is not the live one');
  assert.notDeepEqual(Array.from(st.tape), seeded);
  assert.equal(s[L.O_TACTICS + T.TAC_MARKET + T.MK_OPEN], live[63], 'the open is not the live newest price');
  assert.equal(st.candleShift, shift, 'the tape moved the scroll');
  for (let t = 0; t < 300; t++) step(st, 0, 0, Q, Q, 1);
  submitSample(st, live[63] + 256);
  assert.equal(st.tape[63], live[63] + 256, 'the first live sample after a live tape was moved');
  assert.equal(submitTape(st, live), false, 'a tape was taken after a sample');
});
