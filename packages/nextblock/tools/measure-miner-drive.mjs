// WHAT THE PLAYER ACTUALLY MEETS AT THE MINER (2026-09-20), step 2 of the drawn-versus-solid letter.
//
// The inventory (measure-miner-solids.mjs) says 452 of 904 drawn parts carry no solid box and 46 of those stand
// in the entry corridor below truck height. This drives the approach and asks the only question that matters to
// a player: WHERE does the truck end up inside something that is drawn?
//
// READ FROM THE CORE, NEVER FROM PhysX. The truck's Rigidbody is kinematic and its velocity is permanently zero,
// so Unity has nothing to say about where the truck is; `sim.js` does. The truck is the core's own shape - two
// circles of BODY_RADIUS at BODY_FRONT and BODY_REAR along the nose - and its roof is the body height above the
// ride, which is what passes through a lintel.
//
// Three drives, all with the core stepping exactly as the game steps it:
//   centre      straight down the lane at full throttle
//   drift left  the same with a steady left bias, the "drifts off the lane" case
//   drift right the mirror
//
//   node packages/nextblock/tools/measure-miner-drive.mjs
import { readFileSync } from 'node:fs';
import { init, step, teleport } from '../src/sim.js';
import { BODY_FRONT, BODY_REAR, BODY_RADIUS } from '../src/rules/solids.js';
import { MINER_X, MINER_DOOR_X } from '../src/rules/map.js';
import { O_TRUCK, T_X, T_Z, T_HEADING } from '../src/state.js';

