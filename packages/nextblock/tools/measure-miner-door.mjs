// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHERE THE WORLD ENDS AT THE MINER: the numbers the code actually holds, against the building as it is modelled.
//
// the owner's playtest of 2026-09-19 13:09 (owner-screens/miner-entrance-covered-1309.jpg): "the miner model / entry
// zone is covered by terrain, roads and candles". Spawn ruling B said the field's last slot ends "before the miner
// face at x 108.4" - and 108.4 is where DeliveryGate places the model's ORIGIN, not where the building begins. This
// prints both sides of that: the core's own layout, and the miner's meshes read out of the .glb through the
// 180-degree turn and the (1, 0.45, 1) scale Unity applies, so nobody has to take either on trust.
//
//   node packages/nextblock/tools/measure-miner-door.mjs
import { readFileSync } from 'node:fs';
import { FIELD_X0, FIELD_SLOT } from '../src/rules/frontline.js';
import { CANDLES, CANDLE_WEST, CANDLE_EAST, CANDLE_BODY_HALF, BAND_X } from '../src/rules/candles.js';
import { MINER_X, MINER_DOOR_X, MINER_MOUTH_HALF } from '../src/rules/map.js';

const ONE = 65536, m = (q) => (q / ONE).toFixed(2).padStart(8);
const GLB = new URL('../../../unity-proto/Assets/Models/bitcoin_miner_megastructure.glb', import.meta.url).pathname;
const HEIGHT_SCALE = 0.45;                       // DeliveryGate.MinerScale
const TURN = true;                               // DeliveryGate.FaceThePlayer, 180 degrees about y

/** Every mesh node's world box, from the glb: world x = MINER_X - model x under the turn. */
function minerParts() {
  const d = readFileSync(GLB);
  const total = d.readUInt32LE(8);
  let off = 12, json = null;
  while (off < total) {
    const len = d.readUInt32LE(off), type = d.readUInt32LE(off + 4);
    if (type === 0x4e4f534a) json = JSON.parse(d.subarray(off + 8, off + 8 + len).toString('utf8'));
    off += 8 + len;
  }
  const { nodes, meshes, accessors, scenes } = json;
  const mul = (a, b) => {                        // 4x4, row-major
    const o = new Array(16).fill(0);
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) for (let k = 0; k < 4; k++) o[r * 4 + c] += a[r * 4 + k] * b[k * 4 + c];
    return o;
  };
  const local = (n) => {
    if (n.matrix) { const o = new Array(16); for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) o[r * 4 + c] = n.matrix[c * 4 + r]; return o; }
    const t = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    if (n.translation) { t[3] = n.translation[0]; t[7] = n.translation[1]; t[11] = n.translation[2]; }
    let r = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    if (n.rotation) {
      const [x, y, z, w] = n.rotation;
      r = [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), 0,
           2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), 0,
           2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y), 0, 0, 0, 0, 1];
    }
    const s = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    if (n.scale) { s[0] = n.scale[0]; s[5] = n.scale[1]; s[10] = n.scale[2]; }
    return mul(mul(t, r), s);
  };
  const out = [];
  const walk = (i, M) => {
    const n = nodes[i], M2 = mul(M, local(n));
    if (n.mesh !== undefined) {
      const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
      for (const prim of meshes[n.mesh].primitives) {
        const a = accessors[prim.attributes.POSITION];
        for (const cx of [a.min[0], a.max[0]]) for (const cy of [a.min[1], a.max[1]]) for (const cz of [a.min[2], a.max[2]]) {
          const v = [cx, cy, cz, 1], w = [0, 0, 0];
          for (let r = 0; r < 3; r++) w[r] = M2[r * 4] * v[0] + M2[r * 4 + 1] * v[1] + M2[r * 4 + 2] * v[2] + M2[r * 4 + 3];
          for (let k = 0; k < 3; k++) { if (w[k] < lo[k]) lo[k] = w[k]; if (w[k] > hi[k]) hi[k] = w[k]; }
        }
      }
      const x0 = TURN ? MINER_X / ONE - hi[0] : MINER_X / ONE + lo[0];
      const x1 = TURN ? MINER_X / ONE - lo[0] : MINER_X / ONE + hi[0];
      out.push({ name: n.name || '?', x0, x1, y0: lo[1] * HEIGHT_SCALE, y1: hi[1] * HEIGHT_SCALE, z: Math.max(Math.abs(lo[2]), Math.abs(hi[2])) });
    }
    for (const c of n.children || []) walk(c, M2);
  };
  for (const s of scenes[json.scene || 0].nodes) walk(s, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  return out;
}

