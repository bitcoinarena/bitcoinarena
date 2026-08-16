import * as THREE from 'three';
import { rand, randInt, TAU, clamp } from '../util.js';

const MAX_P = 6000;
const MAX_TRACER = 900;

/**
 * Pooled GPU particle system (one draw call), tracer lines for gunfire, and
 * billboarded floating text for score popups. Everything is preallocated —
 * nothing here allocates per frame.
 */
export class FX {
  constructor(scene) {
    this.scene = scene;
    this._initParticles();
    this._initTracers();
    this._initText();
    this._initRings();
    this.bullets = [];
  }

  /* --------------------------------------------------- ballistic rounds */

  /**
   * A round that actually flies: ballistic arc from muzzle to target, drawing a
   * streak each frame and throwing sparks where it lands. Straight instant
   * lines read as static noise; arcs read as a firefight.
   */
  bullet(x, y, z, tx, ty, tz, { color = 0xffe08a, speed = 90, size = 1.1, heavy = false, onHit = null } = {}) {
    if (this.bullets.length > 260) return;
    const dx = tx - x, dz = tz - z;
    const dist = Math.hypot(dx, dz) || 1;
    const time = Math.max(0.12, dist / speed);
    const g = heavy ? 26 : 42;
    this.bullets.push({
      x, y, z,
      px: x, py: y, pz: z,
      vx: dx / time,
      vy: (ty - y) / time + 0.5 * g * time,
      vz: dz / time,
      g, t: 0, life: time, color, size, heavy, onHit,
    });
  }

