// Procedural PBR surfaces. No texture files ship with the game, so every map is
// painted into a canvas at load: grain, camouflage, rust, worn asphalt. Even a
// low-contrast roughness map makes a material stop reading as flat plastic,
// because the highlight breaks up instead of sweeping across in one piece.

import * as THREE from 'three';

const SIZE = 256;

function canvas(draw, { repeat = 1, srgb = false } = {}) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = SIZE;
  draw(cv.getContext('2d'), SIZE);
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.anisotropy = 4;
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Value noise, tiling, drawn as greyscale. */
function noiseField(ctx, n, { cells = 16, contrast = 1, base = 0.5 } = {}) {
  const g = [];
  for (let y = 0; y <= cells; y++) {
    g[y] = [];
    for (let x = 0; x <= cells; x++) g[y][x] = x === cells || y === cells ? g[y % cells][x % cells] : Math.random();
  }
  const img = ctx.createImageData(n, n);
  const smooth = (t) => t * t * (3 - 2 * t);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const fx = (x / n) * cells, fy = (y / n) * cells;
      const ix = fx | 0, iy = fy | 0;
      const tx = smooth(fx - ix), ty = smooth(fy - iy);
      const v = (g[iy][ix] * (1 - tx) + g[iy][ix + 1] * tx) * (1 - ty)
        + (g[iy + 1][ix] * (1 - tx) + g[iy + 1][ix + 1] * tx) * ty;
      const c = Math.max(0, Math.min(255, (base + (v - 0.5) * contrast) * 255));
      const i = (y * n + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = c;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** Grey-scale detail turned into a tangent-space normal map. */
function toNormal(src, strength = 2.2) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = SIZE;
  const ctx = cv.getContext('2d');
  ctx.drawImage(src, 0, 0);
  const d = ctx.getImageData(0, 0, SIZE, SIZE);
  const out = ctx.createImageData(SIZE, SIZE);
  const at = (x, y) => d.data[(((y + SIZE) % SIZE) * SIZE + ((x + SIZE) % SIZE)) * 4] / 255;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * SIZE + x) * 4;
      out.data[i] = ((-dx / len) * 0.5 + 0.5) * 255;
      out.data[i + 1] = ((-dy / len) * 0.5 + 0.5) * 255;
      out.data[i + 2] = (1 / len) * 0.5 * 255 + 127;
      out.data[i + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

let cache = null;

export function surfaces() {
  if (cache) return cache;

  const grainCv = document.createElement('canvas');
  grainCv.width = grainCv.height = SIZE;
  noiseField(grainCv.getContext('2d'), SIZE, { cells: 40, contrast: 0.7 });

  const scuffCv = document.createElement('canvas');
  scuffCv.width = scuffCv.height = SIZE;
  noiseField(scuffCv.getContext('2d'), SIZE, { cells: 10, contrast: 1.1, base: 0.45 });

  cache = {
    // fine surface grain: breaks up specular so paint looks like paint
    grain: new THREE.CanvasTexture(grainCv),
    grainNormal: toNormal(grainCv, 1.1),
    // larger blotches: wear, dirt, panel variation
    scuff: new THREE.CanvasTexture(scuffCv),
    scuffNormal: toNormal(scuffCv, 2.6),

    asphalt: canvas((c, n) => {
      noiseField(c, n, { cells: 26, contrast: 1.0, base: 0.42 });
      c.globalAlpha = 0.35;
      for (let i = 0; i < 900; i++) {
        c.fillStyle = Math.random() < 0.5 ? '#000' : '#fff';
        c.fillRect(Math.random() * n, Math.random() * n, 1 + Math.random() * 2, 1 + Math.random() * 2);
      }
    }, { repeat: 4 }),

    rust: canvas((c, n) => {
      noiseField(c, n, { cells: 7, contrast: 1.3, base: 0.5 });
    }, { repeat: 2 }),
  };
  for (const t of Object.values(cache)) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4; }
  return cache;
}

/**
 * House PBR material. Smooth shading, environment reflections, and a little
 * procedural break-up in the roughness — the three things that separate "a
 * rendered object" from "a coloured box".
 */
export function pbr(color, opts = {}) {
  const s = surfaces();
  const {
    roughness = 0.55, metalness = 0.25, detail = 1, normalScale = 0.5,
    vertexColors = false, emissive = 0x000000, emissiveIntensity = 0,
    clearcoat = 0,
  } = opts;
  const m = new THREE.MeshStandardMaterial({
    color, roughness, metalness, vertexColors, emissive, emissiveIntensity,
    roughnessMap: detail ? s.grain : null,
    normalMap: detail ? s.grainNormal : null,
    envMapIntensity: 1.0,
  });
  if (detail) m.normalScale = new THREE.Vector2(normalScale, normalScale);
  return m;
}
