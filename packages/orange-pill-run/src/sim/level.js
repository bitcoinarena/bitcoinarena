// Orange Pill Run - the level from the chart (kanban #3246/#3247), ported from the prototype's buildLevel.
// Small moves do not change the height: those candles merge into one flat plateau, shown as faint candles on its
// face. Only a real move up or down makes a step, and that candle is a full pillar. The flat stretches get their
// own challenges, picked from a list seeded by `seed`, so one chart and one seed always build the same level.
// Pure: candles = [[t, o, h, l, c], ...] (48 x 30 min, t in unix seconds), seed = 32-bit integer, version = the
// round's game version (L.version; the world and the score follow it; opr-1 and opr-2 share one layout; opr-3 moves
// the checkpoints to safe spots, kanban #3275).
import { T, ROWS, PW, PH, C0, TILE, GAME_VERSION, SAFE_STEPS, RUN_OUT, isSolid, rulesOf } from "./constants.js";
import { newWorld, stepWorld } from "./world.js";
import { sinRad } from "./trig.js";

// kanban #3275: what an enemy or hazard of the level can do to a runner after a respawn. Walkers, hoppers and FUD clouds
// as the box they can ever reach [x0, y0, x1, y1] in world units: a walker anywhere on its patrol span, a hopper at
// the top of its hop, a cloud over its whole drift; a printer's own body as a box. A bear and a printer's bills are
// played out step by step along the runner's path (dyn): a respawn on opr-3 puts every bear back and clears the bills
// in flight (world.js respawnNow), so the bear starts from its place and the bills from the printer - with the
// printer's cooldown at every value it can have then.
export function hazardList(L) {
  const out = [];
  for (const e of L.enemies) out.push(...hazardsOf(e));
  for (const c of L.clouds) out.push(...hazardsOf(c, true));
  return out;
}
function hazardsOf(e, cloud = false) {
  if (cloud) return [{ src: e, box: [e.x0 - 30 + 10, e.y0 - 12 + 10, e.x0 + 30 + 42, e.y0 + 12 + 24] }];
  const top = e.row * T;
  if (e.kind === "bear") return [{ src: e, dyn: "bear" }];
  if (e.kind === "printer") return [{ src: e, box: [e.x0, top - 20, e.x0 + 24, top] }, { src: e, dyn: "bills" }];
  if (e.hop) return [{ src: e, box: [e.x0, top - 20 - 46, e.x0 + 20, top] }];
  return [{ src: e, box: [e.x0 - e.span, top - 20, e.x0 + e.span + 20, top] }];
}

// the runner's boxes over SAFE_STEPS steps after a respawn at column cx on row `row` with no input and no grace, on
// the tiles alone - twice: with the level's pickups still there (the lightning makes it run faster) and with them gone
// (taken before the death); null when it is not a place to stand (a spike or a wall over it, off the plateaus) or when
// the tiles hurt or end the run in that time: a gap or notch to fall into, a rug tile under it, a spike
function respawnPaths(L, cx, row) {
  if (cx < 0 || cx >= L.w || row < 2 || row >= ROWS) return null;
  const at = (x, y) => L.t[y * L.w + x], v = at(cx, row);
  if (!(L.colMeta[cx] >= 0 ? [TILE.CG, TILE.CR, TILE.PLAT].includes(v) : cx < C0 && v === TILE.GROUND) || at(cx, row - 1) !== TILE.EMPTY || isSolid(at(cx, row - 2))) return null;
  const paths = [];
  for (const items of [L.items, []]) {
    const W = newWorld({ w: L.w, t: L.t, coins: [], enemies: [], clouds: [], items, checkpoints: [{ x: cx, row }], goal: L.goal, chartEnd: L.chartEnd, rampEnd: L.rampEnd, dayHigh: null, version: L.version, parTime: 0 });
    const p = W.p, path = []; p.x = cx * T; p.y = row * T - PH; p.hurtT = 0;
    for (let s = 0; s < SAFE_STEPS && !W.done; s++) {
      stepWorld(W, { jump: false });
      if (p.dying > 0 || W.stats.hits > 0 || p.hurtT > 0 || W.rugs.size > 0) return null;
      path.push([p.x, p.y, p.x + PW, p.y + PH]);
    }
    paths.push(path);
  }
  return paths;
}
const M = 3, MY = 1;                                                      // clearance around the runner (across, up and down), world units
const hits = (q, x0, y0, x1, y1) => q[2] + M > x0 && q[0] - M < x1 && q[3] + MY > y0 && q[1] - MY < y1;
// the same rules as world.js stepWorld for a bear and for bills, along the runner's boxes after each step
function dynTouches(L, path, h) {
  const e = h.src, R = rulesOf(L.version), solid = (cx, y) => cx < 0 || cx >= L.w ? true : y < 0 || y >= ROWS ? false : isSolid(L.t[y * L.w + cx]);
  const ramp = (px) => (1 + .5 * Math.min(1, Math.max(0, px / ((L.rampEnd || L.goal) * T)))) * R.foe;
  if (h.dyn === "bear") { let x = e.x0, charging = false; const ey = e.row * T - 22;
    for (const q of path) { const px = q[0];
      if (!charging && x - px < 210 + M && x > px - M) charging = true;
      if (charging) { const nx = x - 1.6 * ramp(px), tx = Math.floor(nx / T); if (solid(tx, e.row) && !solid(tx, e.row - 1)) x = nx; else charging = false; }
      if (hits(q, x + 6, ey + 5, x + 20, ey + 22)) return true; }
    return false; }
  if (!path.some((q) => e.x0 > q[0] && e.x0 - q[0] < 420 + M)) return false;
  const ey = e.row * T - 20;
  for (let cd0 = 0; cd0 <= Math.round(150 / R.foe) + 1; cd0++) { let cd = cd0, bills = [];
    for (const q of path) { const px = q[0]; cd--;
      if (cd <= 0 && e.x0 > px && e.x0 - px < 420) { cd = Math.round(150 / ramp(px)); bills.push({ x: e.x0 - 4, y: ey + 4, vx: -1.9 * ramp(px), t: 0 }); }
      for (const bl of bills) { bl.x += bl.vx; bl.t++; const by = bl.y + sinRad(bl.t * R.foe / 6) * 3;
        if (solid(Math.floor(bl.x / T), Math.floor((by + 4) / T)) || bl.x < px - 360) bl.gone = true;
        else if (hits(q, bl.x + 1, by, bl.x + 15, by + 8)) return true; }
      bills = bills.filter((bl) => !bl.gone); } }
  return false;
}
const touches = (L, paths, h) => paths.some((path) => (h.dyn ? dynTouches(L, path, h) : path.some((q) => hits(q, ...h.box))));

