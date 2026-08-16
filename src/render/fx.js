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
    const n = clamp(Math.round(60 * power), 24, 420);
    this.spawn(x, y, z, { color, count: n, size: 2.4 * power, life: 1.1 + power * 0.5, speed: 16 * Math.sqrt(power), spread: 1.4, gravity: -14, drag: 1.6 });
    this.spawn(x, y, z, { color: 0xffffff, count: Math.round(n * 0.3), size: 3.4 * power, life: 0.35, speed: 26 * Math.sqrt(power), spread: 0.8, gravity: 0, drag: 3.2 });
    this.spawn(x, y + 2, z, { color: 0x3a3a3a, count: Math.round(n * 0.5), size: 5 * power, life: 2.6, speed: 4, spread: 2.5, gravity: 1.6, drag: 0.7, alpha: 0.55 });
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
