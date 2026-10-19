// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE DRAWN MINER AGAINST THE SOLID ONE, PART BY PART (2026-09-20).
//
// PRIORITIES: "The drawn miner is bigger than either engine's collision. A tank can stand in a drawn cable; the
// truck's roof passes through mass_behind_tunnel by 0.56 m." That is one row. This is the whole table.
//
// THE TWO ENGINES CARRY THE SAME FIVE BOXES, and that is checked here rather than taken from the note:
//   core   packages/nextblock/src/rules/map.js mapSolids() - two facade sides, the lintel over the mouth, two tunnel
//          walls.
//   C#     Cargo/DeliveryGate.cs Slab() - "ShellLeft"/"ShellRight", the lintel, "TunnelLeft"/"TunnelRight", built
//          at the same local centres and sizes under the same 180-degree turn and (1, 0.45, 1) scale.
// So there is one solid world to measure against, and every difference below is drawn-versus-solid, not
// engine-versus-engine.
//
// For every mesh in the .glb, read through Unity's turn and scale exactly as DeliveryGate places it:
//   - is any part of it inside a solid box at all?
//   - how far does the drawn surface reach past the nearest box, in metres, on each axis?
// A part with no box is a thing a player can drive or stand inside. A part that overhangs is a roof to clip.
//
//   node packages/nextblock/tools/measure-miner-solids.mjs
import { readFileSync } from 'node:fs';
import { mapSolids, MAP_BOXES, MINER_X, MINER_DOOR_X, MINER_MOUTH_HALF } from '../src/rules/map.js';
import { BOX_WORDS } from '../src/rules/solids.js';
import { init } from '../src/sim.js';

const ONE = 65536, M = (q) => q / ONE;
const GLB = new URL('../../../unity-proto/Assets/Models/bitcoin_miner_megastructure.glb', import.meta.url).pathname;
const HEIGHT_SCALE = 0.45;                       // DeliveryGate.MinerScale
const MINER_ORIGIN = M(MINER_X);

