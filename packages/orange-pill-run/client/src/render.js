// Orange Pill Run - the renderer (kanban #3246), moved unchanged from the prototype
// (marketing/print/game-mockups/orange-pill-run.html). It only reads the world; drawing may use Math.sin etc.
import { T, ROWS, VH, PH, TILE, isSolid, PW_INFO, PW_ORDER } from "../../src/sim/constants.js";
import { tileAt } from "../../src/sim/world.js";
import { scoreOf } from "../../src/sim/score.js";

const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const COL = { text: css("--text") || "#f6ece4", soft: css("--soft") || "#c8bab2", dim: css("--dim") || "#8c8086", btc: css("--btc") || "#f7931a", gold: css("--gold") || "#ffd166", blue: css("--blue") || "#58a6ff", green: css("--green") || "#3fb950", red: css("--red") || "#f85149" };
const FONT = css("--display") || "system-ui, sans-serif";
const usd = (v) => "$" + Math.round(v).toLocaleString("en-US");
const hhmm = (t) => new Date(t * 1000).toISOString().slice(11, 16);

// ---------- rendering: smooth, lit, high resolution ----------
// Everything is drawn in world units through one transform, at the screen's full resolution. Light comes from
// the moon (upper right) and from glowing objects; gradients give volume, soft shadows and glows give depth.
const cv = document.getElementById("cv"), ctx = cv.getContext("2d");
let cssW = 800, cssH = 450, dpr = 1, zoom = 1, viewW = 600, viewH = 336, camX = 0, camY = 0, R = 1;
// kanban #3270: the HUD (stat pills, price line, mini chart) and the entry pill sit over the top of the canvas. The play band is
// the canvas below them; zoom and the vertical camera are taken from that band, never from the whole canvas height.
let hudTop = 0, hudTopPill = 0, camW = null;
const PAD = 10, PILL_H = 26;
const OUT = "rgba(20,10,8,.55)";
const mk = (w, h) => { const c = document.createElement("canvas"); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; };
const hash = (a, c) => { let h = (a * 374761393 + c * 668265263) | 0; h = (h ^ (h >>> 13)) * 1274126177; return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
let ASSET = {};
function fit() {
  const st = document.getElementById("stage"); cssW = Math.max(240, st.clientWidth); cssH = Math.max(180, st.clientHeight);
  dpr = window.devicePixelRatio || 1; cv.width = Math.round(cssW * dpr); cv.height = Math.round(cssH * dpr); cv.style.width = cssW + "px"; cv.style.height = cssH + "px";
  // the HUD's rows as drawHud lays them out: narrow = three rows (stats, price, mini chart), wide = one row beside the mini chart
  // between 600 and 900 px (a phone held sideways) the stats and the price fill the first row; the mini chart goes on the second, lower
  const small = cssW < 600, mid = !small && cssW < 900, h = (small ? 15 : 18) + 14, mh = mid ? 40 : 58;
  const hudBottom = small ? PAD + h + 6 + h + 6 + mh : mid ? PAD + h + 6 + mh : PAD + Math.max(h, mh);
  const pillY = small ? hudBottom + 6 : PAD + h + 6;     // the entry pill: under the mini chart (narrow), under the stat pills (wide)
  hudTop = hudBottom + 6; hudTopPill = Math.max(hudTop, pillY + PILL_H + 6);
  const pl = document.getElementById("pill");
  if (pl) Object.assign(pl.style, small ? { top: pillY + "px", left: "50%", transform: "translateX(-50%)", maxWidth: (cssW - 2 * PAD) + "px" }
    : { top: pillY + "px", left: PAD + "px", transform: "none", maxWidth: (mid ? cssW - Math.min(360, cssW * .5) - 4 * PAD : Math.max(160, cssW - 440 - 2 * PAD)) + "px" });
  // zoom from the play band: about 62 % of the world's height in the band, and at most 15 columns across a phone (25 on a wide screen)
  const band = Math.max(120, cssH - hudTop);
  zoom = Math.max(.85, Math.min(band / (VH * 0.62), cssW / ((small ? 15 : 25) * T)));
  viewW = cssW / zoom; viewH = cssH / zoom; R = dpr * zoom; camW = null;
  buildAssets();
}
// ---- pre-rendered textures and backdrops, rebuilt on resize at the screen's resolution ----
function buildAssets() {
  ASSET = {};
  // dirt pattern
  const dirt = mk(96 * R, 96 * R), g = dirt.getContext("2d"); g.scale(R, R);
  const dg = g.createLinearGradient(0, 0, 0, 96); dg.addColorStop(0, "#4a2c22"); dg.addColorStop(1, "#2e1913"); g.fillStyle = dg; g.fillRect(0, 0, 96, 96);
  for (let i = 0; i < 140; i++) { const x = hash(i, 1) * 96, y = hash(i, 2) * 96, r = .6 + hash(i, 3) * 2.2; g.fillStyle = hash(i, 4) > .5 ? "rgba(120,80,56,.55)" : "rgba(10,4,2,.35)"; g.beginPath(); g.ellipse(x, y, r * 1.4, r, hash(i, 5) * 3, 0, 7); g.fill(); }
  for (let i = 0; i < 8; i++) { const x = hash(i, 9) * 96, y = hash(i, 8) * 96; const sg = g.createRadialGradient(x - 1, y - 1, 0, x, y, 4); sg.addColorStop(0, "#9a7a62"); sg.addColorStop(1, "#4a3024"); g.fillStyle = sg; g.beginPath(); g.ellipse(x, y, 4, 3, 0, 0, 7); g.fill(); }
  ASSET.dirt = ctx.createPattern(dirt, "repeat");
  // bricks pattern (48 x 48)
  const br = mk(48 * R, 48 * R), b = br.getContext("2d"); b.scale(R, R); b.fillStyle = "#2a1612"; b.fillRect(0, 0, 48, 48);
  for (let r = 0; r < 4; r++) for (let c = -1; c < 3; c++) { const x = c * 24 + (r % 2 ? 12 : 0) + 1, y = r * 12 + 1, w = 22, h = 10;
    const bg2 = b.createLinearGradient(0, y, 0, y + h); const base = hash(r * 7 + c, 3) * 20; bg2.addColorStop(0, `rgb(${190 + base},${100 + base / 2},${62})`); bg2.addColorStop(1, `rgb(${120 + base},${54},${34})`);
    b.fillStyle = bg2; b.beginPath(); b.roundRect ? b.roundRect(x, y, w, h, 1.5) : b.rect(x, y, w, h); b.fill(); b.fillStyle = "rgba(255,230,200,.18)"; b.fillRect(x + 1, y + 1, w - 2, 1.2); }
  ASSET.brick = ctx.createPattern(br, "repeat");
  // soft clouds
  ASSET.clouds = [0, 1, 2].map((k) => { const w = 260, h = 90, c = mk(w * R, h * R), cg = c.getContext("2d"); cg.scale(R, R); cg.filter = "blur(" + 7 + "px)";
    for (let i = 0; i < 9; i++) { const x = 30 + hash(k, i) * 200, y = 40 + (hash(i, k) - .5) * 26, r = 18 + hash(k + 3, i) * 26; const gg = cg.createRadialGradient(x, y - r * .3, 2, x, y, r); gg.addColorStop(0, "rgba(255,200,170,.22)"); gg.addColorStop(1, "rgba(120,70,110,0)"); cg.fillStyle = gg; cg.beginPath(); cg.arc(x, y, r, 0, 7); cg.fill(); }
    return c; });
  // skyline strip (repeats)
  const SW = 1400, SH = 260, sk = mk(SW * R, SH * R), s = sk.getContext("2d"); s.scale(R, R);
  for (let i = 0; i < 46; i++) { const w = 22 + hash(i, 1) * 34, x = (i * 31 + hash(i, 2) * 12) % SW, h = 60 + hash(i, 3) * 150, y = SH - h;
    const bgr = s.createLinearGradient(x, 0, x + w, 0); bgr.addColorStop(0, "#1d1026"); bgr.addColorStop(1, "#140a1b"); s.fillStyle = bgr; s.fillRect(x, y, w, h);
    s.fillStyle = "rgba(255,190,120,.07)"; s.fillRect(x, y, 2, h);
    for (let r = y + 6; r < SH - 6; r += 8) for (let c = x + 4; c < x + w - 4; c += 6) { const v = hash(i * 131 + r, c); if (v > .78) { s.fillStyle = v > .95 ? "rgba(247,147,26,.85)" : "rgba(255,214,160,.38)"; s.fillRect(c, r, 3, 4); } }
    if (i % 13 === 4) { s.save(); s.shadowColor = "#f7931a"; s.shadowBlur = 14; s.fillStyle = "#f7931a"; s.beginPath(); s.arc(x + w / 2, y - 16, 9, 0, 7); s.fill(); s.restore(); s.fillStyle = "#2a1408"; s.font = "700 12px " + FONT; s.textAlign = "center"; s.textBaseline = "middle"; s.fillText("₿", x + w / 2, y - 15); s.fillStyle = "#2a1a30"; s.fillRect(x + w / 2 - 1, y - 8, 2, 8); } }
  ASSET.skyline = sk; ASSET.skylineW = SW; ASSET.skylineH = SH;
}
const W2S = () => ctx.setTransform(R, 0, 0, R, -camX * R, -camY * R);
const SCR = () => ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
function rr(x, y, w, h, r) { ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h); }
function glow(color, blur, fn) { ctx.save(); ctx.shadowColor = color; ctx.shadowBlur = blur * R; fn(); ctx.restore(); }