const ONE = 65536, M = (q) => q / ONE;
const GLB = new URL('../../../unity-proto/Assets/Models/bitcoin_miner_megastructure.glb', import.meta.url).pathname;
const HEIGHT_SCALE = 0.45, MINER_ORIGIN = M(MINER_X);
const ROOF = 3.26;              // the truck body's height over the ground, PRIORITIES' own number
const RIDE = 0.36;              // its underside over the ground

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
      r = [1-2*(y*y+z*z), 2*(x*y-z*w), 2*(x*z+y*w), 0, 2*(x*y+z*w), 1-2*(x*x+z*z), 2*(y*z-x*w), 0,
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
      let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (const prim of meshes[n.mesh].primitives) {
        const acc = accessors[prim.attributes.POSITION];
        if (!acc || !acc.min || !acc.max) continue;
        for (const [sx, sy, sz] of [[acc.min[0],acc.min[1],acc.min[2]],[acc.max[0],acc.max[1],acc.max[2]],
          [acc.min[0],acc.min[1],acc.max[2]],[acc.min[0],acc.max[1],acc.min[2]],[acc.max[0],acc.min[1],acc.min[2]],
          [acc.min[0],acc.max[1],acc.max[2]],[acc.max[0],acc.min[1],acc.max[2]],[acc.max[0],acc.max[1],acc.min[2]]]) {
          const wx = world[0]*sx + world[1]*sy + world[2]*sz + world[3];
          const wy = world[4]*sx + world[5]*sy + world[6]*sz + world[7];
          const wz = world[8]*sx + world[9]*sy + world[10]*sz + world[11];
          lo = [Math.min(lo[0],wx), Math.min(lo[1],wy), Math.min(lo[2],wz)];
          hi = [Math.max(hi[0],wx), Math.max(hi[1],wy), Math.max(hi[2],wz)];
        }
      }
      if (Number.isFinite(lo[0])) out.push({ name: n.name || ('mesh' + idx),
        x0: MINER_ORIGIN - hi[0], x1: MINER_ORIGIN - lo[0],
        y0: lo[1] * HEIGHT_SCALE, y1: hi[1] * HEIGHT_SCALE, z0: -hi[2], z1: -lo[2] });
    }
    for (const k of n.children || []) walk(k, world);
  };
  for (const s of scenes[0].nodes) walk(s, [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
  return out;
}
const parts = minerParts().filter((p) => p.x1 > M(MINER_DOOR_X) - 5);

// The two circles the core resolves the truck by, in metres, at this pose.
const wheels = (x, z, h) => {
  const fx = Math.sin(h), fz = Math.cos(h);
  return [[x + fx * M(BODY_FRONT), z + fz * M(BODY_FRONT)], [x + fx * M(BODY_REAR), z + fz * M(BODY_REAR)]];
};
const R = M(BODY_RADIUS);

function drive(label, steer, startZ = 0) {
  const st = init(1), s = st.i32;
  // PUT THE TRUCK ON THE LANE AT THE DOOR AND DRIVE IN. Driving it out of the bay and across the map is the
  // delivery letter's business, not this one - measured, a straight full-throttle run from the spawn reaches only
  // x 68.8 m of a door at 108.31 m, so the approach never happens and nothing about the miner gets measured.
  // The question here is the geometry at the miner, so the truck is placed on the lane 12 m short of the door,
  // facing east, and driven in. `teleport` is the core's own.
  teleport(st, Math.round((M(MINER_DOOR_X) - 12) * ONE), Math.round(startZ * ONE), 16384);   // 16384 = +x
  const hits = new Map();
  let deepest = null, reached = -Infinity;
  for (let t = 0; t < 2400; t++) {
    step(st, ONE, steer, 0, 0, 0);
    const x = M(s[O_TRUCK + T_X]), z = M(s[O_TRUCK + T_Z]);
    const h = (s[O_TRUCK + T_HEADING] / ONE) * Math.PI * 2;
    reached = Math.max(reached, x);
    if (x < M(MINER_DOOR_X) - 10) continue;                 // only near the miner
    for (const [cx, cz] of wheels(x, z, h)) {
      for (const p of parts) {
        // a circle of R at (cx, cz), and the truck's body between RIDE and ROOF
        const dx = Math.max(p.x0 - cx, 0, cx - p.x1), dz = Math.max(p.z0 - cz, 0, cz - p.z1);
        if (Math.hypot(dx, dz) >= R) continue;
        if (p.y1 <= RIDE || p.y0 >= ROOF) continue;          // over the roof or under the belly: not met
        const depth = R - Math.hypot(dx, dz);
        const prev = hits.get(p.name);
        if (!prev || depth > prev.depth) hits.set(p.name, { depth, x, z, y0: p.y0, y1: p.y1 });
        if (!deepest || depth > deepest.depth) deepest = { name: p.name, depth, x, z };
      }
    }
  }
  const rows = [...hits.entries()].sort((a, b) => b[1].depth - a[1].depth);
  console.log(`\n  ${label}: reached x ${reached.toFixed(1)} m; ${rows.length} drawn parts entered`);
  for (const [name, r] of rows.slice(0, 12))
    console.log(`    ${name.slice(0, 26).padEnd(26)} ${r.depth.toFixed(2)} m inside, at x ${r.x.toFixed(1)} z ${r.z.toFixed(1)}`
      + `  (part y ${r.y0.toFixed(1)} .. ${r.y1.toFixed(1)})`);
  if (rows.length > 12) console.log(`    ... and ${rows.length - 12} more`);
  return rows.length;
}

console.log(`THE TRUCK AGAINST THE DRAWN MINER - from the core's state, never PhysX`);
console.log(`  truck: two circles of ${R.toFixed(2)} m at ${M(BODY_FRONT).toFixed(1)} and ${M(BODY_REAR).toFixed(1)} m along the nose;`
  + ` body ${RIDE} .. ${ROOF} m over the ground`);
console.log(`  door ${M(MINER_DOOR_X).toFixed(2)} m, face ${MINER_ORIGIN.toFixed(2)} m, ${parts.length} drawn parts near the miner`);
let total = 0;
total += drive('centre       ', 0, 0);
total += drive('drift left   ', -4000, 0);
total += drive('drift right  ', 4000, 0);
total += drive('offset z +20 ', 0, 20);
total += drive('offset z -20 ', 0, -20);
console.log(`\n  ${total} part-entries across the three drives.`);
