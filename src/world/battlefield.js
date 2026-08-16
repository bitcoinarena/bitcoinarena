import * as THREE from 'three';
import { WORLD, HISTORY } from '../config.js';
import { Ring, clamp, lerp, rand, randInt, approach, TAU } from '../util.js';
import { Roads, mountainHeight } from './roads.js';
import { makeSoldier, makeTank, makeBomber, makeBomb } from '../render/geom.js';

const COLS = WORLD.columns, ROWS = WORLD.rows;
const VW = COLS + 1, VH = ROWS + 1;

/** Cheap deterministic rolling ground noise (no external noise lib). */
function groundNoise(x, z) {
  return (
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
  constructor(scene, fx) {
    this.scene = scene;
    this.fx = fx;

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
    this.audio = null;         // set by game.js

    this._buildTerrain();
    this._buildTrench();
    this._buildUnits();
    this._buildOrderBook();
    this._buildBackdrop();
    this._buildAircraft();
    this.roads = new Roads(scene, this);
  }

  /** Centreline of a route — the trucks drive on the visible road surface. */
  laneZ(lane, x) { return this.roads.centerZ(lane, x); }

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

    // Mountains are static, so bake them into the base height once instead of
    // paying for them on every vertex of every mesh update.
    this.baseH = new Float32Array(VW * VH);
    for (let iy = 0; iy < VH; iy++) {
      for (let ix = 0; ix < VW; ix++) {
        const i = iy * VW + ix;
        const x = this.colX(ix), z = this.rowZ(iy);
        this.baseH[i] = groundNoise(x, z) * 0.55 + mountainHeight(x, z);
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

  /** Frontline z at a world x (interpolated between columns). */
  frontlineAt(x) {
    const t = clamp((x + WORLD.width / 2) / WORLD.width, 0, 1) * COLS;
    const i0 = Math.floor(t), i1 = Math.min(COLS, i0 + 1);
    return lerp(this.frontZ[i0], this.frontZ[i1], t - i0);
  }

  /** Terrain height at a world position — used to sit trucks/units on the ground. */
  heightAt(x, z) {
    const d = z - this.frontlineAt(x);
    const ad = Math.abs(d);
    let h = groundNoise(x, z) * 0.55 + mountainHeight(x, z);
    h += 2.4 / (1 + Math.pow((ad - 7.5) / 5.5, 2));   // shoulders
    h -= 3.0 / (1 + Math.pow(d / 4.0, 2));            // trench cut
    h -= this._craterAt(x, z);
    return h;
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

  crater(x, z, r = 10, depth = 4) {
    this.craters.push({ x, z, r, depth, k: 1 });
    if (this.craters.length > 26) this.craters.shift();
  }

  /* -------------------------------------------------------------- units */

  _buildUnits() {
    // One merged, vertex-coloured geometry per unit type: the whole army is two
    // draw calls, but every man still has a helmet, a pack and a rifle.
    const soldier = makeSoldier();
    const tank = makeTank();
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

      const infantry = mk(soldier, 240, { roughness: 0.72, metalness: 0.05 });
      const armour = mk(tank, 22, { roughness: 0.5, metalness: 0.35 });
      this.sides[side] = { infantry, armour, units: [], vehicles: [], color, alive: 0 };
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
    const limit = WORLD.halfZ * 1.1;
    const push = (levels, isBid) => {
      let maxQ = 0.0001;
      for (const [, q] of levels) maxQ = Math.max(maxQ, q);
      for (const [p, q] of levels) {
        if (i >= 40) return;
        const z = this.priceToZ(p);
        if (Math.abs(z) > limit) continue;          // off the map, skip it
        const rel = q / maxQ;
        if (rel < 0.12) continue;                   // only meaningful walls
        const h = 0.8 + rel * 5.5;                  // low ramparts, not curtains
        d.position.set(0, this.heightAt(0, z) + 0.1, z);
        d.rotation.set(0, 0, 0);
        d.scale.set(WORLD.width * 0.62, h, 0.9 + rel * 1.4);
        d.updateMatrix();
        this.bookMesh.setMatrixAt(i, d.matrix);
        c.setHex(isBid ? 0x2ee66f : 0xff3b52).multiplyScalar(0.3 + rel * 0.8);
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
        v = v * 0.86 + rand(-1, 1) * price * 0.00016;
        p = p + v;
        seed.push(p);
      }
      const drift = price - seed[VW - 1];
      for (let i = 0; i < VW; i++) this.history.push(seed[i] + drift * (i / (VW - 1)));
      this.priceLo = price * 0.997; this.priceHi = price * 1.003;
      this.seeded = true;
    }
    this._sampleAcc += dt * 1000;
    if (this._sampleAcc >= HISTORY.sampleMs) {
      this._sampleAcc = 0;
      this.history.push(price);
      const [lo, hi] = this.history.minmax();
      const pad = Math.max((hi - lo) * HISTORY.windowPad, price * HISTORY.minSpanPct);
      this.priceLo = approach(this.priceLo, lo - pad, 3, 0.22);
      this.priceHi = approach(this.priceHi, hi + pad, 3, 0.22);
    }
  }

  /* ------------------------------------------------------------- update */

  update(dt, ctx) {
    for (let i = 0; i < VW; i++) this.frontZ[i] = this.priceToZ(this.history.at(i));

    for (let i = this.craters.length - 1; i >= 0; i--) {
      this.craters[i].k -= dt * 0.012;                  // ground slowly heals
      if (this.craters[i].k <= 0) this.craters.splice(i, 1);
    }

    this._meshAcc += dt;
    if (this._meshAcc > 1 / 24) { this._updateMesh(); this._meshAcc = 0; }
    this._updateTrench();
    this._updateBook();
    this._updateStrikes(dt);
    this._updateUnits(dt, ctx);
    this.roads.update(dt);
  }

  _updateMesh() {
    const arr = this.pos.array, col = this.col.array;
    const bullC = new THREE.Color(0x1f7a44), bearC = new THREE.Color(0x7a1f2a);
    const hotC = new THREE.Color(0xffd98a);
    const bias = clamp(this.flow, -1, 1);
    for (let iy = 0; iy < VH; iy++) {
      const z = this.rowZ(iy);
      for (let ix = 0; ix < VW; ix++) {
        const i = iy * VW + ix;
        const i3 = i * 3;
        const d = z - this.frontZ[ix];
        const ad = Math.abs(d);
        let h = this.baseH[i];
        h += 2.4 / (1 + ((ad - 7.5) / 5.5) * ((ad - 7.5) / 5.5));
        h -= 3.0 / (1 + (d / 4.0) * (d / 4.0));
        h -= this._craterAt(arr[i3], z);
        arr[i3 + 1] = h;

        // colour: territory + hot seam, lightened on high ground
        const own = d < 0 ? bullC : bearC;
        const grip = clamp(ad / 46, 0, 1);
        const shade = 0.45 + grip * 0.75 + clamp(this.baseH[i] * 0.022, -0.08, 0.42);
        let r = own.r * shade, g = own.g * shade, b = own.b * shade;
        const heat = 1 / (1 + (ad / 5.5) ** 4);
        r = lerp(r, hotC.r, heat * 0.9);
        g = lerp(g, hotC.g, heat * 0.9);
        b = lerp(b, hotC.b, heat * 0.9);
        if (d < 0) g += bias * 0.05; else r -= bias * 0.05;
        col[i3] = r; col[i3 + 1] = g; col[i3 + 2] = b;
      }
    }
    this.pos.needsUpdate = true;
    this.col.needsUpdate = true;
    this.terrain.geometry.computeVertexNormals();
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
            const my = this.heightAt(u.x, u.z) + 1.35;
            const tz = front + u.dir * rand(5, 16);
            const tx = u.x + rand(-5, 5);
            const col = side === 'bull' ? 0x9dffb8 : 0xffa0a8;
            this.fx.bullet(u.x, my, u.z + u.dir * 0.5, tx, this.heightAt(tx, tz) + 0.8, tz, { color: col, speed: rand(64, 88), size: 1 });
            this.fx.muzzle(u.x, my, u.z + u.dir * 0.8, 0, u.dir, 0.55);
            if (Math.random() < 0.06) ctx.onGunfire?.();
            // Losing side takes casualties faster.
            const pressure = side === 'bull' ? -flow : flow;
            if (Math.random() < 0.35 + pressure * 0.3) this._kill(u, side);
          }
        }
        if (u.x < -WORLD.width / 2 + 4 || u.x > WORLD.width / 2 - 4) u.x = clamp(u.x, -WORLD.width / 2 + 4, WORLD.width / 2 - 4);

        const y = this.heightAt(u.x, u.z);
        d.position.set(u.x, y, u.z);
        d.rotation.set(0, u.dir > 0 ? 0 : Math.PI, Math.sin(performance.now() * 0.006 + u.phase) * 0.09);
        d.scale.setScalar(1);
        d.updateMatrix();
        s.infantry.setMatrixAt(i, d.matrix);
      }
      s.alive = alive;
      s.infantry.instanceMatrix.needsUpdate = true;

      for (let i = 0; i < s.vehicles.length; i++) {
        const v = s.vehicles[i];
        const front = this.frontlineAt(v.x);
        const gap = (front - v.z) * v.dir;
        if (gap > 12) v.z += v.dir * v.speed * dt;
        else v.z -= v.dir * dt * 1.2;
        v.x += Math.sin(v.phase * 3 + performance.now() * 0.0002) * dt * 3;
        v.x = clamp(v.x, -WORLD.width / 2 + 8, WORLD.width / 2 - 8);
        // main gun: a heavy shell that arcs across the line and detonates
        if (Math.random() < dt * 0.07) {
          const front2 = this.frontlineAt(v.x);
          const my = this.heightAt(v.x, v.z) + 2.35;
          const tx = v.x + rand(-10, 10);
          const tz = front2 + v.dir * rand(8, 26);
          this.fx.bullet(v.x, my, v.z + v.dir * 4.6, tx, this.heightAt(tx, tz) + 0.6, tz, {
            color: side === 'bull' ? 0xd6ffe2 : 0xffd6da,
            speed: rand(46, 62), size: 2.2, heavy: true,
            onHit: (hx, hy, hz) => {
              this.fx.explosion(hx, hy + 0.4, hz, 0.5, 0xffa33a);
              // craters are the expensive part of the terrain update — only the
              // occasional shell leaves one behind
              if (Math.random() < 0.15) this.crater(hx, hz, 4.5, 1.1);
            },
          });
          this.fx.muzzle(v.x, my, v.z + v.dir * 5.2, 0, v.dir, 2.2);
          this.fx.shockwave(v.x, my, v.z + v.dir * 5, 9, 0.35, 0xfff0c0);
          ctx.onCannon?.(v.x, v.z);
        }
        const y = this.heightAt(v.x, v.z);
        d.position.set(v.x, y, v.z);
        d.rotation.set(0, v.dir > 0 ? 0 : Math.PI, 0);
        d.scale.setScalar(1);
        d.updateMatrix();
        s.armour.setMatrixAt(i, d.matrix);
      }
      s.armour.instanceMatrix.needsUpdate = true;
    }
  }

  _kill(u, side) {
    u.active = false;
    u.respawn = rand(0.8, 4.5);
    const y = this.heightAt(u.x, u.z) + 1;
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
  airstrike(price, usd, side, onImpact) {
    const z = clamp(this.priceToZ(price), -WORLD.depth / 2 + 10, WORLD.depth / 2 - 10);
    const x = rand(-WORLD.width / 2 + 26, WORLD.width / 2 - 26);
    const power = clamp(Math.log10(Math.max(1000, usd)) - 3.2, 0.35, 3.2);

    const slot = this.planes.find((p) => !p.busy);
    if (!slot) {                                   // all bombers busy: strike anyway
      this._impact({ x, z, power, side, onImpact });
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
      x, z, power, side, onImpact, dir, alt, speed, fall, g,
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
    const { x, z, power, side } = m;
    const y = this.heightAt(x, z);
    this.crater(x, z, 6 + power * 5, 1.4 + power * 2.2);
    this.fx.explosion(x, y + 1, z, power, side === 'long' ? 0xff5a3a : 0x6affc0);
    this.fx.spawn(x, y + 1, z, {
      color: 0xffffff, count: Math.round(30 * power), size: 2.6 * power, life: 0.5,
      speed: 30 * Math.sqrt(power), spread: 1, gravity: 0, drag: 2.4,
    });
    // A column of light left standing at the price level that got wrecked.
    this.markers.push({ x, z, power, side, life: 1 });
    if (this.markers.length > 14) this.markers.shift();

    for (const s of Object.values(this.sides)) {
      for (const u of s.units) {
        if (!u.active) continue;
        const dx = u.x - x, dz = u.z - z;
        if (dx * dx + dz * dz < (14 + power * 8) ** 2) this._kill(u, u.side);
      }
    }
    m.onImpact?.({ x, y, z, power });
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