// kanban #3275: a checkpoint at column cx on row `row` is safe when the runner stands there (on a plateau or a candle,
// no spike, no wall over it), a respawn with no input and no grace lives SAFE_STEPS steps on the tiles alone (no gap,
// no notch, no rug, no spike), and its box at every one of those steps stays M units clear of every hazard (hazardList).
export function checkpointSafe(L, cx, row, hz = hazardList(L)) {
  const paths = respawnPaths(L, cx, row);
  return !!paths && !hz.some((h) => touches(L, paths, h));
}

// the surface row of a chart column (its plateau or candle top), -1 off the chart
const surfaceOf = (L, cx) => (cx >= 0 && cx < L.w && L.colMeta[cx] >= 0 ? L.meta[L.colMeta[cx]].top : -1);

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
  const L = { w: endX + 24, t: new Uint8Array((endX + 24) * ROWS), meta, segs, colMeta: new Int16Array(endX + 24).fill(-1), coins: [], enemies: [], clouds: [], items: [], checkpoints: [{ x: 3, row: 12 }], goal: endX + (R.runOut || RUN_OUT), chartEnd: endX, rampEnd: endX + RUN_OUT, dayHigh: null, seed: seed | 0, version, from: cs[0][0], to: cs[n - 1][0] };
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
  if (!R.safeCp) for (let k = 6; k < n; k += 6) { const m = meta[k]; let cx = m.x0 + 1; while ((![7, 8, 10].includes(get(cx, m.top)) || get(cx, m.top - 1) === 11) && cx < m.x0 + 3) cx++; L.checkpoints.push({ x: cx, row: m.top }); }
  for (let cx = endX; cx < L.w; cx++) { set(cx, 12, 1); set(cx, 13, 1); }
  if (!R.runOut) for (let k = 0; k < 3; k++) for (let y = 11 - k; y <= 11; y++) set(endX + 10 + k, y, 2);   // opr-4 (#3387): no wall, the flag right after the chart
  // opr-3 (kanban #3275; owner: keep the enemies): the planned column (every 6th candle, as before) moves to the nearest
  // safe column (behind it first at equal distance), at least GAP columns after the previous checkpoint and before the
  // next planned one. With no safe column in that window: the column whose tiles are safe and whose blocking hazards
  // (only those that reach its 90-step stretch, never another) can all be moved takes it, fewest such hazards first,
  // then the nearest; those hazards move. Only when no column allows that, the column with the fewest hazards that
  // cannot move takes it, the others move and those are taken out. With no column in the window whose tiles are safe,
  // the checkpoint is left out. L.moved / L.taken count the hazards moved and taken out.
  if (R.safeCp) { const plan = []; for (let k = 6; k < n; k += 6) plan.push(meta[k].x0 + 1);
    const GAP = 3, SHIFT = 18, row = (cx) => surfaceOf(L, cx), cpPaths = [respawnPaths(L, 3, 12)];
    const SHIFTS = []; for (let k = 1; k <= SHIFT; k++) SHIFTS.push(k);
    L.moved = 0; L.taken = 0;
    const standOk = (cx, r) => cx >= 0 && cx < L.w && L.colMeta[cx] >= 0 && [TILE.CG, TILE.CR, TILE.PLAT].includes(get(cx, r)) && get(cx, r - 1) === TILE.EMPTY && !isSolid(get(cx, r - 2));
    // the hazard src moved whole columns from where the level put it - forward first, 1 to SHIFT; a walker or a hopper
    // then also back - or null when no such place clears `paths` and every earlier checkpoint's stretch. An enemy
    // stands on the plateau or candle top it lands on (that row), on both its columns; it never overlaps another
    // hazard's body; a cloud stays before the flag.
    const home = new Map(), bodyOf = (e, cloud) => { const h = hazardsOf(e, cloud)[0]; return h.box || [e.x0, e.row * T - 22, e.x0 + 24, e.row * T]; };
    const shifted = (src, paths) => { const cloud = L.clouds.includes(src), h0 = home.has(src) ? home.get(src) : src.x0;
      for (const k of !cloud && !src.kind ? SHIFTS.concat(SHIFTS.map((v) => -v)) : SHIFTS) { const x0 = h0 + k * T; if (x0 === src.x0) continue;
        const e = { ...src, x0, x: cloud ? src.x : x0 }; if (e.minX !== undefined) e.minX = src.minX + (x0 - src.x0);
        if (cloud) { if (x0 > L.chartEnd * T) continue; }
        else { let ok = surfaceOf(L, Math.floor(x0 / T)) > 0; if (ok) e.row = surfaceOf(L, Math.floor(x0 / T));
          ok = ok && standOk(Math.floor(x0 / T), e.row) && standOk(Math.floor((x0 + 20) / T), e.row);
          if (!ok) continue; }
        const b = bodyOf(e, cloud);
        if ([...L.enemies, ...L.clouds].some((o) => o !== src && (() => { const c = bodyOf(o, L.clouds.includes(o)); return b[2] > c[0] && b[0] < c[2] && b[3] > c[1] && b[1] < c[3]; })())) continue;
        const hs = hazardsOf(e, cloud);
        if (hs.some((h) => touches(L, paths, h)) || cpPaths.some((ps) => ps && hs.some((h) => touches(L, ps, h)))) continue;
        if (!home.has(src)) home.set(src, src.x0);
        return e; }
      return null; };
    plan.forEach((want, j) => { const lo = L.checkpoints[L.checkpoints.length - 1].x + GAP, hi = j + 1 < plan.length ? plan[j + 1] - 1 : endX - 1;
      const hz = hazardList(L), cands = [];
      for (let d = 0; want - d >= lo || want + d <= hi; d++) for (const cx of d ? [want - d, want + d] : [want]) { if (cx < lo || cx > hi) continue;
        const paths = respawnPaths(L, cx, row(cx)); if (!paths) continue;
        cands.push({ cx, paths, hit: [...new Set(hz.filter((h) => touches(L, paths, h)).map((h) => h.src))] }); }
      if (!cands.length) return;
      const place = (c) => { L.checkpoints.push({ x: c.cx, row: row(c.cx) }); cpPaths.push(c.paths); };
      const free = cands.find((c) => !c.hit.length); if (free) return place(free);
      const byHits = [...cands].sort((a, b) => a.hit.length - b.hit.length);
      // one move changes where the next may go, so a failed set of moves is undone before the next column is tried
      const tryMove = (c, takeRest) => { const done = [], out = [];
        for (const src of c.hit) { const e = shifted(src, c.paths);
          if (e) { done.push([src, { ...src }]); Object.assign(src, e); }
          else if (takeRest) out.push(src);
          else { done.forEach(([s0, was]) => Object.assign(s0, was)); return false; } }
        L.moved += done.length; L.taken += out.length;
        L.enemies = L.enemies.filter((e) => !out.includes(e)); L.clouds = L.clouds.filter((e) => !out.includes(e)); return true; };
      for (const c of byHits) if (tryMove(c, false)) return place(c);
      // none can be cleared by moves alone: the column with the fewest hazards that cannot move, then the fewest hazards
      const stuck = (c) => { const done = []; let n = 0;
        for (const src of c.hit) { const e = shifted(src, c.paths); if (e) { done.push([src, { ...src }]); Object.assign(src, e); } else n++; }
        done.forEach(([s0, was]) => Object.assign(s0, was)); return n; };
      let best = null; for (const c of byHits) { const k = stuck(c); if (!best || k < best.k) best = { c, k }; }
      tryMove(best.c, true); place(best.c); }); }
  L.parTime = Math.round(L.goal * T / R.run / 60 * 1.6);
  return L;
}