// ---- backdrop ----
const STARS = Array.from({ length: 160 }, (_, i) => [hash(i, 1), hash(i, 2), hash(i, 3)]);
let L0 = null;
function drawBackdrop(f) {
  SCR(); const sky = ctx.createLinearGradient(0, 0, 0, cssH);
  sky.addColorStop(0, "#0a0716"); sky.addColorStop(.45, "#1d1032"); sky.addColorStop(.75, "#4a1d3a"); sky.addColorStop(.92, "#8a3a26"); sky.addColorStop(1, "#b5561a");
  ctx.fillStyle = sky; ctx.fillRect(0, 0, cssW, cssH);
  STARS.forEach(([a, b2, k]) => { const x = ((a * cssW * 1.6 - camX * zoom * .02) % cssW + cssW) % cssW, y = b2 * cssH * .55; ctx.globalAlpha = .25 + .6 * Math.abs(Math.sin(f / 50 + k * 30)); ctx.fillStyle = "#fff6e0"; ctx.fillRect(x, y, k > .85 ? 2 : 1.2, k > .85 ? 2 : 1.2); });
  ctx.globalAlpha = 1;
  // moon
  const mx = cssW * .8 - camX * zoom * .01, my = cssH * .16, mr = Math.min(cssW, cssH) * .07;
  const halo = ctx.createRadialGradient(mx, my, mr * .8, mx, my, mr * 4); halo.addColorStop(0, "rgba(255,215,150,.35)"); halo.addColorStop(1, "rgba(255,215,150,0)"); ctx.fillStyle = halo; ctx.fillRect(mx - mr * 4, my - mr * 4, mr * 8, mr * 8);
  const mg = ctx.createRadialGradient(mx - mr * .35, my - mr * .35, mr * .1, mx, my, mr); mg.addColorStop(0, "#fff8e6"); mg.addColorStop(.7, "#f4dca8"); mg.addColorStop(1, "#d8b478"); ctx.fillStyle = mg; ctx.beginPath(); ctx.arc(mx, my, mr, 0, 7); ctx.fill();
  [[-.3, .2, .18], [.35, -.25, .12], [.15, .4, .1]].forEach(([dx, dy, r]) => { ctx.fillStyle = "rgba(180,140,90,.25)"; ctx.beginPath(); ctx.arc(mx + dx * mr, my + dy * mr, r * mr, 0, 7); ctx.fill(); });
  ctx.globalAlpha = .18; ctx.fillStyle = "#a06a2a"; ctx.font = "700 " + Math.round(mr * 1.1) + "px " + FONT; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText("₿", mx + mr * .05, my + mr * .05); ctx.globalAlpha = 1;
  // drifting clouds
  ASSET.clouds.forEach((c, i) => { const w = c.width / dpr, h = c.height / dpr, x = ((i * 420 - camX * zoom * .08 - f * .15 * (i + 1)) % (cssW + w) + cssW + w) % (cssW + w) - w, y = cssH * (.12 + i * .1); ctx.drawImage(c, x, y, w, h); });
  // the day's chart across the sky: faint glowing candles
  if (L0) { const m = L0.meta, hi = Math.max(...m.map((c) => c.h)), lo = Math.min(...m.map((c) => c.l)), span = cssW * 1.5, x0 = cssW * .04 - camX * zoom * .05, top = cssH * .2, h = cssH * .24, cw = span / m.length;
    const py = (pp) => top + (hi - pp) / (hi - lo || 1) * h;
    ctx.save(); m.forEach((c, i) => { const x = x0 + i * cw; if (x < -10 || x > cssW + 10) return; const col = c.green ? "rgba(86,211,100," : "rgba(255,123,114,";
      ctx.fillStyle = col + ".16)"; ctx.fillRect(x + cw * .45, py(c.h), Math.max(1, cw * .1), Math.max(1, py(c.l) - py(c.h)));
      ctx.shadowColor = c.green ? "#3fb950" : "#f85149"; ctx.shadowBlur = 5; ctx.fillStyle = col + ".22)"; ctx.fillRect(x + cw * .2, py(Math.max(c.o, c.c)), cw * .6, Math.max(1.5, py(Math.min(c.o, c.c)) - py(Math.max(c.o, c.c)))); ctx.shadowBlur = 0; }); ctx.restore(); }
  // mountains with haze
  const base = (VH - camY) * zoom;
  [[.12, "#2a1734", 110, 46], [.22, "#21122a", 80, 34]].forEach(([par, col, hgt, amp]) => { ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(0, cssH);
    for (let x = 0; x <= cssW + 20; x += 16) { const wx = (x / zoom + camX * par); ctx.lineTo(x, base - (hgt + amp * Math.sin(wx / 140) + amp * .5 * Math.sin(wx / 53)) * zoom); } ctx.lineTo(cssW, cssH); ctx.fill(); });
  // skyline
  const sw = ASSET.skylineW * zoom, sh = ASSET.skylineH * zoom, off = ((camX * zoom * .35) % sw + sw) % sw;
  for (let x = -off; x < cssW; x += sw) ctx.drawImage(ASSET.skyline, x, base - sh - 44 * zoom, sw, sh);
  // near hills and haze
  ctx.fillStyle = "#150a10"; ctx.beginPath(); ctx.moveTo(0, cssH); for (let x = 0; x <= cssW + 20; x += 12) { const wx = x / zoom + camX * .6; ctx.lineTo(x, base - (28 + 10 * Math.sin(wx / 70) + 5 * Math.sin(wx / 23)) * zoom); } ctx.lineTo(cssW, cssH); ctx.fill();
  const hz = ctx.createLinearGradient(0, base - 140 * zoom, 0, base); hz.addColorStop(0, "rgba(181,86,26,0)"); hz.addColorStop(1, "rgba(181,86,26,.18)"); ctx.fillStyle = hz; ctx.fillRect(0, base - 140 * zoom, cssW, 140 * zoom);
}

