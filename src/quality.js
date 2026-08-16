// Device capability tiers. Everything expensive in the scene is sized from
// here, so a phone renders the same game with a smaller army and a coarser
// terrain rather than a slideshow.

const coarse = matchMedia('(pointer: coarse)').matches;
const shortSide = Math.min(screen.width, screen.height);
const cores = navigator.hardwareConcurrency || 4;
const mem = navigator.deviceMemory || 4;

export const IS_MOBILE = coarse && shortSide < 900;

function detectTier() {
  const forced = new URLSearchParams(location.search).get('q');
  if (forced && ['low', 'medium', 'high'].includes(forced)) return forced;
  if (IS_MOBILE) return (cores <= 6 || mem <= 4) ? 'low' : 'medium';
  if (cores <= 4 || mem <= 4) return 'medium';
  return 'high';
}

const PRESETS = {
  high: {
    pixelRatio: 2,
    shadows: true, shadowSize: 2048,
    columns: 160, rows: 96,
    infantry: 240, armour: 22,
    particles: 6000, tracers: 900, bullets: 260, rings: 10, texts: 26,
    roadSeg: 120, propScale: 1,
    planes: 6, helis: 4, bookLevels: 8,
    packages: 170,
  },
  medium: {
    pixelRatio: 1.6,
    shadows: true, shadowSize: 1024,
    columns: 120, rows: 72,
    infantry: 130, armour: 16,
    particles: 3000, tracers: 500, bullets: 150, rings: 8, texts: 18,
    roadSeg: 90, propScale: 0.6,
    planes: 4, helis: 3, bookLevels: 6,
    packages: 130,
  },
  low: {
    pixelRatio: 1.3,
    shadows: false, shadowSize: 512,
    columns: 88, rows: 52,
    infantry: 64, armour: 10,
    particles: 1500, tracers: 260, bullets: 80, rings: 6, texts: 12,
    roadSeg: 60, propScale: 0.32,
    planes: 3, helis: 2, bookLevels: 5,
    packages: 80,
  },
};

export const TIER = detectTier();
export const Q = { tier: TIER, mobile: IS_MOBILE, ...PRESETS[TIER] };

/** Scale an instanced prop count by the tier, never below 2. */
export const props = (n) => Math.max(2, Math.round(n * Q.propScale));
