#!/usr/bin/env node
/** Courier runs: through the seam vs along the rim, then into the mouth. */
import { init, step, setHeat, HALF_Z } from "../src/sim.js";
import { O_TRUCK, O_SCORE, T_X, T_Z, T_HP, S_STATE } from "../src/state.js";
import { ONE } from "../src/fixed.js";
import { frontlineZ } from "../src/rules/frontline.js";
import { RUN_DELIVERED, RUN_WRECKED, RUN_MISSED, BLOCK_TICKS, GATE_X } from "../src/rules/gate.js";

const Q = 65536;
const q = (v) => v / Q;
const HALF_X = Math.imul(130, ONE);
const RIM = Math.imul(62, ONE);

function runOne(seed, mode, heat01) {
  const st = init(seed);
  setHeat(st, Math.round(heat01 * ONE));
  const s = st.i32;
  const T = O_TRUCK;
  for (let t = 0; t < BLOCK_TICKS; t++) {
    const x = s[T + T_X];
    const z = s[T + T_Z];
    const seam = frontlineZ(st.tape, x, HALF_X, HALF_Z);
    const nearGate = x > GATE_X - Math.imul(28, ONE);
    let wantZ = 0;
    if (!nearGate) wantZ = mode === "seam" ? seam : RIM;
    let steer = wantZ - z;
    if (steer > ONE) steer = ONE;
    if (steer < -ONE) steer = -ONE;
    step(st, ONE, steer, 0, 0, 0);
    const stt = s[O_SCORE + S_STATE];
    if (stt !== 0) {
      return { seed, mode, state: stt, tick: t, x: q(x), z: q(z), hp: q(s[T + T_HP]) };
    }
  }
  return { seed, mode, state: s[O_SCORE + S_STATE], tick: BLOCK_TICKS, x: q(s[T + T_X]), z: q(s[T + T_Z]), hp: q(s[T + T_HP]) };
}

function tally(rows) {
  const t = { n: rows.length, delivered: 0, wrecked: 0, missed: 0 };
  for (const r of rows) {
    if (r.state === RUN_DELIVERED) t.delivered++;
    else if (r.state === RUN_WRECKED) t.wrecked++;
    else t.missed++;
  }
  t.pct = t.n ? Math.round((t.delivered / t.n) * 1000) / 10 : 0;
  return t;
}

const n = Number(process.argv[2] || 40);
const seam = [];
const rim = [];
for (let i = 1; i <= n; i++) seam.push(runOne(i, "seam", 1));
for (let i = n + 1; i <= n * 2; i++) rim.push(runOne(i, "rim", 1));
const out = { n: n * 2, seam: tally(seam), rim: tally(rim) };
console.log(JSON.stringify(out, null, 2));
console.log(`seam ${out.seam.delivered}/${out.seam.n} = ${out.seam.pct}%  wrecked ${out.seam.wrecked} missed ${out.seam.missed}`);
console.log(`rim  ${out.rim.delivered}/${out.rim.n} = ${out.rim.pct}%  wrecked ${out.rim.wrecked} missed ${out.rim.missed}`);
