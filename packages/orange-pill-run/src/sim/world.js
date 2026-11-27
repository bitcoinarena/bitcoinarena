// Orange Pill Run - the world and its fixed 60-steps-per-second simulation (kanban #3246), ported from the
// prototype's makeWorld/stepWorld. The run is automatic; the only input is { jump: bool } per step.
// No DOM, no Date, no Math.random/sin/cos/hypot/sqrt/atan2: the same level and the same jump presses give the
// same world on every engine (trig.js). W.fx holds floating texts and particles for the renderer only.
import { T, ROWS, VH, STEP, GRAV, JUMP_V, CUT_V, ACC, MAXFALL, PW, PH, TIME_LIMIT, DEATH_PENALTY, RESPAWN_GRACE, C0, TILE, isSolid, COL, PW_INFO, PW_ORDER, fmtUsd, rulesOf } from "./constants.js";
import { sinRad, hypotD } from "./trig.js";

// a fresh world on its own copy of the level (the level object is never changed, so one L serves many runs)
export function newWorld(L) {
  const Lw = structuredClone(L);
  return { L: Lw, R: rulesOf(Lw.version || "opr-1"), f: 0, done: false, time: 0, penalty: 0, rugs: new Map(), rugGone: [], fx: [], bills: [], qHits: 0, qN: 0,
    p: { x: 3 * T, y: 12 * T - PH, vx: 0, vy: 0, ground: false, coyote: 0, buffer: 0, facing: 1, hurtT: 0, shield: false, boost: 0, pw: { pill: 0, diamond: 0, laser: 0, magnet: 0, moon: 0 }, cp: 0, anim: 0, prevJump: false, landT: 0, dying: 0, fell: false, why: "", cause: "", dj: false },
    stats: { coins: 0, blocks: 0, stomps: 0, hits: 0, high: false, finished: false, printers: 0, powers: 0 } };
}
export const tileAt = (W, tx, ty) => (tx < 0 || tx >= W.L.w) ? TILE.GROUND : ty >= ROWS ? TILE.EMPTY : ty < 0 ? TILE.EMPTY : W.L.t[ty * W.L.w + tx];
function respawn(W) { const p = W.p; if (p.dying > 0) return; W.stats.hits++; p.dying = 55; p.fell = p.y > VH; p.why = p.fell || p.cause === "fell" ? "you fell" : ""; p.cause = ""; p.vx = 0; p.vy = p.fell ? 0 : -6; p.boost = 0; p.shield = false; p.pw = { pill: 0, diamond: 0, laser: 0, magnet: 0, moon: 0 }; }
function respawnNow(W) { const p = W.p, c = W.L.checkpoints[p.cp]; W.rugGone.forEach((k) => { W.L.t[k] = TILE.RUG; W.rugs.delete(k); }); W.rugGone = []; p.x = c.x * T; p.y = c.row * T - PH; p.vx = 0; p.vy = 0; p.hurtT = RESPAWN_GRACE;
  // opr-3 (kanban #3275): no jump pressed before the death carries over, the bills in flight are gone and every bear
  // stands at its place again, so the stretch after the checkpoint holds only what the level puts there (level.js)
  if (W.R.safeCp) { p.buffer = 0; p.coyote = 0; p.dj = false; W.bills = []; W.L.enemies.forEach((e) => { if (e.kind === "bear" && !(e.dead === 0 || e.dead)) { e.x = e.x0; e.charging = false; } }); }
  W.penalty += DEATH_PENALTY; W.time = W.f * STEP + W.penalty; W.fx.push({ kind: "text", text: "+3 s penalty", x: p.x + 8, y: p.y - 6, t: 60, color: COL.red }); }
function givePower(W, kind, x, y) { const p = W.p, info = PW_INFO[kind]; p.pw[kind] = info.t; W.stats.powers++;
  W.fx.push({ kind: "text", text: info.text.split(" · ")[0] + "!", x, y: y - 14, t: 80, color: info.color }); W.fx.push({ kind: "ring", x: p.x + 8, y: p.y + 11, t: 24, color: info.color }); }
