import * as THREE from 'three';
import { WORLD, HISTORY } from '../config.js';
import { Ring, clamp, lerp, rand, randInt, approach, angleDelta, angleApproach, TAU } from '../util.js';
import { Roads } from './roads.js';
import { makeSoldierBody, makeSoldierLeg, makeTankHull, makeTankTurret, makeBomber, makeBomb, makeHelicopter, HIP_Y, TURRET_Y } from '../render/geom.js';

const COLS = WORLD.columns, ROWS = WORLD.rows;
const VW = COLS + 1, VH = ROWS + 1;

// Rear areas: no fighting, no territory colour. The plaza and the depot sit
// beyond these lines so the logistics zones read as separate from the war.
const REAR_X = 74;
const FRONT_X = 84;      // troops are held between -FRONT_X and +FRONT_X

/**
 * Cheap deterministic rolling ground (no external noise lib). Two low-frequency
 * octaves give gentle hills you can see the road climb over; the high-frequency
 * terms just break up the surface. Kept small on purpose — the last version had
 * mountains and they swallowed everything.
 */
function groundNoise(x, z) {
  return (
    Math.sin(x * 0.0125 + 1.7) * 3.4 +
    Math.cos(z * 0.017 - 0.6) * 2.8 +
    Math.sin((x * 0.9 - z) * 0.0075) * 3.0 +
    Math.sin(x * 0.055) * 1.7 +
    Math.cos(z * 0.041 + 1.3) * 1.4 +
    Math.sin((x + z) * 0.021) * 2.3 +
    Math.sin(x * 0.13 + z * 0.09) * 0.55
  );
}

/**
 * The battlefield: the terrain IS the price chart. For every column of the mesh
 * (a moment in time) the boundary between green and red ground sits at the
 * z-position that column's price maps to. Bulls hold z < frontline, bears hold
 * z > frontline, and the seam is a glowing trench that the player can drive down.
 */
export class Battlefield {
  constructor(scene, fx, events) {
    this.scene = scene;
    this.fx = fx;
    this.events = events;

    this.history = new Ring(VW, 0);
    this.priceLo = 0; this.priceHi = 1;
    this.seeded = false;
    this.flow = 0;            // -1 heavy selling .. +1 heavy buying
    this.volatility = 0;
    this._sampleAcc = 0;
    this._meshAcc = 0;

    this.craters = [];
    this.craterField = new Float32Array(VW * VH);
    this.incoming = [];        // bombers currently running a strike
    this.markers = [];         // fading columns of embers at liquidated price levels
    this.mushrooms = [];       // nuke clouds still rising
    this.claims = [];          // ground seized by a strike, held only while troops stay
    this.helis = [];           // gunships on station
    this.audio = null;         // set by game.js

    this._buildTerrain();
    this._buildTrench();
    this._buildUnits();
    this._buildOrderBook();
    this._buildBackdrop();
    this._buildAircraft();
    this._buildHelis();
    this.roads = new Roads(scene, this, fx, events);
  }

  /** Centreline of a route — the trucks drive on the visible road surface. */
  laneZ(lane, x) { return this.roads.centerZ(lane, x); }

  /**
   * Clear the road for a truck. Anything inside the corridor ahead is walked
   * sideways out of it — infantry scramble, tanks grind over reluctantly —
   * and anything already touching the truck is pushed out hard so nothing ever
   * overlaps. The truck holds the centreline; the war gets out of its way.
   */
  clearPath(x, z, dir, dt, halfWidth = 7.5, ahead = 26) {
    const yieldTo = (o, rate, size) => {
      const along = (o.x - x) * dir;
      const dz = o.z - z;
      const lane = halfWidth + size;

      // anticipatory: still up the road, ease out of the corridor
      if (along > -4 && along < ahead && Math.abs(dz) < lane) {
        const need = lane - Math.abs(dz) + 0.6;
        const urgency = 1 - Math.max(0, along) / ahead;
        o.z += (dz >= 0 ? 1 : -1) * need * rate * (0.35 + urgency) * dt;
      }

      // last resort: hard separation so a wheel never clips a hull
      const hard = 4.5 + size;
      const d2 = (o.x - x) ** 2 + dz * dz;
      if (d2 > 1e-4 && d2 < hard * hard) {
        const d = Math.sqrt(d2);
        const push = (hard - d);
        o.x += ((o.x - x) / d) * push;
        o.z += (dz / d) * push;
      }
    };

    for (const side of ['bull', 'bear']) {
      for (const v of this.sides[side].vehicles) if (v.active) yieldTo(v, 3.2, 3.2);
      for (const u of this.sides[side].units) if (u.active) yieldTo(u, 7.0, 0.9);
    }
  }

  /* ------------------------------------------------------------- terrain */

