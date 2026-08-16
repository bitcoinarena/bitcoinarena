import * as THREE from 'three';
import { WORLD, HISTORY } from '../config.js';
import { Ring, clamp, lerp, rand, randInt, approach, TAU } from '../util.js';

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

    this._buildTerrain();
    this._buildTrench();
    this._buildUnits();
    this._buildOrderBook();
    this._buildBackdrop();
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
        this.baseH[i] = groundNoise(this.colX(ix), this.rowZ(iy));
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
    let h = groundNoise(x, z) * 0.55;
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
    if (this.craters.length > 40) this.craters.shift();
  }

  /* -------------------------------------------------------------- units */

  _buildUnits() {
    const soldier = new THREE.CapsuleGeometry(0.55, 1.25, 3, 6);
    soldier.translate(0, 1.2, 0);
    const tank = new THREE.BoxGeometry(4.4, 1.9, 2.6);
    tank.translate(0, 1.1, 0);

    this.sides = {};
    for (const [side, color, emis] of [['bull', 0x3ddc84, 0x0d5a2c], ['bear', 0xff4d5e, 0x6b1220]]) {
      const infantry = new THREE.InstancedMesh(
        soldier,
        new THREE.MeshStandardMaterial({ color, emissive: emis, emissiveIntensity: 0.35, roughness: 0.6 }),
        360,
      );
      infantry.castShadow = true;
      infantry.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      infantry.frustumCulled = false;
      this.scene.add(infantry);

      const armour = new THREE.InstancedMesh(
        tank,
        new THREE.MeshStandardMaterial({ color, emissive: emis, emissiveIntensity: 0.5, roughness: 0.45, metalness: 0.3 }),
        26,
      );
      armour.castShadow = true;
      armour.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      armour.frustumCulled = false;
      this.scene.add(armour);

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
      const pad = Math.max((hi - lo) * HISTORY.windowPad, price * 0.0004);
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
    this._updateUnits(dt, ctx);
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
        let h = this.baseH[i] * 0.55;
        h += 2.4 / (1 + ((ad - 7.5) / 5.5) * ((ad - 7.5) / 5.5));
        h -= 3.0 / (1 + (d / 4.0) * (d / 4.0));
        h -= this._craterAt(arr[i3], z);
        arr[i3 + 1] = h;

        // colour: territory + hot seam
        const own = d < 0 ? bullC : bearC;
        const grip = clamp(ad / 46, 0, 1);
        const shade = 0.45 + grip * 0.75 + this.baseH[i] * 0.035;
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
            const ty = this.heightAt(u.x, front + u.dir * 6) + 1.4;
            this.fx.tracer(u.x, this.heightAt(u.x, u.z) + 1.5, u.z, u.x + rand(-4, 4), ty, front + u.dir * rand(4, 12), side === 'bull' ? 0x9dffb8 : 0xffa0a8);
            if (Math.random() < 0.02) ctx.onGunfire?.();
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
        if (Math.random() < dt * 0.25) {
          const front2 = this.frontlineAt(v.x);
          this.fx.tracer(v.x, this.heightAt(v.x, v.z) + 2.2, v.z, v.x + rand(-8, 8), this.heightAt(v.x, front2) + 2, front2 + v.dir * rand(6, 20), side === 'bull' ? 0xd6ffe2 : 0xffd6da);
          this.fx.spawn(v.x, this.heightAt(v.x, v.z) + 2.2, v.z + v.dir * 2.4, { color: 0xffcc66, count: 5, size: 1.6, life: 0.25, speed: 8, gravity: 0 });
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

  /** Liquidation airstrike at a price level. Returns the world position hit. */
  airstrike(price, usd, side) {
    const z = this.priceToZ(price);
    const x = rand(-WORLD.width / 2 + 20, WORLD.width / 2 - 20);
    const power = clamp(Math.log10(Math.max(1000, usd)) - 3.2, 0.35, 3.2);
    const y = this.heightAt(x, z);
    this.crater(x, z, 6 + power * 5, 1.4 + power * 2.2);
    this.fx.explosion(x, y + 1, z, power, side === 'long' ? 0xff5a3a : 0x6affc0);
    // knock nearby troops flat
    for (const s of Object.values(this.sides)) {
      for (const u of s.units) {
        if (!u.active) continue;
        const dx = u.x - x, dz = u.z - z;
        if (dx * dx + dz * dz < (14 + power * 8) ** 2) this._kill(u, u.side);
      }
    }
    return { x, y, z, power };
  }

  bullDominance() {
    const b = this.sides.bull.alive, r = this.sides.bear.alive;
    return (b - r) / Math.max(1, b + r);
  }
}
