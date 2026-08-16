import * as THREE from 'three';
import { WORLD, LANES } from '../config.js';
import { clamp, lerp, smoothstep, approach } from '../util.js';
import { Q, props } from '../quality.js';
import { makeSandbags, makeBarrier, makeWreck, makeMarkerPost, makeWire, makeEngineer } from '../render/geom.js';

const SEG = Q.roadSeg;              // road segments along X
const HALF_W = 5.2;                 // half road width
const KERB = 1.1;
// Distance from a compound's centre to its blast wall / gate opening. Must match
// the perimeter walls built in logistics.js.
export const GATE_X = 34;
// How long a cut section stays impassable while engineers work it.
const DAMAGE_SEC = 150;
// Surface wear: a stretch this long accumulates damage 0..1 before it fails,
// and heals this fast if nothing else lands on it (~2 min from fully worn).
const WEAR_SPAN = 16;
const WEAR_HEAL = 0.008;

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
  constructor(scene, bf, fx, events) {
    this.scene = scene;
    this.bf = bf;
    this.fx = fx;
    this.events = events;
    this.lanes = ['bull', 'front', 'bear'];
    this.meshes = {};
    this.highlight = null;
    this.time = 0;
    this._acc = 0;
    for (const lane of this.lanes) this._build(lane);
    this._buildProps();
    this._buildRepair();
  }

  /**
   * Centreline z for a lane at world x. All three routes are funnelled to z = 0
   * by the time they reach the compound walls, because that is where the gate
   * openings are — a route that is still off-centre there drives a truck
   * straight into a blast wall.
   */
  centerZ(lane, x) {
    const base = lane === 'front' ? this.bf.frontlineAt(x) : laneBaseZ(lane, x);
    const plazaGate = WORLD.plazaX + GATE_X;
    const depotGate = WORLD.depotX - GATE_X;
    const outOfPlaza = smoothstep(clamp((x - plazaGate) / 58, 0, 1));
    const intoGate = 1 - smoothstep(clamp((x - (depotGate - 58)) / 58, 0, 1));
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
      const col = new Float32Array((SEG + 1) * 2 * 3).fill(1);
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      const idx = [];
      for (let i = 0; i < SEG; i++) {
        const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
        idx.push(a, b, c, b, d, c);
      }
      g.setIndex(idx);
      g.computeVertexNormals();
      const mat = new THREE.MeshStandardMaterial({
        color, vertexColors: true, roughness: 0.92, metalness: 0.05, side: THREE.DoubleSide,
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
      return { mesh, pos, col };
    };

    const front = lane === 'front';
    // The flanks are proper tarmac. The frontline is not a road at all — it is
    // churned earth beaten flat by everything that has driven up it, held
    // between two spoil berms, marked out so you can still see where to drive.
    const tint = front ? 0x4a4034 : lane === 'bull' ? 0x2f3a34 : 0x3a2f33;
    const surface = mk(null, tint);
    const kerbL = mk(null, 0xb9c2cc);
    const kerbR = mk(null, 0xb9c2cc);
    // No kerbs on the frontline: a painted edge (or a berm) reads as a wall
    // bisecting the map. The front is defined by churned ground, litter and
    // marker stakes instead.
    if (front) { kerbL.mesh.visible = false; kerbR.mesh.visible = false; }

    let dashes;
    if (front) {
      // marker posts staking out the route through the mud
      dashes = new THREE.InstancedMesh(
        makeMarkerPost(),
        new THREE.MeshStandardMaterial({
          vertexColors: true, flatShading: true, roughness: 0.7,
          emissive: 0xffb03a, emissiveIntensity: 0.45,
        }),
        Math.floor(SEG / 4) * 2,
      );
      dashes.castShadow = true;
    } else {
      dashes = new THREE.InstancedMesh(
        new THREE.BoxGeometry(2.6, 0.08, 0.42),
        new THREE.MeshStandardMaterial({ color: 0xf2e6c0, roughness: 0.7, emissive: 0x6b5b2a, emissiveIntensity: 0.35 }),
        Math.floor(SEG / 3),
      );
    }
    dashes.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    dashes.frustumCulled = false;
    dashes.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 600);
    this.scene.add(dashes);

    // tank ruts churned into the frontline track
    let ruts = null;
    if (front) {
      ruts = new THREE.InstancedMesh(
        new THREE.BoxGeometry(3.4, 0.06, 0.85),
        new THREE.MeshStandardMaterial({ color: 0x2e281f, roughness: 1 }),
        Math.floor(SEG / 2) * 2,
      );
      ruts.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      ruts.frustumCulled = false;
      ruts.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 600);
      this.scene.add(ruts);
    }

    this.meshes[lane] = { surface, kerbL, kerbR, dashes, ruts, front, dummy: new THREE.Object3D() };
  }

  /** Sandbag nests, barriers, wire and burnt-out wrecks lining the routes. */
  _buildProps() {
    const specs = [
      { geo: makeSandbags(), count: props(26), yaw: true },
      { geo: makeBarrier(), count: props(20), yaw: false },
      { geo: makeWreck(), count: props(14), yaw: true },
      // frontline clutter: strung along the contested track on both shoulders
      { geo: makeWire(), count: props(30), yaw: false, front: true, spread: [3, 16] },
      { geo: makeSandbags(), count: props(22), yaw: true, front: true, spread: [4, 18] },
      { geo: makeWreck(), count: props(16), yaw: true, front: true, spread: [6, 22] },
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
        const lane = spec.front ? 'front' : (rnd() < 0.5 ? 'bull' : 'bear');
        const x = -WORLD.width / 2 + 24 + rnd() * (WORLD.width - 56);
        const side = rnd() < 0.5 ? -1 : 1;
        const [lo, hi] = spec.spread ?? [1.8, 5.0];
        items.push({
          lane, x,
          off: side * (HALF_W + lo + rnd() * (hi - lo)),
          yaw: spec.yaw ? rnd() * 6.28 : rnd() * 0.5 - 0.25,
        });
      }
      this.props.push({ mesh, items });
    }
  }

  /* -------------------------------------------------------- road damage */

  /**
   * A strike landing on or near a route cuts it. The span stays impassable for
   * a couple of minutes while an engineer section from the owning faction works
   * it back into shape.
   */
  /** Tear the road open outright — only a nuke does this in one go. */
  cutAt(x, z, radius) {
    for (const lane of this.lanes) {
      const cz = this.centerZ(lane, x);
      if (Math.abs(cz - z) > radius + HALF_W) continue;
      this._cut(lane, x, Math.max(10, radius * 0.9));
    }
  }

  _cut(lane, x, span) {
    const existing = this.damage.find((d) => d.lane === lane && Math.abs(d.x - x) < span);
    if (existing) { existing.t = Math.max(existing.t, DAMAGE_SEC); return; }
    const owner = this.centerZ(lane, x) < this.bf.frontlineAt(x) ? 'bull' : 'bear';
    this.damage.push({ lane, x, span, t: DAMAGE_SEC, total: DAMAGE_SEC, owner });
    // that stretch is rubble now — no point tracking surface wear on it
    for (let i = this.wear.length - 1; i >= 0; i--) {
      const w = this.wear[i];
      if (w.lane === lane && Math.abs(w.x - x) < span) this.wear.splice(i, 1);
    }
    if (this.damage.length > 6) this.damage.shift();
    this.events?.emit('log', {
      kind: 'loss',
      text: `${LANES[lane].name} CUT at the ${x < 0 ? 'west' : 'east'} stretch — ${owner === 'bull' ? 'BULL' : 'BEAR'} engineers dispatched`,
    });
  }

  /**
   * Surface damage from a near miss. Roads don't fail in one hit — shellfire and
   * burning wrecks chew a stretch up until it finally gives way and has to be
   * rebuilt. Wear runs 0..1 per stretch; at 1 the road is cut.
   */
  wearAt(x, z, radius, amount) {
    for (const lane of this.lanes) {
      const cz = this.centerZ(lane, x);
      const dist = Math.abs(cz - z);
      if (dist > radius + HALF_W) continue;
      if (this.damage.some((d) => d.lane === lane && Math.abs(d.x - x) < d.span)) continue;

      const bite = clamp(1 - (dist - HALF_W) / Math.max(1, radius), 0.2, 1);
      const bucket = Math.round(x / WEAR_SPAN) * WEAR_SPAN;
      let w = this.wear.find((e) => e.lane === lane && e.x === bucket);
      if (!w) {
        w = { lane, x: bucket, span: WEAR_SPAN * 0.55, wear: 0 };
        this.wear.push(w);
        if (this.wear.length > 24) this.wear.shift();
      }
      w.wear += amount * bite;
      if (w.wear >= 1) this._cut(lane, bucket, Math.max(12, radius));
    }
  }

  /** How badly a truck is slowed here: 1 = impassable rubble, 0 = clean road. */
  damageFactor(lane, x) {
    for (const d of this.damage) {
      if (d.lane === lane && Math.abs(d.x - x) < d.span) return 1 - Math.abs(d.x - x) / d.span;
    }
    for (const w of this.wear) {
      if (w.lane === lane && Math.abs(w.x - x) < w.span) return w.wear * 0.45;
    }
    return 0;
  }

  /**
   * How wrecked the road LOOKS here, 0..1. Separate from damageFactor (which is
   * about slowing trucks) because a cut needs to read as destroyed across its
   * whole span, not just at the centre.
   */
  severityAt(lane, x) {
    let s = 0;
    for (const d of this.damage) {
      if (d.lane !== lane) continue;
      const k = Math.abs(d.x - x) / d.span;
      if (k < 1) {
        // repaired stretches visibly come good again as the engineers work
        const repaired = 1 - d.t / d.total;
        s = Math.max(s, (0.55 + 0.45 * (1 - k)) * (1 - repaired * 0.85));
      }
    }
    for (const w of this.wear) {
      if (w.lane !== lane) continue;
      if (Math.abs(w.x - x) < w.span) s = Math.max(s, w.wear * 0.55);
    }
    return s;
  }

  /** Worst surface wear on a lane, 0..1 (cut sections excluded — see repairEta). */
  wearLevel(lane) {
    let m = 0;
    for (const w of this.wear) if (w.lane === lane) m = Math.max(m, w.wear);
    return m;
  }

  isDamaged(lane) { return this.damage.some((d) => d.lane === lane); }

  /** Seconds until this lane is fully repaired (0 if clear). */
  repairEta(lane) {
    let t = 0;
    for (const d of this.damage) if (d.lane === lane) t = Math.max(t, d.t);
    return t;
  }

  _buildRepair() {
    this.damage = [];
    this.wear = [];

    // potholes and shell scars — how a stretch looks on its way to failing
    this.potholeMesh = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(1, 0.75, 0.34, 8),
      new THREE.MeshStandardMaterial({ color: 0x1a1712, roughness: 1 }),
      props(120),
    );
    this.potholeMesh.frustumCulled = false;
    this.potholeMesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 600);
    this.scene.add(this.potholeMesh);

    const geo = makeEngineer();
    this.engineerMesh = new THREE.InstancedMesh(
      geo,
      new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.7 }),
      props(36),
    );
    this.engineerMesh.castShadow = true;
    this.engineerMesh.frustumCulled = false;
    this.engineerMesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 600);
    this.engineerMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(36 * 3), 3);
    this.scene.add(this.engineerMesh);

    this.rubbleMesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color: 0x4a4238, roughness: 1, flatShading: true }),
      props(90),
    );
    this.rubbleMesh.frustumCulled = false;
    this.rubbleMesh.castShadow = true;
    this.rubbleMesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 600);
    this.scene.add(this.rubbleMesh);
  }

  _updateRepair(dt, fx) {
    const d = this._propDummy || (this._propDummy = new THREE.Object3D());
    const col = new THREE.Color();
    let ei = 0, ri = 0, pi = 0;
    this.time = (this.time || 0) + dt;

    // worn stretches: potholes multiply as the surface degrades, and slowly
    // heal again if nothing else lands on them
    for (let k = this.wear.length - 1; k >= 0; k--) {
      const w = this.wear[k];
      w.wear -= dt * WEAR_HEAL;
      if (w.wear <= 0) { this.wear.splice(k, 1); continue; }
      const holes = Math.min(12, Math.ceil(w.wear * 12));
      for (let n = 0; n < holes && pi < this.potholeMesh.count; n++) {
        const f = ((n * 37) % 100) / 100 - 0.5;
        const x = w.x + f * w.span * 2;
        const z = this.centerZ(w.lane, x) + Math.sin(n * 3.1 + w.x) * HALF_W * 0.75;
        const size = 0.5 + ((n * 17) % 10) / 10;
        d.position.set(x, this.bf.surfaceAt(x, z) + 0.45, z);
        d.rotation.set(0, n * 1.3, 0);
        d.scale.set(size, 1, size * 0.8);
        d.updateMatrix();
        this.potholeMesh.setMatrixAt(pi++, d.matrix);
      }
    }

    for (let k = this.damage.length - 1; k >= 0; k--) {
      const dm = this.damage[k];
      dm.t -= dt;
      if (dm.t <= 0) { this.damage.splice(k, 1); continue; }

      const progress = 1 - dm.t / dm.total;
      // rubble strewn across the cut, cleared from the outside in
      for (let n = 0; n < 15 && ri < this.rubbleMesh.count; n++) {
        const f = (n / 15) * 2 - 1;
        if (Math.abs(f) < progress * 0.9) continue;          // this bit is cleared
        const x = dm.x + f * dm.span;
        const z = this.centerZ(dm.lane, x) + Math.sin(n * 2.7) * HALF_W * 0.7;
        d.position.set(x, this.bf.surfaceAt(x, z) + 0.3, z);
        d.rotation.set(Math.sin(n) * 0.4, n * 1.1, Math.cos(n) * 0.3);
        d.scale.set(1.4 + (n % 3) * 0.7, 0.8 + (n % 2) * 0.6, 1.2 + (n % 4) * 0.5);
        d.updateMatrix();
        this.rubbleMesh.setMatrixAt(ri++, d.matrix);
      }

      // engineer section working the cut
      col.setHex(dm.owner === 'bull' ? 0x9effc4 : 0xffb0b8);
      for (let n = 0; n < 6 && ei < this.engineerMesh.count; n++) {
        const along = (n / 5 - 0.5) * dm.span * 1.3 * (1 - progress * 0.5);
        const x = dm.x + along;
        const z = this.centerZ(dm.lane, x) + Math.sin(n * 1.9 + this.time * 0.6) * 3;
        const swing = Math.sin(this.time * 5 + n * 1.3);
        d.position.set(x, this.bf.surfaceAt(x, z) + Math.abs(swing) * 0.12, z);
        d.rotation.set(swing * 0.16, Math.sin(n * 2.1) * 2.4, 0);
        d.scale.setScalar(1);
        d.updateMatrix();
        this.engineerMesh.setMatrixAt(ei, d.matrix);
        this.engineerMesh.setColorAt(ei, col);
        ei++;
        if (fx && Math.random() < dt * 2.5) {
          fx.spawn(x, this.bf.surfaceAt(x, z) + 1.6, z, {
            color: 0xffd08a, count: 2, size: 1.1, life: 0.5, speed: 4, gravity: -12,
          });
        }
      }
    }

    const hide = (mesh, from) => {
      d.position.set(0, -900, 0); d.scale.setScalar(0.001); d.updateMatrix();
      for (let i = from; i < mesh.count; i++) mesh.setMatrixAt(i, d.matrix);
      mesh.instanceMatrix.needsUpdate = true;
    };
    hide(this.engineerMesh, ei);
    hide(this.rubbleMesh, ri);
    hide(this.potholeMesh, pi);
    if (this.engineerMesh.instanceColor) this.engineerMesh.instanceColor.needsUpdate = true;
  }

  /* ------------------------------------------------------------ highlight */

  /** Light up the route the player has selected so the choice is visible. */
  setHighlight(lane) { this.highlight = lane; }

  _updateHighlight(dt) {
    const pulse = 0.5 + Math.sin((this.time || 0) * 3.2) * 0.5;
    for (const lane of this.lanes) {
      const m = this.meshes[lane];
      const on = lane === this.highlight;
      const target = on ? 0.35 + pulse * 0.45 : 0;
      m.glow = approach(m.glow ?? 0, target, 6, dt);
      for (const part of [m.kerbL, m.kerbR]) {
        part.mesh.material.emissive.setHex(0xffd447);
        part.mesh.material.emissiveIntensity = m.glow;
      }
      m.surface.mesh.material.emissive.setHex(0xffb03a);
      m.surface.mesh.material.emissiveIntensity = m.glow * 0.28;
      if (m.dashes.material.emissive) m.dashes.material.emissiveIntensity = 0.35 + m.glow * 1.2;
    }
  }

  update(dt) {
    this._updateRepair(dt, this.fx);
    this._updateHighlight(dt);
    this._acc += dt;
    const full = this._acc > 1 / 20;
    if (full) this._acc = 0;

    for (const lane of this.lanes) {
      // the frontline road moves every frame; flank roads only need the
      // occasional refresh — unless a stretch is being blown up or rebuilt
      const busy = this.damage.some((d) => d.lane === lane) || this.wear.some((w) => w.lane === lane);
      if (lane !== 'front' && !busy && !full && this._built) continue;
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
      // the frontline track wanders and frays; the tarmac flanks stay true
      const edge = m.front
        ? HALF_W + 1.4 + Math.sin(i * 0.7) * 1.5 + Math.sin(i * 2.3) * 0.9 + Math.sin(i * 5.1) * 0.4
        : HALF_W + Math.sin(i * 0.35) * 0.25 * wobble;
      const berm = KERB;
      const bermY = 0.16;

      // How wrecked is this stretch? A cut section is torn open: the surface
      // drops into the crater, the edges break up, and the tarmac scorches.
      const sev = this.severityAt(lane, x);
      const rip = sev > 0 ? Math.sin(i * 5.7) * 1.7 + Math.sin(i * 13.3) * 0.8 : 0;
      const drop = sev * (1.5 + Math.abs(Math.sin(i * 9.1)) * 1.1);
      const ragged = edge * (1 - sev * 0.35) + rip * sev;

      // Sample the ground under each edge rather than lifting the whole width
      // to the centreline height — otherwise the uphill edge of the road
      // disappears into the slope on any lateral gradient.
      const set = (buf, k, off, oy) => {
        const px = x + nx * off, pz = z + nz * off;
        buf[k] = px; buf[k + 1] = bf.surfaceAt(px, pz) + 0.45 + oy - drop; buf[k + 2] = pz;
      };
      set(m.surface.pos, i * 6, -ragged, 0);
      set(m.surface.pos, i * 6 + 3, ragged, 0);
      set(m.kerbL.pos, i * 6, -ragged - berm, bermY);
      set(m.kerbL.pos, i * 6 + 3, -ragged + 0.15, 0.05);
      set(m.kerbR.pos, i * 6, ragged - 0.15, 0.05);
      set(m.kerbR.pos, i * 6 + 3, ragged + berm, bermY);

      // scorched and broken: multiply the tarmac down toward burnt earth
      const shade = 1 - sev * 0.62;
      const warm = 1 - sev * 0.34;
      for (const part of [m.surface, m.kerbL, m.kerbR]) {
        for (let v = 0; v < 2; v++) {
          const k = i * 6 + v * 3;
          part.col[k] = warm; part.col[k + 1] = shade; part.col[k + 2] = shade * 0.85;
        }
      }
    }

    for (const part of [m.surface, m.kerbL, m.kerbR]) {
      part.mesh.geometry.attributes.position.needsUpdate = true;
      part.mesh.geometry.attributes.color.needsUpdate = true;
      part.mesh.geometry.computeVertexNormals();
    }

    const d = m.dummy;
    if (m.front) {
      // marker posts down both shoulders of the track
      const n = m.dashes.count / 2;
      for (let k = 0; k < n; k++) {
        const x = -WORLD.width / 2 + ((k * 4 + 2) * WORLD.width) / SEG;
        const z = this.centerZ(lane, x);
        const zA = this.centerZ(lane, x - 2), zB = this.centerZ(lane, x + 2);
        const tl = Math.hypot(4, zB - zA) || 1;
        const nx = -(zB - zA) / tl, nz = 4 / tl;
        for (let s = 0; s < 2; s++) {
          const off = (s ? 1 : -1) * (HALF_W + 1.6);
          const px = x + nx * off, pz = z + nz * off;
          d.position.set(px, bf.surfaceAt(px, pz), pz);
          d.rotation.set(0, -Math.atan2(zB - zA, 4), Math.sin(k * 2.1 + s) * 0.12);
          d.scale.setScalar(1);
          d.updateMatrix();
          m.dashes.setMatrixAt(k * 2 + s, d.matrix);
        }
      }
      // ruts gouged along the track
      const rn = m.ruts.count / 2;
      for (let k = 0; k < rn; k++) {
        const x = -WORLD.width / 2 + ((k * 2 + 1) * WORLD.width) / SEG;
        const z = this.centerZ(lane, x);
        const zA = this.centerZ(lane, x - 2), zB = this.centerZ(lane, x + 2);
        const tl = Math.hypot(4, zB - zA) || 1;
        const nx = -(zB - zA) / tl, nz = 4 / tl;
        for (let s = 0; s < 2; s++) {
          const off = (s ? 1 : -1) * (1.6 + Math.sin(k * 1.7) * 0.5);
          const px = x + nx * off, pz = z + nz * off;
          d.position.set(px, bf.surfaceAt(px, pz) + 0.5, pz);
          d.rotation.set(0, -Math.atan2(zB - zA, 4), 0);
          d.scale.setScalar(1);
          d.updateMatrix();
          m.ruts.setMatrixAt(k * 2 + s, d.matrix);
        }
      }
      m.ruts.instanceMatrix.needsUpdate = true;
    } else {
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
