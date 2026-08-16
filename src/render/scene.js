import * as THREE from 'three';
import { WORLD, CAMERAS } from '../config.js';
import { Q } from '../quality.js';
import { clamp, lerp, approach, rand, TAU } from '../util.js';

/**
 * Renderer + scene + sky + lighting + the camera rig with all six view modes.
 * Atmosphere (fog colour, sun colour, sky tint) is driven by market bias so a
 * bull run literally looks like golden hour and a dump looks like a storm.
 */
export class Stage {
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, Q.pixelRatio));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = Q.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x121a26, 0.0019);

    this.camera = new THREE.PerspectiveCamera(58, 1, 0.5, 1600);
    this.camera.position.set(-150, 90, 140);

    this._buildSky();
    this._buildLights();

    this.mode = 'cinematic';
    this.bias = 0;                 // -1 bear .. +1 bull
    this.volatility = 0;
    this.shake = 0;
    this._camPos = this.camera.position.clone();
    this._camLook = new THREE.Vector3(0, 0, 0);
    this._t = 0;
    this._free = { yaw: -0.7, pitch: -0.45, pos: new THREE.Vector3(-150, 90, 140), keys: new Set(), speed: 60 };
    this._cineShot = 0;
    this._cineTime = 0;

    this.resize();
    addEventListener('resize', () => this.resize());
  }

  _buildSky() {
    // Big inverted sphere with a vertical gradient shader — cheap and tint-able.
    const geo = new THREE.SphereGeometry(900, 32, 24);
    this.skyUniforms = {
      top: { value: new THREE.Color(0x0a1622) },
      bottom: { value: new THREE.Color(0x2b3550) },
      horizon: { value: new THREE.Color(0x6a7a99) },
      offset: { value: 120 },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.skyUniforms,
      side: THREE.BackSide,
      depthWrite: false,
      vertexShader: `varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `
        uniform vec3 top; uniform vec3 bottom; uniform vec3 horizon; uniform float offset;
        varying vec3 vP;
        void main(){
          float h = normalize(vP + vec3(0.0, offset, 0.0)).y;
          vec3 c = mix(horizon, top, smoothstep(0.0, 0.55, h));
          c = mix(bottom, c, smoothstep(-0.35, 0.02, h));
          gl_FragColor = vec4(c, 1.0);
        }`,
    });
    this.sky = new THREE.Mesh(geo, mat);
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);

    // Star/ember field that doubles as "market particles".
    const N = Q.mobile ? 500 : 1400;
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const r = rand(220, 780), a = rand(TAU), y = rand(30, 420);
      pos[i * 3] = Math.cos(a) * r; pos[i * 3 + 1] = y; pos[i * 3 + 2] = Math.sin(a) * r;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.embers = new THREE.Points(g, new THREE.PointsMaterial({
      size: 2.4, color: 0xffd9a0, transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    this.scene.add(this.embers);
  }

  _buildLights() {
    this.hemi = new THREE.HemisphereLight(0x9fc0ff, 0x2b2418, 0.75);
    this.scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight(0xffd9a8, 2.0);
    this.sun.position.set(-120, 190, 90);
    this.sun.castShadow = Q.shadows;
    this.sun.shadow.mapSize.set(Q.shadowSize, Q.shadowSize);
    const c = this.sun.shadow.camera;
    c.left = -180; c.right = 180; c.top = 140; c.bottom = -140; c.near = 20; c.far = 520;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    this.rim = new THREE.DirectionalLight(0x5588ff, 0.55);
    this.rim.position.set(140, 70, -140);
    this.scene.add(this.rim);
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;

    // A phone held upright is a tall, narrow window onto a very wide map.
    // Dollying back just shrinks everything and adds more empty sky, so instead
    // the wide shots swing round to look ALONG the map's length (see _camera),
    // which puts the long axis up the long axis of the screen. The lens only
    // widens a little to take up the slack.
    this.portrait = this.camera.aspect < 0.95;
    this.camera.fov = clamp(58 * (1 + Math.max(0, 1.3 / Math.max(0.35, this.camera.aspect) - 1) * 0.22), 58, 70);
    this.camera.updateProjectionMatrix();
  }

  setMode(mode) {
    if (!CAMERAS.includes(mode)) return;
    this.mode = mode;
    this._cineTime = 0;
    if (mode === 'free') {
      this._free.pos.copy(this.camera.position);
      const dir = new THREE.Vector3();
      this.camera.getWorldDirection(dir);
      this._free.yaw = Math.atan2(-dir.x, -dir.z);
      this._free.pitch = Math.asin(clamp(dir.y, -1, 1));
    }
  }

  addShake(amount) { this.shake = Math.min(2.2, this.shake + amount); }

  /** Blow out the exposure for a moment — a detonation flash. */
  flash(amount = 1) { this._flash = Math.min(2.5, (this._flash || 0) + amount); }

  /**
   * @param dt seconds
   * @param ctx { bias, volatility, frontlineAt(x), truck, plazaPos, depotPos }
   */
  update(dt, ctx) {
    this._t += dt;
    this.bias = approach(this.bias, clamp(ctx.bias, -1, 1), 0.8, dt);
    this.volatility = approach(this.volatility, clamp(ctx.volatility, 0, 1), 1.2, dt);
    this._atmosphere(dt);
    this._camera(dt, ctx);
    this.embers.rotation.y += dt * 0.006;
    this.renderer.render(this.scene, this.camera);
  }

  _atmosphere(dt) {
    const b = this.bias;            // -1..1
    const bull = Math.max(0, b), bear = Math.max(0, -b);

    const top = new THREE.Color().setHSL(lerp(0.60, 0.09, bull * 0.8), 0.55 - bear * 0.25, lerp(0.06, 0.16, bull) - bear * 0.02);
    const hor = new THREE.Color().setHSL(lerp(0.58, 0.08, bull), 0.62, lerp(0.32, 0.55, bull) - bear * 0.18);
    const bot = new THREE.Color().setHSL(lerp(0.62, 0.05, bull * 0.5), 0.4, 0.10 - bear * 0.04);
    this.skyUniforms.top.value.lerp(top, 1 - Math.exp(-dt));
    this.skyUniforms.horizon.value.lerp(hor, 1 - Math.exp(-dt));
    this.skyUniforms.bottom.value.lerp(bot, 1 - Math.exp(-dt));

    const fogCol = new THREE.Color().copy(this.skyUniforms.horizon.value).multiplyScalar(0.55);
    this.scene.fog.color.lerp(fogCol, 1 - Math.exp(-dt));
    this.scene.fog.density = lerp(0.0019, 0.0048, bear) * (1 + this.volatility * 0.25);

    this.sun.color.setHSL(lerp(0.60, 0.11, bull), lerp(0.15, 0.7, bull), lerp(0.60, 0.70, bull));
    this.sun.intensity = lerp(1.9, 3.1, bull) * (1 - bear * 0.28);
    this.hemi.intensity = lerp(0.85, 1.25, bull);
    this.rim.intensity = 0.35 + bear * 0.5;
    this.rim.color.setHex(bear > 0.3 ? 0xff4d5e : 0x5588ff);
    this.embers.material.opacity = 0.12 + bull * 0.45 + this.volatility * 0.2;
    this.embers.material.color.setHex(bear > 0.35 ? 0x8899bb : 0xffd9a0);
    this._flash = (this._flash || 0) * Math.exp(-3.4 * dt);
    this.renderer.toneMappingExposure = lerp(0.92, 1.18, bull) + this._flash;
  }

  _camera(dt, ctx) {
    const look = new THREE.Vector3();
    const pos = new THREE.Vector3();
    const truck = ctx.truck;
    let snap = 2.6;

    switch (this.mode) {
      case 'god':
        if (this.portrait) {
          // down the length of the battlefield: plaza in the foreground,
          // the Blockchain Gate at the far end
          pos.set(-WORLD.width * 0.66, 138, 6);
          look.set(WORLD.width * 0.22, 0, 0);
        } else {
          pos.set(0, 250, 130);
          look.set(0, 0, 0);
        }
        snap = 2.2;
        break;

      case 'follow':
        if (truck) {
          const back = new THREE.Vector3(-Math.cos(truck.heading), 0, -Math.sin(truck.heading)).multiplyScalar(34);
          pos.copy(truck.pos).add(back).add(new THREE.Vector3(0, 20, 0));
          look.copy(truck.pos).add(new THREE.Vector3(0, 3, 0));
          snap = 4.5;
        } else { pos.set(0, 120, 150); look.set(0, 0, 0); }
        break;

      case 'driver':
        if (truck) {
          // Bumper cam: sit in front of the cab so we aren't inside our own mesh.
          const fwd = new THREE.Vector3(Math.cos(truck.heading), 0, Math.sin(truck.heading));
          pos.copy(truck.pos).add(new THREE.Vector3(0, 6.0, 0)).add(fwd.clone().multiplyScalar(9.5));
          look.copy(pos).add(fwd.clone().multiplyScalar(34)).add(new THREE.Vector3(0, -3.5, 0));
          snap = 12;
        } else { pos.set(WORLD.plazaX, 20, 30); look.set(0, 5, 0); }
        break;

      case 'plaza':
        pos.set(WORLD.plazaX - 26 + Math.sin(this._t * 0.09) * 14, 52, 88);
        look.set(WORLD.plazaX + 14, 6, -2);
        snap = 2.0;
        break;

      case 'free':
        return this._freeFly(dt);

      case 'cinematic':
      default: {
        this._cineTime -= dt;
        if (this._cineTime <= 0) { this._cineTime = rand(9, 15); this._cineShot = (this._cineShot + 1 + ((Math.random() * 3) | 0)) % 5; }
        const t = this._t;
        const fz = ctx.frontlineAt ? ctx.frontlineAt(0) : 0;
        switch (this._cineShot) {
          case 0:  // slow crane over the frontline
            if (this.portrait) {
              pos.set(-150, 74 + Math.sin(t * 0.13) * 10, fz + Math.sin(t * 0.06) * 44);
              look.set(70, 6, fz);
            } else {
              pos.set(Math.sin(t * 0.06) * 150, 78 + Math.sin(t * 0.13) * 12, fz + 120);
              look.set(0, 6, fz);
            }
            break;
          case 1:  // low pass along the trench
            pos.set(-120 + ((t * 14) % 260), 16, fz - 34);
            look.set(-90 + ((t * 14) % 260) + 60, 4, fz + 6);
            break;
          case 2:  // over the shoulder of the truck
            if (truck) {
              pos.copy(truck.pos).add(new THREE.Vector3(Math.sin(t * 0.4) * 26, 14, Math.cos(t * 0.4) * 26));
              look.copy(truck.pos);
            } else { pos.set(0, 100, 160); look.set(0, 0, 0); }
            break;
          case 3:  // depot gate
            pos.set(WORLD.depotX + 60, 40, Math.sin(t * 0.2) * 60);
            look.set(WORLD.depotX - 10, 8, 0);
            break;
          default: // plaza chaos
            pos.set(WORLD.plazaX - 34, 44 + Math.sin(t * 0.3) * 6, 72);
            look.set(WORLD.plazaX + 12, 6, -2);
        }
        snap = 1.4;
      }
    }

    this._camPos.lerp(pos, 1 - Math.exp(-snap * dt));
    this._camLook.lerp(look, 1 - Math.exp(-snap * dt));
    this.camera.position.copy(this._camPos);
    this.camera.lookAt(this._camLook);
    this._applyShake(dt);
  }

  _freeFly(dt) {
    const f = this._free;
    const k = f.keys;
    const dir = new THREE.Vector3();
    const speed = f.speed * (k.has('shiftleft') || k.has('shiftright') ? 3 : 1) * dt;
    const fwd = new THREE.Vector3(-Math.sin(f.yaw) * Math.cos(f.pitch), Math.sin(f.pitch), -Math.cos(f.yaw) * Math.cos(f.pitch));
    const right = new THREE.Vector3(Math.cos(f.yaw), 0, -Math.sin(f.yaw));
    if (k.has('keyw') || k.has('arrowup')) dir.add(fwd);
    if (k.has('keys') || k.has('arrowdown')) dir.sub(fwd);
    if (k.has('keyd') || k.has('arrowright')) dir.add(right);
    if (k.has('keya') || k.has('arrowleft')) dir.sub(right);
    if (k.has('keyq')) dir.y -= 1;
    if (k.has('keye')) dir.y += 1;
    if (dir.lengthSq() > 0) f.pos.add(dir.normalize().multiplyScalar(speed));
    f.pos.y = clamp(f.pos.y, 3, 420);
    this.camera.position.copy(f.pos);
    this.camera.lookAt(f.pos.clone().add(fwd));
    this._camPos.copy(f.pos);
    this._applyShake(dt);
  }

  _applyShake(dt) {
    if (this.shake > 0.001) {
      const s = this.shake;
      this.camera.position.x += rand(-s, s);
      this.camera.position.y += rand(-s, s);
      this.camera.position.z += rand(-s, s);
      this.camera.rotation.z += rand(-s, s) * 0.006;
      this.shake *= Math.exp(-3.2 * dt);
    }
  }

  /** Free-fly mouse look, wired from input.js. */
  lookDelta(dx, dy) {
    if (this.mode !== 'free') return;
    this._free.yaw -= dx * 0.0025;
    this._free.pitch = clamp(this._free.pitch - dy * 0.0025, -1.45, 1.45);
  }
  freeKeys() { return this._free.keys; }
}