// ---- terrain ----
function drawCandle(m, f) {
  const x = m.x0 * T, w = 3 * T, top = m.top * T, bodyB = (m.bottom + 1) * T, bot = 12 * T, g = m.green;
  const c1 = g ? ["#0f4a22", "#2ea043", "#5fe07a", "#1a7f37", "#0b3518"] : ["#5a1214", "#c8302e", "#ff7f78", "#a12a28", "#3e0c0e"];
  // stem below the body
  let sg = ctx.createLinearGradient(x, 0, x + w, 0); sg.addColorStop(0, g ? "#0c2814" : "#2a0c0d"); sg.addColorStop(.35, g ? "#1d4a2a" : "#4d1a1c"); sg.addColorStop(1, g ? "#081a0d" : "#1c0809");
  ctx.fillStyle = sg; ctx.fillRect(x + 2, bodyB, w - 4, bot - bodyB);
  ctx.fillStyle = "rgba(255,255,255,.04)"; for (let y = bodyB + 8; y < bot; y += 16) ctx.fillRect(x + 2, y, w - 4, 1);
  // glossy body
  const bg = ctx.createLinearGradient(x, 0, x + w, 0); bg.addColorStop(0, c1[0]); bg.addColorStop(.18, c1[1]); bg.addColorStop(.34, c1[2]); bg.addColorStop(.55, c1[1]); bg.addColorStop(.85, c1[3]); bg.addColorStop(1, c1[4]);
  glow(g ? "rgba(63,185,80,.45)" : "rgba(248,81,73,.45)", 16, () => { rr(x + 1, top, w - 2, bodyB - top, 5); ctx.fillStyle = bg; ctx.fill(); });
  const vg = ctx.createLinearGradient(0, top, 0, bodyB); vg.addColorStop(0, "rgba(255,255,255,.25)"); vg.addColorStop(.25, "rgba(255,255,255,0)"); vg.addColorStop(1, "rgba(0,0,0,.25)");
  rr(x + 1, top, w - 2, bodyB - top, 5); ctx.fillStyle = vg; ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,.35)"; rr(x + w * .22, top + 4, 4, Math.max(4, bodyB - top - 10), 2); ctx.fill();
  ctx.fillStyle = g ? "#a8ffb8" : "#ffc2bd"; rr(x + 3, top, w - 6, 3, 1.5); ctx.fill();
  // wick: a glowing filament
  if (m.wick < m.top) glow(g ? "#56d364" : "#ff7b72", 10, () => { ctx.strokeStyle = g ? "#b6ffc4" : "#ffd0cc"; ctx.lineWidth = 2.4; ctx.lineCap = "round"; ctx.beginPath(); ctx.moveTo(x + w / 2, m.wick * T + 6); ctx.lineTo(x + w / 2, top); ctx.stroke(); });
}
function drawPlateau(x0, x1, top, L) {     // columns x0..x1 inclusive, a polished stone shelf with faint candles on its face
  const x = x0 * T, w = (x1 - x0 + 1) * T, y = top * T, bot = 12 * T;
  const fg = ctx.createLinearGradient(0, y, 0, bot); fg.addColorStop(0, "#3a2c4a"); fg.addColorStop(.15, "#2a2036"); fg.addColorStop(1, "#160f1e"); ctx.fillStyle = fg; ctx.fillRect(x, y, w, bot - y);
  ctx.fillStyle = "rgba(255,255,255,.035)"; for (let yy = y + 20; yy < bot; yy += 22) ctx.fillRect(x, yy, w, 1);
  for (let cx = x0; cx <= x1; cx++) { const mi = L.colMeta[cx]; if (mi < 0) continue; const m = L.meta[mi]; if (cx - m.x0 !== 1) continue;
    const c = m.green ? "#3fb950" : "#f85149", hgt = Math.max(4, Math.min(16, Math.abs(m.move) * 5200)), mx = cx * T + T / 2;
    ctx.globalAlpha = .45; glow(c, 8, () => { ctx.fillStyle = c; rr(mx - 6, y + 10, 12, hgt, 2); ctx.fill(); ctx.fillRect(mx - 1, y + 6, 2, hgt + 8); }); ctx.globalAlpha = 1; }
  const tg = ctx.createLinearGradient(0, y - 2, 0, y + 8); tg.addColorStop(0, "#efe4ff"); tg.addColorStop(.35, "#b9a6d0"); tg.addColorStop(1, "#5e4c74"); ctx.fillStyle = tg; ctx.fillRect(x, y, w, 7);
  ctx.fillStyle = "rgba(255,255,255,.55)"; ctx.fillRect(x, y, w, 1.2);
}
function drawGround(x0, x1, y, L) {
  const x = x0 * T, w = (x1 - x0 + 1) * T, top = y * T;
  ctx.save(); ctx.translate(0, 0); ctx.fillStyle = ASSET.dirt; ctx.fillRect(x, top, w, ROWS * T - top); ctx.restore();
  const lg = ctx.createLinearGradient(0, top - 2, 0, top + 10); lg.addColorStop(0, "#ffd58a"); lg.addColorStop(.35, "#f7931a"); lg.addColorStop(1, "rgba(150,70,10,0)");
  glow("rgba(247,147,26,.6)", 10, () => { ctx.fillStyle = lg; ctx.fillRect(x, top, w, 10); });
}
function drawTerrain(W, f) {
  const L = W.L, a = Math.max(0, Math.floor(camX / T) - 2), e = Math.min(L.w - 1, Math.ceil((camX + viewW) / T) + 2);
  // notches and pits first (recessed)
  for (let tx = a; tx <= e; tx++) for (let ty = 0; ty < ROWS; ty++) if (L.t[ty * L.w + tx] === TILE.FILL) { const yy = ty * T; const ng = ctx.createLinearGradient(tx * T, 0, tx * T + T, 0); ng.addColorStop(0, "#0d0812"); ng.addColorStop(.5, "#1c1426"); ng.addColorStop(1, "#0d0812"); ctx.fillStyle = ng; ctx.fillRect(tx * T, yy, T, T); }
  // ground runs on rows 12-13 where the surface is exposed
  let run = -1; for (let tx = a; tx <= e + 1; tx++) { const exposed = tx <= e && L.t[12 * L.w + tx] === TILE.GROUND && !isSolid(tileAt(W, tx, 11)); if (exposed && run < 0) run = tx; if (!exposed && run >= 0) { drawGround(run, tx - 1, 12, L); run = -1; } }
  for (let tx = a; tx <= e; tx++) if (L.t[12 * L.w + tx] === TILE.GROUND && isSolid(tileAt(W, tx, 11))) { ctx.fillStyle = ASSET.dirt; ctx.fillRect(tx * T, 12 * T, T, 2 * T); }
  // plateaus as continuous shelves
  for (let tx = a; tx <= e; tx++) { const mi = L.colMeta[tx]; if (mi < 0) continue; const m = L.meta[mi]; if (L.t[m.top * L.w + tx] !== TILE.PLAT) continue; if (tx > a && L.colMeta[tx - 1] >= 0 && L.meta[L.colMeta[tx - 1]].top === m.top && L.t[m.top * L.w + tx - 1] === TILE.PLAT) continue;
    let tx2 = tx; while (tx2 + 1 <= L.w - 1 && L.colMeta[tx2 + 1] >= 0 && L.meta[L.colMeta[tx2 + 1]].top === m.top && L.t[m.top * L.w + tx2 + 1] === TILE.PLAT) tx2++; drawPlateau(tx, tx2, m.top, L); }
  // real candles
  L.meta.forEach((m) => { if (m.real && m.x0 * T < camX + viewW + 80 && (m.x0 + 3) * T > camX - 80) drawCandle(m, f); });
  // blocks, bricks, planks, rugs, spikes
  const bumped = new Map(); W.fx.forEach((x) => { if (x.kind === "bump") bumped.set(x.ty * L.w + x.tx, x.t); });
  for (let ty = 0; ty < ROWS; ty++) for (let tx = a; tx <= e; tx++) { const v = L.t[ty * L.w + tx]; if (!v) continue; const x = tx * T, y = ty * T - (bumped.get(ty * L.w + tx) ? 4 : 0);
    if (v === TILE.BRICK) { ctx.save(); ctx.translate(x, y); ctx.fillStyle = ASSET.brick; ctx.fillRect(0, 0, T, T); ctx.restore(); ctx.fillStyle = "rgba(0,0,0,.25)"; ctx.fillRect(x, y + T - 3, T, 3); }
    else if (v === TILE.QBLOCK || v === TILE.USED) drawQ(x, y, f, v === TILE.USED);
    else if (v === TILE.ONEWAY) drawPlank(x, y);
    else if (v === TILE.RUG) drawRug(x, y, W.rugs.get(ty * L.w + tx) > 0, f);
    else if (v === TILE.SPIKE) drawSpikes(x, y, f); }
}
function drawQ(x, y, f, used) {
  const g1 = ctx.createLinearGradient(x, y, x + T, y + T);
  if (used) { g1.addColorStop(0, "#a88a66"); g1.addColorStop(1, "#5a4028"); } else { g1.addColorStop(0, "#ffe9a0"); g1.addColorStop(.45, "#f7a92a"); g1.addColorStop(1, "#b8620a"); }
  const bob = used ? 0 : Math.sin(f / 12) * .8;
  (used ? (fn) => fn() : (fn) => glow("rgba(255,190,60,.55)", 12, fn))(() => { rr(x + .5, y + .5 + bob, T - 1, T - 1, 3); ctx.fillStyle = g1; ctx.fill(); });
  ctx.strokeStyle = used ? "rgba(40,24,12,.6)" : "rgba(120,60,6,.7)"; ctx.lineWidth = 1; rr(x + 2.5, y + 2.5 + bob, T - 5, T - 5, 2); ctx.stroke();
  [[4, 4], [T - 4, 4], [4, T - 4], [T - 4, T - 4]].forEach(([a, b2]) => { ctx.fillStyle = used ? "#3a2614" : "#8a4a0a"; ctx.beginPath(); ctx.arc(x + a, y + b2 + bob, 1.1, 0, 7); ctx.fill(); });
  if (!used) { ctx.font = "700 15px " + FONT; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillStyle = "rgba(110,50,0,.6)"; ctx.fillText("₿", x + 12.6, y + 13.6 + bob); ctx.fillStyle = "#fff7de"; ctx.fillText("₿", x + 12, y + 13 + bob);
    const s = (f % 150) / 150 * 60 - 18; ctx.save(); rr(x + .5, y + .5 + bob, T - 1, T - 1, 3); ctx.clip(); const sh = ctx.createLinearGradient(x + s, y, x + s + 10, y + T); sh.addColorStop(0, "rgba(255,255,255,0)"); sh.addColorStop(.5, "rgba(255,255,255,.45)"); sh.addColorStop(1, "rgba(255,255,255,0)"); ctx.fillStyle = sh; ctx.fillRect(x, y, T, T); ctx.restore(); }
}
function drawPlank(x, y) {
  const g1 = ctx.createLinearGradient(0, y, 0, y + 9); g1.addColorStop(0, "#d9a066"); g1.addColorStop(.5, "#a8703e"); g1.addColorStop(1, "#6e4424");
  ctx.fillStyle = "rgba(0,0,0,.3)"; ctx.fillRect(x + 2, y + 9, T - 4, 3); rr(x, y, T, 9, 2); ctx.fillStyle = g1; ctx.fill();
  ctx.strokeStyle = "rgba(90,50,20,.5)"; ctx.lineWidth = .6; ctx.beginPath(); ctx.moveTo(x + 2, y + 3.5); ctx.bezierCurveTo(x + 8, y + 2.5, x + 14, y + 5, x + 22, y + 4); ctx.moveTo(x + 3, y + 6.5); ctx.bezierCurveTo(x + 9, y + 7.5, x + 15, y + 5.5, x + 21, y + 6.5); ctx.stroke();
  ctx.fillStyle = "#c9c6cc"; ctx.beginPath(); ctx.arc(x + 4, y + 4.5, .9, 0, 7); ctx.arc(x + T - 4, y + 4.5, .9, 0, 7); ctx.fill();
}
function drawRug(x, y, shaking, f) {
  if (shaking) x += Math.sin(f * 1.7) * 1.2;
  ctx.fillStyle = "rgba(0,0,0,.35)"; ctx.fillRect(x + 1, y + 10, T - 2, 3);
  const g1 = ctx.createLinearGradient(0, y, 0, y + 10); g1.addColorStop(0, "#c8323a"); g1.addColorStop(1, "#7a141c"); ctx.fillStyle = g1; ctx.fillRect(x, y, T, 10);
  ctx.strokeStyle = "#ffd166"; ctx.lineWidth = 1; ctx.strokeRect(x + 1.5, y + 1.5, T - 3, 7);
  ctx.fillStyle = "#ffd166"; ctx.beginPath(); ctx.moveTo(x + 12, y + 2.5); ctx.lineTo(x + 16, y + 5); ctx.lineTo(x + 12, y + 7.5); ctx.lineTo(x + 8, y + 5); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = "#efe2c2"; ctx.lineWidth = .7; for (let i = 1.5; i < T; i += 2.2) { ctx.beginPath(); ctx.moveTo(x + i, y + 10); ctx.lineTo(x + i + Math.sin(f / 9 + i) * .6, y + 13.5); ctx.stroke(); }
}
function drawSpikes(x, y, f) {
  for (let i = 0; i < 3; i++) { const cx = x + 4 + i * 8, base = y + T, tip = y + 7;
    const g1 = ctx.createLinearGradient(cx - 4, 0, cx + 4, 0); g1.addColorStop(0, "#ffb3ad"); g1.addColorStop(.45, "#e5534b"); g1.addColorStop(1, "#7a1a16");
    glow("rgba(248,81,73,.6)", 6, () => { ctx.fillStyle = g1; ctx.beginPath(); ctx.moveTo(cx - 4, base); ctx.lineTo(cx, tip); ctx.lineTo(cx + 4, base); ctx.closePath(); ctx.fill(); }); }
  ctx.fillStyle = "#3a1414"; ctx.fillRect(x, y + T - 2, T, 2);
}

