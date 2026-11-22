// Orange Pill Run - simulation constants (kanban #3246). Any change to a rule or to the tuning below changes
// scores, so it must bump GAME_VERSION; a round pins the version it was opened with.
// VERSIONS holds what differs between versions, so a round opened on an older version still builds, replays and
// scores as it did (kanban #3271): run/boost = the runner's top speeds, foe = factor on every enemy and hazard
// speed (patrol, bear, bills, printer rate, hops, clouds), hopP/hopUp = a hopper's cycle and air steps,
// timePerS = score per second under par.
export const VERSIONS = {
  "opr-1": { run: 3.2, boost: 4.8, foe: 1, hopP: 80, hopUp: 40, timePerS: 2 },
  // owner 2026-11-22: "Die Zeit muss viel mehr gewichtet sein" and "Und 10% langsamer"
  "opr-2": { run: 2.88, boost: 4.32, foe: 0.9, hopP: 88, hopUp: 44, timePerS: 20 },
  // kanban #3275, owner 2026-11-22: "Die Checkpoints so gestalten, dass man nicht direkt danach sterben kann".
  // safeCp: each checkpoint stands where a respawn with no input lives SAFE_STEPS steps without the grace (level.js)
  "opr-3": { run: 2.88, boost: 4.32, foe: 0.9, hopP: 88, hopUp: 44, timePerS: 20, safeCp: true },
};
export const GAME_VERSION = "opr-3";
// the rules of a version; throws a TypeError for one this code does not know
export function rulesOf(v) {
  const r = Object.prototype.hasOwnProperty.call(VERSIONS, v) ? VERSIONS[v] : null;
  if (!r) throw new TypeError("unknown game version " + JSON.stringify(v));
  return r;
}

export const T = 24, ROWS = 14, VH = ROWS * T, STEP = 1 / 60;           // world units; 60 simulation steps per second
export const GRAV = 0.5, JUMP_V = -10, CUT_V = -3.4, ACC = 0.45, MAXFALL = 9;
export const PW = 16, PH = 22, TIME_LIMIT = 180;
export const MAX_STEPS = TIME_LIMIT * 60;                                 // the run is over by then at the latest
export const DEATH_PENALTY = 3;                                           // seconds per death
export const RESPAWN_GRACE = 70;                                          // steps without damage after a respawn (hurtT)
export const SAFE_STEPS = 90;                                             // opr-3: 1.5 s of run after a checkpoint are safe
export const C0 = 14;                                                     // first candle column
export const TILE = { EMPTY: 0, GROUND: 1, BRICK: 2, ONEWAY: 3, QBLOCK: 4, USED: 5, RUG: 6, CG: 7, CR: 8, FILL: 9, PLAT: 10, SPIKE: 11 };
const SOLID_TILES = new Uint8Array(16);
for (const v of [1, 2, 4, 5, 6, 7, 8, 9, 10]) SOLID_TILES[v] = 1;
export const isSolid = (v) => SOLID_TILES[v] === 1;

// colours of the floating texts the simulation emits (drawing only; never read back by the rules)
export const COL = { text: "#f6ece4", soft: "#c8bab2", dim: "#8c8086", btc: "#f7931a", gold: "#ffd166", blue: "#58a6ff", green: "#3fb950", red: "#f85149" };

export const PW_INFO = {
  pill: { t: 1200, text: "ORANGE PILL · bigger, survives 1 hit", color: "#f7931a", icon: "💊" },
  diamond: { t: 480, text: "DIAMOND HANDS · 8 s invincible", color: "#7ee8ff", icon: "💎" },
  laser: { t: 720, text: "LASER EYES · 12 s, shoots foes", color: "#ff4a3a", icon: "👁" },
  magnet: { t: 720, text: "SATS MAGNET · 12 s, pulls coins", color: "#c08cff", icon: "🧲" },
  moon: { t: 600, text: "MOON BOOTS · 10 s, double jump", color: "#ffe9a8", icon: "🌙" },
};
export const PW_ORDER = ["pill", "moon", "diamond", "laser", "magnet"];

// "$61,912" without toLocaleString (the same text in every engine)
export function fmtUsd(v) {
  const s = String(Math.round(v)); let out = "";
  for (let i = 0; i < s.length; i++) { if (i > 0 && (s.length - i) % 3 === 0 && s[i - 1] !== "-") out += ","; out += s[i]; }
  return "$" + out;
}
