import * as THREE from 'three';
import { WORLD, LANES, FEE, TRUCKS } from '../config.js';
import { clamp, lerp, rand, hash01, TAU, approach, pick } from '../util.js';

const MAX_PKG = 170;

/** Tier of a package relative to what the next block is currently paying. */
export function feeTier(feeRate, baseline = 1) {
  const ratio = feeRate / Math.max(0.5, baseline);
  let t = FEE.tiers[0];
  for (const tier of FEE.tiers) if (ratio >= tier.min) t = tier;
  return t;
}

const RADIO = {
  depart: [
    'Rolling out. Try not to explode this time.',
    'Convoy moving. Coffee is in the glovebox.',
    'Packages secured, mostly.',
  ],
  frontline: [
    'Taking the trench road! Tell my wife I said hi!',
    'Frontline route — we are basically a target now.',
    'Driving into the seam. This is fine.',
  ],
  hit: [
    'Ambush! Taking fire, taking fire!',
    'We lost a mirror! And possibly a package!',
    'That was NOT a pothole.',
  ],
  arrive: [
    'Delivery complete. Stamp it.',
    'Into the block she goes. Beautiful.',
    'Confirmed. One block deep and climbing.',
  ],
  wreck: [
    'We are down! Send another van!',
    'Truck is scrap. The packages RBF-ed themselves out.',
  ],
};

/**
 * Everything the player operates: the sorting plaza, the packages that spawn
 * from the real mempool, the fleet of mail trucks, and the block depot with the
 * Blockchain Gate at the far end of the battlefield.
 */
export class Logistics {
  constructor(scene, fx, battlefield, audio, events) {
    this.scene = scene;
    this.fx = fx;
    this.bf = battlefield;
    this.audio = audio;
    this.events = events;          // Emitter from game.js for log lines / scoring

    this.packages = [];
    this.trucks = [];
    this.selected = new Set();
    this.hover = null;
    this.time = 0;
    this.convoys = [];
    this.gatePulse = 0;
    this.feeBaseline = 1;      // next-block median fee, set by game.js
    this._whaleLogCd = 0;

    this._buildPlaza();
    this._buildPackages();
    this._buildDepot();
    this.addTruck(TRUCKS[0]);
  }

  /* -------------------------------------------------------------- plaza */

  _buildPlaza() {
    const g = new THREE.Group();
    g.position.set(WORLD.plazaX, 0, 0);

    const pad = new THREE.Mesh(
      new THREE.BoxGeometry(60, 1.6, 92),
      new THREE.MeshStandardMaterial({ color: 0x515c72, roughness: 0.92 }),
    );
    pad.position.y = 2.4;
    pad.receiveShadow = true;
    g.add(pad);

    const legsMat = new THREE.MeshStandardMaterial({ color: 0x1a1f2b, roughness: 0.8, metalness: 0.3 });
    for (const [lx, lz] of [[-26, -40], [26, -40], [-26, 40], [26, 40], [0, 0]]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(3, 8, 3), legsMat);
      leg.position.set(lx, -0.5, lz);
      g.add(leg);
    }

    const shed = new THREE.Mesh(
      new THREE.BoxGeometry(26, 15, 36),
      new THREE.MeshStandardMaterial({ color: 0x63719a, roughness: 0.75, metalness: 0.15 }),
    );
    shed.position.set(-15, 10.7, -22);
    shed.castShadow = true; shed.receiveShadow = true;
    g.add(shed);

    const roof = new THREE.Mesh(
      new THREE.CylinderGeometry(14, 14, 36, 14, 1, false, 0, Math.PI),
      new THREE.MeshStandardMaterial({ color: 0xf0a83c, roughness: 0.6 }),
    );
    roof.rotation.set(0, Math.PI / 2, Math.PI / 2);
    roof.position.set(-15, 18.2, -22);
    roof.castShadow = true;
    g.add(roof);