// ---- characters and pickups ----
function drawHero(x, y, facing, anim, run, air, tint, alpha, f) {
  ctx.save(); ctx.globalAlpha = alpha; ctx.translate(x + 8, y + 22); ctx.scale(1.3, 1.3); ctx.translate(0, -22); if (facing < 0) ctx.scale(-1, 1);
  const s = run ? Math.sin(anim) : air ? .6 : 0, bob = run ? Math.abs(Math.cos(anim)) * 1.2 : 0;
  if (alpha === 1) { ctx.fillStyle = "rgba(0,0,0,.35)"; ctx.beginPath(); ctx.ellipse(0, 22.5, 8, 2, 0, 0, 7); ctx.fill(); }
  const limb = (x0, y0, ang, len, wdt, col) => { ctx.save(); ctx.translate(x0, y0); ctx.rotate(ang); rr(-wdt / 2, 0, wdt, len, wdt / 2); ctx.fillStyle = col; ctx.fill(); ctx.restore(); };
  // back leg, back arm
  limb(-2, 14 - bob, -s * .7, 8.5, 4.2, "#1c2236"); limb(-1, 8 - bob, s * .8, 7, 3.4, "#24365e");
  // body: hoodie with shading and a glowing ₿
  const bg = ctx.createLinearGradient(-7, 0, 7, 0); bg.addColorStop(0, "#2a3f6e"); bg.addColorStop(.5, "#3c5a9a"); bg.addColorStop(1, "#1a2746"); rr(-6.5, 6.5 - bob, 13, 10, 4); ctx.fillStyle = bg; ctx.fill();
  glow(tint, 6, () => { ctx.fillStyle = tint; ctx.beginPath(); ctx.arc(0.5, 11.5 - bob, 3.2, 0, 7); ctx.fill(); }); ctx.font = "700 5px " + FONT; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillStyle = "#2a1408"; ctx.fillText("₿", .5, 11.8 - bob);
  // front leg with boot
  limb(2, 14 - bob, s * .7, 8.5, 4.2, "#262e48"); ctx.save(); ctx.translate(2, 14 - bob); ctx.rotate(s * .7); rr(-2.6, 7, 6.2, 2.6, 1.2); ctx.fillStyle = "#5a321a"; ctx.fill(); ctx.restore();
  ctx.save(); ctx.translate(-2, 14 - bob); ctx.rotate(-s * .7); rr(-2.6, 7, 6.2, 2.6, 1.2); ctx.fillStyle = "#4a2814"; ctx.fill(); ctx.restore();
  // head
  const hg = ctx.createRadialGradient(1, 0 - bob, 1, 0, 2 - bob, 7); hg.addColorStop(0, "#ffd9b8"); hg.addColorStop(1, "#c98a62"); ctx.fillStyle = hg; ctx.beginPath(); ctx.ellipse(.5, 2.5 - bob, 5, 5.2, 0, 0, 7); ctx.fill();
  ctx.fillStyle = "#5a321c"; ctx.beginPath(); ctx.ellipse(-.5, 5.5 - bob, 4.2, 2.4, 0, 0, Math.PI); ctx.fill();
  ctx.fillStyle = "#1b0f0c"; ctx.beginPath(); ctx.ellipse(3, 2 - bob, .8, 1, 0, 0, 7); ctx.fill();
  // helmet
  const hm = ctx.createRadialGradient(-1, -4 - bob, 1, 0, -1 - bob, 8); hm.addColorStop(0, "#ffd27a"); hm.addColorStop(.5, tint); hm.addColorStop(1, "#8a3a06");
  ctx.fillStyle = hm; ctx.beginPath(); ctx.ellipse(0, -.5 - bob, 6.6, 4.6, 0, Math.PI, 0); ctx.fill(); rr(-7.5, -1 - bob, 15, 2, 1); ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,.55)"; ctx.beginPath(); ctx.ellipse(-2.5, -3 - bob, 2, 1, -.3, 0, 7); ctx.fill();
  if (alpha === 1) glow("#fff3b0", 10, () => { ctx.fillStyle = "#fffbe0"; ctx.beginPath(); ctx.arc(6.4, -2 - bob, 1.8, 0, 7); ctx.fill(); });
  // front arm
  limb(1, 8 - bob, -s * .8, 7, 3.4, "#33508a"); ctx.save(); ctx.translate(1, 8 - bob); ctx.rotate(-s * .8); ctx.fillStyle = "#f0b890"; ctx.beginPath(); ctx.arc(0, 7.2, 1.7, 0, 7); ctx.fill(); ctx.restore();
  ctx.restore();
}
function drawLamp(p) {
  const lx = p.x + 8 + p.facing * 9, ly = p.y - 5, g1 = ctx.createRadialGradient(lx, ly, 2, lx + p.facing * 40, ly + 8, 70);
  g1.addColorStop(0, "rgba(255,240,190,.35)"); g1.addColorStop(1, "rgba(255,240,190,0)");
  ctx.save(); ctx.globalCompositeOperation = "lighter"; ctx.fillStyle = g1; ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(lx + p.facing * 80, ly - 22); ctx.lineTo(lx + p.facing * 80, ly + 34); ctx.closePath(); ctx.fill(); ctx.restore();
}
function drawShitcoin(e, f) {
  ctx.save(); const fx0 = e.x + 10, fy0 = (e.y || e.row * T - 20) + 20; ctx.translate(fx0, fy0); ctx.scale(1.25, 1.25); ctx.translate(-fx0, -fy0); drawShitcoinBody(e, f); ctx.restore();
}
function drawShitcoinBody(e, f) {
  const x = e.x + 10, y = (e.y || e.row * T - 20) + 10, d = e.dir;
  ctx.fillStyle = "rgba(0,0,0,.35)"; ctx.beginPath(); ctx.ellipse(x, y + 10.5, 10, 2.2, 0, 0, 7); ctx.fill();
  if (e.dead) { const g1 = ctx.createLinearGradient(0, y + 4, 0, y + 10); g1.addColorStop(0, "#a8743e"); g1.addColorStop(1, "#5a3414"); ctx.fillStyle = g1; ctx.beginPath(); ctx.ellipse(x, y + 7.5, 11, 3.5, 0, 0, 7); ctx.fill(); return; }
  const hop = Math.abs(Math.sin(f / 5)) * 1.6, yy = y - hop;
  // feet
  [[-4, f % 20 < 10 ? 0 : 1], [4, f % 20 < 10 ? 1 : 0]].forEach(([dx, k]) => { ctx.fillStyle = "#3a2010"; ctx.beginPath(); ctx.ellipse(x + dx, y + 9 - k, 3, 1.6, 0, 0, 7); ctx.fill(); });
  // three glossy swirls
  [[0, 5, 10, 5], [0, 0, 8, 4.2], [0, -4.6, 5.5, 3.4]].forEach(([dx, dy, rx, ry], i) => { const g1 = ctx.createRadialGradient(x - 3, yy + dy - 2, 1, x, yy + dy, rx + 2); g1.addColorStop(0, "#d79a5a"); g1.addColorStop(.5, "#8a5524"); g1.addColorStop(1, "#4a2a10"); ctx.fillStyle = g1; ctx.beginPath(); ctx.ellipse(x + dx, yy + dy, rx, ry, 0, 0, 7); ctx.fill(); });
  ctx.fillStyle = "#6a3e18"; ctx.beginPath(); ctx.moveTo(x - 1, yy - 7); ctx.quadraticCurveTo(x + 3, yy - 12, x + 1.5, yy - 9); ctx.fill();
  ctx.fillStyle = "rgba(255,240,220,.5)"; ctx.beginPath(); ctx.ellipse(x - 3.5, yy - 5.5, 1.6, .8, -.4, 0, 7); ctx.fill();
  // angry face
  [[-3, 0], [3, 0]].forEach(([dx]) => { ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.ellipse(x + dx, yy + 1, 2.2, 2.5, 0, 0, 7); ctx.fill(); ctx.fillStyle = "#1b0f0c"; ctx.beginPath(); ctx.arc(x + dx + d * .9, yy + 1.5, 1.1, 0, 7); ctx.fill(); });
  ctx.strokeStyle = "#1b0f0c"; ctx.lineWidth = 1.2; ctx.lineCap = "round"; ctx.beginPath(); ctx.moveTo(x - 5.5, yy - 2.6); ctx.lineTo(x - 1.2, yy - 1.2); ctx.moveTo(x + 5.5, yy - 2.6); ctx.lineTo(x + 1.2, yy - 1.2); ctx.stroke();
  ctx.fillStyle = "#1b0f0c"; ctx.beginPath(); ctx.ellipse(x, yy + 5.2, 3, 1.4, 0, 0, Math.PI); ctx.fill(); ctx.fillStyle = "#fff"; ctx.fillRect(x - 1.6, yy + 5.1, 1.1, .9); ctx.fillRect(x + .4, yy + 5.1, 1.1, .9);
  ctx.fillStyle = "#3fb950"; ctx.font = "700 5px " + FONT; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText("$", x + 6.5, yy + 6);
}
// BEAR: a bear-market bear that charges at you along a plateau
function drawBear(e, f) {
  const x = e.x + 12, base = e.row * T, run = e.charging, k = run ? Math.sin(f / 3) : 0;
  ctx.save(); ctx.translate(x, base); ctx.scale(1.35, 1.35); ctx.translate(-x, -base);
  ctx.fillStyle = "rgba(0,0,0,.35)"; ctx.beginPath(); ctx.ellipse(x, base - .5, 13, 2.4, 0, 0, 7); ctx.fill();
  if (e.dead) { const g1 = ctx.createLinearGradient(0, base - 8, 0, base); g1.addColorStop(0, "#7a5034"); g1.addColorStop(1, "#3a2414"); ctx.fillStyle = g1; ctx.beginPath(); ctx.ellipse(x, base - 3.5, 14, 4, 0, 0, 7); ctx.fill(); ctx.restore(); return; }
  const leg = (dx, ph) => { ctx.fillStyle = "#3e2616"; ctx.beginPath(); ctx.ellipse(x + dx + Math.sin(ph) * 2.2, base - 3, 2.6, 3.4, 0, 0, 7); ctx.fill(); };
  leg(-7, f / 3); leg(5, f / 3 + 2);
  const bg = ctx.createRadialGradient(x + 2, base - 15, 2, x, base - 10, 14); bg.addColorStop(0, "#a8734a"); bg.addColorStop(.6, "#6e4428"); bg.addColorStop(1, "#3a2212"); ctx.fillStyle = bg; ctx.beginPath(); ctx.ellipse(x + 1, base - 11 + k * .6, 12, 8.5, 0, 0, 7); ctx.fill();
  leg(-4, f / 3 + 1); leg(8, f / 3 + 3);
  // head facing left (towards the player)
  const hx = x - 10, hy = base - 15 + k * .8; const hg = ctx.createRadialGradient(hx + 1, hy - 2, 1, hx, hy, 8); hg.addColorStop(0, "#b07c52"); hg.addColorStop(1, "#5a3620"); ctx.fillStyle = hg; ctx.beginPath(); ctx.arc(hx, hy, 6.5, 0, 7); ctx.fill();
  [[-3, -5.5], [3.5, -5]].forEach(([dx, dy]) => { ctx.fillStyle = "#5a3620"; ctx.beginPath(); ctx.arc(hx + dx, hy + dy, 2.4, 0, 7); ctx.fill(); ctx.fillStyle = "#c99a74"; ctx.beginPath(); ctx.arc(hx + dx, hy + dy, 1.1, 0, 7); ctx.fill(); });
  ctx.fillStyle = "#d8b08a"; ctx.beginPath(); ctx.ellipse(hx - 3.5, hy + 2, 3.4, 2.4, 0, 0, 7); ctx.fill(); ctx.fillStyle = "#1b0f0c"; ctx.beginPath(); ctx.arc(hx - 5.6, hy + 1.2, 1, 0, 7); ctx.fill();
  glow("#ff3b30", 8, () => { ctx.fillStyle = "#ff4a3a"; ctx.beginPath(); ctx.arc(hx - 2, hy - 1.5, 1.2, 0, 7); ctx.arc(hx + 2.2, hy - 1.5, 1.2, 0, 7); ctx.fill(); });
  ctx.strokeStyle = "#1b0f0c"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(hx - 3.6, hy - 3.6); ctx.lineTo(hx - .6, hy - 2.4); ctx.moveTo(hx + 4, hy - 3.6); ctx.lineTo(hx + 1, hy - 2.4); ctx.stroke();
  // red falling chart on the flank
  ctx.strokeStyle = "#f85149"; ctx.lineWidth = 1.4; ctx.lineJoin = "round"; ctx.beginPath(); ctx.moveTo(x - 1, base - 16); ctx.lineTo(x + 3, base - 12); ctx.lineTo(x + 5, base - 14); ctx.lineTo(x + 9, base - 8); ctx.stroke();
  ctx.restore();
}
// MONEY PRINTER: goes brrr and fires dollar bills at head height
function drawPrinter(e, f) {
  const x = e.x, base = e.row * T, y = base - 20;
  ctx.fillStyle = "rgba(0,0,0,.35)"; ctx.beginPath(); ctx.ellipse(x + 12, base - .5, 13, 2.2, 0, 0, 7); ctx.fill();
  if (e.dead) { ctx.fillStyle = "#4a4a52"; rr(x + 1, base - 7, 22, 7, 2); ctx.fill(); ctx.fillStyle = "#2a2a30"; ctx.fillRect(x + 4, base - 5, 16, 1.5); return; }
  const shake = e.flash > 0 ? Math.sin(f * 2) * .8 : 0;
  const g1 = ctx.createLinearGradient(x, y, x, base); g1.addColorStop(0, "#c9ccd6"); g1.addColorStop(.5, "#8a8e9c"); g1.addColorStop(1, "#4a4d58"); rr(x + 1 + shake, y + 4, 22, 16, 3); ctx.fillStyle = g1; ctx.fill();
  ctx.fillStyle = "#2a2c34"; rr(x + 3 + shake, y + 7, 18, 3, 1); ctx.fill();
  ctx.fillStyle = "#e8eaf0"; rr(x + 5 + shake, y, 14, 6, 1); ctx.fill(); ctx.fillStyle = "#3fb950"; ctx.fillRect(x + 7 + shake, y + 1.5, 10, 2.5);
  glow(e.flash > 0 ? "#3fb950" : "#f85149", 8, () => { ctx.fillStyle = e.flash > 0 ? "#56d364" : "#f85149"; ctx.beginPath(); ctx.arc(x + 19 + shake, y + 15, 1.4, 0, 7); ctx.fill(); });
  ctx.font = "700 5.5px " + FONT; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillStyle = "#1b1c22"; ctx.fillText(e.flash > 0 ? "BRRR" : "FIAT", x + 10 + shake, y + 15.5);
}
function drawBill(bl) {
  const y = bl.y + Math.sin(bl.t / 6) * 3; ctx.save(); ctx.translate(bl.x + 7, y + 4); ctx.rotate(Math.sin(bl.t / 5) * .15);
  glow("rgba(86,211,100,.6)", 6, () => { const g1 = ctx.createLinearGradient(-7, -4, 7, 4); g1.addColorStop(0, "#a8e6a0"); g1.addColorStop(1, "#3f8a3a"); rr(-7, -3.6, 14, 7.2, 1); ctx.fillStyle = g1; ctx.fill(); });
  ctx.strokeStyle = "#2a5a26"; ctx.lineWidth = .6; rr(-5.8, -2.4, 11.6, 4.8, .8); ctx.stroke();
  ctx.font = "700 5px " + FONT; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillStyle = "#1e4a1a"; ctx.fillText("$", 0, .3); ctx.restore();
}
function drawFud(c, f) {
  const x = c.x, y = c.y;
  const puffs = [[10, 15, 10], [22, 10, 12.5], [35, 14, 10.5], [16, 20, 9], [30, 21, 9]];
  puffs.forEach(([dx, dy, r], i) => { const g1 = ctx.createRadialGradient(x + dx - 3, y + dy - r * .5, 2, x + dx, y + dy, r + 1); g1.addColorStop(0, "#8d87a6"); g1.addColorStop(.6, "#4f4864"); g1.addColorStop(1, "#2c2738"); ctx.fillStyle = g1; ctx.beginPath(); ctx.arc(x + dx, y + dy, r, 0, 7); ctx.fill(); });
  glow("#ffd166", 8, () => { [[17, 16], [29, 16]].forEach(([dx, dy]) => { ctx.fillStyle = "#ffd166"; ctx.beginPath(); ctx.ellipse(x + dx, y + dy, 2.6, 2, 0, 0, 7); ctx.fill(); }); });
  ctx.strokeStyle = "#16121e"; ctx.lineWidth = 1.6; ctx.lineCap = "round"; ctx.beginPath(); ctx.moveTo(x + 13, y + 11.5); ctx.lineTo(x + 19, y + 14); ctx.moveTo(x + 33, y + 11.5); ctx.lineTo(x + 27, y + 14); ctx.stroke();
  ctx.fillStyle = "#16121e"; ctx.beginPath(); ctx.ellipse(x + 23, y + 23, 4, 2.4, 0, 0, 7); ctx.fill();
  ctx.font = "700 8px " + FONT; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillStyle = "#e8e2f4"; ctx.fillText("FUD", x + 23, y + 4.5);
  ctx.strokeStyle = "rgba(140,180,230,.55)"; ctx.lineWidth = .8; for (let i = 0; i < 7; i++) { const ry = (f * 1.4 + i * 9) % 26; ctx.beginPath(); ctx.moveTo(x + 10 + i * 4.4, y + 28 + ry); ctx.lineTo(x + 9 + i * 4.4, y + 32 + ry); ctx.stroke(); }
  if (f % 60 < 6) glow("#ffe066", 14, () => { ctx.strokeStyle = "#fff2a0"; ctx.lineWidth = 1.8; ctx.beginPath(); ctx.moveTo(x + 20, y + 28); ctx.lineTo(x + 15, y + 38); ctx.lineTo(x + 20, y + 38); ctx.lineTo(x + 14, y + 50); ctx.stroke(); });
}
function drawCoin(cx, cy, f, k) {
  const sp = Math.cos(f / 14 + k), w = Math.max(.12, Math.abs(sp)) * 7.5;
  glow("rgba(255,200,80,.7)", 8, () => { const g1 = ctx.createLinearGradient(cx - w, cy - 8, cx + w, cy + 8); g1.addColorStop(0, "#fff0b0"); g1.addColorStop(.5, sp > 0 ? "#ffc23a" : "#e89a1a"); g1.addColorStop(1, "#b8620a"); ctx.fillStyle = g1; ctx.beginPath(); ctx.ellipse(cx, cy, w, 8, 0, 0, 7); ctx.fill(); });
  ctx.strokeStyle = "rgba(140,70,0,.6)"; ctx.lineWidth = .8; ctx.beginPath(); ctx.ellipse(cx, cy, Math.max(.1, w - 1.6), 6.2, 0, 0, 7); ctx.stroke();
  if (w > 4) { ctx.save(); ctx.translate(cx, cy); ctx.scale(w / 7.5, 1); ctx.font = "700 9px " + FONT; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillStyle = "#9a5206"; ctx.fillText("₿", .4, .9); ctx.restore(); }
  if ((f + k * 37 | 0) % 80 < 6) { ctx.fillStyle = "#fff"; ctx.save(); ctx.translate(cx + 4, cy - 6); ctx.rotate(Math.PI / 4); ctx.fillRect(-.5, -3, 1, 6); ctx.fillRect(-3, -.5, 6, 1); ctx.restore(); }
}
function drawPowerIcon(kind, x, y, f) {
  const info = PW_INFO[kind];
  ctx.save(); ctx.globalCompositeOperation = "lighter"; const hg = ctx.createRadialGradient(x, y, 2, x, y, 22); hg.addColorStop(0, info.color + "66"); hg.addColorStop(1, info.color + "00"); ctx.fillStyle = hg; ctx.beginPath(); ctx.arc(x, y, 22, 0, 7); ctx.fill(); ctx.restore();
  if (kind === "pill") { ctx.save(); ctx.translate(x, y); ctx.rotate(-.6 + Math.sin(f / 20) * .15);
    ctx.fillStyle = "#f7931a"; rr(-11, -5, 11, 10, 5); ctx.fill(); ctx.fillRect(-5, -5, 5, 10); ctx.fillStyle = "#f4f1ea"; rr(0, -5, 11, 10, 5); ctx.fill(); ctx.fillRect(0, -5, 5, 10);
    ctx.fillStyle = "rgba(255,255,255,.55)"; rr(-8, -3.5, 14, 2.2, 1); ctx.fill(); ctx.font = "700 6px " + FONT; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillStyle = "#fff"; ctx.fillText("₿", -5.5, .5); ctx.restore(); }
  else if (kind === "diamond") { ctx.save(); ctx.translate(x, y); const g1 = ctx.createLinearGradient(-10, -9, 10, 10); g1.addColorStop(0, "#e8fdff"); g1.addColorStop(.5, "#7ee8ff"); g1.addColorStop(1, "#2a8cc8");
    ctx.fillStyle = g1; ctx.beginPath(); ctx.moveTo(-10, -3); ctx.lineTo(-5, -9); ctx.lineTo(5, -9); ctx.lineTo(10, -3); ctx.lineTo(0, 11); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,.7)"; ctx.lineWidth = .8; ctx.beginPath(); ctx.moveTo(-10, -3); ctx.lineTo(10, -3); ctx.moveTo(-5, -9); ctx.lineTo(-3, -3); ctx.lineTo(0, 11); ctx.lineTo(3, -3); ctx.lineTo(5, -9); ctx.stroke();
    const tw = (Math.sin(f / 6) + 1) / 2; ctx.fillStyle = `rgba(255,255,255,${tw})`; ctx.beginPath(); ctx.moveTo(7, -12); ctx.lineTo(8, -9); ctx.lineTo(11, -8); ctx.lineTo(8, -7); ctx.lineTo(7, -4); ctx.lineTo(6, -7); ctx.lineTo(3, -8); ctx.lineTo(6, -9); ctx.closePath(); ctx.fill(); ctx.restore(); }
  else if (kind === "laser") { ctx.save(); ctx.translate(x, y);
    [-5.5, 5.5].forEach((dx) => { ctx.fillStyle = "#f4f1ea"; ctx.beginPath(); ctx.ellipse(dx, 0, 5, 3.6, 0, 0, 7); ctx.fill(); glow("#ff3b30", 10, () => { ctx.fillStyle = "#ff2a1a"; ctx.beginPath(); ctx.arc(dx, 0, 2.4, 0, 7); ctx.fill(); }); });
    ctx.globalCompositeOperation = "lighter"; ctx.strokeStyle = "rgba(255,70,50,.7)"; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(5.5, 0); ctx.lineTo(14 + Math.sin(f / 4) * 2, 0); ctx.stroke(); ctx.restore(); }
  else if (kind === "magnet") { ctx.save(); ctx.translate(x, y); ctx.lineCap = "butt"; ctx.lineWidth = 6; ctx.strokeStyle = "#d8383a"; ctx.beginPath(); ctx.arc(0, -1, 7, Math.PI, 0); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-7, -1); ctx.lineTo(-7, 6); ctx.moveTo(7, -1); ctx.lineTo(7, 6); ctx.stroke(); ctx.fillStyle = "#d9dde6"; ctx.fillRect(-10, 6, 6, 4); ctx.fillRect(4, 6, 6, 4);
    ctx.fillStyle = "rgba(192,140,255,.9)"; for (let i = 0; i < 3; i++) { const a = f / 10 + i * 2.1; ctx.beginPath(); ctx.arc(Math.cos(a) * 15, 4 + Math.sin(a) * 6, 1.4, 0, 7); ctx.fill(); } ctx.restore(); }
  else if (kind === "moon") { ctx.save(); ctx.translate(x, y); glow("#fff2c0", 12, () => { ctx.fillStyle = "#ffe9a8"; ctx.beginPath(); ctx.arc(0, 0, 9, 0, 7); ctx.fill(); });
    ctx.globalCompositeOperation = "destination-out"; ctx.beginPath(); ctx.arc(4.5, -3, 7.5, 0, 7); ctx.fill(); ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "#e6e9f2"; rr(-2, 4, 9, 6, 2); ctx.fill(); ctx.fillStyle = "#f7931a"; ctx.fillRect(-2, 8, 10, 2); ctx.restore(); }
}
function drawBolt(x, y) {
  glow("#ffe066", 16, () => { ctx.fillStyle = "#ffe066"; ctx.beginPath(); ctx.moveTo(x + 3, y - 12); ctx.lineTo(x - 7, y + 3); ctx.lineTo(x, y + 3); ctx.lineTo(x - 3, y + 16); ctx.lineTo(x + 9, y - 1); ctx.lineTo(x + 2, y - 1); ctx.lineTo(x + 5, y - 12); ctx.closePath(); ctx.fill(); });
  ctx.fillStyle = "rgba(255,255,255,.7)"; ctx.beginPath(); ctx.moveTo(x + 3, y - 10); ctx.lineTo(x - 3, y + 1); ctx.lineTo(x - 1, y + 1); ctx.closePath(); ctx.fill();
}
function drawWallet(x, y) {
  const g1 = ctx.createLinearGradient(x - 8, y - 11, x + 8, y + 13); g1.addColorStop(0, "#6a7c96"); g1.addColorStop(1, "#283244");
  ctx.fillStyle = "rgba(0,0,0,.35)"; ctx.beginPath(); ctx.ellipse(x, y + 15, 8, 2, 0, 0, 7); ctx.fill();
  rr(x - 8, y - 11, 16, 24, 3); ctx.fillStyle = g1; ctx.fill();
  glow("#f7931a", 8, () => { rr(x - 5.5, y - 8, 11, 8, 1.5); ctx.fillStyle = "#1a0e04"; ctx.fill(); ctx.font = "700 6px " + FONT; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillStyle = "#f7931a"; ctx.fillText("₿", x, y - 3.8); });
  [[-3, 5], [3, 5]].forEach(([dx, dy]) => { const bg = ctx.createRadialGradient(x + dx - .5, y + dy - .5, .2, x + dx, y + dy, 2.2); bg.addColorStop(0, "#d8e4f4"); bg.addColorStop(1, "#7a8aa4"); ctx.fillStyle = bg; ctx.beginPath(); ctx.arc(x + dx, y + dy, 2, 0, 7); ctx.fill(); });
}
function drawFlag(L, f) {
  const x = L.goal * T + 4, top = 2 * T, bot = 12 * T;
  const pg = ctx.createLinearGradient(x, 0, x + 4, 0); pg.addColorStop(0, "#f0ece6"); pg.addColorStop(1, "#8a8078"); ctx.fillStyle = pg; ctx.fillRect(x, top, 4, bot - top);
  glow("#ffd166", 10, () => { ctx.fillStyle = "#ffd166"; ctx.beginPath(); ctx.arc(x + 2, top - 3, 4, 0, 7); ctx.fill(); });
  ctx.beginPath(); ctx.moveTo(x + 4, top + 4); for (let i = 0; i <= 12; i++) ctx.lineTo(x + 4 + i * 4, top + 4 + Math.sin(f / 8 + i * .55) * 2.6 + i * .15); for (let i = 12; i >= 0; i--) ctx.lineTo(x + 4 + i * 4, top + 32 + Math.sin(f / 8 + i * .55) * 2.6 - i * .15); ctx.closePath();
  const fg = ctx.createLinearGradient(x, top, x + 52, top + 30); fg.addColorStop(0, "#ffb040"); fg.addColorStop(.5, "#f7931a"); fg.addColorStop(1, "#b8580a"); ctx.fillStyle = fg; ctx.fill();
  ctx.font = "700 16px " + FONT; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillStyle = "#fff6dc"; ctx.fillText("₿", x + 28, top + 19 + Math.sin(f / 8 + 3.3) * 2.6);
  const bg = ctx.createLinearGradient(0, bot - 8, 0, bot); bg.addColorStop(0, "#7a5a48"); bg.addColorStop(1, "#3a2620"); ctx.fillStyle = bg; rr(x - 10, bot - 8, 24, 8, 2); ctx.fill();
}
function drawCheckpoint(c, on, f) {
  const x = c.x * T + 8, y = c.row * T;
  ctx.fillStyle = "#5a5260"; ctx.fillRect(x + 2, y - 30, 3, 30);
  const g1 = ctx.createLinearGradient(x - 6, y - 42, x + 12, y - 30); g1.addColorStop(0, "#4a4456"); g1.addColorStop(1, "#1e1a26"); rr(x - 6, y - 42, 19, 13, 2.5); ctx.fillStyle = g1; ctx.fill();
  const led = on ? "#56d364" : "#a83232"; glow(led, on ? 12 : 4, () => { ctx.fillStyle = led; ctx.beginPath(); ctx.arc(x + 3.5, y - 35.5, 2.4, 0, 7); ctx.fill(); });
  ctx.fillStyle = "rgba(255,255,255,.12)"; ctx.fillRect(x - 5, y - 41, 17, 2);
}
function drawWorld(W, ghosts) {
  const L = W.L, p = W.p, f = W.f; L0 = L;
  camX = Math.max(0, Math.min(L.w * T - viewW, p.x - viewW * .2));
  // vertical camera (#3270): the world's rows live in the band under the HUD. If the whole world fits, its ground sits on the
  // canvas bottom; otherwise the camera holds the runner between 30 % and 70 % of the band and moves only when he leaves it.
  const top = (pillShown() ? hudTopPill : hudTop) / zoom, band = viewH - top, lowest = VH - viewH;
  if (band >= VH) camY = lowest;
  else {
    if (camW !== W) { camW = W; camY = lowest; }
    camY = Math.max(p.y + PH - top - band * .7, Math.min(p.y - top - band * .3, camY));
    camY = Math.max(-top, Math.min(lowest, camY));
  }
  drawBackdrop(f); W2S();
  L.checkpoints.slice(1).forEach((c, i) => drawCheckpoint(c, p.cp > i, f));
  drawFlag(L, f);
  drawTerrain(W, f);
  L.coins.forEach((c, i) => { if (!c.got && c.x > camX - 20 && c.x < camX + viewW + 20) drawCoin(c.x, c.y, f, i); });
  L.items.forEach((it) => { if (it.got) return; const yy = it.y + (it.rise === undefined ? Math.sin(f / 15) * 3 : 0); if (PW_INFO[it.kind]) drawPowerIcon(it.kind, it.x, yy, f); else if (it.kind === "bolt") drawBolt(it.x, yy); else drawWallet(it.x, yy); });
  const hd = L.dayHigh; if (hd && !hd.got) { const yy = hd.y + Math.sin(f / 10) * 2; ctx.save(); ctx.translate(hd.x, yy); ctx.rotate(f / 80); for (let i = 0; i < 10; i++) { ctx.rotate(Math.PI / 5); const rg = ctx.createLinearGradient(0, 0, 0, 34); rg.addColorStop(0, "rgba(255,209,102,.4)"); rg.addColorStop(1, "rgba(255,209,102,0)"); ctx.fillStyle = rg; ctx.beginPath(); ctx.moveTo(-2, 0); ctx.lineTo(-6, 34); ctx.lineTo(6, 34); ctx.lineTo(2, 0); ctx.fill(); } ctx.restore(); drawQ(hd.x - 12, yy - 12, f, false); }
  L.enemies.forEach((e) => { if (e.dead === 0 || e.x < camX - 40 || e.x > camX + viewW + 40) return; if (e.kind === "bear") drawBear(e, f); else if (e.kind === "printer") drawPrinter(e, f); else drawShitcoin(e, f); });
  W.bills.forEach((bl) => drawBill(bl));
  L.clouds.forEach((c) => { if (c.x > camX - 60 && c.x < camX + viewW + 60) drawFud(c, f); });
  ghosts.forEach((gh) => { const i = Math.min(gh.path.length / 2 - 1, Math.floor(f / 2)) * 2; if (i < 0) return; const gx = gh.path[i], gy = gh.path[i + 1], px = gh.path[Math.max(0, i - 2)], py = gh.path[Math.max(1, i - 1)];
    drawHero(gx, gy, 1, f * .32, gx !== px && gy === py, gy !== py, gh.color, .45); });
  if (p.boost > 0) { ctx.save(); ctx.globalCompositeOperation = "lighter"; for (let i = 1; i < 6; i++) { ctx.fillStyle = `rgba(255,220,110,${.22 - i * .035})`; ctx.beginPath(); ctx.ellipse(p.x + 8 - i * 7, p.y + 11, 7, 10, 0, 0, 7); ctx.fill(); } ctx.restore(); }
  if (p.pw.magnet > 0) { ctx.strokeStyle = `rgba(192,140,255,${.25 + .15 * Math.sin(f / 5)})`; ctx.lineWidth = 1.2; ctx.setLineDash([4, 6]); ctx.beginPath(); ctx.arc(p.x + 8, p.y + 11, 46 + (f % 30), 0, 7); ctx.stroke(); ctx.setLineDash([]); }
  if (p.pw.diamond > 0) { ctx.save(); ctx.globalCompositeOperation = "lighter"; for (let i = 0; i < 8; i++) { const a = f / 7 + i * Math.PI / 4, hue = (f * 6 + i * 45) % 360; ctx.fillStyle = `hsla(${hue},100%,70%,.85)`; ctx.beginPath(); ctx.arc(p.x + 8 + Math.cos(a) * 20, p.y + 9 + Math.sin(a) * 24, 2.4, 0, 7); ctx.fill(); }
    const ag = ctx.createRadialGradient(p.x + 8, p.y + 10, 4, p.x + 8, p.y + 10, 30); ag.addColorStop(0, `hsla(${(f * 6) % 360},100%,70%,.35)`); ag.addColorStop(1, "rgba(0,0,0,0)"); ctx.fillStyle = ag; ctx.beginPath(); ctx.arc(p.x + 8, p.y + 10, 30, 0, 7); ctx.fill(); ctx.restore(); }
  if (p.pw.moon > 0 && !p.ground) { ctx.save(); ctx.globalCompositeOperation = "lighter"; for (let i = 0; i < 4; i++) { ctx.fillStyle = `rgba(255,233,168,${.5 - i * .1})`; ctx.beginPath(); ctx.arc(p.x + 8 - i * 6 + Math.sin(f / 3 + i) * 2, p.y + PH + 4 + i * 4, 2.2 - i * .3, 0, 7); ctx.fill(); } ctx.restore(); }
  if (p.shield) glow("#58a6ff", 12, () => { ctx.strokeStyle = "rgba(120,180,255,.8)"; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.arc(p.x + 8, p.y + 11, 17 + Math.sin(f / 6), 0, 7); ctx.stroke(); });
  const blink = p.hurtT > 0 && (p.hurtT >> 2) % 2 === 0;
  if (p.dying > 0) { if (!p.fell) { ctx.save(); ctx.translate(p.x + 8, p.y + 11); ctx.rotate((55 - p.dying) * .18); ctx.translate(-p.x - 8, -p.y - 11); drawHero(p.x, p.y, 1, 0, false, true, "#f7931a", Math.max(0, p.dying / 55), f); ctx.restore(); } }
  else if (!blink) { drawLamp(p); const big = p.pw.pill > 0 ? 1.35 : 1; ctx.save(); ctx.translate(p.x + 8, p.y + PH); ctx.scale(big, big); ctx.translate(-p.x - 8, -p.y - PH);
    drawHero(p.x, p.y, 1, p.anim * 1.4, Math.abs(p.vx) > .3 && p.ground, !p.ground, "#f7931a", 1, f); ctx.restore();
    if (p.pw.laser > 0) glow("#ff3b30", 10, () => { ctx.fillStyle = "#ff2a1a"; const hy = p.y + PH - 22 * 1.3 * big + 7 * big; ctx.beginPath(); ctx.arc(p.x + 10 + 2 * big, hy, 1.8 * big, 0, 7); ctx.arc(p.x + 10 + 6 * big, hy, 1.8 * big, 0, 7); ctx.fill(); }); }
  W.fx.forEach((e) => {
    if (e.kind === "dust") { const k = 1 - e.t / 14; ctx.fillStyle = `rgba(230,205,180,${.45 * (1 - k)})`; [-1, 1].forEach((s) => { ctx.beginPath(); ctx.arc(e.x + s * (4 + k * 10), e.y - 2 - k * 3, 2 + k * 3, 0, 7); ctx.fill(); }); }
    else if (e.kind === "spark") { const k = 16 - e.t; ctx.save(); ctx.globalCompositeOperation = "lighter"; ctx.fillStyle = "rgba(255,230,150,.9)"; for (let i = 0; i < 6; i++) { const a = i * Math.PI / 3; ctx.beginPath(); ctx.arc(e.x + Math.cos(a) * k * 1.4, e.y + Math.sin(a) * k * 1.4, 1.4, 0, 7); ctx.fill(); } ctx.restore(); }
    else if (e.kind === "puff") { const k = 18 - e.t; for (let i = 0; i < 7; i++) { ctx.fillStyle = `rgba(160,110,60,${.6 - k / 30})`; ctx.beginPath(); ctx.arc(e.x + Math.cos(i) * k, e.y - k * .4 + Math.sin(i * 2) * k * .3, 3 + k * .2, 0, 7); ctx.fill(); } }
    else if (e.kind === "pop") drawCoin(e.x, e.y - (30 - e.t) * 1.2, f * 4, 0);
    else if (e.kind === "laser") { ctx.save(); ctx.globalCompositeOperation = "lighter"; ctx.lineCap = "round"; [[7, .25], [3.5, .55], [1.4, 1]].forEach(([w, a]) => { ctx.strokeStyle = `rgba(255,${a === 1 ? 220 : 60},${a === 1 ? 200 : 40},${a * e.t / 10})`; ctx.lineWidth = w; ctx.beginPath(); ctx.moveTo(e.x1, e.y1); ctx.lineTo(e.x2, e.y2); ctx.stroke(); }); ctx.restore(); }
    else if (e.kind === "ring") { const k = 1 - e.t / 24; ctx.strokeStyle = e.color; ctx.globalAlpha = 1 - k; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(e.x, e.y, 10 + k * 40, 0, 7); ctx.stroke(); ctx.globalAlpha = 1; }
  });
  // screen space: vignette, names, tags, text, HUD
  SCR();
  const vg = ctx.createRadialGradient(cssW / 2, cssH * .55, Math.min(cssW, cssH) * .3, cssW / 2, cssH / 2, Math.max(cssW, cssH) * .75); vg.addColorStop(0, "rgba(0,0,0,0)"); vg.addColorStop(1, "rgba(5,0,10,.5)"); ctx.fillStyle = vg; ctx.fillRect(0, 0, cssW, cssH);
  const sx = (wx) => (wx - camX) * zoom, sy = (wy) => (wy - camY) * zoom;
  ghosts.forEach((gh) => { const i = Math.min(gh.path.length / 2 - 1, Math.floor(f / 2)) * 2; if (i >= 0) label(gh.name, sx(gh.path[i] + 8), sy(gh.path[i + 1]) - 14, 13, gh.color, .85); });
  introduce(W, sx, sy);
  W.fx.forEach((e) => { if (e.kind === "text") label(e.text, sx(e.x), sy(e.y) - (70 - e.t) * .7, 17, e.color, Math.min(1, e.t / 25)); });
  if (p.dying > 0) { const k = p.dying / 55; ctx.fillStyle = `rgba(60,0,0,${.35 * k})`; ctx.fillRect(0, 0, cssW, cssH); label(p.why ? "REKT · " + p.why : "REKT", cssW / 2, cssH * .42, Math.min(72, cssW / 8), "#ff6b62", Math.min(1, k * 2)); label("+3 s · back to the last checkpoint", cssW / 2, cssH * .42 + Math.min(60, cssW / 10), 18, COL.text, Math.min(1, k * 2)); }
  drawHud(W, ghosts);
}
function pillShown() { const pl = document.getElementById("pill"); return !!pl && !pl.hidden; }
// for tests and measurement (#3270): where the camera is and where the runner is drawn, in CSS pixels of the canvas
function view(W) {
  const p = W && W.p;
  return { cssW, cssH, zoom, camX, camY, viewW, viewH, hudTop: pillShown() ? hudTopPill : hudTop,
    runner: p ? { x: (p.x - camX) * zoom, top: (p.y - camY) * zoom, bottom: (p.y + PH - camY) * zoom } : null };
}
function label(text, x, y, size, color, alpha) {
  ctx.globalAlpha = alpha == null ? 1 : alpha; ctx.font = "700 " + size + "px " + FONT; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.lineWidth = Math.max(3, size / 4); ctx.strokeStyle = "rgba(12,6,8,.9)"; ctx.lineJoin = "round"; ctx.strokeText(text, x, y); ctx.fillStyle = color; ctx.fillText(text, x, y); ctx.globalAlpha = 1;
}
function tag(text, x, y, color, alpha) {
  ctx.globalAlpha = alpha; ctx.font = "700 14px " + FONT; const w = ctx.measureText(text).width + 20; x = Math.max(w / 2 + 8, Math.min(cssW - w / 2 - 8, x)); y = Math.max(hudTop + 16, y);
  ctx.fillStyle = "rgba(14,9,16,.92)"; ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x - w / 2, y - 14, w, 28, 8); else ctx.rect(x - w / 2, y - 14, w, 28); ctx.fill(); ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke();
  ctx.fillStyle = color; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(text, x, y + 1); ctx.globalAlpha = 1;
}
function introduce(W, sx, sy) {
  W.seen = W.seen || {}; W.nextTag = W.nextTag || 250;
  const show = (key, wx, wy, text, color) => { const s = W.seen[key]; if (s === undefined) { if (wx > camX + 30 && wx < camX + viewW - 30) { W.seen[key] = Math.max(W.f, W.nextTag); W.nextTag = W.seen[key] + 320; } return; }
    const age = W.f - s; if (age < 0 || age > 300) return; tag(text, sx(wx), sy(wy) - 24, color, Math.min(1, (300 - age) / 30, (age + 1) / 10)); };
  const e = W.L.enemies.find((x) => !x.kind && x.dead !== 0 && !x.dead && x.x > camX && x.x < camX + viewW); if (e) show("shit", e.x + 10, e.row * T - 20, "SHITCOIN · jump on it", "#d8a25a");
  const br = W.L.enemies.find((x) => x.kind === "bear" && !x.dead && x.dead !== 0 && x.x > camX && x.x < camX + viewW); if (br) show("bear", br.x + 12, br.row * T - 30, "BEAR · it charges, jump on it", "#ff7b72");
  const pr = W.L.enemies.find((x) => x.kind === "printer" && !x.dead && x.dead !== 0 && x.x > camX && x.x < camX + viewW); if (pr) show("printer", pr.x + 12, pr.row * T - 24, "MONEY PRINTER · dodge the bills", "#56d364");
  const c = W.L.clouds.find((x) => x.x > camX && x.x < camX + viewW); if (c) show("fud", c.x + 27, c.y, "FUD STORM · don't touch", "#c8c0dc");
  W.L.items.forEach((it) => { if (it.got || it.rise !== undefined) return; const info = PW_INFO[it.kind]; if (info) show(it.kind, it.x, it.y - 14, info.text, info.color); else show(it.kind, it.x, it.y - 10, it.kind === "bolt" ? "LIGHTNING · 5 s sprint" : "HARDWARE WALLET · shield", it.kind === "bolt" ? COL.gold : COL.blue); });
  const sp = W.L.t.findIndex((v, kk) => v === TILE.SPIKE && (kk % W.L.w) * T > camX && (kk % W.L.w) * T < camX + viewW); if (sp >= 0) show("spike", (sp % W.L.w) * T + 12, Math.floor(sp / W.L.w) * T, "LIQUIDATION · jump over", "#ff7b72");
  const hd = W.L.dayHigh; if (hd && !hd.got) show("high", hd.x, hd.y - 14, "DAY HIGH " + usd(hd.price) + " · +50", COL.gold);
  const r = W.L.t.findIndex((v, kk) => v === TILE.RUG && (kk % W.L.w) * T > camX && (kk % W.L.w) * T < camX + viewW); if (r >= 0) show("rug", (r % W.L.w) * T + 12, Math.floor(r / W.L.w) * T, "RUG PULL · don't stand still", "#ff7b72");
}
let hudKey = "";
function placeHud(x, y, h, small) {
  const snd = document.getElementById("sndBtn"), tag = document.getElementById("modeTag");
  if (!snd || !tag || snd.parentNode.id !== "hudctl") return x;
  const sw = h + 4, tw = Math.max(h, tag.offsetWidth || h);
  const sx = x, tx = small ? cssW - PAD - tw : x + sw + 6, ty = small ? y + h + 6 : y;
  const k = [sx, y, h, tx, ty].map(Math.round).join(",");
  if (k !== hudKey) { hudKey = k;
    Object.assign(snd.style, { left: Math.round(sx) + "px", top: Math.round(y) + "px", height: h + "px", width: sw + "px" });
    Object.assign(tag.style, { left: Math.round(tx) + "px", top: Math.round(ty) + "px", height: h + "px", minWidth: h + "px" }); }
  return small ? x + sw + 6 : x + sw + 6 + tw + 6;
}
function pill(x, y, w, h) { ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x, y, w, h, h / 2); else ctx.rect(x, y, w, h); ctx.fillStyle = "rgba(14,9,16,.82)"; ctx.fill(); ctx.strokeStyle = "rgba(255,255,255,.14)"; ctx.lineWidth = 1.5; ctx.stroke(); }

