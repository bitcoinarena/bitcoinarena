import * as THREE from 'three';

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

const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const cyl = (r1, r2, h, seg = 8) => new THREE.CylinderGeometry(r1, r2, h, seg);

/* --------------------------------------------------------------- soldier */

/**
 * Infantryman, ~2 units tall, facing +Z (the direction their side advances).
 * Deliberately chunky — this reads at 200 instances and 60 metres away.
 */
export function makeSoldier() {
  const SKIN = 0xd9a06b, DARK = 0x3a3f47, GEAR = 0x6b6152, STEEL = 0x2b2f36;
  return mergeParts([
    // legs
    { geo: box(0.3, 0.85, 0.3), m: xf(-0.22, 0.43, 0), color: DARK },
    { geo: box(0.3, 0.85, 0.3), m: xf(0.22, 0.43, 0.12), color: DARK },
    // boots
    { geo: box(0.34, 0.2, 0.5), m: xf(-0.22, 0.1, 0.06), color: STEEL },
    { geo: box(0.34, 0.2, 0.5), m: xf(0.22, 0.1, 0.18), color: STEEL },
    // torso + webbing
    { geo: box(0.78, 0.82, 0.46), m: xf(0, 1.24, 0), color: 0xffffff },
    { geo: box(0.84, 0.22, 0.5), m: xf(0, 1.12, 0), color: GEAR },
    // backpack
    { geo: box(0.54, 0.56, 0.28), m: xf(0, 1.3, -0.34), color: GEAR },
    { geo: box(0.2, 0.2, 0.2), m: xf(0.2, 1.05, -0.42), color: STEEL },
    // arms
    { geo: box(0.2, 0.62, 0.22), m: xf(-0.5, 1.24, 0.06), color: 0xffffff },
    { geo: box(0.2, 0.5, 0.34), m: xf(0.48, 1.28, 0.2, -0.5, 0, 0), color: 0xffffff },
    // head + helmet
    { geo: box(0.36, 0.36, 0.34), m: xf(0, 1.83, 0.02), color: SKIN },
    { geo: cyl(0.3, 0.32, 0.2, 10), m: xf(0, 2.03, 0), color: STEEL },
    { geo: box(0.6, 0.07, 0.62), m: xf(0, 1.95, 0.02), color: STEEL },
    // rifle
    { geo: box(0.09, 0.11, 1.0), m: xf(0.44, 1.32, 0.42), color: 0x14171c },
    { geo: box(0.08, 0.24, 0.26), m: xf(0.44, 1.2, 0.08), color: 0x14171c },
  ]);
}

/* ------------------------------------------------------------------ tank */

/** Main battle tank, ~7 long, facing +Z. Turret is baked forward. */
export function makeTank() {
  const HULL = 0xffffff, TRACK = 0x1b1f26, DETAIL = 0x3d434d, STEEL = 0x2a2e35;
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
    // turret
    { geo: box(2.3, 0.86, 2.7), m: xf(0, 2.28, -0.25), color: HULL },
    { geo: box(1.9, 0.3, 2.3), m: xf(0, 2.76, -0.25), color: HULL },
    // mantlet + barrel
    { geo: box(0.9, 0.6, 0.7), m: xf(0, 2.3, 1.2), color: DETAIL },
    { geo: cyl(0.17, 0.19, 3.6, 8), m: xf(0, 2.32, 2.9, Math.PI / 2, 0, 0), color: STEEL },
    { geo: cyl(0.26, 0.26, 0.5, 8), m: xf(0, 2.32, 4.5, Math.PI / 2, 0, 0), color: STEEL },
    // cupola, hatch, MG
    { geo: cyl(0.4, 0.42, 0.34, 8), m: xf(-0.55, 2.9, -0.5), color: DETAIL },
    { geo: box(0.14, 0.14, 0.9), m: xf(0.55, 2.95, 0.2), color: 0x14171c },
    // stowage
    { geo: box(1.6, 0.35, 0.5), m: xf(0, 2.5, -1.75), color: 0x5a5140 },
    // antenna
    { geo: cyl(0.04, 0.03, 2.2, 4), m: xf(0.9, 3.6, -1.1, 0.12, 0, 0.1), color: STEEL },
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
  const body = new THREE.MeshStandardMaterial({ color: tint, roughness: 0.55, metalness: 0.45, flatShading: true });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2a3038, roughness: 0.7, metalness: 0.3, flatShading: true });
  const glass = new THREE.MeshStandardMaterial({ color: 0x1a2634, roughness: 0.1, metalness: 0.9 });

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

export function makeWreck() {
  return mergeParts([
    { geo: box(3.0, 1.0, 5.2), m: xf(0, 0.7, 0, 0.12, 0.4, 0.16), color: 0x2e3238 },
    { geo: box(2.0, 0.8, 2.2), m: xf(0.2, 1.5, -0.4, 0.2, 0.4, 0.3), color: 0x24272c },
    { geo: cyl(0.14, 0.16, 3.0, 6), m: xf(0.6, 1.9, 1.4, 1.2, 0.4, 0), color: 0x1a1d21 },
    { geo: cyl(0.5, 0.5, 0.4, 8), m: xf(-1.6, 0.35, 1.6, 0, 0, Math.PI / 2), color: 0x15181c },
  ]);
}
