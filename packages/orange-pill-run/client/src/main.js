// Orange Pill Run - the client loop, input and recording (kanban #3246). The simulation runs at a fixed 60 steps
// per second (src/sim), independent of the frame rate; every step's jump state goes into the input log
// { v, presses: [[downStep, upStep], ...] }, which src/sim/replay.js runLog turns into the same score in Node.
// Modes: play (one button: tap anywhere, Space, ArrowUp), bot (the scripted player, ?bot), replay(log).
// The intro and result screens below are the prototype's placeholders; phase 3 (#3251) replaces them through
// the hooks in window.OPR (day, onStart, onFinish, showIntro, showResult).
import { GAME_VERSION, STEP, MAX_STEPS } from "../../src/sim/constants.js";
import { buildLevel } from "../../src/sim/level.js";
import { newWorld, stepWorld } from "../../src/sim/world.js";
import { botInput, BOT_CONFIGS } from "../../src/sim/bot.js";
import { resultOf, validateLog } from "../../src/sim/replay.js";
import { fit, drawWorld, usd } from "./render.js";

const HOOKS = (window.OPR = window.OPR || {});
// the day: { candles, seed, source, from, to, roundId?, stale? } - set by the page before this script, or the embedded practice day
const DAY = HOOKS.day || window.OPR_DAY;
const L = buildLevel(DAY.candles, DAY.seed);
const $ = (id) => document.getElementById(id);

let W = null, running = false, acc = 0, last = 0, mode = "idle";
let presses = [], down = -1, botCfg = null, replayLog = null, replayIdx = 0, speed = 1;
let lastLog = null, lastResult = null;
const input = { jump: false };
const keyMap = { Space: "jump", ArrowUp: "jump", KeyW: "jump" };

const KEY = "orange-pill-run-chart-" + DAY.to + "-" + DAY.seed; let saved = { best: [] };
try { const s = JSON.parse(localStorage.getItem(KEY) || "null"); if (s && Array.isArray(s.best)) saved = s; } catch (_) {}
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch (_) {} };