function drawHud(W, ghosts) {
  const sc = scoreOf(W), L = W.L, small = cssW < 600, fs = small ? 15 : 18, pad = 10, h = fs + 14;
  const cmi = L.colMeta[Math.floor((W.p.x + 8) / T)], m = L.meta[cmi >= 0 ? cmi : 0], onChart = cmi >= 0;
  const pills = [["⏱ " + W.time.toFixed(1) + "s", COL.text], ["₿ " + (W.stats.coins + W.stats.blocks * 5) + " sats", COL.gold], ["★ " + sc.base + (W.stats.hits === 0 ? " ×1.5" : ""), COL.btc]];
  // a phone: tighter pills, so the speaker fits right after the ★ pill (#3251, owner 2026-11-22: "tu das Sound-Icon neben die Sterne")
  const pp = small ? 18 : 24, gap = small ? 5 : 6;
  let x = pad; ctx.font = "700 " + fs + "px " + FONT;
  pills.forEach(([t, c]) => { const w = ctx.measureText(t).width + pp; pill(x, pad, w, h); label(t, x + w / 2, pad + h / 2 + 1, fs, c); x += w + gap; });
  // THE SPEAKER AND THE ROUND'S NUMBER IN THE HUD (#3251): DOM buttons placed on the pill row - the speaker after ★, the round's badge at the
  // right end of the price row on a phone, after the speaker on a wide screen; the stats row leaves them their room
  x = placeHud(x, pad, h, small);
  // price of the candle you stand on
  const ptxt = onChart ? hhmm(m.t) + " UTC  " + usd(m.c) + "  " + (m.move >= 0 ? "▲ " : "▼ ") + Math.abs(m.move * 100).toFixed(2) + "%" : "BTC " + usd(L.meta[L.meta.length - 1].c) + "  24 h " + ((L.meta[L.meta.length - 1].c - L.meta[0].o) / L.meta[0].o * 100).toFixed(1) + "%";
  const pc = onChart ? (m.green ? COL.green : COL.red) : COL.text;
  ctx.font = "700 " + fs + "px " + FONT; let pw = ctx.measureText(ptxt).width + 24, px = small ? pad : x, py = small ? pad + h + 6 : pad;
  pill(px, py, pw, h); label(ptxt, px + pw / 2, py + h / 2 + 1, fs, pc);
  // mini chart of the whole day: every candle, the part you see, you and the ghosts
  const mid = !small && cssW < 900;     // #3270: a phone held sideways - the mini chart on the second row, beside the entry pill
  const mw = small ? cssW - pad * 2 : mid ? Math.min(360, cssW * .5) : Math.min(420, Math.max(220, cssW - (px + pw) - pad * 3)), mh = mid ? 40 : 58, mx = small ? pad : cssW - mw - pad, my = small ? py + h + 6 : mid ? pad + h + 6 : pad;
  ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(mx, my, mw, mh, 12); else ctx.rect(mx, my, mw, mh); ctx.fillStyle = "rgba(14,9,16,.84)"; ctx.fill(); ctx.strokeStyle = "rgba(255,255,255,.14)"; ctx.lineWidth = 1.5; ctx.stroke();
  const ix = mx + 10, iw = mw - 20, iy = my + 8, ih = mh - 16, lvl = L.goal * T, toX = (wx) => ix + Math.max(0, Math.min(1, wx / lvl)) * iw;
  const hiP = Math.max(...L.meta.map((c) => c.h)), loP = Math.min(...L.meta.map((c) => c.l)), toY = (pp) => iy + (hiP - pp) / (hiP - loP || 1) * ih;
  const vx0 = toX(camX), vx1 = toX(camX + viewW); ctx.fillStyle = "rgba(255,255,255,.08)"; ctx.fillRect(vx0, iy - 3, vx1 - vx0, ih + 6); ctx.strokeStyle = "rgba(255,255,255,.35)"; ctx.lineWidth = 1; ctx.strokeRect(vx0 + .5, iy - 2.5, vx1 - vx0 - 1, ih + 5);
  L.meta.forEach((c) => { const cx = toX((c.x0 + 1.5) * T), w = Math.max(2, iw / L.meta.length * .6); ctx.fillStyle = c.green ? "#3fb950" : "#f85149"; ctx.fillRect(cx - .5, toY(c.h), 1, Math.max(1, toY(c.l) - toY(c.h))); ctx.fillRect(cx - w / 2, toY(Math.max(c.o, c.c)), w, Math.max(1.5, toY(Math.min(c.o, c.c)) - toY(Math.max(c.o, c.c)))); });
  const fxm = toX(L.goal * T); ctx.fillStyle = COL.btc; ctx.fillRect(fxm - 1, iy - 2, 2, ih + 4);
  const dot = (wx, c, r) => { ctx.beginPath(); ctx.arc(toX(wx), my + mh - 6, r, 0, 7); ctx.fillStyle = c; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = "#0c0608"; ctx.stroke(); };
  ghosts.forEach((gh) => { const i = Math.min(gh.path.length / 2 - 1, Math.floor(W.f / 2)) * 2; if (i >= 0) dot(gh.path[i], gh.color, 4.5); }); dot(W.p.x, COL.btc, 6);
  const act = []; if (W.p.boost > 0) act.push(["⚡ " + Math.ceil(W.p.boost / 60) + " s", COL.gold]);
  PW_ORDER.forEach((k) => { const t = W.p.pw[k]; if (t > 0) act.push([PW_INFO[k].icon + " " + PW_INFO[k].text.split(" · ")[0].replace(/^\w/, (c) => c) + (k === "pill" ? "" : " " + Math.ceil(t / 60) + " s"), PW_INFO[k].color]); });
  act.forEach(([txt, c], i) => label(txt, cssW / 2, (pillShown() ? hudTopPill : hudTop) + 14 + i * (small ? 20 : 25), small ? 15 : 19, c, 1));
}


export { fit, drawWorld, view, COL, usd };