  _buildTerrain() {
    const geo = new THREE.PlaneGeometry(WORLD.width, WORLD.depth, COLS, ROWS);
    geo.rotateX(-Math.PI / 2);
    const colors = new Float32Array(geo.attributes.position.count * 3);
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.94, metalness: 0.02, flatShading: true,
    });
    this.terrain = new THREE.Mesh(geo, mat);
    this.terrain.receiveShadow = true;
    this.terrain.name = 'terrain';
    this.scene.add(this.terrain);
    this.pos = geo.attributes.position;
    this.col = geo.attributes.color;

    this.baseH = new Float32Array(VW * VH);
    for (let iy = 0; iy < VH; iy++) {
      for (let ix = 0; ix < VW; ix++) {
        const i = iy * VW + ix;
        this.baseH[i] = groundNoise(this.colX(ix), this.rowZ(iy)) * 0.55;
      }
    }
    this.frontZ = new Float32Array(VW);
  }

  _buildTrench() {
    // A glowing ribbon that traces the frontline — the contested road.
    const seg = COLS;
    const g = new THREE.BufferGeometry();
    this.trenchPos = new Float32Array((seg + 1) * 2 * 3);
    g.setAttribute('position', new THREE.BufferAttribute(this.trenchPos, 3));
    const idx = [];
    for (let i = 0; i < seg; i++) {
      const a = i * 2, b = i * 2 + 1, c = a + 2, d = a + 3;
      idx.push(a, b, c, b, d, c);
    }
    g.setIndex(idx);
    this.trench = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
      color: 0xffe08a, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false,
    }));
    this.trench.renderOrder = 2;
    this.scene.add(this.trench);
  }

  _buildBackdrop() {
    // Ground plane far below/around so the world doesn't end in a void.
    const g = new THREE.PlaneGeometry(1500, 1500);
    g.rotateX(-Math.PI / 2);
    const m = new THREE.MeshStandardMaterial({ color: 0x1a2130, roughness: 1 });
    const plane = new THREE.Mesh(g, m);
    plane.position.y = -6;
    this.scene.add(plane);
    this.backdrop = m;
  }

  colX(ix) { return -WORLD.width / 2 + (ix * WORLD.width) / COLS; }
  rowZ(iy) { return -WORLD.depth / 2 + (iy * WORLD.depth) / ROWS; }

  priceToZ(p) {
    const mid = (this.priceHi + this.priceLo) / 2;
    const span = Math.max(1e-6, this.priceHi - this.priceLo);
    return clamp(((p - mid) / span) * 2 * WORLD.halfZ, -WORLD.halfZ * 1.35, WORLD.halfZ * 1.35);
  }
  zToPrice(z) {
    const mid = (this.priceHi + this.priceLo) / 2;
    const span = Math.max(1e-6, this.priceHi - this.priceLo);
    return mid + (z / (2 * WORLD.halfZ)) * span;
  }

  /**
   * Ground taken by a strike. The blast alone doesn't win anything — the claim
   * only consolidates while the attacking side has troops standing in it, and
   * bleeds away as soon as they're driven off or killed.
   */
  claimGround(x, z, r, side) {
    const existing = this.claims.find((c) => c.side === side && (c.x - x) ** 2 + (c.z - z) ** 2 < (c.r * 0.7) ** 2);
    if (existing) {
      existing.r = Math.max(existing.r, r);
      existing.hold = Math.min(1, existing.hold + 0.4);
      return existing;
    }
    const claim = { x, z, r, side, hold: 0.25 };
    this.claims.push(claim);
    if (this.claims.length > 10) {
      let weakest = 0;
      for (let i = 1; i < this.claims.length; i++) if (this.claims[i].hold < this.claims[weakest].hold) weakest = i;
      this.claims.splice(weakest, 1);
    }
    return claim;
  }

  _updateClaims(dt) {
    for (let i = this.claims.length - 1; i >= 0; i--) {
      const c = this.claims[i];
      let friend = 0, foe = 0;
      const r2 = (c.r * 1.15) ** 2;
      for (const side of ['bull', 'bear']) {
        const mine = side === c.side;
        for (const u of this.sides[side].units) {
          if (!u.active) continue;
          if ((u.x - c.x) ** 2 + (u.z - c.z) ** 2 < r2) mine ? friend++ : foe++;
        }
        for (const v of this.sides[side].vehicles) {
          if (!v.active) continue;
          if ((v.x - c.x) ** 2 + (v.z - c.z) ** 2 < r2) mine ? friend += 4 : (foe += 4);
        }
      }
      // held while your side owns the ground, contested away otherwise
      const pressure = friend > foe ? 0.16 : -0.11 - Math.min(0.3, foe * 0.02);
      c.hold = clamp(c.hold + pressure * dt, 0, 1);
      if (c.hold <= 0.001) this.claims.splice(i, 1);
    }
  }

  /** Which side effectively owns (x,z) — territory, overridden by any claim. */
  ownerAt(x, z) {
    for (const c of this.claims) {
      if (c.hold < 0.25) continue;
      if ((x - c.x) ** 2 + (z - c.z) ** 2 < c.r * c.r) return c.side;
    }
    return z < this.frontlineAt(x) ? 'bull' : 'bear';
  }

  /** Frontline z at a world x (interpolated between columns). */
  frontlineAt(x) {
    const t = clamp((x + WORLD.width / 2) / WORLD.width, 0, 1) * COLS;
    const i0 = Math.floor(t), i1 = Math.min(COLS, i0 + 1);
    return lerp(this.frontZ[i0], this.frontZ[i1], t - i0);
  }

  /** Terrain height at a world position — used to sit trucks/units on the ground. */
  /** Analytic ground height — this is what the terrain mesh is generated from. */
  heightAt(x, z) {
    const d = z - this.frontlineAt(x);
    const ad = Math.abs(d);
    let h = groundNoise(x, z) * 0.55;
    h += 0.8 / (1 + Math.pow((ad - 9) / 7, 2));     // faint spoil, not a rampart
    h -= 1.9 / (1 + Math.pow(d / 8.0, 2));         // broad churned hollow
    h -= this._craterAt(x, z);
    return h;
  }

  /**
   * Height of the terrain *as actually rendered*, by interpolating the mesh's
   * own vertices. The analytic height and the triangulated mesh disagree
   * wherever the ground curves sharply — most of all in the frontline trench,
   * where flat triangles cut across the dip and sit well above the true curve.
   * Anything that must appear to rest ON the ground (roads, trucks, troops)
   * has to use this, or it gets swallowed by the terrain.
   */
  surfaceAt(x, z) {
    if (!this._meshed) return this.heightAt(x, z);
    const arr = this.pos.array;
    const fx = clamp((x + WORLD.width / 2) / WORLD.width, 0, 1) * COLS;
    const fz = clamp((z + WORLD.depth / 2) / WORLD.depth, 0, 1) * ROWS;
    const ix = Math.min(COLS - 1, fx | 0), iz = Math.min(ROWS - 1, fz | 0);
    const tx = fx - ix, tz = fz - iz;
    const h = (cx, cz) => arr[(cz * VW + cx) * 3 + 1];
    return lerp(
      lerp(h(ix, iz), h(ix + 1, iz), tx),
      lerp(h(ix, iz + 1), h(ix + 1, iz + 1), tx),
      tz,
    );
  }

  _craterAt(x, z) {
    let v = 0;
    for (const c of this.craters) {
      const dx = x - c.x, dz = z - c.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < c.r * c.r) v += c.depth * (1 - d2 / (c.r * c.r)) * c.k;
    }
    return v;
  }

  crater(x, z, r = 10, depth = 4, decay = 0.012) {
    this.craters.push({ x, z, r, depth, k: 1, decay });
    if (this.craters.length > 26) {
      // Evict the least significant crater, not the oldest: a nuke destroys
      // everything around it, and each of those wrecks leaves its own small
      // crater — dropping oldest-first would delete the nuke's own hole.
      let worst = 0, worstScore = Infinity;
      for (let i = 0; i < this.craters.length; i++) {
        const c = this.craters[i];
        const score = c.r * c.depth * c.k;
        if (score < worstScore) { worstScore = score; worst = i; }
      }
      this.craters.splice(worst, 1);
    }
  }

  /* -------------------------------------------------------------- units */

  _buildUnits() {
    // Merged, vertex-coloured geometries: the whole army is a handful of draw
    // calls, but every man has a helmet and a rifle, legs that swing from the
    // hip, and every tank has a turret that traverses independently.
    const body = makeSoldierBody();
    const leg = makeSoldierLeg();
    const hull = makeTankHull();
    const turret = makeTankTurret();
    const bigBounds = new THREE.Sphere(new THREE.Vector3(), 600);

    this.sides = {};
    for (const [side, color] of [['bull', 0x46e08c], ['bear', 0xff5a6a]]) {
      const mk = (geo, count, extra) => {
        const mesh = new THREE.InstancedMesh(
          geo,
          new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, ...extra }),
          count,
        );
        mesh.castShadow = true;
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
        mesh.frustumCulled = false;
        mesh.boundingSphere = bigBounds.clone();
        this.scene.add(mesh);
        // team colour, with a little per-man variation so ranks don't look cloned
        const c = new THREE.Color();
        for (let i = 0; i < count; i++) {
          c.setHex(color).offsetHSL(0, rand(-0.06, 0.06), rand(-0.09, 0.05));
          mesh.setColorAt(i, c);
        }
        mesh.instanceColor.needsUpdate = true;
        return mesh;
      };

      const infantry = mk(body, 240, { roughness: 0.72, metalness: 0.05 });
      const legL = mk(leg, 240, { roughness: 0.72, metalness: 0.05 });
      const legR = mk(leg, 240, { roughness: 0.72, metalness: 0.05 });
      const armour = mk(hull, 22, { roughness: 0.5, metalness: 0.35 });
      const turrets = mk(turret, 22, { roughness: 0.5, metalness: 0.35 });
      this.sides[side] = { infantry, legL, legR, armour, turrets, units: [], vehicles: [], color, alive: 0 };
    }

    this.dummy = new THREE.Object3D();
    const dir = (side) => (side === 'bull' ? 1 : -1);   // bulls push +z, bears push -z
    for (const side of ['bull', 'bear']) {
      const s = this.sides[side];
      for (let i = 0; i < s.infantry.count; i++) {
        s.units.push(this._newUnit(side, dir(side)));
      }
      for (let i = 0; i < s.armour.count; i++) {
        s.vehicles.push(this._newUnit(side, dir(side), true));
      }
    }
  }

  _newUnit(side, dir, vehicle = false) {
    const x = rand(-WORLD.width / 2 + 6, WORLD.width / 2 - 6);
    return {
      side, dir, vehicle,
      x,
      z: this.frontlineAt(x) - dir * rand(14, 70),
      speed: vehicle ? rand(3.2, 5.2) : rand(2.0, 4.6),
      phase: rand(TAU),
      stride: rand(TAU),          // desynchronised, or the whole army goose-steps
      traverse: rand(-0.2, 0.2),
      recoil: 0,
      reload: rand(0, 2.5),
      retreating: false,
      yaw: dir > 0 ? 0 : Math.PI,      // hull heading, follows actual travel
      turretYaw: dir > 0 ? 0 : Math.PI,
      hp: vehicle ? rand(3, 6) : 1,
      fire: rand(0.4),
      active: true,
      respawn: rand(0, 3),
    };
  }

  setFlow(imbalance) { this.flow = clamp(imbalance, -1, 1); }

  /* --------------------------------------------------------- order book */

  _buildOrderBook() {
    const g = new THREE.BoxGeometry(1, 1, 1);
    g.translate(0, 0.5, 0);
    this.bookMesh = new THREE.InstancedMesh(
      g,
      new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.3, roughness: 0.3, metalness: 0.1, depthWrite: false }),
      40,
    );
    this.bookMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.bookMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(40 * 3), 3);
    this.bookMesh.frustumCulled = false;
    this.scene.add(this.bookMesh);
    this.book = null;
  }

  setDepth(book) { this.book = book; }

  _updateBook() {
    if (!this.book) return;
    const d = this.dummy;
    const c = new THREE.Color();
    let i = 0;
    // Lay the book out by DEPTH RANK, not by mapping price to z. The terrain
    // auto-zooms to a window a few dollars wide, so real book levels (±0.4% of
    // price) either fall off the map or collapse onto the same z and stack into
    // one solid translucent slab. Rank keeps them legible in any regime: rung 0
    // is the touch, rung 11 is deep in the book.
    const front = this.frontlineAt(0);
    const N = 8;
    const push = (levels, isBid) => {
      let maxQ = 0.0001;
      for (const [, q] of levels.slice(0, N)) maxQ = Math.max(maxQ, q);
      for (let k = 0; k < Math.min(N, levels.length); k++) {
        if (i >= 40) return;
        const rel = levels[k][1] / maxQ;
        if (rel < 0.15) continue;                   // only walls worth drawing
        const z = clamp(front + (isBid ? -1 : 1) * (7 + k * 4.6), -WORLD.halfZ * 1.3, WORLD.halfZ * 1.3);
        // Height is the resting size at that rung, so a big wall is visibly a
        // big wall. Length shrinks with depth so the stack reads as a fan of
        // barricades behind the line, not a set of mystery stripes.
        const h = 0.7 + rel * 7;
        d.position.set(0, this.surfaceAt(0, z) + 0.1, z);
        d.rotation.set(0, 0, 0);
        d.scale.set(WORLD.width * (0.46 - k * 0.03), h, 1.1 + rel * 1.6);
        d.updateMatrix();
        this.bookMesh.setMatrixAt(i, d.matrix);
        c.setHex(isBid ? 0x2ee66f : 0xff3b52).multiplyScalar(0.3 + rel * 0.9);
        this.bookMesh.setColorAt(i, c);
        i++;
      }
    };
    push(this.book.bids, true);
    push(this.book.asks, false);
    for (; i < 40; i++) {
      d.position.set(0, -999, 0); d.scale.set(0.01, 0.01, 0.01); d.updateMatrix();
      this.bookMesh.setMatrixAt(i, d.matrix);
    }
    this.bookMesh.instanceMatrix.needsUpdate = true;
    if (this.bookMesh.instanceColor) this.bookMesh.instanceColor.needsUpdate = true;
  }

  /* --------------------------------------------------------------- feed */

  /** Called every frame with the latest price; samples into history on a timer. */
  feedPrice(price, dt) {
    if (!this.seeded && price > 0) {
      // Seed with a plausible random walk so the terrain has history on frame 1
      // instead of a suspiciously perfect sine wave.
      let p = price, v = 0;
      const seed = [];
      for (let i = 0; i < VW; i++) {
        // keep the seeded walk close to real market scale, so the opening
        // seconds don't look wilder than the live data that replaces them
        v = v * 0.86 + rand(-1, 1) * price * 0.00006;
        p = p + v;
        seed.push(p);
      }
      const drift = price - seed[VW - 1];
      for (let i = 0; i < VW; i++) this.history.push(seed[i] + drift * (i / (VW - 1)));
      this.priceLo = price * 0.997; this.priceHi = price * 1.003;
      this.seeded = true;
    }
    // Exponentially smooth the price before sampling it. Real ticks arrive as a
    // step function — a flat stretch then a jump — and a smoothed series turns
    // that into a curve the terrain and the road can actually follow.
    this._ema = this._ema ? lerp(this._ema, price, HISTORY.emaAlpha) : price;

    this._sampleAcc += dt * 1000;
    if (this._sampleAcc >= HISTORY.sampleMs) {
      this._sampleAcc = 0;
      this.history.push(this._ema);
      const [lo, hi] = this.history.minmax();
      // The window auto-zooms to whatever range actually exists, so a market
      // that only moves cents still redraws the whole battlefield. The floor
      // only exists to avoid dividing by zero on a perfectly flat tape.
      const pad = Math.max((hi - lo) * HISTORY.windowPad, price * HISTORY.minSpanPct);
      this.priceLo = approach(this.priceLo, lo - pad, 1.5, 0.22);
      this.priceHi = approach(this.priceHi, hi + pad, 1.5, 0.22);
    }
  }

  /* ------------------------------------------------------------- update */

  update(dt, ctx) {
    // Raw price samples are spiky: BTC can sit on two distinct values for a
    // minute, and the auto-scaled window turns each tick into a big z jump. Left
    // raw, the frontline is a sawtooth and the road that follows it zigzags
    // across the map. Smooth it into a line you can actually drive down.
    const raw = this._rawFront || (this._rawFront = new Float32Array(VW));
    for (let i = 0; i < VW; i++) raw[i] = this.priceToZ(this.history.at(i));
    for (let i = 0; i < VW; i++) {
      let sum = 0, wsum = 0;
      for (let k = -4; k <= 4; k++) {
        const j = i + k < 0 ? 0 : i + k >= VW ? VW - 1 : i + k;
        const w = 1 / (1 + Math.abs(k));
        sum += raw[j] * w; wsum += w;
      }
      this.frontZ[i] = sum / wsum;
    }

    for (let i = this.craters.length - 1; i >= 0; i--) {
      this.craters[i].k -= dt * (this.craters[i].decay ?? 0.012);   // ground slowly heals
      if (this.craters[i].k <= 0) this.craters.splice(i, 1);
    }

    this._meshAcc += dt;
    if (this._meshAcc > 1 / 24) { this._updateMesh(); this._meshAcc = 0; }
    this._updateTrench();
    this._updateBook();
    this._updateStrikes(dt);
    this._updateMushrooms(dt);
    this._updateClaims(dt);
    this._updateHelis(dt, ctx);
    this._updateUnits(dt, ctx);
    this.roads.update(dt);
  }

  _updateMesh() {
    const arr = this.pos.array, col = this.col.array;
    const bullC = new THREE.Color(0x1f7a44), bearC = new THREE.Color(0x7a1f2a);
    const hotC = new THREE.Color(0xffd98a);
    const rearC = new THREE.Color(0x3f4756);
    const bias = clamp(this.flow, -1, 1);
    for (let iy = 0; iy < VH; iy++) {
      const z = this.rowZ(iy);
      for (let ix = 0; ix < VW; ix++) {
        const i = iy * VW + ix;
        const i3 = i * 3;
        const d = z - this.frontZ[ix];
        const ad = Math.abs(d);
        let h = this.baseH[i];
        h += 0.8 / (1 + ((ad - 9) / 7) * ((ad - 9) / 7));
        h -= 1.9 / (1 + (d / 8.0) * (d / 8.0));
        h -= this._craterAt(arr[i3], z);
        arr[i3 + 1] = h;

        // colour: territory + hot seam, fading to neutral rear areas so the
        // plaza and the depot read as friendly ground, not contested ground
        const own = d < 0 ? bullC : bearC;
        const grip = clamp(ad / 46, 0, 1);
        const shade = 0.45 + grip * 0.75 + clamp(this.baseH[i] * 0.022, -0.08, 0.42);
        let r = own.r * shade, g = own.g * shade, b = own.b * shade;
        const heat = 1 / (1 + (ad / 5.5) ** 4);
        r = lerp(r, hotC.r, heat * 0.9);
        g = lerp(g, hotC.g, heat * 0.9);
        b = lerp(b, hotC.b, heat * 0.9);
        if (d < 0) g += bias * 0.05; else r -= bias * 0.05;
        // ground seized by a strike flies the attacker's colours while held
        if (this.claims.length) {
          const vx = arr[i3];
          for (let k = 0; k < this.claims.length; k++) {
            const cl = this.claims[k];
            const dcx = vx - cl.x, dcz = z - cl.z;
            const dd = dcx * dcx + dcz * dcz;
            if (dd > cl.r * cl.r) continue;
            const edge = 1 - Math.sqrt(dd) / cl.r;
            const t = clamp(edge * 2.2, 0, 1) * cl.hold;
            const own2 = cl.side === 'bull' ? bullC : bearC;
            r = lerp(r, own2.r * (0.9 + grip * 0.4), t);
            g = lerp(g, own2.g * (0.9 + grip * 0.4), t);
            b = lerp(b, own2.b * (0.9 + grip * 0.4), t);
          }
        }
        const rear = clamp((Math.abs(arr[i3]) - REAR_X) / 26, 0, 1);
        if (rear > 0) {
          const k = rear * rear * (3 - 2 * rear);
          r = lerp(r, rearC.r, k); g = lerp(g, rearC.g, k); b = lerp(b, rearC.b, k);
        }
        col[i3] = r; col[i3 + 1] = g; col[i3 + 2] = b;
      }
    }
    this.pos.needsUpdate = true;
    this.col.needsUpdate = true;
    this.terrain.geometry.computeVertexNormals();
    this._meshed = true;
  }

  _updateTrench() {
    const p = this.trenchPos;
    for (let i = 0; i <= COLS; i++) {
      const x = this.colX(i);
      const z = this.frontZ[i];
      const y = this.heightAt(x, z) + 0.35;
      p[i * 6] = x; p[i * 6 + 1] = y; p[i * 6 + 2] = z - 3.4;
      p[i * 6 + 3] = x; p[i * 6 + 4] = y; p[i * 6 + 5] = z + 3.4;
    }
    this.trench.geometry.attributes.position.needsUpdate = true;
    this.trench.material.opacity = 0.32 + this.volatility * 0.35 + Math.abs(this.flow) * 0.15;
  }

  _updateUnits(dt, ctx) {
    const d = this.dummy;
    const flow = this.flow;
    for (const side of ['bull', 'bear']) {
      const s = this.sides[side];
      // Trade flow decides how many troops each side can keep in the field.
      const strength = side === 'bull' ? 0.45 + clamp(flow, -0.4, 1) * 0.55 : 0.45 + clamp(-flow, -0.4, 1) * 0.55;
      const wanted = Math.round(s.units.length * clamp(strength, 0.15, 1));
      let alive = 0;

      for (let i = 0; i < s.units.length; i++) {
        const u = s.units[i];
        if (!u.active) {
          u.respawn -= dt;
          if (u.respawn <= 0 && alive < wanted) {
            u.active = true;
            u.x = rand(-WORLD.width / 2 + 6, WORLD.width / 2 - 6);
            u.z = this.frontlineAt(u.x) - u.dir * rand(30, 78);
            u.hp = 1;
          } else {
            d.position.set(0, -500, 0); d.scale.setScalar(0.001); d.updateMatrix();
            s.infantry.setMatrixAt(i, d.matrix);
            s.legL.setMatrixAt(i, d.matrix);
            s.legR.setMatrixAt(i, d.matrix);
            continue;
          }
        }
        if (alive >= wanted) { u.active = false; u.respawn = rand(1, 5); }
        alive++;

        const front = this.frontlineAt(u.x);
        const gap = (front - u.z) * u.dir;               // >0 means still behind the line
        if (gap > 3) {
          u.z += u.dir * u.speed * dt * (1 + Math.abs(flow) * 0.6);
          u.x += Math.sin(u.phase + performance.now() * 0.0006) * dt * 2.2;
        } else {
          u.z += u.dir * Math.sin(performance.now() * 0.002 + u.phase) * dt * 3;
          u.fire -= dt;
          if (u.fire <= 0) {
            u.fire = rand(0.25, 1.4);
            const my = this.surfaceAt(u.x, u.z) + 1.35;
            const tz = front + u.dir * rand(5, 16);
            const tx = u.x + rand(-5, 5);
            const col = side === 'bull' ? 0x9dffb8 : 0xffa0a8;
            this.fx.bullet(u.x, my, u.z + u.dir * 0.5, tx, this.surfaceAt(tx, tz) + 0.8, tz, { color: col, speed: rand(64, 88), size: 1 });
            this.fx.muzzle(u.x, my, u.z + u.dir * 0.8, 0, u.dir, 0.55);
            if (Math.random() < 0.06) ctx.onGunfire?.();
            // Losing side takes casualties faster.
            const pressure = side === 'bull' ? -flow : flow;
            if (Math.random() < 0.35 + pressure * 0.3) this._kill(u, side);
          }
        }
        u.x = clamp(u.x, -FRONT_X, FRONT_X);

        // --- animation: march the legs, bob the body, lean into the advance
        const moving = gap > 3;
        u.stride += dt * (moving ? 6.5 + u.speed * 0.5 : 1.6);
        const swing = Math.sin(u.stride) * (moving ? 0.62 : 0.06);
        const y = this.surfaceAt(u.x, u.z);
        const bob = moving ? Math.abs(Math.cos(u.stride)) * 0.09 : 0;
        const yaw = u.dir > 0 ? 0 : Math.PI;

        d.position.set(u.x, y + bob, u.z);
        d.rotation.set(moving ? 0.1 : 0, yaw, Math.sin(u.stride) * (moving ? 0.05 : 0.02));
        d.scale.setScalar(1);
        d.updateMatrix();
        s.infantry.setMatrixAt(i, d.matrix);

        // legs pivot at the hip, out of phase with each other
        const hipX = 0.22;
        for (const [mesh, sign, off] of [[s.legL, 1, -hipX], [s.legR, -1, hipX]]) {
          d.position.set(u.x + off * Math.cos(yaw), y + bob + HIP_Y, u.z - off * Math.sin(yaw));
          d.rotation.set(swing * sign * u.dir, yaw, 0);
          d.scale.setScalar(1);
          d.updateMatrix();
          mesh.setMatrixAt(i, d.matrix);
        }
      }
      s.alive = alive;
      s.infantry.instanceMatrix.needsUpdate = true;
      s.legL.instanceMatrix.needsUpdate = true;
      s.legR.instanceMatrix.needsUpdate = true;

    }
    this._updateArmour(dt, ctx);
  }

  /**
   * Armour is resolved across both sides at once, because tanks have to know
   * about each other: they push apart instead of interpenetrating, they duel
   * the nearest enemy instead of driving through it, and when the frontline
   * moves against them they fall back toward their own flank rather than
   * standing in ground they no longer hold.
   */
  _updateArmour(dt, ctx) {
    const d = this.dummy;
    const flow = this.flow;

    const live = [];
    for (const side of ['bull', 'bear']) {
      for (const v of this.sides[side].vehicles) if (v.active) live.push(v);
    }

    // --- keep hulls out of each other ------------------------------------
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        const a = live[i], b = live[j];
        const dx = b.x - a.x, dz = b.z - a.z;
        const d2 = dx * dx + dz * dz;
        const min = a.side === b.side ? 8.5 : 7.5;
        if (d2 > 1e-4 && d2 < min * min) {
          const dist = Math.sqrt(d2);
          const push = (min - dist) * 0.5;
          const nx = dx / dist, nz = dz / dist;
          a.x -= nx * push; a.z -= nz * push;
          b.x += nx * push; b.z += nz * push;
        }
      }
    }

    for (const side of ['bull', 'bear']) {
      const s = this.sides[side];
      const pressure = side === 'bull' ? flow : -flow;   // >0 = this side is winning

      for (let i = 0; i < s.vehicles.length; i++) {
        const v = s.vehicles[i];

        if (!v.active) {
          v.respawn -= dt;
          if (v.respawn <= 0) {
            v.active = true;
            v.hp = rand(3, 6);
            v.x = rand(-FRONT_X + 8, FRONT_X - 8);
            v.z = this.frontlineAt(v.x) - v.dir * rand(46, 76);   // arrives from the rear
          } else {
            d.position.set(0, -500, 0); d.scale.setScalar(0.001); d.updateMatrix();
            s.armour.setMatrixAt(i, d.matrix);
            s.turrets.setMatrixAt(i, d.matrix);
            continue;
          }
        }

        v.recoil = Math.max(0, v.recoil - dt * 4);
        v.reload = Math.max(0, (v.reload ?? rand(0, 2)) - dt);

        // nearest enemy hull
        let foe = null, foeD2 = Infinity;
        for (const w of live) {
          if (w.side === v.side || !w.active) continue;
          const dd = (w.x - v.x) ** 2 + (w.z - v.z) ** 2;
          if (dd < foeD2) { foeD2 = dd; foe = w; }
        }
        const engaged = foe && foeD2 < 46 * 46;

        // --- movement: drive toward an objective, hold, or fall back -------
        // Tanks steer toward a point rather than sliding along Z, so the hull
        // actually turns into its line of advance instead of strafing.
        const front = this.frontlineAt(v.x);
        const gap = (front - v.z) * v.dir;        // >0 = still behind our line
        const overrun = gap < -14;                // the line has moved past us
        const px = v.x, pz = v.z;

        let goalX, goalZ, drive;
        if (overrun) {
          goalX = v.x + Math.sin(v.phase) * 20;
          goalZ = front - v.dir * 34;             // fall back behind our own line
          drive = v.speed * 1.35;
          if (!v.retreating) { v.retreating = true; this.fx.smoke(v.x, this.surfaceAt(v.x, v.z) + 2, v.z, 3, 1.4); }
        } else {
          v.retreating = false;
          goalX = engaged ? foe.x : v.x + Math.sin(v.phase * 3 + performance.now() * 0.0002) * 26;
          if (engaged && foeD2 < 24 * 24) {
            goalZ = v.z - v.dir * 6;              // back off to keep standoff
            drive = v.speed * 0.35;
          } else {
            goalZ = front - v.dir * 9;            // push up to the line
            drive = v.speed;
          }
        }
        goalX = clamp(goalX, -FRONT_X + 4, FRONT_X - 4);

        const gx = goalX - v.x, gz = goalZ - v.z;
        const gl = Math.hypot(gx, gz);
        if (gl > 0.6) {
          const step = Math.min(drive * dt, gl);
          v.x += (gx / gl) * step;
          v.z += (gz / gl) * step;
        }
        v.x = clamp(v.x, -FRONT_X + 4, FRONT_X - 4);
        v.z = clamp(v.z, -WORLD.depth / 2 + 6, WORLD.depth / 2 - 6);

        // hull turns to face the way it is actually travelling
        const mvx = v.x - px, mvz = v.z - pz;
        const moved = Math.hypot(mvx, mvz);
        if (moved > dt * 0.4) v.yaw = angleApproach(v.yaw, Math.atan2(mvx, mvz), 2.2, dt);
        const yaw = v.yaw;

        // --- turret + gunnery: traverses in world space, independent of hull
        const aimWorld = engaged
          ? Math.atan2(foe.x - v.x, foe.z - v.z)
          : Math.atan2(Math.sin(v.phase) * 14, (front + v.dir * 20) - v.z);
        v.turretYaw = angleApproach(v.turretYaw, aimWorld, 2.6, dt);
        let want = v.turretYaw - yaw;
        while (want > Math.PI) want -= TAU;
        while (want < -Math.PI) want += TAU;
        v.traverse = want;

        if (engaged && v.reload <= 0 && Math.abs(angleDelta(v.turretYaw, aimWorld)) < 0.2) {
          v.reload = rand(1.4, 3.2) / (1 + Math.max(0, pressure));
          v.recoil = 1;
          const worldYaw = v.turretYaw;
          const my = this.surfaceAt(v.x, v.z) + TURRET_Y + 0.5;
          const mx = v.x + Math.sin(worldYaw) * 5.2;
          const mz = v.z + Math.cos(worldYaw) * 5.2;
          const target = foe;
          this.fx.bullet(mx, my, mz, target.x, this.surfaceAt(target.x, target.z) + 1.6, target.z, {
            color: side === 'bull' ? 0xd6ffe2 : 0xffd6da,
            speed: rand(70, 95), size: 2.2, heavy: true,
            onHit: (hx, hy, hz) => {
              this.fx.explosion(hx, hy + 0.4, hz, 0.55, 0xffa33a);
              this.roads.wearAt(hx, hz, 5, 0.16);
              if (Math.random() < 0.15) this.crater(hx, hz, 4.5, 1.1);
              if (!target.active) return;
              // did it actually connect? near misses are part of the show
              if ((target.x - hx) ** 2 + (target.z - hz) ** 2 < 36) {
                target.hp -= rand(1.1, 2.4) * (1 + Math.max(0, pressure) * 0.6);
                if (target.hp <= 0) this._destroyVehicle(target);
              }
            },
          });
          this.fx.muzzle(mx, my, mz, Math.sin(worldYaw), Math.cos(worldYaw), 2.2);
          this.fx.shockwave(mx, my, mz, 9, 0.35, 0xfff0c0);
          ctx.onCannon?.(v.x, v.z);
        }

        // --- pose: pitch along the hull's own axis, roll across it ---------
        const y = this.surfaceAt(v.x, v.z);
        const fx = Math.sin(yaw) * 3.2, fz = Math.cos(yaw) * 3.2;
        const rx = Math.cos(yaw) * 2.0, rz = -Math.sin(yaw) * 2.0;
        const pitch = -Math.atan2(this.surfaceAt(v.x + fx, v.z + fz) - this.surfaceAt(v.x - fx, v.z - fz), 6.4);
        const roll = Math.atan2(this.surfaceAt(v.x + rx, v.z + rz) - this.surfaceAt(v.x - rx, v.z - rz), 4);

        d.position.set(v.x, y, v.z);
        d.rotation.set(pitch + v.recoil * 0.05, yaw, roll);
        d.scale.setScalar(1);
        d.updateMatrix();
        s.armour.setMatrixAt(i, d.matrix);

        const wy = v.turretYaw;
        d.position.set(v.x - Math.sin(wy) * v.recoil * 0.55, y + TURRET_Y, v.z - Math.cos(wy) * v.recoil * 0.55);
        d.rotation.set(pitch, wy, roll);
        d.scale.setScalar(1);
        d.updateMatrix();
        s.turrets.setMatrixAt(i, d.matrix);
      }
      s.armour.instanceMatrix.needsUpdate = true;
      s.turrets.instanceMatrix.needsUpdate = true;
    }
  }

  /** A tank brews up: fireball, wreck smoke, and a long walk back from the rear. */
  _destroyVehicle(v, quiet = false) {
    v.active = false;
    v.retreating = false;
    v.respawn = rand(6, 14);
    const y = this.surfaceAt(v.x, v.z);
    this.fx.explosion(v.x, y + 1.6, v.z, 1.5, 0xffa33a);
    this.fx.spawn(v.x, y + 2.5, v.z, {
      color: 0x3a3a3a, count: 40, size: 6, life: 4.5, speed: 5, spread: 2, gravity: 2.6, drag: 0.6, alpha: 0.5,
    });
    if (!quiet) this.crater(v.x, v.z, 7, 1.6);
    this.roads.wearAt(v.x, v.z, 7, 0.3);
    this.audio?.explosion(quiet ? 0.4 : 0.9);
  }

  _kill(u, side) {
    u.active = false;
    u.respawn = rand(0.8, 4.5);
    const y = this.surfaceAt(u.x, u.z) + 1;
    this.fx.spawn(u.x, y, u.z, {
      color: side === 'bull' ? 0x8dffb0 : 0xff8a95, count: 9, size: 1.5, life: 0.7, speed: 7, gravity: -12,
    });
  }

  _buildAircraft() {
    this.planes = [];
    for (let i = 0; i < 6; i++) {
      const obj = makeBomber(i % 2 ? 0x8d99ab : 0x7f8b78);
      obj.visible = false;
      this.scene.add(obj);
      this.planes.push({ obj, busy: false });
    }
    const bombGeo = makeBomb();
    this.bombs = [];
    for (let i = 0; i < 6; i++) {
      const obj = new THREE.Mesh(bombGeo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.4, flatShading: true }));
      obj.visible = false;
      obj.castShadow = true;
      this.scene.add(obj);
      this.bombs.push({ obj, busy: false });
    }
  }

  /**
   * Liquidation airstrike. A bomber flies in from off-map, runs over the target,
   * releases a bomb that falls ballistically, then banks away trailing smoke —
   * about eight seconds of theatre rather than an instant puff. Impact damage is
   * resolved by the caller through `onImpact`.
   */
  airstrike(price, usd, side, onImpact, { nuke = false } = {}) {
    const z = clamp(this.priceToZ(price), -WORLD.depth / 2 + 10, WORLD.depth / 2 - 10);
    const x = rand(-WORLD.width / 2 + 26, WORLD.width / 2 - 26);
    const power = clamp(Math.log10(Math.max(1000, usd)) - 3.2, 0.35, 3.2) * (nuke ? 1.6 : 1);

    const slot = this.planes.find((p) => !p.busy);
    if (!slot) {                                   // all bombers busy: strike anyway
      this._impact({ x, z, power, side, onImpact, nuke });
      return { x, z, power };
    }
    slot.busy = true;

    const dir = Math.random() < 0.5 ? 1 : -1;
    const alt = 62 + power * 12;
    const speed = 52 + power * 5;
    const g = 30;
    const fall = Math.sqrt((2 * (alt - this.heightAt(x, z))) / g);

    slot.obj.visible = true;
    this.incoming.push({
      kind: 'raid',
      plane: slot,
      x, z, power, side, onImpact, nuke, dir, alt, speed, fall, g,
      dropX: x - dir * speed * fall,             // release early so the bomb arcs in
      px: x - dir * (speed * fall + 190),        // spawn well off-map
      t: 0,
      dropped: false,
      bank: 0,
      engine: this.audio?.engine?.() ?? null,
    });
    if (power > 1.6) this.audio?.siren();
    return { x, z, power };
  }

  _retire(m, i) {
    m.engine?.stop();
    if (m.bomb) { m.bomb.obj.visible = false; m.bomb.busy = false; }
    if (m.plane) { m.plane.obj.visible = false; m.plane.busy = false; }
    this.incoming.splice(i, 1);
  }

  _impact(m) {
    const { x, z, power, side, nuke } = m;
    const y = this.heightAt(x, z);

    if (nuke) {
      // A liquidation doesn't dent the ground, it reshapes it: a wide, deep
      // crater that stays for minutes, a mushroom column, stacked shockwaves.
      const r = 20 + power * 9;
      this.crater(x, z, r, 4 + power * 2.6, 0.0016);
      this.crater(x + rand(-r, r) * 0.4, z + rand(-r, r) * 0.4, r * 0.55, 2 + power, 0.0022);
      this.mushrooms.push({ x, z, y, power, t: 0, capped: false });
      for (let i = 0; i < 3; i++) {
        this.fx.shockwave(x, y, z, (26 + power * 22) * (1 + i * 0.5), 1.1 + i * 0.45, i ? 0xffb46a : 0xffffff);
      }
      this.fx.spawn(x, y + 2, z, {
        color: 0xffffff, count: 200, size: 5 * power, life: 0.55,
        speed: 60 * Math.sqrt(power), spread: 2, gravity: 0, drag: 2.2,
      });
      this.fx.explosion(x, y + 2, z, power * 2.2, 0xffd08a);
      this.audio?.explosion(1.6);
      this.audio?.siren();
    } else {
      this.crater(x, z, 6 + power * 5, 1.4 + power * 2.2);
      this.fx.explosion(x, y + 1, z, power, side === 'long' ? 0xff5a3a : 0x6affc0);
      this.fx.spawn(x, y + 1, z, {
        color: 0xffffff, count: Math.round(30 * power), size: 2.6 * power, life: 0.5,
        speed: 30 * Math.sqrt(power), spread: 1, gravity: 0, drag: 2.4,
      });
    }

    // The blast takes ground for whoever called it in — but only if their
    // troops are close enough to actually hold it (see _updateClaims).
    this.claimGround(x, z, nuke ? 22 + power * 8 : 10 + power * 5, side === 'long' ? 'bear' : 'bull');
    if (nuke) this.roads.cutAt(x, z, 26 + power * 8);
    else this.roads.wearAt(x, z, 12 + power * 4, 0.55 + power * 0.15);

    // A column of light left standing at the price level that got wrecked.
    this.markers.push({ x, z, power, side, life: 1 });
    if (this.markers.length > 14) this.markers.shift();

    const lethal = (nuke ? 34 + power * 16 : 14 + power * 8) ** 2;
    for (const s of Object.values(this.sides)) {
      for (const u of s.units) {
        if (!u.active) continue;
        const dx = u.x - x, dz = u.z - z;
        if (dx * dx + dz * dz < lethal) this._kill(u, u.side);
      }
      if (nuke) {
        for (const v of s.vehicles) {
          if (!v.active) continue;
          const dx = v.x - x, dz = v.z - z;
          if (dx * dx + dz * dz < lethal) this._destroyVehicle(v, true);
        }
      }
    }
    m.onImpact?.({ x, y, z, power, nuke });
  }

  /* --------------------------------------------------------- helicopters */

  _buildHelis() {
    this.heliPool = [];
    for (let i = 0; i < 4; i++) {
      const obj = makeHelicopter(i % 2 ? 0x6f7a68 : 0x74707c);
      obj.visible = false;
      this.scene.add(obj);
      this.heliPool.push({ obj, busy: false });
    }
  }

  /**
   * Gunship run: comes in low from its own rear, sweeps the length of the enemy
   * front rocketing whatever it passes, then wheels away. Sits between armour
   * and a bomber on the escalation ladder.
   */
  heliStrike(side, power = 1) {
    const slot = this.heliPool.find((h) => !h.busy);
    if (!slot) return false;
    slot.busy = true;
    slot.obj.visible = true;

    const dir = Math.random() < 0.5 ? 1 : -1;
    const sign = side === 'bull' ? -1 : 1;          // which side it launches from
    this.helis.push({
      slot, side, dir, power,
      x: dir > 0 ? -WORLD.width / 2 - 40 : WORLD.width / 2 + 40,
      z: this.frontlineAt(0) + sign * rand(34, 52),
      y: 34,
      yaw: dir > 0 ? 0 : Math.PI,
      bank: 0, t: 0, fire: rand(0.4, 1.2),
      engine: this.audio?.engine?.() ?? null,
    });
    return true;
  }

  _updateHelis(dt, ctx) {
    const sign = (s) => (s === 'bull' ? -1 : 1);
    for (let i = this.helis.length - 1; i >= 0; i--) {
      const h = this.helis[i];
      h.t += dt;

      // run the length of the front, standing off on our own side of it
      const speed = 34 + h.power * 6;
      const px = h.x, pz = h.z;
      h.x += h.dir * speed * dt;
      const wantZ = this.frontlineAt(h.x) + sign(h.side) * (26 + Math.sin(h.t * 0.6) * 9);
      h.z += clamp(wantZ - h.z, -speed * dt * 1.6, speed * dt * 1.6);
      const wantY = this.surfaceAt(h.x, h.z) + 22 + Math.sin(h.t * 0.9) * 3;
      h.y = approach(h.y, wantY, 2, dt);

      // nose follows travel, and it banks in proportion to how hard it is turning
      const vx = h.x - px, vz = h.z - pz;
      if (Math.hypot(vx, vz) > 1e-4) {
        const want = Math.atan2(vx, vz);
        const turn = angleDelta(h.yaw, want);
        h.yaw = angleApproach(h.yaw, want, 3, dt);
        h.bank = approach(h.bank, clamp(turn * 4.5, -0.8, 0.8), 3.5, dt);
      }

      const o = h.slot.obj;
      o.position.set(h.x, h.y, h.z);
      // model noses along +X, so yaw is offset by a quarter turn
      o.rotation.set(0, h.yaw - Math.PI / 2, h.bank);
      o.userData.mainRotor.rotation.y += dt * 44;
      o.userData.tailRotor.rotation.x += dt * 60;
      h.engine?.set(clamp(1.2 - Math.abs(h.x) / 200, 0.15, 1), 1.5);

      // rocket the nearest enemy it passes
      h.fire -= dt;
      if (h.fire <= 0 && Math.abs(h.x) < WORLD.width / 2 - 10) {
        h.fire = rand(0.35, 0.9) / h.power;
        const foeSide = h.side === 'bull' ? 'bear' : 'bull';
        let best = null, bestD = 70 * 70;
        for (const v of this.sides[foeSide].vehicles) {
          if (!v.active) continue;
          const d2 = (v.x - h.x) ** 2 + (v.z - h.z) ** 2;
          if (d2 < bestD) { bestD = d2; best = v; }
        }
        if (!best) {
          for (const u of this.sides[foeSide].units) {
            if (!u.active) continue;
            const d2 = (u.x - h.x) ** 2 + (u.z - h.z) ** 2;
            if (d2 < bestD) { bestD = d2; best = u; }
          }
        }
        if (best) {
          const col = h.side === 'bull' ? 0xd6ffe2 : 0xffd6da;
          this.fx.bullet(h.x, h.y - 0.6, h.z, best.x, this.surfaceAt(best.x, best.z) + 1, best.z, {
            color: col, speed: 95, size: 1.9, heavy: true,
            onHit: (hx, hy, hz) => {
              this.fx.explosion(hx, hy + 0.4, hz, 0.45, 0xffa33a);
              this.claimGround(hx, hz, 11, h.side);
              if (best.vehicle) {
                best.hp -= rand(1.2, 2.2);
                if (best.hp <= 0) this._destroyVehicle(best);
              } else if (best.active) this._kill(best, best.side);
            },
          });
          this.fx.muzzle(h.x, h.y - 0.6, h.z, Math.sin(h.yaw), Math.cos(h.yaw), 1.1);
          ctx?.onCannon?.(h.x, h.z);
        }
      }

      if (Math.abs(h.x) > WORLD.width / 2 + 60 || h.t > 40) {
        h.engine?.stop();
        h.slot.obj.visible = false;
        h.slot.busy = false;
        this.helis.splice(i, 1);
      }
    }
  }

  /** Rising stem, then the cap — a mushroom cloud over a nuked price level. */
  _updateMushrooms(dt) {
    for (let i = this.mushrooms.length - 1; i >= 0; i--) {
      const c = this.mushrooms[i];
      c.t += dt;
      const p = c.power;
      if (c.t < 2.2) {
        this.fx.spawn(c.x + rand(-3, 3), c.y + 2 + c.t * 22, c.z + rand(-3, 3), {
          color: c.t < 0.8 ? 0xffb45a : 0x8a8378, count: 3, size: 7 * p, life: 4,
          speed: 3, spread: 2.5, gravity: 3.2, drag: 0.5, alpha: 0.6,
        });
      }
      if (!c.capped && c.t > 1.5) {
        c.capped = true;
        const capY = c.y + 42 * Math.min(1.6, p);
        this.fx.spawn(c.x, capY, c.z, {
          color: 0x9a9186, count: 160, size: 9 * p, life: 6,
          speed: 15 * p, spread: 3, gravity: 0.8, drag: 1.1, alpha: 0.5,
        });
        this.fx.spawn(c.x, capY, c.z, {
          color: 0xffc27a, count: 60, size: 7 * p, life: 3,
          speed: 12 * p, spread: 2, gravity: 1.4, drag: 1.3, alpha: 0.45,
        });
      }
      if (c.t > 7) this.mushrooms.splice(i, 1);
    }
  }

  _updateStrikes(dt) {
    for (let i = this.incoming.length - 1; i >= 0; i--) {
      const m = this.incoming[i];
      m.t += dt;
      m.px += m.dir * m.speed * dt;

      const obj = m.plane.obj;
      const toTarget = (m.x - m.px) * m.dir;          // >0 while still inbound
      const past = -toTarget;

      // bank into a turn once the payload is away
      const wantBank = m.dropped ? clamp(past / 90, 0, 1) * 0.85 : Math.sin(m.t * 0.7) * 0.10;
      m.bank = approach(m.bank, wantBank, 1.6, dt);
      const drift = m.dropped ? Math.pow(clamp(past / 70, 0, 1), 2) * 62 : 0;

      obj.position.set(m.px, m.alt + Math.sin(m.t * 1.3) * 1.4, m.z + drift * (m.side === 'long' ? 1 : -1));
      obj.rotation.set(0, m.dir > 0 ? 0 : Math.PI, m.bank * (m.dir > 0 ? 1 : -1));
      obj.scale.setScalar(1);
      for (const p of obj.userData.props) p.rotation.x += dt * 46;

      // engine note swells as it passes overhead
      m.engine?.set(clamp(1.1 - Math.abs(toTarget) / 220, 0.12, 1), 1 + clamp(toTarget / 400, -0.35, 0.35));

      // contrails from both engines
      if (Math.random() < dt * 30) {
        for (const s of [-4.2, 4.2]) {
          this.fx.spawn(m.px - m.dir * 2, obj.position.y - 0.3, obj.position.z + s, {
            color: 0xdfe6f0, count: 1, size: 2.6, life: 1.6, speed: 0.5, gravity: 0.4, alpha: 0.30,
          });
        }
      }

      // release
      if (!m.dropped && toTarget <= m.speed * m.fall) {
        m.dropped = true;
        const b = this.bombs.find((k) => !k.busy);
        if (b) {
          b.busy = true;
          b.obj.visible = true;
          m.bomb = b;
          m.bombX = m.px; m.bombY = obj.position.y; m.bombZ = m.z;
          m.bombVy = 0; m.bombT = 0;
          this.audio?.whistle(m.fall);
        } else {
          this._impact(m);
          this._retire(m, i);
          continue;
        }
      }

      // bomb flight
      if (m.dropped && m.bomb) {
        m.bombT += dt;
        m.bombVy -= m.g * dt;
        m.bombX += m.dir * m.speed * dt;
        m.bombY += m.bombVy * dt;
        const bo = m.bomb.obj;
        bo.position.set(m.bombX, m.bombY, m.bombZ);
        bo.rotation.set(clamp(-m.bombVy / 40, -1.4, 0) - Math.PI / 2, 0, m.dir > 0 ? 0 : Math.PI);
        bo.scale.setScalar(1 + m.power * 0.35);
        if (Math.random() < dt * 40) {
          this.fx.spawn(m.bombX, m.bombY, m.bombZ, { color: 0xb9c2cc, count: 1, size: 1.6, life: 0.8, speed: 0.4, gravity: 0.5, alpha: 0.45 });
        }
        if (m.bombY <= this.heightAt(m.bombX, m.bombZ) + 0.4) {
          m.x = m.bombX; m.z = m.bombZ;
          this._impact(m);
          m.bomb.obj.visible = false;
          m.bomb.busy = false;
          m.bomb = null;
        }
      }

      // Retire only once it has actually overflown the target and left — the
      // spawn point is itself far off-map, so a plain bounds check would kill
      // the raid on its first frame.
      if ((m.dropped && past > 240) || m.t > 26) this._retire(m, i);
    }

    for (let i = this.markers.length - 1; i >= 0; i--) {
      const mk = this.markers[i];
      mk.life -= dt * 0.16;
      if (mk.life <= 0) { this.markers.splice(i, 1); continue; }
      if (Math.random() < dt * 26 * mk.life) {
        const y = this.heightAt(mk.x, mk.z);
        this.fx.spawn(mk.x + rand(-1.5, 1.5), y + rand(0, 26), mk.z + rand(-1.5, 1.5), {
          color: mk.side === 'long' ? 0xff4d5e : 0x3ddc84,
          count: 1, size: 1.6, life: 1.1, speed: 1.4, gravity: 2.2, alpha: 0.7 * mk.life,
        });
      }
    }
  }

  bullDominance() {
    const b = this.sides.bull.alive, r = this.sides.bear.alive;
    return (b - r) / Math.max(1, b + r);
  }
}