function killFoe(W, e, text) { e.dead = 34; W.stats.stomps++; W.fx.push({ kind: "text", text, x: e.x + 10, y: (e.y || e.row * T - 20) - 8, t: 50, color: COL.gold }); W.fx.push({ kind: "puff", x: e.x + 10, y: (e.y || e.row * T - 20) + 14, t: 18 }); }
function hurt(W) { const p = W.p; if (p.hurtT > 0 || p.pw.diamond > 0) return;
  if (p.pw.pill > 0) { p.pw.pill = 0; p.hurtT = 70; W.fx.push({ kind: "text", text: "orange pill used up", x: p.x + 8, y: p.y - 6, t: 60, color: COL.btc }); return; } if (p.shield) { p.shield = false; p.hurtT = 60; W.fx.push({ kind: "text", text: "wallet saved you", x: p.x + 8, y: p.y - 6, t: 60, color: COL.blue }); return; } respawn(W); }
const camXHint = (W) => W.p.x - 300;
// enemies get up to 50 % faster toward the goal; R.foe scales every enemy and hazard speed (kanban #3271)
// #3387: toward the place of the opr-3 flag (rampEnd) on every version, so opr-4's short run-out leaves the enemies as they were
const ramp = (W) => (1 + .5 * Math.min(1, Math.max(0, W.p.x / ((W.L.rampEnd || W.L.goal) * T)))) * W.R.foe;
const ageFx = (W) => { W.fx.forEach((e) => { e.t -= e.kind === "text" ? .4 : 1; }); W.fx = W.fx.filter((e) => e.t > 0); };

