// External CC0 assets (Poly Haven). Everything here loads asynchronously and is
// applied when it arrives, so the game is playable from the first frame and
// simply gets better a second later — a phone on a slow link still starts.
//
// Licence: all assets under vendor/assets are CC0 from polyhaven.com.

import * as THREE from 'three';
import { RGBELoader } from '../../vendor/addons/loaders/RGBELoader.js';
import { GLTFLoader } from '../../vendor/addons/loaders/GLTFLoader.js';
import { Q } from '../quality.js';

const BASE = './vendor/assets';

/**
 * A real captured sky, turned into a light probe. A photographed environment is
 * the single biggest step toward realism available here: it is what puts true
 * sky gradients and horizon detail into every reflective surface, which no
 * amount of procedural gradient can fake.
 */
export function loadEnvironment(renderer, onReady) {
  new RGBELoader().setPath(`${BASE}/hdri/`).load('quarry_cloudy_1k.hdr', (hdr) => {
    const pmrem = new THREE.PMREMGenerator(renderer);
    const target = pmrem.fromEquirectangular(hdr);
    hdr.dispose();
    pmrem.dispose();
    onReady(target.texture);
  }, undefined, () => { /* keep the procedural probe */ });
}

function tex(url, { srgb = false, repeat = 1 } = {}) {
  const t = new THREE.TextureLoader().load(url);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = Q.mobile ? 2 : 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * Scanned PBR ground set. `arm` packs ambient occlusion, roughness and
 * metalness into R/G/B, which is exactly the layout three.js expects when the
 * same texture is bound to aoMap, roughnessMap and metalnessMap.
 */
export function groundMaps(name, repeat) {
  const p = `${BASE}/textures/${name}/${name}`;
  const arm = tex(`${p}_arm_1k.jpg`, { repeat });
  return {
    map: tex(`${p}_diff_1k.jpg`, { srgb: true, repeat }),
    normalMap: tex(`${p}_nor_gl_1k.jpg`, { repeat }),
    roughnessMap: arm,
    aoMap: arm,
  };
}

/**
 * Load a photoreal prop and hand back geometry + material ready to instance.
 * Poly Haven models are metres and Y-up; the world here runs at roughly two
 * units to the metre, so they are scaled on the way in.
 */
export function loadProp(name, file, scale, onReady) {
  new GLTFLoader().load(`${BASE}/models/${name}/${file}`, (gltf) => {
    let mesh = null;
    gltf.scene.traverse((o) => { if (!mesh && o.isMesh) mesh = o; });
    if (!mesh) return;
    const geo = mesh.geometry.clone();
    geo.scale(scale, scale, scale);
    geo.computeBoundingSphere();
    const mat = mesh.material;
    mat.envMapIntensity = 0.9;
    onReady(geo, mat);
  }, undefined, () => { /* keep the procedural stand-in */ });
}

export const PROPS = {
  barrier: { name: 'concrete_road_barrier', file: 'concrete_road_barrier_1k.gltf', scale: 2.0 },
  crate: { name: 'old_military_crate', file: 'old_military_crate_1k.gltf', scale: 2.4 },
  barrel: { name: 'barrel_03', file: 'barrel_03_1k.gltf', scale: 2.2 },
};
