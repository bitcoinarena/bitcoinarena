// Orange Pill Run - the level from the chart (kanban #3246/#3247), ported from the prototype's buildLevel.
// Small moves do not change the height: those candles merge into one flat plateau, shown as faint candles on its
// face. Only a real move up or down makes a step, and that candle is a full pillar. The flat stretches get their
// own challenges, picked from a list seeded by `seed`, so one chart and one seed always build the same level.
// Pure: candles = [[t, o, h, l, c], ...] (48 x 30 min, t in unix seconds), seed = 32-bit integer, version = the
// round's game version (L.version; the world and the score follow it; the layout is the same in every version).
import { T, ROWS, C0, TILE, GAME_VERSION, rulesOf } from "./constants.js";

export function buildLevel(candles, seed, version = GAME_VERSION) {
  const R = rulesOf(version);
  if (!Array.isArray(candles) || candles.length < 8) throw new TypeError("buildLevel: candles must be an array of [t,o,h,l,c]");
  const cs = candles, n = cs.length;
  let hi = -Infinity, lo = Infinity;
  for (const c of cs) { if (c[2] > hi) hi = c[2]; if (c[3] < lo) lo = c[3]; }
  const span = hi - lo || 1;
  const rowOf = (p) => 10.4 - (p - lo) / span * 5.4;
  let s32 = (seed | 0) || 1;
  const rnd = () => { s32 = (s32 + 0x6D2B79F5) | 0; let t = Math.imul(s32 ^ (s32 >>> 15), 1 | s32); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  // heights per candle, then segments of equal height
  const meta = []; let prevTop = 12;
  cs.forEach(([t, o, h, l, c], i) => { let top = Math.round(rowOf(Math.max(o, c))); top = Math.min(11, Math.max(top, prevTop - 3, 5));
    meta.push({ i, t, o, h, l, c, green: c >= o, move: (c - o) / o, top, bottom: Math.max(top, Math.round(rowOf(Math.min(o, c)))), wick: Math.max(1, top - 4, Math.round(rowOf(h))) }); prevTop = top; });
  const segs = []; meta.forEach((m) => { const s = segs[segs.length - 1]; if (s && s.top === m.top) s.items.push(m); else segs.push({ top: m.top, items: [m] }); });
  // columns: a step candle is a 3-wide pillar; the rest of a segment is 3 columns of plateau per candle; a notch between segments
  let x = C0; segs.forEach((s, si) => { s.x0 = x; s.items.forEach((m, k) => { m.x0 = x; m.real = k === 0; m.seg = si; x += 3; }); s.x1 = x - 1; x += 1; });
  const endX = x;
  const L = { w: endX + 24, t: new Uint8Array((endX + 24) * ROWS), meta, segs, colMeta: new Int16Array(endX + 24).fill(-1), coins: [], enemies: [], clouds: [], items: [], checkpoints: [{ x: 3, row: 12 }], goal: endX + 18, dayHigh: null, seed: seed | 0, version, from: cs[0][0], to: cs[n - 1][0] };
  const set = (cx, y, v) => { if (cx >= 0 && cx < L.w && y >= 0 && y < ROWS) L.t[y * L.w + cx] = v; };
  const get = (cx, y) => L.t[y * L.w + cx];
  const coin = (cx, y) => L.coins.push({ x: cx * T + T / 2, y: y * T + T / 2, got: false });
  const foe = (cx, row, half) => L.enemies.push({ x: cx * T, row, x0: cx * T, dir: -1, span: half * T });
  // start
  for (let cx = 0; cx < C0; cx++) { set(cx, 12, 1); set(cx, 13, 1); }
  for (let cx = 5; cx <= 7; cx++) set(cx, 8, cx === 6 ? 4 : 2);
  coin(9, 10); coin(10, 10); coin(11, 10); L.items.push({ kind: "wallet", x: 2 * T + 12, y: 10 * T, got: false });
  // terrain
  meta.forEach((m) => { for (let cx = m.x0; cx < m.x0 + 3; cx++) { L.colMeta[cx] = m.i; for (let y = m.top; y <= 11; y++) set(cx, y, m.real ? (m.green ? 7 : 8) : 10); set(cx, 12, 1); set(cx, 13, 1); } });
  segs.forEach((s, si) => { const nx = s.x1 + 1, nxt = segs[si + 1]; if (!nxt) return;
    const dump = nxt.top > s.top + 1 && si > 0;
    if (dump) { set(nx, Math.max(s.top, nxt.top), 6); s.pit = true; return; }
    for (let y = Math.max(s.top, nxt.top) + 1; y <= 13; y++) set(nx, y, 9); });
  // pickups on real candles
  meta.forEach((m) => { if (!m.real) return; if (m.green) { coin(m.x0, m.top - 2); coin(m.x0 + 2, m.top - 2); } if (m.wick < m.top - 1) coin(m.x0 + 1, m.wick); });
  meta.forEach((m) => { if (!m.real || m.i < 2) return; if (!m.green) L.enemies.push({ x: (m.x0 + 1) * T, row: m.top, x0: (m.x0 + 1) * T, dir: -1, span: 1.1 * T });
    else if (m.i % 2 === 0) L.enemies.push({ x: (m.x0 + 1) * T, row: m.top, x0: (m.x0 + 1) * T, dir: 0, span: 0, hop: true }); });
  // challenges on the flat plateaus (columns after the step candle)
  const kinds = ["parade", "blocks", "rugs", "fud", "spikes", "wall", "stairs", "bear", "printer"]; let last = "", bag = [], firstBag = true;
  const chunks = []; segs.forEach((s) => { const a0 = s.x0 + 3; for (let ca = a0; ca <= s.x1; ca += 14) { const cb = Math.min(s.x1, ca + 13); if (s.x1 - cb < 4) { chunks.push([ca, s.x1, s.top, s]); break; } chunks.push([ca, cb, s.top, s]); } });
  chunks.forEach(([a, b, r, s]) => {
    const len = b - a + 1; if (len < 3) return;
    if (len < 9) { const k = rnd(); if (k < .4) foe(Math.floor((a + b) / 2), r, len / 2 - .8); else if (k < .7 && r >= 6) { set(a + Math.floor(len / 2), r - 1, 11); } else { for (let cx = a; cx <= b; cx += 2) coin(cx, r - 2); } return; }
    if (!bag.length) { bag = kinds.slice(); for (let i = bag.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [bag[i], bag[j]] = [bag[j], bag[i]]; } if (bag[bag.length - 1] === last) bag.reverse(); if (firstBag) { bag = bag.filter((k) => k !== "bear" && k !== "printer").concat(["printer", "bear"]); firstBag = false; } } let kind = bag.pop(); last = kind;
    if (kind === "fud" && r < 7) kind = "parade"; if (kind === "stairs" && r < 8) kind = "blocks"; if (kind === "blocks" && r < 6) kind = "spikes";
    (s.challenges = s.challenges || []).push(kind); const mid = Math.floor((a + b) / 2);
    if (kind === "parade") { const nE = len >= 15 ? 3 : 2; for (let e = 0; e < nE; e++) foe(a + 2 + Math.floor((len - 4) * (e + .5) / nE), r, Math.max(1, (len - 4) / nE / 2 - .5)); for (let cx = a + 1; cx <= b - 1; cx += 3) coin(cx, r - 3); }
    else if (kind === "blocks") { for (let cx = mid - 3; cx <= mid + 3; cx++) set(cx, r - 4, (cx - mid) % 2 === 0 ? 4 : 2); for (let cx = mid - 3; cx <= mid + 3; cx++) coin(cx, r - 5); foe(mid, r, 2.5); }
    else if (kind === "rugs") { for (let cx = mid - 2; cx <= mid + 2; cx++) { for (let y = r; y <= 13; y++) set(cx, y, 0); set(cx, r, 6); L.colMeta[cx] = -1; } coin(mid, r - 3); coin(mid - 1, r - 2); coin(mid + 1, r - 2); }
    else if (kind === "fud") { L.clouds.push({ x0: (mid - 1) * T, y0: (r - 4) * T + 2, x: 0, y: 0, low: true }); for (let cx = a; cx <= b; cx += 2) coin(cx, r - 1); }
    else if (kind === "spikes") { const cnt = Math.max(1, Math.min(3, Math.floor((len - 2) / 5))); for (let k = 0; k < cnt; k++) { const cx = a + 2 + k * 5; set(cx, r - 1, 11); coin(cx, r - 3); } }
    else if (kind === "wall") { for (let y = r - 2; y < r; y++) { set(mid, y, 2); set(mid + 1, y, 2); } set(mid + 1, r - 3, 4); coin(mid - 2, r - 2); coin(mid + 3, r - 2); foe(Math.min(b - 1, mid + 4), r, 1.2); }
    else if (kind === "bear") { L.enemies.push({ kind: "bear", x: (b - 1) * T, row: r, x0: (b - 1) * T, dir: -1, span: 0, minX: a * T }); for (let cx = a + 1; cx <= b - 3; cx += 3) coin(cx, r - 2); }
    else if (kind === "printer") { L.enemies.push({ kind: "printer", x: (b - 1) * T, row: r, x0: (b - 1) * T, dir: -1, span: 0, cd: 40 }); for (let cx = a + 1; cx <= b - 3; cx += 2) coin(cx, r - 3); }
    else if (kind === "stairs") { for (let k = 0; k < 3; k++) { const cx = a + 1 + k * 3, y = r - 2 - k * 2; if (cx + 1 > b || y < 1) break; set(cx, y, 3); set(cx + 1, y, 3); coin(cx, y - 1); coin(cx + 1, y - 1); } }
  });
  // FUD storms over the worst real dumps, the lightning on the best pump, ₿ blocks over the next best pumps
  const real = meta.filter((m) => m.real), byMove = [...real].sort((p, q) => p.move - q.move || p.i - q.i);
  byMove.filter((m) => !m.green && m.i > 1 && m.top >= 7).slice(0, 5).forEach((m) => L.clouds.push({ x0: m.x0 * T - 6, y0: (m.top - 7) * T + 4, x: 0, y: 0 }));
  { const cyc = ["pill", "moon", "diamond", "laser", "magnet"]; let k = 0; const best4 = byMove.slice(-4);
    meta.filter((m) => m.real && m.i > 2 && m.top >= 4 && !best4.includes(m)).forEach((m, j) => { if (j % 2 !== 1) return; L.items.push({ kind: cyc[k++ % cyc.length], x: (m.x0 + 1) * T + 12, y: (m.top - 2) * T, got: false }); }); }
  byMove.slice(-4).reverse().forEach((m, k) => { if (k === 0) L.items.push({ kind: "bolt", x: (m.x0 + 1) * T + 12, y: (m.top - 1) * T, got: false }); else if (m.top - 4 >= 1 && get(m.x0 + 1, m.top - 4) === 0) set(m.x0 + 1, m.top - 4, 4); });
  const topC = meta.reduce((p, q) => (q.h > p.h ? q : p));
  L.dayHigh = { x: (topC.x0 + 1) * T + 12, y: Math.max(1, topC.top - 3) * T + 12, got: false, price: topC.h, t: topC.t };
  for (let k = 6; k < n; k += 6) { const m = meta[k]; let cx = m.x0 + 1; while ((![7, 8, 10].includes(get(cx, m.top)) || get(cx, m.top - 1) === 11) && cx < m.x0 + 3) cx++; L.checkpoints.push({ x: cx, row: m.top }); }
  for (let cx = endX; cx < L.w; cx++) { set(cx, 12, 1); set(cx, 13, 1); }
  for (let k = 0; k < 3; k++) for (let y = 11 - k; y <= 11; y++) set(endX + 10 + k, y, 2);
  L.parTime = Math.round(L.goal * T / R.run / 60 * 1.6);
  return L;
}
