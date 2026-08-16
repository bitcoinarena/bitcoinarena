import * as THREE from 'three';
import { WORLD, LANES } from '../config.js';
import { clamp, lerp, smoothstep } from '../util.js';
import { makeSandbags, makeBarrier, makeWreck, xf } from '../render/geom.js';

const SEG = 120;                    // road segments along X
const HALF_W = 5.2;                 // half road width
const KERB = 1.1;

/* ----------------------------------------------------------- centrelines */

/** The raw winding centreline of a flank route, before the end funnels. */
export function laneBaseZ(lane, x) {
  if (lane === 'bull') {
    return LANES.bull.z + Math.sin(x * 0.0195) * 14 + Math.sin(x * 0.041 + 1.7) * 6.5 + Math.sin(x * 0.0083 + 0.6) * 9;
  }
  if (lane === 'bear') {
    return LANES.bear.z + Math.sin(x * 0.017 + 2.4) * 13 + Math.sin(x * 0.037 + 0.3) * 7 + Math.sin(x * 0.0091 + 2.1) * 8;
  }
  return 0;
}

/**
 * Roads: three visible streets across the battlefield. The two flank routes
 * are fixed winding highways; the frontline route is redrawn every frame
 * because it follows the live price. All three fan out of the Sorting Plaza
 * and converge again on the Blockchain Gate.
 */
export class Roads {
  constructor(scene, bf) {
    this.scene = scene;
    this.bf = bf;
    this.lanes = ['bull', 'front', 'bear'];
    this.meshes = {};
    this._acc = 0;
    for (const lane of this.lanes) this._build(lane);
    this._buildProps();
  }

  /** Centreline z for a lane at world x, including the plaza/gate funnels. */
  centerZ(lane, x) {
    const base = lane === 'front' ? this.bf.frontlineAt(x) : laneBaseZ(lane, x);
    const outOfPlaza = smoothstep(clamp((x - (WORLD.plazaX + 14)) / 52, 0, 1));
    const intoGate = 1 - smoothstep(clamp((x - (WORLD.depotX - 60)) / 48, 0, 1));
    return base * Math.min(outOfPlaza, intoGate);
  }

  /** Road surface height at a point on the centreline. */
  surfaceY(lane, x) {
    return this.bf.surfaceAt(x, this.centerZ(lane, x)) + 0.45;
  }

  _build(lane) {
    // surface + two kerbs, all as ribbons sharing the same centreline
    const mk = (verts, color, opacity = 1) => {
      const g = new THREE.BufferGeometry();
      const pos = new Float32Array((SEG + 1) * 2 * 3);
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const idx = [];
      for (let i = 0; i < SEG; i++) {
        const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
        idx.push(a, b, c, b, d, c);
      }
      g.setIndex(idx);
      g.computeVertexNormals();
      const mat = new THREE.MeshStandardMaterial({
        color, roughness: 0.92, metalness: 0.05, side: THREE.DoubleSide,
        transparent: opacity < 1, opacity,
        // the road lies almost flat on the terrain; bias it toward the camera
        // so it never fights with the ground it is resting on
        polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8,
      });
      const mesh = new THREE.Mesh(g, mat);
      mesh.frustumCulled = false;
      mesh.receiveShadow = true;
      mesh.renderOrder = 3;
      this.scene.add(mesh);
      return { mesh, pos };
    };

    const tint = lane === 'bull' ? 0x2f3a34 : lane === 'bear' ? 0x3a2f33 : 0x40382a;
    const surface = mk(null, tint);
    const kerbL = mk(null, lane === 'front' ? 0xffcf5c : 0xb9c2cc);
    const kerbR = mk(null, lane === 'front' ? 0xffcf5c : 0xb9c2cc);

    // dashed centre line as instanced slabs
    const dashes = new THREE.InstancedMesh(
      new THREE.BoxGeometry(2.6, 0.08, 0.42),
      new THREE.MeshStandardMaterial({ color: 0xf2e6c0, roughness: 0.7, emissive: 0x6b5b2a, emissiveIntensity: 0.35 }),
      Math.floor(SEG / 3),
    );
    dashes.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    dashes.frustumCulled = false;
    dashes.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 600);
    this.scene.add(dashes);

