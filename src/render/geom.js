import * as THREE from 'three';
import { RoundedBoxGeometry } from '../../vendor/addons/geometries/RoundedBoxGeometry.js';
import { pbr } from './surfaces.js';
import { Q } from '../quality.js';

/**
 * Model kit. Everything here bakes a multi-part model down to ONE BufferGeometry
 * with baked vertex colours, so a whole army still renders in a single
 * instanced draw call. Team colour comes from instanceColor, which the shader
 * multiplies with the baked vertex colour — so a 0x222222 rifle stays near-black
 * on a green soldier and a red one.
 */

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();

/** Compose a transform without allocating. */
export function xf(x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  _e.set(rx, ry, rz);
  _q.setFromEuler(_e);
  _v.set(x, y, z);
  _s.set(sx, sy, sz);
  return new THREE.Matrix4().compose(_v, _q, _s);
}

/** Merge [{geo, m, color}] into one vertex-coloured geometry. */
export function mergeParts(parts) {
  let total = 0;
  const prepped = [];
  for (const part of parts) {
    const g = part.geo.index ? part.geo.toNonIndexed() : part.geo.clone();
    if (part.m) g.applyMatrix4(part.m);
    if (!g.attributes.normal) g.computeVertexNormals();
    total += g.attributes.position.count;
    prepped.push({ g, c: new THREE.Color(part.color ?? 0xffffff) });
  }
  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  const col = new Float32Array(total * 3);
  let o = 0;
  for (const { g, c } of prepped) {
    const n = g.attributes.position.count;
    pos.set(g.attributes.position.array.subarray(0, n * 3), o * 3);
    nor.set(g.attributes.normal.array.subarray(0, n * 3), o * 3);
    for (let i = 0; i < n; i++) {
      col[(o + i) * 3] = c.r; col[(o + i) * 3 + 1] = c.g; col[(o + i) * 3 + 2] = c.b;
    }
    o += n;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.computeBoundingSphere();
  return out;
}

/**
 * Hard 90-degree edges are the single strongest "toy brick" cue: real objects
 * catch a highlight along every edge because nothing is perfectly sharp. So the
 * default box is chamfered. Instanced crowds keep the cheap one — a rounded box
 * is ~16x the triangles and there are hundreds of them.
 */
const box = (w, h, d) => {
  const r = Math.min(0.06, Math.min(w, h, d) * 0.22);
  if (r < 0.012) return new THREE.BoxGeometry(w, h, d);
  return new RoundedBoxGeometry(w, h, d, 1, r);
};
const plainBox = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const bevelBox = (w, h, d, r = 0.12, seg = 2) => new RoundedBoxGeometry(w, h, d, seg, r);
const cyl = (r1, r2, h, seg = 8, hSeg = 1, open = false, start = 0, len = Math.PI * 2) =>
  new THREE.CylinderGeometry(r1, r2, Math.max(0.001, h), Math.max(seg, Q.mobile ? 8 : 14), hSeg, open, start, len);

/* --------------------------------------------------------------- soldier */

/**
 * Infantry is split into a body and two legs so the legs can actually swing —
 * a marching soldier needs a hip joint, and a single merged mesh can't have one.
 * Three instanced meshes per side, still three draw calls for 240 men.
 * Everything faces +Z, the direction that side advances.
 */
export const HIP_Y = 0.9;

export function makeSoldierBody() {
  const SKIN = 0xd9a06b, GEAR = 0x6b6152, STEEL = 0x2b2f36;
  return mergeParts([
    // torso + webbing
    { geo: box(0.78, 0.82, 0.46), m: xf(0, 1.26, 0), color: 0xffffff },
    { geo: box(0.84, 0.22, 0.5), m: xf(0, 1.14, 0), color: GEAR },
    { geo: box(0.72, 0.2, 0.42), m: xf(0, 0.9, 0), color: GEAR },        // hips
    // backpack
    { geo: box(0.54, 0.56, 0.28), m: xf(0, 1.32, -0.34), color: GEAR },
    { geo: box(0.2, 0.2, 0.2), m: xf(0.2, 1.07, -0.42), color: STEEL },
    // arms
    { geo: box(0.2, 0.62, 0.22), m: xf(-0.5, 1.26, 0.06), color: 0xffffff },
    { geo: box(0.2, 0.5, 0.34), m: xf(0.48, 1.3, 0.2, -0.5, 0, 0), color: 0xffffff },
    // head + helmet
    { geo: box(0.36, 0.36, 0.34), m: xf(0, 1.85, 0.02), color: SKIN },
    { geo: cyl(0.3, 0.32, 0.2, 10), m: xf(0, 2.05, 0), color: STEEL },
    { geo: box(0.6, 0.07, 0.62), m: xf(0, 1.97, 0.02), color: STEEL },
    // rifle
    { geo: box(0.09, 0.11, 1.0), m: xf(0.44, 1.34, 0.42), color: 0x14171c },
    { geo: box(0.08, 0.24, 0.26), m: xf(0.44, 1.22, 0.08), color: 0x14171c },
  ]);
}

/** One leg, pivoting about the origin (the hip) and hanging down HIP_Y. */
export function makeSoldierLeg() {
  const DARK = 0x3a3f47, STEEL = 0x2b2f36;
  return mergeParts([
    { geo: box(0.3, 0.86, 0.3), m: xf(0, -0.45, 0), color: DARK },
    { geo: box(0.34, 0.2, 0.5), m: xf(0, -0.82, 0.08), color: STEEL },
  ]);
}

/* ------------------------------------------------------------------ tank */

/** Height of the turret ring above the hull's ground origin. */
export const TURRET_Y = 1.85;

/** Tank hull, ~7 long, facing +Z. Turret is a separate mesh so it can traverse. */
export function makeTankHull() {
  const HULL = 0xffffff, TRACK = 0x1b1f26, DETAIL = 0x3d434d;
  return mergeParts([
    // tracks
    { geo: box(0.95, 1.15, 6.6), m: xf(-1.75, 0.62, 0), color: TRACK },
    { geo: box(0.95, 1.15, 6.6), m: xf(1.75, 0.62, 0), color: TRACK },
    // road wheels
    ...[-2.2, -0.75, 0.75, 2.2].flatMap((z) => [
      { geo: cyl(0.45, 0.45, 0.5, 8), m: xf(-1.75, 0.6, z, 0, 0, Math.PI / 2), color: DETAIL },
      { geo: cyl(0.45, 0.45, 0.5, 8), m: xf(1.75, 0.6, z, 0, 0, Math.PI / 2), color: DETAIL },
    ]),
    // hull
    { geo: box(3.3, 0.9, 6.0), m: xf(0, 1.42, 0), color: HULL },
    // sloped glacis plate
    { geo: box(3.1, 0.28, 1.9), m: xf(0, 1.62, 2.7, -0.62, 0, 0), color: HULL },
    { geo: box(3.2, 0.22, 1.4), m: xf(0, 1.55, -2.9, 0.5, 0, 0), color: HULL },
    // fenders
    { geo: box(4.0, 0.16, 5.6), m: xf(0, 1.22, 0), color: DETAIL },
    // turret ring
    { geo: cyl(1.0, 1.0, 0.2, 12), m: xf(0, 1.82, -0.25), color: DETAIL },
  ]);
}

/** Turret, pivoting about the origin (the turret ring). Gun points +Z. */
export function makeTankTurret() {
  const HULL = 0xffffff, DETAIL = 0x3d434d, STEEL = 0x2a2e35;
  return mergeParts([
    { geo: box(2.3, 0.86, 2.7), m: xf(0, 0.43, 0), color: HULL },
    { geo: box(1.9, 0.3, 2.3), m: xf(0, 0.91, 0), color: HULL },
    // mantlet + barrel
    { geo: box(0.9, 0.6, 0.7), m: xf(0, 0.45, 1.45), color: DETAIL },
    { geo: cyl(0.17, 0.19, 3.6, 8), m: xf(0, 0.47, 3.15, Math.PI / 2, 0, 0), color: STEEL },
    { geo: cyl(0.26, 0.26, 0.5, 8), m: xf(0, 0.47, 4.75, Math.PI / 2, 0, 0), color: STEEL },
    // cupola, MG, stowage, antenna
    { geo: cyl(0.4, 0.42, 0.34, 8), m: xf(-0.55, 1.05, -0.25), color: DETAIL },
    { geo: box(0.14, 0.14, 0.9), m: xf(0.55, 1.1, 0.45), color: 0x14171c },
    { geo: box(1.6, 0.35, 0.5), m: xf(0, 0.65, -1.5), color: 0x5a5140 },
    { geo: cyl(0.04, 0.03, 2.2, 4), m: xf(0.9, 1.75, -0.85, 0.12, 0, 0.1), color: STEEL },
  ]);
}

/* ---------------------------------------------------------------- bomber */

/**
 * Twin-engine bomber, ~14 long, nose pointing +X (its own travel direction).
 * Returned as a Group, not merged, because each plane animates independently
 * (banking, prop spin) and there are only a handful at a time.
 */
export function makeBomber(tint = 0x9aa6b8) {
  const g = new THREE.Group();
  const body = pbr(tint, { roughness: 0.42, metalness: 0.62, normalScale: 0.3 });
  const dark = pbr(0x2a3038, { roughness: 0.6, metalness: 0.45 });
  const glass = new THREE.MeshPhysicalMaterial({ color: 0x121c28, roughness: 0.06, metalness: 0.1, transmission: 0.25, thickness: 0.4, clearcoat: 1, clearcoatRoughness: 0.05, envMapIntensity: 2 });

  const add = (geo, mat, m) => { const mesh = new THREE.Mesh(geo, mat); mesh.applyMatrix4(m); mesh.castShadow = true; g.add(mesh); return mesh; };

  add(cyl(0.9, 0.62, 12, 10), body, xf(0, 0, 0, 0, 0, -Math.PI / 2));       // fuselage
  add(cyl(0.62, 0.05, 2.2, 10), body, xf(6.9, 0, 0, 0, 0, -Math.PI / 2));   // nose cone
  add(box(1.1, 0.7, 1.2), glass, xf(3.6, 0.55, 0));                          // cockpit
  add(box(2.6, 0.26, 15), body, xf(-0.4, -0.15, 0));                         // main wing
  add(box(1.5, 0.22, 5.4), body, xf(-5.2, 0.15, 0));                         // tailplane
  add(box(1.4, 2.6, 0.24), body, xf(-5.4, 1.3, 0));                          // fin
  add(box(2.2, 0.3, 1.0), dark, xf(0.2, -0.55, 0));                          // bomb bay

  const props = [];
  for (const s of [-4.2, 4.2]) {
    add(cyl(0.55, 0.42, 3.0, 8), dark, xf(0.3, -0.2, s, 0, 0, -Math.PI / 2));   // nacelle
    const prop = add(box(0.14, 4.0, 0.3), dark, xf(1.9, -0.2, s));              // propeller disc
    props.push(prop);
    add(cyl(0.34, 0.34, 0.4, 8), body, xf(0.5, -0.75, s, 0, 0, -Math.PI / 2));  // gear pod
  }
  g.userData.props = props;
  return g;
}

export function makeBomb() {
  return mergeParts([
    { geo: cyl(0.28, 0.28, 1.5, 8), m: xf(0, 0, 0, Math.PI / 2, 0, 0), color: 0x33383f },
    { geo: cyl(0.28, 0.02, 0.7, 8), m: xf(0, 0, 0.95, Math.PI / 2, 0, 0), color: 0x33383f },
    { geo: box(0.06, 0.7, 0.7), m: xf(0, 0, -0.75), color: 0x8a9199 },
    { geo: box(0.7, 0.06, 0.7), m: xf(0, 0, -0.75), color: 0x8a9199 },
  ]);
}

/* -------------------------------------------------------------- fortress */

/** Roadside drama: sandbag nests, barriers, burnt-out wrecks. */
export function makeSandbags() {
  const parts = [];
  for (let row = 0; row < 3; row++) {
    for (let i = 0; i < 5 - row; i++) {
      parts.push({
        geo: box(0.9, 0.4, 0.55),
        m: xf(-1.8 + row * 0.45 + i * 0.95, 0.2 + row * 0.38, 0, 0, (i % 2) * 0.18, 0),
        color: row % 2 ? 0x8a7f63 : 0x9c9070,
      });
    }
  }
  return mergeParts(parts);
}

export function makeBarrier() {
  return mergeParts([
    { geo: box(3.0, 0.28, 0.5), m: xf(0, 1.05, 0), color: 0xd8dde5 },
    { geo: box(3.0, 0.28, 0.5), m: xf(0, 0.62, 0), color: 0xd8dde5 },
    { geo: box(0.28, 1.3, 0.28), m: xf(-1.3, 0.65, 0), color: 0x6d7480 },
    { geo: box(0.28, 1.3, 0.28), m: xf(1.3, 0.65, 0), color: 0x6d7480 },
  ]);
}

/* ----------------------------------------------------------------- truck */

/**
 * Armoured mail truck. Built from tapered and rotated forms rather than stacked
 * cubes — raked windscreen, curved cargo roof, wheel arches, bumper, mirrors,
 * exhaust — so it reads as a vehicle rather than a pile of boxes. Nose faces +X.
 */
export function makeTruckBody(spec) {
  const s = spec.capacity > 8000 ? 1.3 : spec.capacity > 5000 ? 1.12 : spec.id === 'express' ? 0.94 : 1;
  const SHELL = 0xffffff, TRIM = 0xf0a83c, GLASS = 0x1b2836, DARK = 0x23272e;
  const STEEL = 0x8a93a2, LIGHT = 0xfff2c4, RED = 0xd8452f;
  const P = [];
  const add = (geo, m, color) => P.push({ geo, m, color });

  // chassis rails + fuel tank
  add(box(15 * s, 0.5 * s, 0.55 * s), xf(-0.4 * s, 1.5 * s, 1.55 * s), DARK);
  add(box(15 * s, 0.5 * s, 0.55 * s), xf(-0.4 * s, 1.5 * s, -1.55 * s), DARK);
  add(cyl(0.62 * s, 0.62 * s, 2.4 * s, 10), xf(-1.2 * s, 1.5 * s, 2.1 * s, 0, 0, Math.PI / 2), STEEL);

  // cargo body: flat sides, curved roof
  add(box(8.6 * s, 4.4 * s, 5 * s), xf(-2.2 * s, 4.3 * s, 0), SHELL);
  add(cyl(2.5 * s, 2.5 * s, 8.6 * s, 14, 1, false, 0, Math.PI), xf(-2.2 * s, 6.4 * s, 0, 0, 0, Math.PI / 2), SHELL);
  add(box(8.7 * s, 0.9 * s, 5.1 * s), xf(-2.2 * s, 3.1 * s, 0), TRIM);          // livery band
  add(box(0.35 * s, 3.4 * s, 4.7 * s), xf(-6.6 * s, 4.2 * s, 0), DARK);          // rear door
  add(box(0.5 * s, 0.6 * s, 5.2 * s), xf(-6.8 * s, 2.1 * s, 0), STEEL);          // rear bumper
  for (const z of [-1.6, 1.6]) add(box(0.2 * s, 0.5 * s, 0.5 * s), xf(-6.9 * s, 2.9 * s, z * s), RED);

  // cab: tapered nose, raked screen, roof fairing
  add(box(3.9 * s, 3.2 * s, 4.7 * s), xf(4.1 * s, 3.7 * s, 0), SHELL);
  add(box(1.7 * s, 2.0 * s, 4.6 * s), xf(6.4 * s, 2.9 * s, 0, 0, 0, -0.22), SHELL);   // sloped nose
  add(box(0.4 * s, 2.1 * s, 4.3 * s), xf(5.9 * s, 4.6 * s, 0, 0, 0, -0.42), GLASS);   // windscreen
  for (const z of [-2.4, 2.4]) add(box(3.4 * s, 1.5 * s, 0.18 * s), xf(4.1 * s, 4.2 * s, z * s), GLASS);
  add(cyl(1.5 * s, 1.5 * s, 4.6 * s, 12, 1, false, 0, Math.PI), xf(4.2 * s, 5.3 * s, 0, 0, 0, Math.PI / 2), TRIM);

  // bumper, grille, lights
  add(box(0.7 * s, 0.8 * s, 5.1 * s), xf(7.2 * s, 2.1 * s, 0), STEEL);
  add(box(0.3 * s, 1.0 * s, 3.4 * s), xf(7.15 * s, 3.1 * s, 0), DARK);
  for (const z of [-1.8, 1.8]) {
    add(cyl(0.42 * s, 0.42 * s, 0.3 * s, 10), xf(7.3 * s, 3.2 * s, z * s, 0, 0, Math.PI / 2), LIGHT);
  }
  // mirrors + exhaust + horn
  for (const z of [-2.7, 2.7]) {
    add(box(0.12 * s, 0.9 * s, 0.12 * s), xf(5.6 * s, 5.1 * s, z * s), DARK);
    add(box(0.16 * s, 0.75 * s, 0.5 * s), xf(5.6 * s, 5.6 * s, z * s), DARK);
  }
  add(cyl(0.26 * s, 0.24 * s, 4.2 * s, 8), xf(2.0 * s, 5.2 * s, -2.55 * s), STEEL);
  add(cyl(0.3 * s, 0.3 * s, 0.8 * s, 8), xf(3.2 * s, 6.6 * s, 2.3 * s, 0, 0, Math.PI / 2), TRIM);

  // wheel arches
  for (const [wx, wz] of [[4.2, 2.6], [4.2, -2.6], [-3.6, 2.6], [-3.6, -2.6]]) {
    add(cyl(1.95 * s, 1.95 * s, 0.5 * s, 12, 1, false, 0, Math.PI),
      xf(wx * s, 1.55 * s, wz * s, 0, 0, Math.PI / 2), SHELL);
  }

  if (spec.armor >= 1.6) {
    add(box(0.6 * s, 2.6 * s, 5.2 * s), xf(7.5 * s, 3.3 * s, 0, 0, 0, -0.12), STEEL);
    for (const z of [-2.2, 2.2]) add(box(7.0 * s, 1.8 * s, 0.3 * s), xf(-1.5 * s, 2.6 * s, z * s), STEEL);
  }
  if (spec.id === 'express') {
    add(cyl(0.9 * s, 0.05, 2.6 * s, 4), xf(-2.2 * s, 8.4 * s, 0), 0x7ee0ff);
  }
  return mergeParts(P);
}

/** Pintle-mounted gun on the cab roof, pivoting about the origin, aiming +X. */
export function makeTruckTurret(scale = 1) {
  const s = scale, STEEL = 0x3a4048, DARK = 0x14171c, SHIELD = 0x6d7480;
  return mergeParts([
    { geo: cyl(0.5 * s, 0.6 * s, 0.35 * s, 12), m: xf(0, 0.18 * s, 0), color: STEEL },
    { geo: box(0.7 * s, 0.5 * s, 0.7 * s), m: xf(0, 0.6 * s, 0), color: STEEL },
    { geo: box(0.25 * s, 1.5 * s, 1.7 * s), m: xf(0.55 * s, 0.85 * s, 0, 0, 0, -0.12), color: SHIELD },
    { geo: cyl(0.12 * s, 0.14 * s, 3.0 * s, 10), m: xf(1.6 * s, 0.72 * s, 0, 0, 0, Math.PI / 2), color: DARK },
    { geo: cyl(0.2 * s, 0.2 * s, 0.4 * s, 10), m: xf(3.0 * s, 0.72 * s, 0, 0, 0, Math.PI / 2), color: DARK },
    { geo: box(0.5 * s, 0.35 * s, 0.55 * s), m: xf(-0.55 * s, 0.7 * s, 0), color: DARK },
  ]);
}

/**
 * Wheel: tyre, rim and hub, axle along Z so it spins about its own axle.
 *
 * The old wheel was a black cylinder with the spokes buried INSIDE the tyre,
 * so from outside it was radially symmetric — it span every frame and looked
 * dead still. Everything that reads as rotation is now on the outside: tread
 * blocks around the circumference and a spoked face with lug bolts on both
 * sides, because the same geometry serves the left and right of the truck.
 */
export function makeTruckWheel(scale = 1) {
  const S = scale;
  const R = 1.5 * S;            // tyre radius
  const HW = 0.575 * S;         // half width
  const parts = [
    // carcass, slightly narrower than the tread so the blocks stand proud
    { geo: cyl(R * 0.97, R * 0.97, HW * 2, 20), m: xf(0, 0, 0, Math.PI / 2, 0, 0), color: 0x14171c },
    // rim barrel
    { geo: cyl(0.95 * S, 0.95 * S, HW * 2.06, 16), m: xf(0, 0, 0, Math.PI / 2, 0, 0), color: 0x79828e },
  ];

  // tread blocks: the strongest rotation cue there is
  const BLOCKS = 14;
  for (let i = 0; i < BLOCKS; i++) {
    const a = (i / BLOCKS) * Math.PI * 2;
    parts.push({
      geo: box(0.2 * S, 0.46 * S, HW * 1.94),
      m: xf(Math.cos(a) * R * 0.95, Math.sin(a) * R * 0.95, 0, 0, 0, a),
      color: i % 2 ? 0x0d0f13 : 0x1b1f26,
    });
  }

  // both faces get a rim, so one geometry serves both sides of the truck
  for (const side of [1, -1]) {
    const z = side * (HW + 0.02 * S);
    parts.push({ geo: cyl(0.36 * S, 0.36 * S, 0.12 * S, 12), m: xf(0, 0, z, Math.PI / 2, 0, 0), color: 0xc8ced6 });
    const SPOKES = 5;
    for (let i = 0; i < SPOKES; i++) {
      const a = (i / SPOKES) * Math.PI * 2 + side * 0.3;
      parts.push({
        geo: box(0.62 * S, 0.24 * S, 0.09 * S),
        m: xf(Math.cos(a) * 0.62 * S, Math.sin(a) * 0.62 * S, z, 0, 0, a),
        color: 0xb4bcc6,
      });
      parts.push({
        geo: cyl(0.085 * S, 0.085 * S, 0.09 * S, 6),
        m: xf(Math.cos(a) * 0.5 * S, Math.sin(a) * 0.5 * S, z + side * 0.05 * S, Math.PI / 2, 0, 0),
        color: 0xe6ebf1,
      });
    }
  }
  return mergeParts(parts);
}

/* ------------------------------------------------------------ helicopter */

/**
 * Gunship. Returned as a Group so the rotors can spin and the airframe can bank.
 * Nose faces +X. userData holds { mainRotor, tailRotor }.
 */
export function makeHelicopter(tint = 0x6f7a68) {
  const g = new THREE.Group();
  const body = pbr(tint, { roughness: 0.45, metalness: 0.6, normalScale: 0.3 });
  const dark = pbr(0x22262c, { roughness: 0.6, metalness: 0.4 });
  const glass = new THREE.MeshPhysicalMaterial({ color: 0x101a26, roughness: 0.06, metalness: 0.1, transmission: 0.2, thickness: 0.4, clearcoat: 1, envMapIntensity: 2 });
  const add = (geo, mat, m) => { const k = new THREE.Mesh(geo, mat); k.applyMatrix4(m); k.castShadow = true; g.add(k); return k; };

  add(cyl(1.35, 1.05, 5.6, 12), body, xf(0.4, 0, 0, 0, 0, -Math.PI / 2));       // fuselage
  add(cyl(1.05, 0.35, 2.2, 12), body, xf(3.6, -0.15, 0, 0, 0, -Math.PI / 2));   // nose taper
  add(box(1.5, 1.1, 1.7), glass, xf(2.5, 0.45, 0));                              // canopy
  add(cyl(0.42, 0.3, 6.2, 10), body, xf(-4.4, 0.45, 0, 0, 0, -Math.PI / 2));     // tail boom
  add(box(0.5, 1.6, 0.16), body, xf(-7.2, 1.1, 0));                              // tail fin
  add(box(1.4, 0.14, 2.0), body, xf(-6.4, 0.6, 0));                              // stabiliser
  add(cyl(0.55, 0.55, 0.7, 10), body, xf(0.2, 1.35, 0));                         // rotor mast

  // stub wings + rocket pods
  add(box(0.9, 0.22, 5.4), body, xf(0.1, 0.1, 0));
  for (const z of [-2.1, 2.1]) {
    add(cyl(0.42, 0.42, 1.9, 8), dark, xf(0.2, -0.35, z, 0, 0, -Math.PI / 2));
    add(box(0.16, 0.5, 0.5), dark, xf(1.3, -0.35, z));
  }
  // skids
  for (const z of [-1.3, 1.3]) {
    add(box(4.6, 0.16, 0.16), dark, xf(0.2, -1.65, z));
    add(box(0.16, 1.0, 0.16), dark, xf(1.6, -1.15, z));
    add(box(0.16, 1.0, 0.16), dark, xf(-1.2, -1.15, z));
  }

  const mainRotor = new THREE.Group();
  for (let i = 0; i < 4; i++) {
    const blade = new THREE.Mesh(box(9.5, 0.1, 0.62), dark);
    blade.rotation.y = (i * Math.PI) / 2;
    mainRotor.add(blade);
  }
  mainRotor.position.set(0.2, 1.75, 0);
  g.add(mainRotor);

  const tailRotor = new THREE.Group();
  for (let i = 0; i < 3; i++) {
    const blade = new THREE.Mesh(box(0.08, 2.4, 0.3), dark);
    blade.rotation.x = (i * Math.PI) / 3;
    tailRotor.add(blade);
  }
  tailRotor.position.set(-7.3, 1.1, 0.28);
  g.add(tailRotor);

  g.userData.mainRotor = mainRotor;
  g.userData.tailRotor = tailRotor;
  return g;
}

/** Combat engineer — like an infantryman but with a hard hat and a toolkit. */
export function makeEngineer() {
  const HI = 0xffc84a, GEAR = 0x5f6a4a, SKIN = 0xd9a06b, STEEL = 0x2b2f36;
  return mergeParts([
    { geo: box(0.3, 0.85, 0.3), m: xf(-0.22, 0.43, 0), color: GEAR },
    { geo: box(0.3, 0.85, 0.3), m: xf(0.22, 0.43, 0), color: GEAR },
    { geo: box(0.76, 0.8, 0.44), m: xf(0, 1.24, 0), color: HI },
    { geo: box(0.82, 0.2, 0.48), m: xf(0, 1.32, 0), color: 0xffffff },
    { geo: box(0.2, 0.6, 0.2), m: xf(-0.48, 1.2, 0.1, -0.7, 0, 0), color: HI },
    { geo: box(0.2, 0.6, 0.2), m: xf(0.48, 1.2, 0.1, -0.7, 0, 0), color: HI },
    { geo: box(0.34, 0.34, 0.32), m: xf(0, 1.82, 0), color: SKIN },
    { geo: cyl(0.3, 0.32, 0.22, 10), m: xf(0, 2.02, 0), color: HI },
    { geo: box(0.5, 0.16, 0.16), m: xf(0, 1.0, 0.42, 0, 0, 0.3), color: STEEL },
  ]);
}

/** Barbed wire on X-frames — frontline clutter, not a wall. */
export function makeWire() {
  const parts = [];
  const WOOD = 0x6b5f4a, STEEL = 0x9aa0a8;
  for (let i = 0; i < 3; i++) {
    const x = -2.6 + i * 2.6;
    parts.push({ geo: box(0.16, 2.2, 0.16), m: xf(x, 0.9, 0, 0, 0, 0.5), color: WOOD });
    parts.push({ geo: box(0.16, 2.2, 0.16), m: xf(x, 0.9, 0, 0, 0, -0.5), color: WOOD });
  }
  for (let s = 0; s < 3; s++) {
    parts.push({ geo: box(6.4, 0.07, 0.07), m: xf(0, 0.5 + s * 0.55, 0, 0, 0, 0.03 * (s % 2 ? 1 : -1)), color: STEEL });
  }
  return mergeParts(parts);
}

/** Route marker staking out the frontline track: post with a painted top. */
export function makeMarkerPost() {
  return mergeParts([
    { geo: box(0.22, 2.4, 0.22), m: xf(0, 1.2, 0), color: 0x2b2f36 },
    { geo: box(0.46, 0.5, 0.46), m: xf(0, 2.55, 0), color: 0xffd447 },
    { geo: box(0.36, 0.3, 0.36), m: xf(0, 2.1, 0), color: 0xd8dde5 },
  ]);
}

export function makeWreck() {
  return mergeParts([
    { geo: box(3.0, 1.0, 5.2), m: xf(0, 0.7, 0, 0.12, 0.4, 0.16), color: 0x2e3238 },
    { geo: box(2.0, 0.8, 2.2), m: xf(0.2, 1.5, -0.4, 0.2, 0.4, 0.3), color: 0x24272c },
    { geo: cyl(0.14, 0.16, 3.0, 6), m: xf(0.6, 1.9, 1.4, 1.2, 0.4, 0), color: 0x1a1d21 },
    { geo: cyl(0.5, 0.5, 0.4, 8), m: xf(-1.6, 0.35, 1.6, 0, 0, Math.PI / 2), color: 0x15181c },
  ]);
}