    // Conveyor belts feeding the sorting floor — one per fee lane.
    this.belts = [];
    const beltMat = new THREE.MeshStandardMaterial({ color: 0x181d27, roughness: 0.55, metalness: 0.45 });
    for (let i = 0; i < 3; i++) {
      const belt = new THREE.Mesh(new THREE.BoxGeometry(34, 1.2, 5.4), beltMat);
      belt.position.set(2, 6.2, -26 + i * 15);
      belt.receiveShadow = true;
      g.add(belt);
      for (let k = 0; k < 6; k++) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.9, 3.4, 0.9), beltMat);
        leg.position.set(-15 + k * 6.2, 4.2, -26 + i * 15);
        g.add(leg);
      }
      this.belts.push(belt);
    }

    this.laneSigns = [];
    const signCols = [0xffd447, 0xc9b98a, 0x6f8fa8];
    for (let i = 0; i < 3; i++) {
      const sign = new THREE.Mesh(
        new THREE.BoxGeometry(7, 2.6, 0.5),
        new THREE.MeshStandardMaterial({ color: signCols[i], emissive: signCols[i], emissiveIntensity: 0.45, roughness: 0.5 }),
      );
      sign.position.set(22, 9.4, -26 + i * 15);
      g.add(sign);
      this.laneSigns.push(sign);
    }

    for (const zz of [-32, 0, 32]) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.32, 18, 6), new THREE.MeshStandardMaterial({ color: 0x76829c, roughness: 0.6, metalness: 0.4 }));
      pole.position.set(10, 12, zz);
      g.add(pole);
      const lamp = new THREE.PointLight(0xffe4bb, 260, 120, 2);
      lamp.position.set(10, 20, zz);
      g.add(lamp);
    }

    this.plaza = g;
    this.plazaPos = new THREE.Vector3(WORLD.plazaX, 0, 0);
    this.scene.add(g);
  }

  /* ----------------------------------------------------------- packages */

  _buildPackages() {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    geo.translate(0, 0.5, 0);
    this.pkgMesh = new THREE.InstancedMesh(
      geo,
      new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.15 }),
      MAX_PKG,
    );
    this.pkgMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.pkgMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PKG * 3), 3);
    this.pkgMesh.castShadow = true;
    this.pkgMesh.frustumCulled = false;
    this.pkgMesh.name = 'packages';
    this.scene.add(this.pkgMesh);

    const halo = new THREE.BoxGeometry(1.3, 1.3, 1.3);
    halo.translate(0, 0.5, 0);
    this.haloMesh = new THREE.InstancedMesh(
      halo,
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false }),
      MAX_PKG,
    );
    this.haloMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.haloMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PKG * 3), 3);
    this.haloMesh.frustumCulled = false;
    this.scene.add(this.haloMesh);

    this.dummy = new THREE.Object3D();
    this._color = new THREE.Color();

    // Pile slots on the sorting floor, grouped into three fee lanes.
    this._slots = [];
    for (let i = 0; i < MAX_PKG; i++) {
      const lane = i % 3;
      const n = Math.floor(i / 3);
      const col = n % 17;
      const row = Math.floor(n / 17);
      this._slots.push(new THREE.Vector3(
        WORLD.plazaX - 14 + col * 2.0 + (row % 2) * 1.0,
        7.4 + row * 1.3,
        -26 + lane * 15 + rand(-1.6, 1.6),
      ));
    }
  }

  addPackage(tx, price) {
    if (this.packages.length >= MAX_PKG) {
      let worst = null, worstFee = Infinity;
      for (const p of this.packages) {
        if (p.state !== 'plaza' || this.selected.has(p)) continue;
        if (p.feeRate < worstFee) { worstFee = p.feeRate; worst = p; }
      }
      if (!worst || worstFee > tx.feeRate) return null;
      this._remove(worst, true);
    }

    const btc = tx.valueSats / 1e8;
    const p = {
      txid: tx.txid,
      vsize: tx.vsize,
      fee: tx.fee,
      feeRate: tx.feeRate,
      valueSats: tx.valueSats,
      btc,
      usd: btc * price,
      real: tx.real,
      tier: feeTier(tx.feeRate, this.feeBaseline),
      whale: btc >= FEE.whaleBtc,
      pizza: hash01(tx.txid) < 0.005,
      born: this.time,
      state: 'plaza',
      pos: new THREE.Vector3(),
      home: new THREE.Vector3(),
      scale: clamp(0.9 + (Math.log10(Math.max(140, tx.vsize)) - 2.1) * 1.6, 0.7, 2.8),
      spin: rand(TAU),
      wob: rand(TAU),
      truck: null,
      slotIndex: 0,
    };
    if (p.whale) p.scale *= 1.8;
    p.slotIndex = this.packages.length % MAX_PKG;
    p.home.copy(this._slots[p.slotIndex]);
    p.pos.copy(p.home).setY(p.home.y + rand(16, 30));
    this.packages.push(p);

    if (p.whale && this._whaleLogCd <= 0) {
      this._whaleLogCd = 6;
      this.audio?.whale();
      this.fx.text(`🐋 ${p.btc.toFixed(1)} BTC`, p.home.x, 20, p.home.z, { color: '#7ee0ff', life: 2.4, scale: 0.8 });
      this.fx.spawn(p.home.x, 14, p.home.z, { color: 0x7ee0ff, count: 46, size: 2.2, life: 1.7, speed: 10 });
      this.events?.emit('log', { kind: 'whale', text: `WHALE package inbound — ${p.btc.toFixed(2)} BTC @ ${p.feeRate.toFixed(1)} sat/vB` });
    }
    if (p.pizza) {
      this.events?.emit('log', { kind: 'egg', text: `🍕 Pizza Day commemorative package spotted (${p.vsize} vB)` });
    }
    return p;
  }

  _remove(p, silent = false) {
    const i = this.packages.indexOf(p);
    if (i >= 0) this.packages.splice(i, 1);
    this.selected.delete(p);
    if (p.truck) {
      const j = p.truck.cargo.indexOf(p);
      if (j >= 0) p.truck.cargo.splice(j, 1);
      p.truck = null;
    }
    if (!silent) this.fx.spawn(p.pos.x, p.pos.y + 1, p.pos.z, { color: p.tier.color, count: 16, size: 1.7, life: 0.9, speed: 9 });
  }

  /* -------------------------------------------------------------- depot */

  _buildDepot() {
    const g = new THREE.Group();
    g.position.set(WORLD.depotX, 0, 0);

    const pad = new THREE.Mesh(
      new THREE.BoxGeometry(46, 1.6, 86),
      new THREE.MeshStandardMaterial({ color: 0x232a38, roughness: 0.9 }),
    );
    pad.position.y = 2.4;
    pad.receiveShadow = true;
    g.add(pad);

    // The Blockchain Gate: two pylons + an energy curtain packages pass through.
    const pylonMat = new THREE.MeshStandardMaterial({ color: 0x39445c, roughness: 0.6, metalness: 0.4 });
    for (const s of [-1, 1]) {
      const pylon = new THREE.Mesh(new THREE.BoxGeometry(5, 30, 6), pylonMat);
      pylon.position.set(-6, 17, s * 15);
      pylon.castShadow = true;
      g.add(pylon);
    }
    const lintel = new THREE.Mesh(new THREE.BoxGeometry(6, 4.5, 36), pylonMat);
    lintel.position.set(-6, 30, 0);
    g.add(lintel);

    this.gate = new THREE.Mesh(
      new THREE.PlaneGeometry(28, 26),
      new THREE.MeshBasicMaterial({ color: 0xffd447, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false }),
    );
    this.gate.rotation.y = Math.PI / 2;
    this.gate.position.set(-6, 16, 0);
    g.add(this.gate);

    this.gateLight = new THREE.PointLight(0xffd447, 120, 140, 2);
    this.gateLight.position.set(-6, 18, 0);
    g.add(this.gateLight);

    // Fortified depot behind the gate
    const depot = new THREE.Mesh(
      new THREE.BoxGeometry(20, 16, 46),
      new THREE.MeshStandardMaterial({ color: 0x2f394d, roughness: 0.8, metalness: 0.2 }),
    );
    depot.position.set(12, 11, 0);
    depot.castShadow = true; depot.receiveShadow = true;
    g.add(depot);

    // Stack of confirmed blocks that grows as blocks are found.
    this.blockStack = new THREE.Group();
    this.blockStack.position.set(12, 19, 0);
    g.add(this.blockStack);
    this.blockStackMat = new THREE.MeshStandardMaterial({ color: 0xf7931a, emissive: 0x8a4a05, emissiveIntensity: 0.6, roughness: 0.4, metalness: 0.3 });

    this.depot = g;
    this.depotPos = new THREE.Vector3(WORLD.depotX, 0, 0);
    this.scene.add(g);
  }

  pushBlockMarker() {
    const n = this.blockStack.children.length;
    const cube = new THREE.Mesh(new THREE.BoxGeometry(6, 6, 6), this.blockStackMat);
    cube.position.set(0, 0, -20 + (n % 8) * 5.6);
    cube.castShadow = true;
    this.blockStack.add(cube);
    if (this.blockStack.children.length > 8) this.blockStack.remove(this.blockStack.children[0]);
  }

  /** Armoured convoy that parades across the map when a real block is found. */
  spawnConvoy(height) {
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: 0xf7931a, emissive: 0x7a3f04, emissiveIntensity: 0.7, roughness: 0.45, metalness: 0.35 });
    for (let i = 0; i < 4; i++) {
      const car = new THREE.Mesh(new THREE.BoxGeometry(9, 6, 5.5), mat);
      car.position.set(-i * 11, 4, 0);
      car.castShadow = true;
      g.add(car);
      const flag = new THREE.Mesh(new THREE.PlaneGeometry(4, 2.4), new THREE.MeshBasicMaterial({ color: 0x4ade80, side: THREE.DoubleSide }));
      flag.position.set(-i * 11, 9, 0);
      g.add(flag);
    }
    g.position.set(WORLD.depotX - 10, 0, 0);
    this.scene.add(g);
    this.convoys.push({ obj: g, t: 0, height });
    this.gatePulse = 1;
  }

  /* -------------------------------------------------------------- fleet */

  addTruck(spec) {
    const truck = {
      spec,
      id: this.trucks.length,
      pos: new THREE.Vector3(WORLD.plazaX + 20, 0, 16 + this.trucks.length * 10),
      heading: 0,
      speed: 0,
      hp: 100 * spec.armor,
      maxHp: 100 * spec.armor,
      cargo: [],
      lane: 'bull',
      state: 'idle',
      manual: false,
      boost: 0,
      hazardCd: rand(1, 3),
      radioCd: 0,
      wobble: rand(TAU),
      obj: this._buildTruckMesh(spec),
    };
    truck.obj.userData.truck = truck;
    this.scene.add(truck.obj);
    this.trucks.push(truck);
    return truck;
  }

  _buildTruckMesh(spec) {
    const g = new THREE.Group();
    const s = spec.capacity > 8000 ? 1.35 : spec.capacity > 5000 ? 1.15 : spec.id === 'express' ? 0.92 : 1;

    const shell = new THREE.MeshStandardMaterial({ color: 0xeef1f7, roughness: 0.45, metalness: 0.25 });
    const trim = new THREE.MeshStandardMaterial({ color: 0xf0a83c, roughness: 0.4, metalness: 0.35, emissive: 0x4a2f05, emissiveIntensity: 0.5 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x1a2634, roughness: 0.15, metalness: 0.7 });
    const rubber = new THREE.MeshStandardMaterial({ color: 0x14181f, roughness: 0.95 });

    const cargo = new THREE.Mesh(new THREE.BoxGeometry(8.5 * s, 5.6 * s, 5 * s), shell);
    cargo.position.set(-1.6 * s, 4.4 * s, 0);
    cargo.castShadow = true;
    g.add(cargo);

    const stripe = new THREE.Mesh(new THREE.BoxGeometry(8.6 * s, 1.1 * s, 5.1 * s), trim);
    stripe.position.set(-1.6 * s, 3.4 * s, 0);
    g.add(stripe);

    const cab = new THREE.Mesh(new THREE.BoxGeometry(4 * s, 4 * s, 4.6 * s), shell);
    cab.position.set(4.2 * s, 3.6 * s, 0);
    cab.castShadow = true;
    g.add(cab);

    const windshield = new THREE.Mesh(new THREE.BoxGeometry(0.4 * s, 2.2 * s, 4.0 * s), glass);
    windshield.position.set(6.25 * s, 4.4 * s, 0);
    g.add(windshield);

    if (spec.armor >= 1.6) {
      const plate = new THREE.Mesh(new THREE.BoxGeometry(1.2 * s, 4 * s, 5.4 * s), new THREE.MeshStandardMaterial({ color: 0x5a6376, roughness: 0.7, metalness: 0.6 }));
      plate.position.set(6.9 * s, 3.2 * s, 0);
      g.add(plate);
    }
    if (spec.id === 'express') {
      const bolt = new THREE.Mesh(new THREE.ConeGeometry(1.1 * s, 3.4 * s, 4), new THREE.MeshStandardMaterial({ color: 0x7ee0ff, emissive: 0x2a7d9c, emissiveIntensity: 1.4 }));
      bolt.position.set(-1.6 * s, 8.2 * s, 0);
      g.add(bolt);
    }

    this._wheels = this._wheels || [];
    const wheels = [];
    const wgeo = new THREE.CylinderGeometry(1.5 * s, 1.5 * s, 1.1 * s, 10);
    wgeo.rotateX(Math.PI / 2);
    for (const [wx, wz] of [[4 * s, 2.5 * s], [4 * s, -2.5 * s], [-3.4 * s, 2.5 * s], [-3.4 * s, -2.5 * s]]) {
      const w = new THREE.Mesh(wgeo, rubber);
      w.position.set(wx, 1.5 * s, wz);
      w.castShadow = true;
      g.add(w);
      wheels.push(w);
    }
    g.userData.wheels = wheels;

    const head = new THREE.PointLight(0xfff0c0, 40, 60, 2);
    head.position.set(7 * s, 3.4 * s, 0);
    g.add(head);
    g.userData.headlight = head;

    // Cargo fill indicator on the roof
    const bar = new THREE.Mesh(
      new THREE.BoxGeometry(7 * s, 0.5, 0.9),
      new THREE.MeshBasicMaterial({ color: 0x4ade80 }),
    );
    bar.position.set(-1.6 * s, 7.4 * s, 0);
    g.add(bar);
    g.userData.bar = bar;
    g.userData.barWidth = 7 * s;

    return g;
  }

  usedCapacity(truck) { return truck.cargo.reduce((a, p) => a + p.vsize, 0); }

  canLoad(truck, p) {
    return truck.state === 'idle' && p.state === 'plaza' &&
      this.usedCapacity(truck) + p.vsize <= truck.spec.capacity;
  }

  load(truck, p) {
    if (!this.canLoad(truck, p)) return false;
    p.state = 'loading';
    p.truck = truck;
    truck.cargo.push(p);
    this.selected.delete(p);
    this.audio?.stamp();
    return true;
  }

  /** Auto-load highest fee-rate packages until the truck is full. */
  autoLoad(truck) {
    const pool = this.packages
      .filter((p) => p.state === 'plaza')
      .sort((a, b) => b.feeRate - a.feeRate);
    let n = 0;
    for (const p of pool) if (this.canLoad(truck, p)) { this.load(truck, p); n++; }
    if (n) this.events?.emit('log', { kind: 'ops', text: `Auto-sorter packed ${n} package${n > 1 ? 's' : ''} into ${truck.spec.name}` });
    else this.audio?.error();
    return n;
  }

  dispatch(truck, lane) {
    if (truck.state !== 'idle' || truck.cargo.length === 0) { this.audio?.error(); return false; }
    truck.lane = lane || truck.lane;
    truck.state = 'enroute';
    truck.hazardCd = rand(1.5, 4);
    this.audio?.horn();
    this.radio(truck, truck.lane === 'front' ? pick(RADIO.frontline) : pick(RADIO.depart));
    return true;
  }

  radio(truck, text) {
    if (truck.radioCd > 0) return;
    truck.radioCd = 3.5;
    this.events?.emit('radio', { truck, text });
  }

  laneZ(lane, x) {
    const base = lane === 'front' ? this.bf.frontlineAt(x) : LANES[lane].z;
    // Funnel every route into the Blockchain Gate on the final approach.
    const t = clamp((x - (WORLD.depotX - 58)) / 46, 0, 1);
    return lerp(base, 0, t * t * (3 - 2 * t));
  }

  /* ------------------------------------------------------------- update */

  update(dt, ctx) {
    this.time += dt;
    this._whaleLogCd = Math.max(0, this._whaleLogCd - dt);
    this._updateTrucks(dt, ctx);
    this._updatePackages(dt, ctx);
    this._updateProps(dt);
  }

  _updateProps(dt) {
    for (let i = 0; i < this.belts.length; i++) {
      this.belts[i].position.x = 2 + Math.sin(this.time * (1.2 + i * 0.2)) * 0.35;
    }
    this.gatePulse = Math.max(0, this.gatePulse - dt * 0.5);
    const pulse = 0.14 + this.gatePulse * 0.6 + Math.sin(this.time * 2.2) * 0.03;
    this.gate.material.opacity = pulse;
    this.gateLight.intensity = 80 + this.gatePulse * 700;

    for (let i = this.convoys.length - 1; i >= 0; i--) {
      const c = this.convoys[i];
      c.t += dt;
      c.obj.position.x = WORLD.depotX - 10 - c.t * 26;
      c.obj.position.y = this.bf.heightAt(c.obj.position.x, 0);
      c.obj.children.forEach((m, k) => { m.position.y = (k % 2 === 0 ? 4 : 9) + Math.sin(this.time * 6 + k) * 0.25; });
      if (c.t > 1 && Math.random() < dt * 14) {
        this.fx.confetti(c.obj.position.x, 12, rand(-10, 10), 12);
      }
      if (c.obj.position.x < -WORLD.width / 2 - 30) {
        this.scene.remove(c.obj);
        this.convoys.splice(i, 1);
      }
    }
  }

  _updateTrucks(dt, ctx) {
    for (const truck of this.trucks) {
      truck.radioCd = Math.max(0, truck.radioCd - dt);
      truck.boost = Math.max(0, truck.boost - dt);

      if (truck.state === 'enroute' || truck.state === 'returning') {
        this._driveTruck(truck, dt, ctx);
      } else if (truck.state === 'wrecked') {
        truck.hp = clamp(truck.hp + dt * 6, 0, truck.maxHp);
        this.fx.smoke(truck.pos.x, truck.pos.y + 5, truck.pos.z, 1, 1.2);
        if (truck.hp >= truck.maxHp * 0.6) {
          truck.state = 'idle';
          truck.pos.set(WORLD.plazaX + 20, 0, 16 + truck.id * 10);
          this.events?.emit('log', { kind: 'ops', text: `${truck.spec.name} repaired and back on the roster` });
        }
      } else {
        // idle: park at the plaza
        const target = new THREE.Vector3(WORLD.plazaX + 20, 0, 16 + truck.id * 10);
        truck.pos.lerp(target, 1 - Math.exp(-3 * dt));
        truck.heading = approach(truck.heading, 0, 4, dt);
        truck.speed = 0;
      }

      truck.pos.y = this.bf.heightAt(truck.pos.x, truck.pos.z) + (truck.state === 'idle' ? 3.2 : 0);
      truck.obj.position.copy(truck.pos);
      truck.obj.rotation.y = -truck.heading;
      const tilt = Math.sin(this.time * 8 + truck.wobble) * 0.02 * (truck.speed / 20);
      truck.obj.rotation.z = tilt;
      truck.obj.rotation.x = truck.state === 'wrecked' ? 0.12 : 0;

      const wheels = truck.obj.userData.wheels || [];
      for (const w of wheels) w.rotation.z -= truck.speed * dt * 0.7;

      const fill = clamp(this.usedCapacity(truck) / truck.spec.capacity, 0, 1);
      const bar = truck.obj.userData.bar;
      bar.scale.x = Math.max(0.001, fill);
      bar.position.x = -1.6 + (truck.obj.userData.barWidth * (fill - 1)) / 2;
      bar.material.color.setHex(fill > 0.85 ? 0xffd447 : 0x4ade80);
      bar.visible = truck.state !== 'wrecked';
    }
  }

  _driveTruck(truck, dt, ctx) {
    const dir = truck.state === 'enroute' ? 1 : -1;
    const goalX = dir > 0 ? WORLD.depotX - 12 : WORLD.plazaX + 20;
    const laneZ = truck.state === 'enroute' ? this.laneZ(truck.lane, truck.pos.x) : LANES.bull.z;

    let targetZ = laneZ;
    let steerBoost = 1;
    if (truck.manual && ctx.manualSteer) {
      targetZ = clamp(truck.pos.z + ctx.manualSteer.z * 40 * dt, -WORLD.depth / 2 + 6, WORLD.depth / 2 - 6);
      steerBoost = 1 + Math.max(0, ctx.manualSteer.x) * 0.5;
    }

    const base = truck.spec.speed * LANES[truck.lane].speed * (truck.boost > 0 ? 1.9 : 1) * steerBoost;
    const load = 1 - clamp(this.usedCapacity(truck) / truck.spec.capacity, 0, 1) * 0.22;
    truck.speed = approach(truck.speed, base * load, 2.5, dt);

    const dz = clamp(targetZ - truck.pos.z, -26, 26);
    const step = truck.speed * dt;
    truck.pos.x += dir * step;
    truck.pos.z += clamp(dz * dt * 2.4, -step, step);
    truck.heading = dir > 0 ? Math.atan2(clamp(dz * 0.06, -0.8, 0.8), 1) : Math.PI - Math.atan2(clamp(dz * 0.06, -0.8, 0.8), 1);

    if (truck.boost > 0 || truck.speed > 4) {
      if (Math.random() < dt * 22) {
        this.fx.spawn(truck.pos.x - 5, truck.pos.y + 1.4, truck.pos.z, {
          color: truck.boost > 0 ? 0x7ee0ff : 0x8b8b8b, count: 1, size: 1.8, life: 0.9, speed: 2.6, gravity: 1.4, alpha: 0.5,
        });
      }
    }

    // --- risk model -------------------------------------------------------
    const frontDist = Math.abs(truck.pos.z - this.bf.frontlineAt(truck.pos.x));
    const proximity = clamp(1 - frontDist / 40, 0, 1);
    const laneRisk = LANES[truck.lane].risk;
    const danger = (0.12 + laneRisk * 0.55) * (0.35 + proximity * 1.5) * (0.6 + ctx.volatility * 1.4);
    truck.hazardCd -= dt;
    if (truck.hazardCd <= 0 && truck.state === 'enroute') {
      truck.hazardCd = rand(1.4, 3.4);
      if (Math.random() < danger * 0.55) this.hitTruck(truck, rand(8, 26) * (1 + ctx.volatility));
    }

    // arrival
    if (dir > 0 && truck.pos.x >= goalX) {
      this._arrive(truck, ctx);
    } else if (dir < 0 && truck.pos.x <= goalX) {
      truck.state = 'idle';
      truck.speed = 0;
    }
  }

  hitTruck(truck, dmg) {
    if (truck.state === 'wrecked') return;
    const armor = truck.spec.armor;
    const applied = dmg / armor;
    truck.hp -= applied;
    this.fx.explosion(truck.pos.x, truck.pos.y + 3, truck.pos.z, 0.35, 0xff8844);
    this.audio?.explosion(0.4);
    this.radio(truck, pick(RADIO.hit));
    this.events?.emit('shake', 0.5);

    // A hit can scatter a package out of the back — some RBF themselves home.
    if (truck.cargo.length && Math.random() < 0.45) {
      const lost = pick(truck.cargo);
      const rbf = Math.random() < 0.4;
      this._remove(lost);
      this.events?.emit('log', {
        kind: rbf ? 'ops' : 'loss',
        text: rbf
          ? `Package ${lost.txid.slice(0, 8)} RBF'd itself back to the mempool (${lost.feeRate.toFixed(0)} sat/vB)`
          : `LOST: ${lost.btc.toFixed(3)} BTC package scattered across the front`,
      });
    }

    if (truck.hp <= 0) {
      truck.hp = 0;
      truck.state = 'wrecked';
      truck.speed = 0;
      this.fx.explosion(truck.pos.x, truck.pos.y + 3, truck.pos.z, 1.5, 0xffaa33);
      this.audio?.explosion(1.2);
      this.events?.emit('shake', 1.2);
      this.radio(truck, pick(RADIO.wreck));
      for (const p of [...truck.cargo]) this._remove(p);
      this.events?.emit('log', { kind: 'loss', text: `${truck.spec.name} destroyed on the ${LANES[truck.lane].name}` });
    }
  }

  _arrive(truck, ctx) {
    truck.state = 'returning';
    truck.speed = 0;
    this.gatePulse = 1;
    this.audio?.stamp();
    this.radio(truck, pick(RADIO.arrive));
    this.events?.emit('deliver', { truck, cargo: [...truck.cargo] });
    for (const p of [...truck.cargo]) {
      p.state = 'delivered';
      this._remove(p, true);
    }
    truck.cargo.length = 0;
    this.fx.confetti(WORLD.depotX - 8, 14, 0, 90);
  }

  /* ----------------------------------------------------------- packages */

  _updatePackages(dt, ctx) {
    const d = this.dummy;
    const c = this._color;
    let i = 0;
    const now = this.time;

    for (const p of this.packages) {
      p.wob += dt * (p.tier.glow > 0.5 ? 3.4 : 1.4);

      if (p.state === 'plaza') {
        p.pos.lerp(p.home, 1 - Math.exp(-4 * dt));
        p.pos.y = Math.max(p.home.y, p.pos.y);
      } else if (p.state === 'loading' || p.state === 'onTruck') {
        const t = p.truck;
        if (!t) { p.state = 'plaza'; continue; }
        const idx = t.cargo.indexOf(p);
        const slot = new THREE.Vector3(
          t.pos.x - 3.5 + (idx % 3) * 2.2,
          t.pos.y + 4 + Math.floor(idx / 3) * 1.4,
          t.pos.z + ((idx % 2) - 0.5) * 1.6,
        );
        p.pos.lerp(slot, 1 - Math.exp(-(p.state === 'loading' ? 6 : 22) * dt));
        if (p.state === 'loading' && p.pos.distanceTo(slot) < 1.2) {
          p.state = 'onTruck';
          this.audio?.thud();
        }
      }

      if (i >= MAX_PKG) break;

      // Low-fee packages droop and sulk; high-fee ones hover and spin proudly.
      const sad = p.tier.name === 'Stuck';
      const bob = sad ? Math.sin(p.wob) * 0.06 : Math.sin(p.wob) * 0.35 * (0.4 + p.tier.glow);
      const spin = sad ? 0 : p.wob * (0.2 + p.tier.glow * 0.5);
      const sel = this.selected.has(p);
      const hovered = this.hover === p;

      d.position.set(p.pos.x, p.pos.y + bob + (sad ? -0.15 : 0), p.pos.z);
      d.rotation.set(sad ? 0.22 : 0, spin, sad ? 0.18 : Math.sin(p.wob * 0.7) * 0.05);
      const pop = (sel ? 1.25 : 1) * (hovered ? 1.12 : 1) * (1 + Math.max(0, 0.4 - (now - p.born)) * 1.2);
      d.scale.setScalar(p.scale * pop);
      d.updateMatrix();
      this.pkgMesh.setMatrixAt(i, d.matrix);

      c.setHex(p.pizza ? 0xff8c42 : p.tier.color);
      if (sel) c.lerp(new THREE.Color(0xffffff), 0.45);
      this.pkgMesh.setColorAt(i, c);

      // halo shell for glowing / whale / selected packages
      const glow = p.tier.glow * (sel ? 1.7 : 1) * (p.whale ? 1.6 : 1);
      d.scale.setScalar(p.scale * pop * (1 + glow * 0.12));
      d.updateMatrix();
      this.haloMesh.setMatrixAt(i, d.matrix);
      c.setHex(p.whale ? 0x7ee0ff : p.tier.color).multiplyScalar(clamp(glow, 0.05, 2));
      this.haloMesh.setColorAt(i, c);

      if (p.tier.glow > 0.9 && Math.random() < dt * 3) {
        this.fx.spawn(p.pos.x, p.pos.y + 1.6, p.pos.z, { color: 0xffe27a, count: 1, size: 1.3, life: 0.9, speed: 2.4, gravity: 1.2 });
      }
      p.instance = i;
      i++;
    }

    for (let k = i; k < MAX_PKG; k++) {
      d.position.set(0, -9999, 0); d.scale.setScalar(0.001); d.updateMatrix();
      this.pkgMesh.setMatrixAt(k, d.matrix);
      this.haloMesh.setMatrixAt(k, d.matrix);
    }
    this.visibleCount = i;
    this.pkgMesh.instanceMatrix.needsUpdate = true;
    this.haloMesh.instanceMatrix.needsUpdate = true;
    if (this.pkgMesh.instanceColor) this.pkgMesh.instanceColor.needsUpdate = true;
    if (this.haloMesh.instanceColor) this.haloMesh.instanceColor.needsUpdate = true;
  }

  packageByInstance(id) {
    return this.packages.find((p) => p.instance === id && p.state === 'plaza') ||
      this.packages.find((p) => p.instance === id);
  }

  plazaPackages() { return this.packages.filter((p) => p.state === 'plaza'); }

  /** Re-grade every package when the fee market moves under it. */
  setFeeBaseline(v) {
    const b = Math.max(0.5, v || 1);
    if (Math.abs(b - this.feeBaseline) / this.feeBaseline < 0.12) return;
    this.feeBaseline = b;
    for (const p of this.packages) p.tier = feeTier(p.feeRate, b);
  }

  /** Airstrikes scatter nearby plaza packages and can wreck trucks. */
  shockwave(x, z, power) {
    for (const truck of this.trucks) {
      if (truck.state !== 'enroute' && truck.state !== 'returning') continue;
      const dx = truck.pos.x - x, dz = truck.pos.z - z;
      const r = 16 + power * 12;
      if (dx * dx + dz * dz < r * r) this.hitTruck(truck, 22 * power);
    }
    for (const p of this.packages) {
      if (p.state !== 'plaza') continue;
      const dx = p.pos.x - x, dz = p.pos.z - z;
      if (dx * dx + dz * dz < 900) {
        p.pos.y += rand(2, 8);
        p.pos.x += rand(-4, 4);
      }
    }
  }
}