  _updateBullets(dt) {
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      b.px = b.x; b.py = b.y; b.pz = b.z;
      b.t += dt;
      b.vy -= b.g * dt;
      b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt;
      this.tracer(b.px, b.py, b.pz, b.x, b.y, b.z, b.color);
      if (b.heavy && Math.random() < dt * 30) {
        this.spawn(b.x, b.y, b.z, { color: 0x8b8b8b, count: 1, size: 1.6, life: 0.6, speed: 0.6, gravity: 0.8, alpha: 0.4 });
      }
      if (b.t >= b.life || b.y < 0) {
        this.spawn(b.x, Math.max(0.3, b.y), b.z, {
          color: b.color, count: b.heavy ? 26 : 7, size: b.size * 1.4,
          life: b.heavy ? 0.7 : 0.32, speed: b.heavy ? 14 : 7, gravity: -18,
        });
        b.onHit?.(b.x, b.y, b.z);
        this.bullets.splice(i, 1);
      }
    }
  }

  /** Muzzle flash: a bright cone of sparks along the firing direction. */
  muzzle(x, y, z, dirX, dirZ, scale = 1) {
    this.spawn(x, y, z, {
      color: 0xfff0b0, count: Math.round(7 * scale), size: 2.2 * scale, life: 0.14,
      speed: 16 * scale, gravity: 0, drag: 4, dir: { x: dirX, y: 0.12, z: dirZ },
    });
    this.spawn(x, y, z, {
      color: 0x6b6b6b, count: Math.round(4 * scale), size: 3 * scale, life: 0.8,
      speed: 4, gravity: 1.4, alpha: 0.4,
    });
  }

  /* --------------------------------------------------------- shockwaves */

  _initRings() {
    this.rings = [];
    const geo = new THREE.RingGeometry(0.82, 1, 40);
    geo.rotateX(-Math.PI / 2);
    for (let i = 0; i < 10; i++) {
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        color: 0xffd9a0, transparent: true, opacity: 0, side: THREE.DoubleSide,
        depthWrite: false, blending: THREE.AdditiveBlending,
      }));
      m.visible = false;
      m.renderOrder = 8;
      this.scene.add(m);
      this.rings.push({ mesh: m, t: 0, life: 0, max: 1 });
    }
  }

  shockwave(x, y, z, radius = 30, life = 0.9, color = 0xffd9a0) {
    const r = this.rings.find((k) => !k.mesh.visible);
    if (!r) return;
    r.mesh.position.set(x, y + 0.6, z);
    r.mesh.material.color.setHex(color);
    r.mesh.visible = true;
    r.t = 0; r.life = life; r.max = radius;
  }

  _updateRings(dt) {
    for (const r of this.rings) {
      if (!r.mesh.visible) continue;
      r.t += dt;
      const k = r.t / r.life;
      if (k >= 1) { r.mesh.visible = false; continue; }
      const s = r.max * (1 - Math.pow(1 - k, 2.4));
      r.mesh.scale.set(s, 1, s);
      r.mesh.material.opacity = 0.75 * (1 - k) * (1 - k);
    }
  }

  _initParticles() {
    const g = new THREE.BufferGeometry();
    this.pPos = new Float32Array(MAX_P * 3);
    this.pCol = new Float32Array(MAX_P * 3);
    this.pSize = new Float32Array(MAX_P);
    this.pAlpha = new Float32Array(MAX_P);
    this.pVel = new Float32Array(MAX_P * 3);
    this.pLife = new Float32Array(MAX_P);
    this.pMax = new Float32Array(MAX_P);
    this.pDrag = new Float32Array(MAX_P);
    this.pGrav = new Float32Array(MAX_P);
    this.pSpin = new Float32Array(MAX_P);
    this.head = 0;

    g.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(this.pCol, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.pSize, 1));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.pAlpha, 1));

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uScale: { value: innerHeight * 0.6 } },
      vertexShader: `
        attribute vec3 aColor; attribute float aSize; attribute float aAlpha;
        varying vec3 vC; varying float vA;
        uniform float uScale;
        void main(){
          vC = aColor; vA = aAlpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * uScale / max(1.0, -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying vec3 vC; varying float vA;
        void main(){
          vec2 d = gl_PointCoord - 0.5;
          float r = dot(d, d);
          if (r > 0.25) discard;
          float a = vA * smoothstep(0.25, 0.02, r);
          gl_FragColor = vec4(vC, a);
        }`,
    });
    this.points = new THREE.Points(g, mat);
    this.points.frustumCulled = false;
    this.geo = g;
    this.scene.add(this.points);
    addEventListener('resize', () => { mat.uniforms.uScale.value = innerHeight * 0.6; });
  }

  _initTracers() {
    const g = new THREE.BufferGeometry();
    this.tPos = new Float32Array(MAX_TRACER * 6);
    this.tCol = new Float32Array(MAX_TRACER * 6);
    this.tLife = new Float32Array(MAX_TRACER);
    this.tHead = 0;
    g.setAttribute('position', new THREE.BufferAttribute(this.tPos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.tCol, 3));
    this.tracers = new THREE.LineSegments(g, new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.tracers.frustumCulled = false;
    this.tGeo = g;
    this.scene.add(this.tracers);
  }

  _initText() {
    this.texts = [];
    this.textPool = [];
    for (let i = 0; i < 26; i++) {
      const cv = document.createElement('canvas');
      cv.width = 512; cv.height = 128;
      const tex = new THREE.CanvasTexture(cv);
      tex.colorSpace = THREE.SRGBColorSpace;
      const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false }));
      spr.visible = false;
      spr.renderOrder = 20;
      this.scene.add(spr);
      this.textPool.push({ spr, cv, tex, ctx: cv.getContext('2d') });
    }
  }

  /* ------------------------------------------------------------ spawning */

  spawn(x, y, z, opts = {}) {
    const {
      color = 0xffffff, size = 1.4, life = 1.2, speed = 6, spread = 1,
      drag = 1.2, gravity = -9, count = 1, dir = null, alpha = 1,
    } = opts;
    const c = new THREE.Color(color);
    for (let n = 0; n < count; n++) {
      const i = this.head; this.head = (this.head + 1) % MAX_P;
      const i3 = i * 3;
      this.pPos[i3] = x + rand(-spread, spread);
      this.pPos[i3 + 1] = y + rand(-spread, spread) * 0.6;
      this.pPos[i3 + 2] = z + rand(-spread, spread);
      let vx, vy, vz;
      if (dir) {
        vx = dir.x + rand(-0.4, 0.4); vy = dir.y + rand(-0.4, 0.4); vz = dir.z + rand(-0.4, 0.4);
      } else {
        const a = rand(TAU), p = Math.acos(rand(-1, 1));
        vx = Math.sin(p) * Math.cos(a); vy = Math.abs(Math.cos(p)) * 0.9 + 0.15; vz = Math.sin(p) * Math.sin(a);
      }
      const sp = speed * rand(0.35, 1.25);
      this.pVel[i3] = vx * sp; this.pVel[i3 + 1] = vy * sp; this.pVel[i3 + 2] = vz * sp;
      this.pCol[i3] = c.r; this.pCol[i3 + 1] = c.g; this.pCol[i3 + 2] = c.b;
      this.pSize[i] = size * rand(0.6, 1.5);
      this.pMax[i] = this.pLife[i] = life * rand(0.7, 1.3);
      this.pAlpha[i] = alpha;
      this.pDrag[i] = drag;
      this.pGrav[i] = gravity;
      this.pSpin[i] = 0;
    }
  }

  explosion(x, y, z, power = 1, color = 0xffa33a) {
    const n = clamp(Math.round(70 * power), 28, 460);
    // fireball, flash, rising smoke column, ground shockwave and thrown debris
    this.spawn(x, y, z, { color, count: n, size: 2.6 * power, life: 1.2 + power * 0.6, speed: 17 * Math.sqrt(power), spread: 1.4, gravity: -14, drag: 1.6 });
    this.spawn(x, y, z, { color: 0xffffff, count: Math.round(n * 0.35), size: 3.6 * power, life: 0.32, speed: 30 * Math.sqrt(power), spread: 0.8, gravity: 0, drag: 3.4 });
    this.spawn(x, y + 1, z, { color: 0xff6a2a, count: Math.round(n * 0.4), size: 4.2 * power, life: 1.7, speed: 7 * power, spread: 1.8, gravity: 5.5, drag: 0.9, alpha: 0.8 });
    this.spawn(x, y + 2, z, { color: 0x3a3a3a, count: Math.round(n * 0.55), size: 5.5 * power, life: 3.4, speed: 4, spread: 2.5, gravity: 2.2, drag: 0.7, alpha: 0.55 });
    this.spawn(x, y, z, { color: 0x6a5a44, count: Math.round(n * 0.3), size: 1.8 * power, life: 1.9, speed: 22 * Math.sqrt(power), spread: 1, gravity: -30, drag: 0.5 });
    this.shockwave(x, y, z, 16 + power * 20, 0.8 + power * 0.25, color);
  }

  confetti(x, y, z, count = 220) {
    const cols = [0xffd447, 0x4ade80, 0x60a5fa, 0xf472b6, 0xffffff, 0xf97316];
    for (let i = 0; i < count; i++) {
      this.spawn(x + rand(-14, 14), y + rand(0, 6), z + rand(-14, 14), {
        color: cols[randInt(0, cols.length - 1)], count: 1, size: 1.8, life: rand(2.5, 4.5),
        speed: rand(9, 26), spread: 0.4, gravity: -7, drag: 1.1,
      });
    }
  }

  smoke(x, y, z, count = 6, scale = 1) {
    this.spawn(x, y, z, { color: 0x555555, count, size: 4 * scale, life: 2.2, speed: 2.2, spread: 1.2 * scale, gravity: 1.4, drag: 0.9, alpha: 0.35 });
  }

  tracer(x1, y1, z1, x2, y2, z2, color = 0x88ff99) {
    const i = this.tHead; this.tHead = (this.tHead + 1) % MAX_TRACER;
    const i6 = i * 6;
    this.tPos[i6] = x1; this.tPos[i6 + 1] = y1; this.tPos[i6 + 2] = z1;
    this.tPos[i6 + 3] = x2; this.tPos[i6 + 4] = y2; this.tPos[i6 + 5] = z2;
    const c = new THREE.Color(color);
    for (let k = 0; k < 2; k++) {
      this.tCol[i6 + k * 3] = c.r; this.tCol[i6 + k * 3 + 1] = c.g; this.tCol[i6 + k * 3 + 2] = c.b;
    }
    this.tLife[i] = 0.09;
  }

  text(str, x, y, z, { color = '#ffd447', size = 54, life = 2.0, rise = 16, scale = 1 } = {}) {
    const slot = this.textPool.find((s) => !s.spr.visible);
    if (!slot) return;
    const { ctx, cv, tex, spr } = slot;
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.font = `900 ${size}px "Barlow Condensed", Impact, system-ui, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineWidth = 9; ctx.strokeStyle = 'rgba(0,0,0,0.82)';
    ctx.strokeText(str, 256, 64);
    ctx.fillStyle = color;
    ctx.fillText(str, 256, 64);
    tex.needsUpdate = true;
    spr.position.set(x, y, z);
    spr.scale.set(30 * scale, 7.5 * scale, 1);
    spr.material.opacity = 1;
    spr.visible = true;
    this.texts.push({ slot, t: 0, life, rise, baseY: y, scale });
  }

  /* -------------------------------------------------------------- update */

  update(dt) {
    this._updateBullets(dt);
    this._updateRings(dt);

    // particles
    for (let i = 0; i < MAX_P; i++) {
      const l = this.pLife[i];
      if (l <= 0) { if (this.pAlpha[i] !== 0) this.pAlpha[i] = 0; continue; }
      const nl = l - dt;
      this.pLife[i] = nl;
      const i3 = i * 3;
      const d = Math.exp(-this.pDrag[i] * dt);
      this.pVel[i3] *= d;
      this.pVel[i3 + 1] = this.pVel[i3 + 1] * d + this.pGrav[i] * dt;
      this.pVel[i3 + 2] *= d;
      this.pPos[i3] += this.pVel[i3] * dt;
      this.pPos[i3 + 1] += this.pVel[i3 + 1] * dt;
      this.pPos[i3 + 2] += this.pVel[i3 + 2] * dt;
      if (this.pPos[i3 + 1] < 0.2) { this.pPos[i3 + 1] = 0.2; this.pVel[i3 + 1] *= -0.25; this.pVel[i3] *= 0.7; this.pVel[i3 + 2] *= 0.7; }
      const k = Math.max(0, nl / this.pMax[i]);
      this.pAlpha[i] = k * k * 0.95;
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aAlpha.needsUpdate = true;
    this.geo.attributes.aColor.needsUpdate = true;
    this.geo.attributes.aSize.needsUpdate = true;

    // tracers fade by collapsing the segment
    let anyTracer = false;
    for (let i = 0; i < MAX_TRACER; i++) {
      if (this.tLife[i] <= 0) continue;
      anyTracer = true;
      this.tLife[i] -= dt;
      if (this.tLife[i] <= 0) {
        const i6 = i * 6;
        for (let k = 0; k < 6; k++) this.tPos[i6 + k] = 0;
      }
    }
    if (anyTracer) { this.tGeo.attributes.position.needsUpdate = true; this.tGeo.attributes.color.needsUpdate = true; }

    // floating text
    for (let i = this.texts.length - 1; i >= 0; i--) {
      const t = this.texts[i];
      t.t += dt;
      const k = t.t / t.life;
      t.slot.spr.position.y = t.baseY + t.rise * (1 - Math.pow(1 - k, 2));
      t.slot.spr.material.opacity = clamp(1 - Math.pow(k, 2.4), 0, 1);
      const pop = 1 + Math.max(0, 0.25 - t.t) * 1.6;
      t.slot.spr.scale.set(30 * t.scale * pop, 7.5 * t.scale * pop, 1);
      if (k >= 1) { t.slot.spr.visible = false; this.texts.splice(i, 1); }
    }
  }
}