    this.meshes[lane] = { surface, kerbL, kerbR, dashes, dummy: new THREE.Object3D() };
  }

  /** Sandbag nests, barriers and burnt-out wrecks lining the routes. */
  _buildProps() {
    const specs = [
      { geo: makeSandbags(), count: 26, color: 0xffffff, yaw: true },
      { geo: makeBarrier(), count: 22, color: 0xffffff, yaw: false },
      { geo: makeWreck(), count: 14, color: 0xffffff, yaw: true },
    ];
    this.props = [];
    let seed = 991;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

    for (const spec of specs) {
      const mesh = new THREE.InstancedMesh(
        spec.geo,
        new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true }),
        spec.count,
      );
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 600);
      this.scene.add(mesh);
      const items = [];
      for (let i = 0; i < spec.count; i++) {
        const lane = rnd() < 0.5 ? 'bull' : 'bear';
        const x = -WORLD.width / 2 + 24 + rnd() * (WORLD.width - 56);
        const side = rnd() < 0.5 ? -1 : 1;
        items.push({ lane, x, off: side * (HALF_W + 1.8 + rnd() * 3.2), yaw: spec.yaw ? rnd() * 6.28 : 0 });
      }
      this.props.push({ mesh, items });
    }
  }

  update(dt) {
    this._acc += dt;
    const full = this._acc > 1 / 20;
    if (full) this._acc = 0;

    for (const lane of this.lanes) {
      // the frontline road moves every frame; flank roads only need the
      // occasional refresh as craters reshape the ground under them
      if (lane !== 'front' && !full && this._built) continue;
      this._updateRibbon(lane);
    }
    if (full || !this._built) this._updateProps();
    this._built = true;
  }

  _updateRibbon(lane) {
    const m = this.meshes[lane];
    const bf = this.bf;
    const wobble = lane === 'front' ? 1.5 : 0.9;

    for (let i = 0; i <= SEG; i++) {
      const x = -WORLD.width / 2 + (i * WORLD.width) / SEG;
      const z = this.centerZ(lane, x);
      // tangent -> normal, so the ribbon stays the same width through curves
      const zA = this.centerZ(lane, x - 2), zB = this.centerZ(lane, x + 2);
      const tx = 4, tz = zB - zA;
      const tl = Math.hypot(tx, tz) || 1;
      const nx = -tz / tl, nz = tx / tl;
      const edge = HALF_W + Math.sin(i * 0.35) * 0.25 * wobble;

      // Sample the ground under each edge rather than lifting the whole width
      // to the centreline height — otherwise the uphill edge of the road
      // disappears into the slope on any lateral gradient.
      const set = (buf, k, off, oy) => {
        const px = x + nx * off, pz = z + nz * off;
        buf[k] = px; buf[k + 1] = bf.surfaceAt(px, pz) + 0.45 + oy; buf[k + 2] = pz;
      };
      set(m.surface.pos, i * 6, -edge, 0);
      set(m.surface.pos, i * 6 + 3, edge, 0);
      set(m.kerbL.pos, i * 6, -edge - KERB, 0.16);
      set(m.kerbL.pos, i * 6 + 3, -edge + 0.15, 0.05);
      set(m.kerbR.pos, i * 6, edge - 0.15, 0.05);
      set(m.kerbR.pos, i * 6 + 3, edge + KERB, 0.16);
    }

    for (const part of [m.surface, m.kerbL, m.kerbR]) {
      part.mesh.geometry.attributes.position.needsUpdate = true;
      part.mesh.geometry.computeVertexNormals();
    }

    // centre dashes
    const d = m.dummy;
    for (let i = 0; i < m.dashes.count; i++) {
      const x = -WORLD.width / 2 + ((i * 3 + 1) * WORLD.width) / SEG;
      const z = this.centerZ(lane, x);
      const zA = this.centerZ(lane, x - 2), zB = this.centerZ(lane, x + 2);
      d.position.set(x, bf.surfaceAt(x, z) + 0.62, z);
      d.rotation.set(0, -Math.atan2(zB - zA, 4), 0);
      d.scale.setScalar(1);
      d.updateMatrix();
      m.dashes.setMatrixAt(i, d.matrix);
    }
    m.dashes.instanceMatrix.needsUpdate = true;
  }

  _updateProps() {
    const d = this._propDummy || (this._propDummy = new THREE.Object3D());
    for (const { mesh, items } of this.props) {
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const z = this.centerZ(it.lane, it.x) + it.off;
        const zA = this.centerZ(it.lane, it.x - 2), zB = this.centerZ(it.lane, it.x + 2);
        d.position.set(it.x, this.bf.surfaceAt(it.x, z), z);
        d.rotation.set(0, -Math.atan2(zB - zA, 4) + it.yaw, 0);
        d.scale.setScalar(1);
        d.updateMatrix();
        mesh.setMatrixAt(i, d.matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
    }
  }
}