function jumpNow() {
  const s = W.f;
  if (mode === "bot") return botInput(W, botCfg).jump;
  if (mode === "replay") { const ps = replayLog.presses; while (replayIdx < ps.length && ps[replayIdx][1] <= s) replayIdx++; return replayIdx < ps.length && ps[replayIdx][0] <= s; }
  return input.jump;
}
function step() {
  const s = W.f, j = jumpNow();
  if (j && down < 0) down = s; else if (!j && down >= 0) { presses.push([down, s]); down = -1; }
  stepWorld(W, { jump: j });
}
function begin(m, opts = {}) {
  mode = m; W = newWorld(L); presses = []; down = -1; replayIdx = 0; speed = opts.speed || 1;
  botCfg = m === "bot" ? { ...BOT_CONFIGS[opts.bot || 0] } : null;
  document.body.classList.add("playing"); running = true; acc = 0; last = performance.now();
  $("intro").hidden = true; $("result").hidden = true;
  if (HOOKS.onStart) try { HOOKS.onStart({ mode, gameVersion: GAME_VERSION }); } catch (_) {}
  requestAnimationFrame(loop);
}
function loop(now) {
  if (!running) return;
  acc += Math.max(0, Math.min(.1, (now - last) / 1000)) * speed; last = now;
  while (acc >= STEP && !W.done && W.f < MAX_STEPS) { step(); acc -= STEP; }
  drawWorld(W, []);
  if (W.done || W.f >= MAX_STEPS) return finish();
  requestAnimationFrame(loop);
}
function finish() {
  running = false; document.body.classList.remove("playing");
  if (down >= 0) { presses.push([down, W.f]); down = -1; }
  const log = { v: GAME_VERSION, presses }, res = resultOf(W);
  lastLog = log; lastResult = { ...res, mode };
  if (HOOKS.onFinish) { try { if (HOOKS.onFinish(log, lastResult, W) === false) return; } catch (_) {} }
  showResult(res);
}
function showResult(res) {
  const sc = { parts: res.parts, total: res.total, clean: res.clean, par: L.parTime }, finished = res.finished;
  $("rTitle").textContent = mode === "replay" ? "Replay: " + (finished ? "flag in " + res.timeS.toFixed(1) + " s" : "time is up") : finished ? "Flag reached in " + res.timeS.toFixed(1) + " s" : "Time is up";
  $("rText").textContent = (res.deaths ? res.deaths + (res.deaths > 1 ? " deaths" : " death") + ": +" + (res.deaths * 3) + " s on your time, and no ×1.5 bonus." : finished ? "No deaths: score ×1.5." : "") + (W.stats.high ? " You reached the day high." : " The day high (" + usd(L.dayHigh.price) + ") is worth 50 extra.");
  const t1 = $("rScore"); t1.textContent = ""; const add = (a, v, cl) => cellRow(t1.insertRow(), [a, v], cl);
  add("Sats (coins and ₿ blocks)", sc.parts.sats); add("Shitcoins stomped × 10", sc.parts.stomps); add("Flag reached", sc.parts.goal); add("Time bonus (2 per second under " + sc.par + " s)", sc.parts.time); add("Day high", sc.parts.high); if (sc.clean) add("No hits", "×1.5"); add("Total", sc.total, [null, "tot"]);
  if (mode === "play") { saved.best.push({ score: sc.total, time: res.timeS, finished }); saved.best.sort((a, z) => z.score - a.score); saved.best = saved.best.slice(0, 5); save(); }
  const t3 = $("rBest"); t3.textContent = ""; cellRow(t3.createTHead().insertRow(), ["#", "Time", "Score"], null, true); const b3 = t3.createTBody();
  saved.best.forEach((x, i) => cellRow(b3.insertRow(), [String(i + 1), x.finished ? x.time.toFixed(1) + " s" : "no flag", x.score], [null, null, "tot"]));
  $("result").hidden = false; $("againBtn").focus();
}
const cellRow = (tr, cells, cls, th) => cells.forEach((c, i) => { const td = document.createElement(th ? "th" : "td"); td.textContent = c; if (cls && cls[i]) td.className = cls[i]; tr.append(td); });
function idle() { drawWorld(newWorld(L), []); }
function showIntro() {
  const cs = DAY.candles, open = cs[0][1], lastC = cs[cs.length - 1][4], ch = (lastC - open) / open * 100, el = $("iPrice"); el.textContent = "";
  const bb = document.createElement("b"), sp = document.createElement("span"), sm = document.createElement("small");
  bb.textContent = "BTC " + usd(lastC); sp.className = ch >= 0 ? "up" : "dn"; sp.textContent = (ch >= 0 ? "▲ " : "▼ ") + Math.abs(ch).toFixed(1) + "% in 24 h";
  const end = cs[cs.length - 1][0] + 1800;
  sm.textContent = cs.length + " candles of 30 min · " + (DAY.source || "Coinbase BTC-USD") + " · until " + new Date(end * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC" + (DAY.stale ? " · yesterday's chart again" : "");
  el.append(bb, sp, sm); $("intro").hidden = false; $("result").hidden = true;
}

// input: one button. Tap anywhere, Space, ArrowUp; on phones no selection, long-press menu or zoom while playing.
addEventListener("keydown", (e) => { const kk = keyMap[e.code]; if (!kk) return; input[kk] = true; if (running) e.preventDefault(); });
addEventListener("keyup", (e) => { const kk = keyMap[e.code]; if (kk) input[kk] = false; });
{ const bt = $("pJ"); const on = (e) => { input.jump = true; bt.classList.add("held"); e.preventDefault(); }, off = () => { input.jump = false; bt.classList.remove("held"); };
  bt.addEventListener("pointerdown", on); bt.addEventListener("pointerup", off); bt.addEventListener("pointercancel", off); bt.addEventListener("pointerleave", off); }
document.addEventListener("pointerdown", (e) => { if (running) { input.jump = true; if (e.cancelable) e.preventDefault(); } }, { passive: false });
["pointerup", "pointercancel"].forEach((ev) => document.addEventListener(ev, () => { input.jump = false; }));
["touchstart", "touchmove", "gesturestart", "dblclick"].forEach((ev) => document.addEventListener(ev, (e) => { if (running && e.cancelable) e.preventDefault(); }, { passive: false }));
document.addEventListener("selectstart", (e) => { if (running) e.preventDefault(); });
document.addEventListener("contextmenu", (e) => { if (running) e.preventDefault(); });
$("startBtn").onclick = () => begin("play"); $("againBtn").onclick = () => begin("play");
addEventListener("resize", () => { fit(); if (!running) (W ? drawWorld(W, []) : idle()); });

// the API for the page (phase 3) and for tests
Object.assign(HOOKS, {
  gameVersion: GAME_VERSION, level: L,
  play: () => begin("play"),
  playBot: (opts = {}) => begin("bot", opts),
  replay(log, opts = {}) { const bad = validateLog(log); if (bad) throw new TypeError(bad); replayLog = log; begin("replay", opts); },
  state: () => ({ running, mode, f: W ? W.f : 0, done: W ? W.done : false }),
  lastLog: () => lastLog, lastResult: () => lastResult,
  showIntro, showResult: (r) => showResult(r || lastResult),
});
fit(); idle(); showIntro();
const q = new URLSearchParams(location.search);
if (q.has("bot")) begin("bot", { bot: +q.get("bot") || 0, speed: +q.get("speed") || 1 });
