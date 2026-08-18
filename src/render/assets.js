// External CC0 assets (Poly Haven). Everything loads asynchronously and swaps in
// over a procedural stand-in when it arrives, so the game is playable from the
// first frame and still runs if the files are missing entirely.
//
// Licence: everything under vendor/assets is CC0 from polyhaven.com — see
// ASSETS.md.

import * as THREE from 'three';
import { RGBELoader } from '../../vendor/addons/loaders/RGBELoader.js';
import { GLTFLoader } from '../../vendor/addons/loaders/GLTFLoader.js';
import { Q } from '../quality.js';

const BASE = './vendor/assets';

/* ------------------------------------------------------------- registry */

/** Every external asset, so the UI can show exactly what is and is not in. */
export const ASSETS = [];
const listeners = new Set();

function track(id, label) {
  const entry = { id, label, state: 'pending', detail: '' };
  ASSETS.push(entry);
  return {
    ok: (detail = '') => { entry.state = 'ok'; entry.detail = detail; notify(); },
    fail: (why = '') => { entry.state = 'fail'; entry.detail = why; notify(); },
  };
}
function notify() { for (const fn of listeners) fn(ASSETS); }
export function onAssetChange(fn) { listeners.add(fn); fn(ASSETS); }
export function assetSummary() {
  const ok = ASSETS.filter((a) => a.state === 'ok').length;
  const fail = ASSETS.filter((a) => a.state === 'fail').length;
  return { ok, fail, total: ASSETS.length, done: ok + fail >= ASSETS.length };
}

/* ---------------------------------------------------------------- sky */

/**
 * A real captured sky, turned into a light probe. A photographed environment is
 * the one thing no generated gradient can fake: true horizon structure ends up
 * in every reflective surface in the scene.
 */
export function loadEnvironment(renderer, onReady) {
  const t = track('hdri', 'Captured sky');
  new RGBELoader().setPath(`${BASE}/hdri/`).load(
    'quarry_cloudy_1k.hdr',
    (hdr) => {
      const pmrem = new THREE.PMREMGenerator(renderer);
      const target = pmrem.fromEquirectangular(hdr);
      hdr.dispose(); pmrem.dispose();
      onReady(target.texture);
      t.ok('quarry_cloudy 1k');
    },
    undefined,
    () => t.fail('download failed'),
  );
}

/* ------------------------------------------------------------ textures */

function tex(url, { srgb = false, repeat = 1, onLoad, onError } = {}) {
  const t = new THREE.TextureLoader().load(url, onLoad, undefined, onError);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = Q.mobile ? 2 : 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * Scanned PBR set. `arm` packs ambient occlusion, roughness and metalness into
 * R/G/B, which is exactly the channel layout three.js reads when the same
 * texture is bound to aoMap and roughnessMap.
 */
const mapCache = new Map();

export function groundMaps(name, repeat, label) {
  // Called once per road ribbon — five routes, three ribbons each — so without
  // a cache this loaded the same 1k set fifteen times over and registered
  // fifteen identical rows in the loading status.
  const key = `${name}@${repeat}`;
  if (mapCache.has(key)) return mapCache.get(key);

  const st = track(`tex:${name}`, label || name);
  const p = `${BASE}/textures/${name}/${name}`;
  let left = 2;
  const done = () => { if (--left === 0) st.ok('1k diff+nor+arm'); };
  const arm = tex(`${p}_arm_1k.jpg`, { repeat });
  const set = {
    map: tex(`${p}_diff_1k.jpg`, { srgb: true, repeat, onLoad: done, onError: () => st.fail('missing') }),
    normalMap: tex(`${p}_nor_gl_1k.jpg`, { repeat, onLoad: done, onError: () => st.fail('missing') }),
    roughnessMap: arm,
    aoMap: arm,
  };
  mapCache.set(key, set);
  return set;
}

/* -------------------------------------------------------------- models */

/**
 * Load a scanned prop and hand back geometry ready to instance.
 *
 * Two things have to be right or the model is invisible rather than wrong:
 * the mesh's node transform must be baked in (Poly Haven nests meshes under
 * scaled nodes, and taking bare geometry threw that away — the first version of
 * this left every prop 0.14 units tall), and the result must be normalised to a
 * target world size, because source units vary per asset and guessing a scale
 * factor per model does not survive the next download.
 */
export function loadProp(name, file, targetSize, onReady) {
  const st = track(`model:${name}`, name.replace(/_/g, ' '));
  new GLTFLoader().load(
    `${BASE}/models/${name}/${file}`,
    (gltf) => {
      gltf.scene.updateMatrixWorld(true);

      // Several of these downloads are not one model but a COLLECTION of
      // variants sharing a file — the military crate ships a lid, a latch, a
      // loop, a cloth and the crate itself. Merging them stacks unrelated parts
      // into one flat smear, so take the single mesh with the largest volume,
      // which is the object the asset is actually named after.
      let best = null, bestVol = -1, material = null;
      gltf.scene.traverse((o) => {
        if (!o.isMesh) return;
        const g = o.geometry.clone();
        g.applyMatrix4(o.matrixWorld);
        for (const key of Object.keys(g.attributes)) {
          if (!['position', 'normal', 'uv'].includes(key)) g.deleteAttribute(key);
        }
        g.computeBoundingBox();
        const s2 = new THREE.Vector3();
        g.boundingBox.getSize(s2);
        const vol = s2.x * s2.y * s2.z;
        if (vol > bestVol) { bestVol = vol; best = g; material = o.material; }
      });
      if (!best) return st.fail('no mesh');

      const geo = best;
      geo.computeBoundingBox();
      const size = new THREE.Vector3();
      geo.boundingBox.getSize(size);
      const span = Math.max(size.x, size.y, size.z) || 1;
      const s = targetSize / span;
      geo.scale(s, s, s);

      // sit it on the ground rather than half-buried
      geo.computeBoundingBox();
      geo.translate(0, -geo.boundingBox.min.y, 0);
      geo.computeBoundingSphere();

      material.envMapIntensity = 0.9;
      onReady(geo, material);
      st.ok(`${(span * s).toFixed(1)}u · ${(geo.attributes.position.count / 1000).toFixed(1)}k verts`);
    },
    undefined,
    () => st.fail('download failed'),
  );
}

export const PROPS = {
  barrier: { name: 'concrete_road_barrier', file: 'concrete_road_barrier_1k.gltf', size: 4.2 },
  crate: { name: 'old_military_crate', file: 'old_military_crate_1k.gltf', size: 2.6 },
  barrel: { name: 'barrel_03', file: 'barrel_03_1k.gltf', size: 2.0 },
};