export function stepWorld(W, inp) {
  if (W.done) return;
  const jump = !!(inp && inp.jump);
  const p = W.p, L = W.L; W.f++; W.time = W.f * STEP + W.penalty;
  if (p.dying > 0) { p.dying--; if (!p.fell) { p.vy = Math.min(MAXFALL, p.vy + GRAV * .7); p.y += p.vy; } ageFx(W); if (p.dying === 0) respawnNow(W); if (W.time >= TIME_LIMIT) W.done = true; return; }
  const R = W.R, max = p.boost > 0 ? R.boost : R.run; if (p.boost > 0) p.boost--;
  for (const k of PW_ORDER) if (p.pw[k] > 0 && --p.pw[k] === 0 && k !== "pill") W.fx.push({ kind: "text", text: PW_INFO[k].text.split(" · ")[0].toLowerCase() + " over", x: p.x + 8, y: p.y - 10, t: 50, color: COL.text });
  p.vx = Math.min(max, p.vx + ACC); p.facing = 1;                                           // the run is automatic
  if (jump && !p.prevJump) p.buffer = 9; else if (p.buffer > 0) p.buffer--;
  p.coyote = p.ground ? 8 : Math.max(0, p.coyote - 1);
  if (p.ground) p.dj = false;
  if (p.buffer > 0 && p.coyote > 0) { p.vy = JUMP_V * (p.pw.moon > 0 ? 1.18 : 1); p.buffer = 0; p.coyote = 0; p.ground = false; if (R.minJ) p.jt = R.minJ; W.fx.push({ kind: "dust", x: p.x + 8, y: p.y + PH, t: 14 }); }
  else if (p.buffer > 0 && p.pw.moon > 0 && !p.dj && !p.ground) { p.vy = JUMP_V * 1.05; p.buffer = 0; p.dj = true; if (R.minJ) p.jt = R.minJ; W.fx.push({ kind: "ring", x: p.x + 8, y: p.y + PH, t: 18, color: "#ffe9a8" }); }
  // opr-6 (kanban #3718): a jump rises at least R.minJ steps before a let-go cuts it, so a short click (60-120 ms) clears the
  // first candle as a finger's tap does; a longer hold jumps higher as before
  if (p.jt > 0) p.jt--; else if (!jump && p.vy < CUT_V) p.vy = CUT_V;
  p.prevJump = jump; p.vy = Math.min(MAXFALL, p.vy + GRAV);
  p.x += p.vx; if (p.x < 0) { p.x = 0; p.vx = 0; }
  for (let ty = Math.floor(p.y / T); ty <= Math.floor((p.y + PH - 1) / T); ty++) {
    if (p.vx > 0) { const tx = Math.floor((p.x + PW) / T); if (isSolid(tileAt(W, tx, ty))) {
        if (!isSolid(tileAt(W, tx, ty - 1)) && p.y + PH - ty * T <= 8) { p.y = ty * T - PH; continue; }
        p.x = tx * T - PW; p.vx = 0; } }
    else if (p.vx < 0) { const tx = Math.floor(p.x / T); if (isSolid(tileAt(W, tx, ty))) { p.x = (tx + 1) * T; p.vx = 0; } }
  }
  const prevBottom = p.y + PH, wasGround = p.ground; p.y += p.vy; p.ground = false;
  const x0 = Math.floor((p.x + 1) / T), x1 = Math.floor((p.x + PW - 2) / T);
  if (p.vy > 0) {
    const ty = Math.floor((p.y + PH) / T);
    for (let tx = x0; tx <= x1; tx++) { const v = tileAt(W, tx, ty);
      if (isSolid(v) || (v === TILE.ONEWAY && prevBottom <= ty * T + 1)) { p.y = ty * T - PH; p.vy = 0; p.ground = true; if (v === TILE.RUG && !W.rugs.has(ty * L.w + tx)) W.rugs.set(ty * L.w + tx, 26); } }
    if (p.ground && !wasGround) W.fx.push({ kind: "dust", x: p.x + 8, y: p.y + PH, t: 12 });
    if (p.ground) { const ty2 = Math.floor((p.y + PH + 1) / T), mid = Math.floor((p.x + PW / 2) / T), under = tileAt(W, mid, ty2), inChart = mid >= C0 && mid < (L.chartEnd != null ? L.chartEnd : L.goal - 18);
      if (under === TILE.FILL || (under === TILE.GROUND && inChart)) { p.cause = "fell"; respawn(W); return; } }
  } else if (p.vy < 0) {
    const ty = Math.floor(p.y / T);
    for (let tx = x0; tx <= x1; tx++) { const v = tileAt(W, tx, ty);
      if (isSolid(v)) { p.y = (ty + 1) * T; p.vy = 0;
        if (v === TILE.QBLOCK) { L.t[ty * L.w + tx] = TILE.USED; W.stats.blocks++; W.qHits++; if (W.qHits % 2 === 1) { const kind = PW_ORDER[(++W.qN) % PW_ORDER.length]; L.items.push({ kind, x: tx * T + 12, y: ty * T - 6, got: false, rise: 22 }); } W.fx.push({ kind: "text", text: "+5 sats", x: tx * T + 12, y: ty * T - 8, t: 50, color: COL.gold }); W.fx.push({ kind: "pop", x: tx * T + 12, y: ty * T - 6, t: 30 }); W.fx.push({ kind: "bump", tx, ty, t: 8 }); }
        break; } }
  }
  W.rugs.forEach((t, k) => { if (t > 0) { W.rugs.set(k, t - 1); if (t === 1) { L.t[k] = TILE.EMPTY; W.rugGone.push(k); W.fx.push({ kind: "text", text: "rug pulled", x: (k % L.w) * T + 12, y: Math.floor(k / L.w) * T, t: 50, color: COL.red }); } } });
  if (p.y > VH + 40) respawn(W);
  for (let ty = Math.floor(p.y / T); ty <= Math.floor((p.y + PH - 1) / T); ty++) for (let tx = Math.floor((p.x + 3) / T); tx <= Math.floor((p.x + PW - 3) / T); tx++) if (tileAt(W, tx, ty) === TILE.SPIKE && p.y + PH > ty * T + 14 && p.x + PW > tx * T + 5 && p.x < tx * T + T - 5) hurt(W);
  L.checkpoints.forEach((c, i) => { if (i > p.cp && p.x >= c.x * T) { p.cp = i; W.fx.push({ kind: "text", text: "checkpoint", x: c.x * T + 12, y: c.row * T - 40, t: 60, color: COL.green }); } });
  const cx = p.x + PW / 2, cy = p.y + PH / 2;
  L.coins.forEach((c) => { if (!c.got && Math.abs(c.x - cx) < 14 && Math.abs(c.y - cy) < 18) { c.got = true; W.stats.coins++; W.fx.push({ kind: "spark", x: c.x, y: c.y, t: 16 }); } });
  L.items.forEach((it) => { if (it.got) return;
    if (it.rise !== undefined) { if (it.rise > 0) { it.rise--; it.y -= 1.4; } else { const dx = cx - it.x, dy = cy - 10 - it.y, d = hypotD(dx, dy) || 1, sp = Math.min(d, 6 + Math.abs(p.vx)); it.x += dx / d * sp; it.y += dy / d * sp; } }
    if (Math.abs(it.x - cx) > 16 || Math.abs(it.y + 10 - cy) > 22) return; it.got = true;
    if (PW_INFO[it.kind]) givePower(W, it.kind, it.x, it.y);
    else if (it.kind === "bolt") { p.boost = 300; W.fx.push({ kind: "text", text: "Lightning! 5 s sprint", x: it.x, y: it.y - 14, t: 70, color: COL.gold }); }
    else { p.shield = true; W.fx.push({ kind: "text", text: "Hardware wallet: 1 free hit", x: it.x, y: it.y - 14, t: 70, color: COL.blue }); } });
  const hd = L.dayHigh; if (hd && !hd.got && Math.abs(hd.x - cx) < 16 && Math.abs(hd.y - cy) < 22) { hd.got = true; W.stats.high = true; W.fx.push({ kind: "text", text: "DAY HIGH " + fmtUsd(hd.price) + "  +50", x: hd.x, y: hd.y - 16, t: 100, color: COL.gold }); W.fx.push({ kind: "pop", x: hd.x, y: hd.y, t: 30 }); }
  if (p.pw.magnet > 0) L.coins.forEach((c) => { if (c.got) return; const dx = cx - c.x, dy = cy - c.y, d = hypotD(dx, dy); if (d < 150 && d > 0) { const sp = Math.min(d, 7); c.x += dx / d * sp; c.y += dy / d * sp; } });
  if (p.pw.diamond > 0) { L.enemies.forEach((e) => { if (e.dead === 0 || e.dead || e.y === undefined) return; if (p.x + PW > e.x - 2 && p.x < e.x + 24 && p.y + PH > e.y - 2 && p.y < e.y + 24) killFoe(W, e, "+10 diamond hands"); });
    W.bills.forEach((bl) => { if (Math.abs(bl.x - p.x) < 22 && Math.abs(bl.y - p.y - 8) < 22) bl.gone = true; }); }
  if (p.pw.laser > 0 && W.f % 26 === 0) { const ey = p.y + 4; let hit = null, hx = p.x + 16 + 300;
    L.enemies.forEach((e) => { if (e.dead === 0 || e.dead || e.y === undefined) return; if (e.x > p.x + 4 && e.x < hx && Math.abs(e.y + 10 - ey) < 30) { hit = e; hx = e.x; } });
    for (let x = p.x + 20; x < hx; x += 12) if (isSolid(tileAt(W, Math.floor(x / T), Math.floor(ey / T)))) { hx = x; hit = null; break; }
    W.bills.forEach((bl) => { if (bl.x > p.x && bl.x < hx && Math.abs(bl.y - ey) < 24) bl.gone = true; });
    if (hit) killFoe(W, hit, "+10 laser eyes");
    W.fx.push({ kind: "laser", x1: p.x + 12, y1: ey, x2: hx + (hit ? 10 : 0), y2: hit ? hit.y + 10 : ey, t: 10 }); }
  L.enemies.forEach((e) => {
    if (e.dead === 0) return; if (e.dead) { e.dead--; return; }
    if (e.kind === "bear") {
      const ey = e.row * T - 22; e.y = ey;
      if (!e.charging && e.x - p.x < 210 && e.x > p.x) { e.charging = true; W.fx.push({ kind: "text", text: "ROAR", x: e.x + 12, y: ey - 10, t: 40, color: COL.red }); }
      if (e.charging) { const nx = e.x - 1.6 * ramp(W), tx = Math.floor(nx / T); if (isSolid(tileAt(W, tx, e.row)) && !isSolid(tileAt(W, tx, e.row - 1))) e.x = nx; else e.charging = false; if (W.f % 6 === 0) W.fx.push({ kind: "dust", x: e.x + 20, y: e.row * T, t: 14 }); }
      if (p.x + PW > e.x + 6 && p.x < e.x + 20 && p.y + PH > ey + 5 && p.y < ey + 22) {
        if (p.vy > 0.5 && prevBottom <= ey + 12) { e.dead = 34; p.vy = -7; W.stats.stomps += 2; W.fx.push({ kind: "text", text: "+20 bear stomped", x: e.x + 12, y: ey - 8, t: 50, color: COL.gold }); W.fx.push({ kind: "puff", x: e.x + 12, y: ey + 14, t: 18 }); }
        else hurt(W);
      }
      return;
    }
    if (e.kind === "printer") {
      const ey = e.row * T - 20; e.y = ey; e.cd--;
      if (e.cd <= 0 && e.x > p.x && e.x - p.x < 420) { e.cd = Math.round(150 / ramp(W)); e.flash = 16; W.bills.push({ x: e.x - 4, y: ey + 4, vx: -1.9 * ramp(W), t: 0 }); }
      if (e.flash > 0) e.flash--;
      if (p.x + PW > e.x + 1 && p.x < e.x + 23 && p.y + PH > ey + 2 && p.y < ey + 20) {
        if (p.vy > 0.5 && prevBottom <= ey + 11) { e.dead = 34; p.vy = -6.5; W.stats.stomps += 1; W.stats.printers++; W.fx.push({ kind: "text", text: "+15 printer off", x: e.x + 12, y: ey - 8, t: 50, color: COL.gold }); W.fx.push({ kind: "puff", x: e.x + 12, y: ey + 14, t: 18 }); }
        else hurt(W);
      }
      return;
    }
    let ey = e.row * T - 20;
    if (e.hop) { const ph = (W.f + e.x0 * 3) % R.hopP; ey -= ph < R.hopUp ? sinRad(ph / R.hopUp * Math.PI) * 46 : 0; }
    else { const nx = e.x + e.dir * 0.65 * ramp(W), tx = Math.floor((e.dir > 0 ? nx + 20 : nx) / T);
      if (!isSolid(tileAt(W, tx, e.row)) || isSolid(tileAt(W, tx, e.row - 1)) || Math.abs(nx - e.x0) > e.span) e.dir *= -1; else e.x = nx; }
    e.y = ey;
    if (p.x + PW > e.x + 4 && p.x < e.x + 16 && p.y + PH > ey + 3 && p.y < ey + 20) {
      if (p.vy > 0.5 && prevBottom <= ey + 11) { e.dead = 34; p.vy = -6.5; W.stats.stomps++; W.fx.push({ kind: "text", text: "+10 stomp", x: e.x + 10, y: ey - 8, t: 50, color: COL.gold }); W.fx.push({ kind: "puff", x: e.x + 10, y: ey + 14, t: 18 }); }
      else hurt(W);
    }
  });
  W.bills.forEach((bl) => { bl.x += bl.vx; bl.t++; const by = bl.y + sinRad(bl.t * R.foe / 6) * 3; bl.by = by;
    if (isSolid(tileAt(W, Math.floor(bl.x / T), Math.floor((by + 4) / T))) || bl.x < camXHint(W) - 60) bl.gone = true;
    else if (p.x + PW > bl.x + 1 && p.x < bl.x + 15 && p.y + PH > by && p.y < by + 8) { bl.gone = true; hurt(W); } });
  W.bills = W.bills.filter((bl) => !bl.gone);
  L.clouds.forEach((c) => { c.x = c.x0 + sinRad(W.f * R.foe / 65) * 30; c.y = c.y0 + sinRad(W.f * R.foe / 42) * 12;
    if (p.x + PW > c.x + 10 && p.x < c.x + 42 && p.y + PH > c.y + 10 && p.y < c.y + 24) hurt(W); });
  if (p.hurtT > 0) p.hurtT--;
  p.anim += Math.abs(p.vx) * 0.09;
  ageFx(W);
  if (p.x >= L.goal * T) { W.done = true; W.stats.finished = true; } else if (W.time >= TIME_LIMIT) W.done = true;
}
