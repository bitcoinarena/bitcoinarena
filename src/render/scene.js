import * as THREE from 'three';
import { EffectComposer } from '../../vendor/addons/postprocessing/EffectComposer.js';
import { RenderPass } from '../../vendor/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from '../../vendor/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from '../../vendor/addons/postprocessing/OutputPass.js';
import { SMAAPass } from '../../vendor/addons/postprocessing/SMAAPass.js';
import { loadEnvironment } from './assets.js';
import { WORLD, CAMERAS } from '../config.js';
import { Q } from '../quality.js';
import { clamp, lerp, approach, rand, TAU, angleApproach } from '../util.js';

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

    this.mode = 'god';
    this.bias = 0;                 // -1 bear .. +1 bull
    this.volatility = 0;
    this.shake = 0;
    this._camPos = this.camera.position.clone();
    this._camLook = new THREE.Vector3(0, 0, 0);
    this._t = 0;
    this._free = { yaw: -0.7, pitch: -0.45, pos: new THREE.Vector3(-150, 90, 140), keys: new Set(), speed: 60 };
    this._cineShot = 0;
    this._cineTime = 0;

    this._buildEnvironment();
    this._buildComposer();

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

  /**
   * Image-based lighting. Without an environment map a MeshStandardMaterial has
   * nothing to reflect, so metal reads as flat paint and everything looks like
   * untextured plastic — the single biggest reason the old look felt like toy
   * bricks. A small procedural sky is rendered into a PMREM probe and used as
   * scene.environment, so every surface picks up the sky above it and the
   * ground bounce below, and metal actually looks like metal.
   */
  _buildEnvironment() {
    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.pmrem.compileEquirectangularShader();

    this.envScene = new THREE.Scene();
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(50, 24, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        uniforms: {
          top: { value: new THREE.Color(0x2a3a52) },
          horizon: { value: new THREE.Color(0x8a93a3) },
          ground: { value: new THREE.Color(0x2a2622) },
        },
        vertexShader: 'varying vec3 vP; void main(){ vP=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }',
        fragmentShader: `uniform vec3 top; uniform vec3 horizon; uniform vec3 ground; varying vec3 vP;
          void main(){ float h=normalize(vP).y;
            vec3 c = h > 0.0 ? mix(horizon, top, pow(h, 0.55)) : mix(horizon, ground, pow(-h, 0.4));
            gl_FragColor = vec4(c, 1.0); }`,
      }),
    );
    this.envScene.add(dome);

    // a bright disc standing in for the sun, so metal gets a specular highlight
    this.envSun = new THREE.Mesh(
      new THREE.SphereGeometry(6, 12, 8),
      new THREE.MeshBasicMaterial({ color: 0xffe9c4 }),
    );
    this.envSun.position.set(-24, 34, 18);
    this.envScene.add(this.envSun);

    this._envAcc = 99;
    this._updateEnvironment();

    // A photographed sky replaces the procedural probe as soon as it arrives.
    // Until then the generated one carries the lighting, so nothing waits.
    loadEnvironment(this.renderer, (texture) => {
      this.hdri = texture;
      this.scene.environment = texture;
      // A real sky carries a strong colour cast of its own. Dialled back so it
      // grounds the reflections without overriding the market-driven mood,
      // which is the thing the atmosphere is supposed to communicate.
      this.scene.environmentIntensity = 0.5;
    });
  }

  _updateEnvironment() {
    const u = this.envScene.children[0].material.uniforms;
    u.top.value.copy(this.skyUniforms.top.value).multiplyScalar(1.5);
    u.horizon.value.copy(this.skyUniforms.horizon.value).multiplyScalar(1.35);
    u.ground.value.copy(this.skyUniforms.bottom.value).multiplyScalar(0.9);
    this.envSun.material.color.copy(this.sun.color).multiplyScalar(1.5);

    if (this.hdri) return;                    // the captured sky outranks it
    const target = this.pmrem.fromScene(this.envScene, 0, 1, 120);
    this.scene.environment?.dispose?.();
    this.scene.environment = target.texture;
    this.scene.environmentIntensity = 0.8;
  }

  /** Bloom and anti-aliasing, both gated on the device tier. */
  _buildComposer() {
    if (!Q.bloom && !Q.aa) { this.composer = null; return; }
    const size = new THREE.Vector2(innerWidth, innerHeight);
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    if (Q.bloom) {
      this.bloom = new UnrealBloomPass(size, 0.22, 0.5, 1.15);
      this.composer.addPass(this.bloom);
    }
    this.composer.addPass(new OutputPass());
    if (Q.aa) this.composer.addPass(new SMAAPass(size.x, size.y));
  }

  _buildLights() {
    this.hemi = new THREE.HemisphereLight(0x9fc0ff, 0x2b2418, 0.2);
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
    this.composer?.setSize(w, h);
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

    // the sky is market-driven, so the light probe has to follow it — but not
    // every frame, PMREM is far too expensive for that
    this._envAcc += dt;
    if (this._envAcc > Q.envEvery) { this._envAcc = 0; this._updateEnvironment(); }

    if (this.composer) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);
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
    this.sun.intensity = lerp(2.2, 3.0, bull) * (1 - bear * 0.28);
    this.hemi.intensity = lerp(0.26, 0.42, bull);
    this.rim.intensity = 0.18 + bear * 0.32;
    this.rim.color.setHex(bear > 0.3 ? 0xff4d5e : 0x5588ff);
    this.embers.material.opacity = 0.12 + bull * 0.45 + this.volatility * 0.2;
    this.embers.material.color.setHex(bear > 0.35 ? 0x8899bb : 0xffd9a0);
    this._flash = (this._flash || 0) * Math.exp(-3.4 * dt);
    this.renderer.toneMappingExposure = lerp(0.98, 1.2, bull) + this._flash;
  }

  _camera(dt, ctx) {
    const look = new THREE.Vector3();
    const pos = new THREE.Vector3();
    const truck = ctx.truck;
    let snap = 2.6;

    switch (this.mode) {
      case 'follow': {
        if (!truck) { pos.set(0, 120, 150); look.set(0, 0, 0); break; }
        const sp = Math.min(1, Math.abs(truck.speed) / 34);
        // Chase the direction of travel rather than the nose. In a slide the
        // two diverge, so the camera stays square to the road and you watch
        // your own flank come round — which is how a drift reads as a drift.
        const v = truck.vel;
        const moving = v && Math.hypot(v.x, v.z) > 6;
        const yaw = moving ? Math.atan2(v.z, v.x) : truck.heading;
        this._chaseYaw = this._chaseYaw === undefined
          ? yaw
          : angleApproach(this._chaseYaw, yaw, 2.8, dt);
        const back = new THREE.Vector3(-Math.cos(this._chaseYaw), 0, -Math.sin(this._chaseYaw))
          .multiplyScalar(28 + sp * 14);
        pos.copy(truck.pos).add(back).add(new THREE.Vector3(0, 13 + sp * 6, 0));
        // look down the road ahead, not at the tailgate
        look.copy(truck.pos)
          .add(new THREE.Vector3(Math.cos(truck.heading), 0, Math.sin(truck.heading)).multiplyScalar(6 + sp * 12))
          .add(new THREE.Vector3(0, 3.4, 0));
        snap = 6.5;
        break;
      }

      case 'god':
      default:
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