/** Every mesh node's world box, from the glb, through the 180-degree turn and the height scale. */
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
  const mul = (a, b) => { const o = new Array(16).fill(0);
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) for (let k = 0; k < 4; k++) o[r * 4 + c] += a[r * 4 + k] * b[k * 4 + c];
    return o; };
  const local = (n) => {
    if (n.matrix) { const o = new Array(16); for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) o[r * 4 + c] = n.matrix[c * 4 + r]; return o; }
    const t = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
    if (n.translation) { t[3] = n.translation[0]; t[7] = n.translation[1]; t[11] = n.translation[2]; }
    let r = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
    if (n.rotation) { const [x, y, z, w] = n.rotation;
      r = [1-2*(y*y+z*z), 2*(x*y-z*w), 2*(x*z+y*w), 0,
           2*(x*y+z*w), 1-2*(x*x+z*z), 2*(y*z-x*w), 0,
           2*(x*z-y*w), 2*(y*z+x*w), 1-2*(x*x+y*y), 0, 0,0,0,1]; }
    let s = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
    if (n.scale) { s[0] = n.scale[0]; s[5] = n.scale[1]; s[10] = n.scale[2]; }
    return mul(mul(t, r), s);
  };
  const out = [];
  const walk = (idx, parent) => {
    const n = nodes[idx];
    const world = mul(parent, local(n));
    if (n.mesh !== undefined) {
      const mesh = meshes[n.mesh];
      let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (const prim of mesh.primitives) {
        const acc = accessors[prim.attributes.POSITION];
        if (!acc || !acc.min || !acc.max) continue;
        for (const [sx, sy, sz] of [[acc.min[0], acc.min[1], acc.min[2]], [acc.max[0], acc.max[1], acc.max[2]],
          [acc.min[0], acc.min[1], acc.max[2]], [acc.min[0], acc.max[1], acc.min[2]], [acc.max[0], acc.min[1], acc.min[2]],
          [acc.min[0], acc.max[1], acc.max[2]], [acc.max[0], acc.min[1], acc.max[2]], [acc.max[0], acc.max[1], acc.min[2]]]) {
          const wx = world[0]*sx + world[1]*sy + world[2]*sz + world[3];
          const wy = world[4]*sx + world[5]*sy + world[6]*sz + world[7];
          const wz = world[8]*sx + world[9]*sy + world[10]*sz + world[11];
          lo = [Math.min(lo[0], wx), Math.min(lo[1], wy), Math.min(lo[2], wz)];
          hi = [Math.max(hi[0], wx), Math.max(hi[1], wy), Math.max(hi[2], wz)];
        }
      }
      if (Number.isFinite(lo[0])) out.push({
        name: n.name || ('mesh' + idx),
        // the turn about y puts model +x to world -x about the origin; the height scale is Unity's
        x0: MINER_ORIGIN - hi[0], x1: MINER_ORIGIN - lo[0],
        y0: lo[1] * HEIGHT_SCALE, y1: hi[1] * HEIGHT_SCALE,
        z0: -hi[2], z1: -lo[2],
      });
    }
    for (const k of n.children || []) walk(k, world);
  };
  for (const s of scenes[0].nodes) walk(s, [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
  return out;
}

// The solid world, from the core itself - the same boxes the C# Slab() calls build.
const st = init(1);
const { n, box } = mapSolids(st.ground, st.halfX ?? (104 * ONE), st.halfZ ?? (104 * ONE));
const boxes = [];
for (let i = 0; i < n; i++) {
  const b = i * BOX_WORDS;
  const cx = M(box[b]), cz = M(box[b + 1]), hx = M(box[b + 2]), hz = M(box[b + 3]);
  boxes.push({ x0: cx - hx, x1: cx + hx, z0: cz - hz, z1: cz + hz, y0: M(box[b + 4]), y1: M(box[b + 5]) });
}
// The miner's own boxes are the ones standing east of the door.
const minerBoxes = boxes.filter((b) => b.x1 > M(MINER_DOOR_X));

const overlap = (a0, a1, b0, b1) => Math.min(a1, b1) - Math.max(a0, b0);
const past = (p) => {
  // how far the drawn surface reaches beyond EVERY box, on each axis: the smallest overhang over all boxes
  let best = null;
  for (const b of minerBoxes) {
    const ox = overlap(p.x0, p.x1, b.x0, b.x1), oy = overlap(p.y0, p.y1, b.y0, b.y1), oz = overlap(p.z0, p.z1, b.z0, b.z1);
    if (ox <= 0 || oy <= 0 || oz <= 0) continue;                       // this box does not touch the part at all
    const outX = Math.max(0, b.x0 - p.x0) + Math.max(0, p.x1 - b.x1);
    const outY = Math.max(0, b.y0 - p.y0) + Math.max(0, p.y1 - b.y1);
    const outZ = Math.max(0, b.z0 - p.z0) + Math.max(0, p.z1 - b.z1);
    const total = outX + outY + outZ;
    if (best === null || total < best.total) best = { total, outX, outY, outZ };
  }
  return best;
};

const parts = minerParts().sort((a, b) => a.x0 - b.x0);
console.log(`THE MINER: ${parts.length} drawn parts against ${minerBoxes.length} solid boxes `
  + `(the same five each engine builds)\n`);
console.log(`  door ${M(MINER_DOOR_X).toFixed(2)} m, face/origin ${MINER_ORIGIN.toFixed(2)} m, mouth half ${M(MINER_MOUTH_HALF).toFixed(2)} m`);
console.log(`  the solid boxes stand at x ${Math.min(...minerBoxes.map((b) => b.x0)).toFixed(1)} .. ${Math.max(...minerBoxes.map((b) => b.x1)).toFixed(1)} m\n`);
console.log('  part                        x range            y range        |z| max   solid?');
let none = 0, over = 0;
const noBox = [];
for (const p of parts) {
  const b = past(p);
  const tag = b === null ? 'NO BOX' : (b.total > 0.01 ? `over by ${b.total.toFixed(2)} m` : 'covered');
  if (b === null) { none++; noBox.push(p); } else if (b.total > 0.01) over++;
  console.log(`  ${p.name.slice(0, 26).padEnd(26)} ${p.x0.toFixed(1).padStart(7)} ..${p.x1.toFixed(1).padStart(7)}`
    + `  ${p.y0.toFixed(1).padStart(5)} ..${p.y1.toFixed(1).padStart(6)}`
    + `  ${Math.max(Math.abs(p.z0), Math.abs(p.z1)).toFixed(1).padStart(6)}   ${tag}`);
}
console.log(`\n  ${none} drawn parts have NO solid box at all; ${over} overhang the box they touch.`);
const inCorridor = noBox.filter((p) => Math.max(Math.abs(p.z0), Math.abs(p.z1)) <= 40 && p.y0 < 4);
console.log(`  of the ${none} with no box, ${inCorridor.length} stand in the entry corridor below 4 m - a truck's height:`);
for (const p of inCorridor) console.log(`    ${p.name.slice(0, 26).padEnd(26)} x ${p.x0.toFixed(1)} .. ${p.x1.toFixed(1)}  y ${p.y0.toFixed(1)} .. ${p.y1.toFixed(1)}`);