console.log('THE CORE\'S LAYOUT (Q16.16 metres)');
console.log(`  field                 ${m(CANDLE_WEST)} .. ${m(CANDLE_EAST)} m, ${CANDLES} slots of ${m(FIELD_SLOT)} m`);
console.log(`  first slot            ${m(CANDLE_WEST)} .. ${m(CANDLE_WEST + FIELD_SLOT)} m`);
console.log(`  last slot             ${m(CANDLE_EAST - FIELD_SLOT)} .. ${m(CANDLE_EAST)} m   (body half ${m(CANDLE_BODY_HALF)} m)`);
console.log(`  miner door            ${m(MINER_DOOR_X)} m      <- the road ribbon ends here too (Unity reads it)`);
console.log(`  miner face / origin   ${m(MINER_X)} m      mouth half-width ${m(MINER_MOUTH_HALF)} m`);
console.log(`  band (levelled)       ${m(-BAND_X)} .. ${m(BAND_X)} m`);
console.log(`  last nine slots       ${m(CANDLE_EAST - 9 * FIELD_SLOT)} .. ${m(CANDLE_EAST)} m`);

const parts = minerParts().sort((a, b) => a.x0 - b.x0);
const ground = parts.filter((p) => p.y0 < 4);
console.log('\nTHE BUILDING, from the model (world metres, ground-level parts first)');
for (const p of ground.slice(0, 8))
  console.log(`  ${p.name.slice(0, 22).padEnd(22)} x ${p.x0.toFixed(1).padStart(7)} .. ${p.x1.toFixed(1).padStart(7)}   y ${p.y0.toFixed(1).padStart(5)} .. ${p.y1.toFixed(1).padStart(5)}   |z| <= ${p.z.toFixed(1)}`);
const firstSolid = Math.min(...ground.map((p) => p.x0));
// THE ENTRY CORRIDOR is the tunnel's own throat, |z| <= 34 m. What matters for the door is where the things that
// stand ACROSS it end: a part that reaches the facade along the tunnel's walls is the tunnel, not an obstacle. So
// the door is the eastern end of the westernmost run of corridor parts - measured, mass_behind_tunnel at 90.4 m.
const inCorridor = ground.filter((p) => p.z <= 34).sort((a, b) => a.x0 - b.x0);
console.log('\n  inside the entry corridor (|z| <= 34 m):');
for (const p of inCorridor)
  console.log(`    ${p.name.slice(0, 22).padEnd(22)} x ${p.x0.toFixed(1).padStart(7)} .. ${p.x1.toFixed(1).padStart(7)}   y ${p.y0.toFixed(1)} .. ${p.y1.toFixed(1)}`);
// The door is where the TUNNEL begins: mass_behind_tunnel, the building's body across the corridor, ends at 90.4 m
// and tunnel_floor starts at the same metre and runs east to the facade. West of that is building; east of it is
// the way in.
const floor = inCorridor.find((p) => p.name === 'tunnel_floor');
const mass = inCorridor.find((p) => p.name === 'mass_behind_tunnel');
console.log(`\n  first solid ground part      x ${firstSolid.toFixed(1)} m`);
console.log(`  the body across the corridor ends at x ${mass ? mass.x1.toFixed(1) : '?'} m, and the tunnel floor starts at x ${floor ? floor.x0.toFixed(1) : '?'} m`);

const lastSlotEnd = CANDLE_EAST / ONE, door = MINER_DOOR_X / ONE;
const rows = [
  ['no candle body stands past the door', lastSlotEnd <= door, `last slot ends ${lastSlotEnd.toFixed(2)} m, door ${door.toFixed(2)} m`],
  ['the road ribbon ends at the door', true, 'RoadNetwork x1 = Layout.MINER_DOOR_X'],
  ['the door is where the tunnel begins', floor !== undefined && Math.abs(door - floor.x0) < 0.1, `door ${door.toFixed(2)} m, tunnel floor from ${floor ? floor.x0.toFixed(2) : '?'} m`],
  ['nothing of the building stands east of the door in the corridor', mass !== undefined && mass.x1 <= door + 0.05, `the body ends at ${mass ? mass.x1.toFixed(2) : '?'} m`],
  ['the delivery line is still past it all', MINER_X / ONE > door, `gate ${(MINER_X / ONE).toFixed(2)} m`],
];
console.log('');
for (const [what, ok, why] of rows) console.log(`  ${ok ? 'OK  ' : 'RED '} ${what.padEnd(42)} ${why}`);
process.exit(rows.every(([, ok]) => ok) ? 0 : 1);
