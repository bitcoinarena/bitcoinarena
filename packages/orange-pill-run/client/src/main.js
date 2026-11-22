// Orange Pill Run - the client loop, input, recording and screens (kanban #3246, #3251, #3265). The simulation runs at a fixed 60 steps
// per second (src/sim), independent of the frame rate; every step's jump state goes into the input log
// { v, presses: [[downStep, upStep], ...] }, which src/sim/replay.js runLog turns into the same score in Node (the service scores that log).
// Modes: play (one button: tap anywhere, Space, ArrowUp), bot (the scripted player, ?bot), replay(log) with pause and 2x.
// THE ARENA AROUND THE GAME (#3265): the Arena page loads this file in a frame of its own origin (?game=orange-pill-run) and hands it
// window.ARENA_OPR - the identity key's sign-in, the wallet's balance, the page's pay-an-invoice path, the welcome's state and the bug bounty's
// X link. Without it (the file on its own) the game is practice only.
import { GAME_VERSION, VERSIONS, rulesOf, STEP, MAX_STEPS } from "../../src/sim/constants.js";
import { buildLevel } from "../../src/sim/level.js";
import { newWorld, stepWorld } from "../../src/sim/world.js";
import { botInput, BOT_CONFIGS } from "../../src/sim/bot.js";
import { resultOf, validateLog } from "../../src/sim/replay.js";
import { fit, drawWorld, view, usd } from "./render.js";
import { makeApi } from "./api.js";
import { createEntry, entryOf } from "./entry.js";
import { introModel, resultModel, entryLine, myBest, boardRows, fmtSats, fmtTime } from "./screens.js";
import { RULES, RULES_TITLE } from "./rules.js";

const HOOKS = (window.OPR = window.OPR || {});
// the practice day: { candles, seed, source, from, to } - set by the page before this script, or the embedded one
const DAY = HOOKS.day || window.OPR_DAY;
let L = buildLevel(DAY.candles, DAY.seed), levelOf = "practice";
const $ = (id) => document.getElementById(id);

// ---------- the bridge to the Arena page ----------
function findBridge() {
  if (HOOKS.bridge) return HOOKS.bridge;
  try { if (window.parent && window.parent !== window && window.parent.ARENA_OPR && window.parent.ARENA_OPR.v) return window.parent.ARENA_OPR; } catch (_) { /* another origin */ }
  try { if (window.ARENA_OPR && window.ARENA_OPR.v) return window.ARENA_OPR; } catch (_) { /* none */ }
  return null;
}
// THE GAME'S ADDRESS ON ITS OWN OPENS THE ARENA AROUND IT (#3265): games/orange-pill-run/ in a tab of its own goes to the page's game link,
// which makes or opens the wallet; ?practice keeps the file alone
{ const q = new URLSearchParams(location.search);
  if (window.top === window && !HOOKS.bridge && /^https:$/.test(location.protocol) && /\/games\/orange-pill-run\/(index\.html)?$/.test(location.pathname) && !q.has("practice") && !q.has("bot"))
    location.replace(location.pathname.replace(/games\/orange-pill-run\/(index\.html)?$/, "") + "?game=orange-pill-run" + (location.hash || "")); }
const bridge = findBridge();
if (bridge) document.body.classList.add("bridged");
const api = bridge ? makeApi({ base: bridge.apiBase || location.origin + "/api/opr", signBase: bridge.signBase || bridge.apiBase || location.origin + "/api/opr", bridge, fetch: (u, o) => fetch(u, o) }) : null;
let vault = null; try { vault = window.localStorage; } catch (_) { vault = null; }
const entry = api ? createEntry({ api, bridge, store: vault, log: (m) => console.log("[opr] " + m) }) : null;
const wallet = () => {
  if (!bridge) return null;
  let pubkey = null, balance = null, welcomeComing = false;
  try { pubkey = bridge.pubkey(); } catch (_) { pubkey = null; }
  try { balance = bridge.balance(); } catch (_) { balance = null; }
  try { welcomeComing = !!bridge.welcomeComing(); } catch (_) { welcomeComing = false; }
  return { pubkey, balance, welcomeComing };
};

// ---------- the loop ----------
let W = null, running = false, paused = false, acc = 0, last = 0, mode = "idle";
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
const SHEETS = ["intro", "result", "board", "rules"];
const showSheet = (id) => { for (const s of SHEETS) $(s).hidden = s !== id; };
function begin(m, opts = {}) {
  mode = m; W = newWorld(L); presses = []; down = -1; replayIdx = 0; speed = opts.speed || 1; paused = false; input.jump = false;
  botCfg = m === "bot" ? { ...BOT_CONFIGS[opts.bot || 0] } : null;
  document.body.classList.add("playing"); document.body.classList.toggle("replaying", m === "replay"); running = true; acc = 0; last = performance.now();
  showSheet(null); if (m !== "play") pill("", "");
  $("rbar").hidden = m !== "replay"; $("rbPlay").textContent = "Pause"; $("rb2x").setAttribute("aria-pressed", String(speed === 2));
  if (HOOKS.onStart) try { HOOKS.onStart({ mode, gameVersion: GAME_VERSION }); } catch (_) {}
  requestAnimationFrame(loop);
}
function loop(now) {
  if (!running) return;
  const dt = Math.max(0, Math.min(.1, (now - last) / 1000)); last = now;
  if (!paused) acc += dt * speed;
  while (acc >= STEP && !W.done && W.f < MAX_STEPS) { step(); acc -= STEP; }
  drawWorld(W, []);
  if (W.done || W.f >= MAX_STEPS) return finish();
  requestAnimationFrame(loop);
}
function finish() {
  running = false; document.body.classList.remove("playing", "replaying"); $("rbar").hidden = true; pill("", "");
  if (down >= 0) { presses.push([down, W.f]); down = -1; }
  const res = resultOf(W);
  if (mode !== "replay") { lastLog = { v: L.version, presses }; lastResult = { ...res, mode }; }
  if (HOOKS.onFinish) { try { if (HOOKS.onFinish(lastLog, { ...res, mode }, W) === false) return; } catch (_) {} }
  if (mode === "play" && run) return sendRun(res);
  showResult({ res, mode, entry: mode === "play" ? "practice" : null });
}

// ---------- the service: round, me, board ----------
const S = { round: null, me: null, board: [], err: null, at: 0, loaded: false };   // loaded: the first GET /round has answered (#3251)
let run = null;   // the attempt being played: { attempt, token, level, invoice, sats, deadlineMs, before, payer, entry, entryWhy, sent }
async function refresh() {
  if (!api) return;
  const [r, b] = await Promise.all([api.get("/round"), api.get("/board")]);
  S.round = r.ok ? r.round : null; S.err = r.ok ? null : r.why; S.loaded = true;
  S.board = b.ok ? b.board : [];
  const w = wallet();
  if (w && w.pubkey) { const m = await api.getSigned("/me" + (S.round ? "?round=" + encodeURIComponent(S.round.id) : "")); if (m.ok) S.me = m; }
  S.at = Date.now();
}
function paintWallet() {
  const w = wallet(), el = $("wal");
  if (!w) { el.hidden = true; return; }
  el.hidden = false; el.textContent = "";
  if (!w.balance) { el.textContent = w.welcomeComing ? "Wallet: welcome sats on their way …" : "Wallet: opening …"; return; }
  const b = document.createElement("b"); b.textContent = fmtSats(w.balance.sats);
  el.append("Wallet: ", b, " testnet sats" + (w.welcomeComing && Number(w.balance.sats) < 100 ? " · welcome on its way" : ""));
}
function paintIntro() {
  const m = introModel({ round: S.round, me: S.me, board: S.board, wallet: wallet(), nowMs: Date.now(), loading: !S.loaded });
  $("iLine").textContent = m.line;
  $("iBounty").hidden = !m.bounty; $("iBounty").textContent = m.bounty || "";
  const dl = $("iFacts"); dl.textContent = ""; dl.hidden = !m.facts;
  for (const [k, v, cls] of m.facts || []) { const d = document.createElement("div"); if (cls) d.className = cls; const dt = document.createElement("dt"), dd = document.createElement("dd"); dt.textContent = k; dd.textContent = v; d.append(dt, dd); dl.append(d); }
  $("iPrice").hidden = !m.practice;
  // #3270: the X account on the intro, so a player can link it before the first run (it was only on the result screen)
  $("iX").hidden = !m.x; $("iXText").textContent = m.x ? m.x.text : "";
  $("iXBtn").hidden = !(m.x && m.x.link && bridge && bridge.linkX);
  const btn = $("startBtn"); if (!btn.dataset.busy) { btn.textContent = m.button.label; btn.disabled = !!m.button.disabled; }
  if (!$("iWhy").dataset.err) $("iWhy").textContent = m.button.why || (S.err && bridge ? S.err : "");
  $("modeTag").textContent = !bridge ? "OFFLINE · PRACTICE" : S.round ? (S.round.test ? "TEST ROUND " : "ROUND ") + (S.round.number || "") : "TESTNET";
  paintWallet();
  HOOKS.intro = m;
}
function showIntro() {
  showSheet("intro"); $("rbar").hidden = true; paintPractice(); paintIntro();
  if (api && Date.now() - S.at > 5000) refresh().then(paintIntro).catch(() => {});
}
function paintPractice() {
  const cs = DAY.candles, open = cs[0][1], lastC = cs[cs.length - 1][4], ch = (lastC - open) / open * 100, el = $("iPrice"); el.textContent = "";
  const bb = document.createElement("b"), sp = document.createElement("span"), sm = document.createElement("small");
  bb.textContent = "BTC " + usd(lastC); sp.className = ch >= 0 ? "up" : "dn"; sp.textContent = (ch >= 0 ? "▲ " : "▼ ") + Math.abs(ch).toFixed(1) + "% in 24 h";
  sm.textContent = "practice chart · " + (DAY.source || "Coinbase BTC-USD");
  el.append(bb, sp, sm);
}
setInterval(() => { if (!$("intro").hidden) { paintIntro(); if (api && Date.now() - S.at > 20000) refresh().then(paintIntro).catch(() => {}); } else paintWallet(); }, 1000);

// ---------- one attempt (#3265: it starts at once; the entry is paid in the background) ----------
const pill = (kind, text) => { const p = $("pill"); p.hidden = !text; p.className = kind || ""; p.textContent = text || ""; };
const PILL = { "waiting-welcome": ["wait", "Entry: waiting for your welcome sats …"], "waiting-balance": ["wait", "Entry: waiting for 100 sats in your wallet"],
  paying: ["wait", "Entry: paying 100 sats …"], confirming: ["wait", "Entry: paid, confirming …"], paid: ["ok", "Entry paid"], "not-paid": ["bad", "Entry not paid - this run does not count"],
  "pay-failed": ["bad", "Entry not paid yet - trying again"] };
function onEntry(kind, why) {
  if (!run) return;
  run.status = kind; run.statusWhy = why || null;
  if (kind === "paid") run.entry = "paid"; else if (kind === "not-paid") { run.entry = "not-paid"; run.entryWhy = why || null; }
  const p = PILL[kind]; if (running && mode === "play") pill(p ? p[0] : "", p ? p[1] + (kind === "pay-failed" && why ? " (" + why + ")" : "") : "");
  if (!$("result").hidden && run.shown) paintEntry();
  HOOKS.entryStatus = { kind, why: why || null };
}
function useLevel(level) {
  if (!level || !Array.isArray(level.candles)) throw new Error("the round sent no level");
  // a round plays the version it was opened with (kanban #3271: an opr-1 round keeps opr-1 after the page moved on)
  const v = level.gameVersion || GAME_VERSION;
  if (!Object.prototype.hasOwnProperty.call(VERSIONS, v)) throw new Error("this page plays " + GAME_VERSION + ", the round " + v + " - reload the page");
  L = buildLevel(level.candles, level.seed, v); levelOf = level.round || "round";
}
async function play() {
  if (!api) return begin("play");
  const btn = $("startBtn"), why = $("iWhy");
  btn.dataset.busy = "1"; btn.disabled = true; btn.textContent = "Starting …"; why.dataset.err = ""; why.textContent = "";
  const fail = (t) => { delete btn.dataset.busy; why.dataset.err = "1"; why.textContent = t; paintIntro(); setTimeout(() => { delete why.dataset.err; }, 8000); };
  try {
    if (!S.round) await refresh();
    if (!S.round) return fail(S.err || "No round is open right now.");
    const before = S.me ? myBest(S.me, S.board) : null;
    const a = await entry.start(S.round.id);
    if (!a.ok) { await refresh().catch(() => {}); return fail(a.why); }
    run = { ...a, round: S.round.id, before, entry: null, status: null };
    if (!a.level || !a.token) {
      // the older service: paid first, then the run
      btn.textContent = "Paying the entry …";
      const st = await entry.waitStarted(a, { onStatus: (k, w) => { const p = PILL[k]; why.textContent = p ? p[1] + (w ? " (" + w + ")" : "") : ""; } });
      if (!st.ok) { run = null; return fail(st.why); }
      Object.assign(run, { token: st.token, level: st.level, deadlineMs: st.deadlineMs, entry: "paid" });
    }
    useLevel(run.level);
    delete btn.dataset.busy;
    if (run.entry !== "paid") run.payer = entry.payInBackground(run, { onStatus: onEntry });
    begin("play");
  } catch (e) { run = null; fail((e && e.message) || String(e)); }
}
async function sendRun(res) {
  const mine = run; mine.shown = false;
  showResult({ res, mode: "play", entry: mine.entry || "waiting", sending: true });
  mine.shown = true;
  const client = { ua: String(navigator.userAgent || "").slice(0, 160), w: innerWidth, h: innerHeight, touch: "ontouchstart" in window, v: GAME_VERSION };
  const r = await entry.submit({ attempt: mine.attempt, token: mine.token, round: mine.round, log: lastLog, client });
  mine.sent = r;
  if (!r.ok) mine.submitWhy = r.why || "not taken";
  // the entry's state as the service says it now; a waiting entry is asked again until it is decided or the attempt's time is over
  if (r.ok && entryOf(r) === "paid") mine.entry = "paid";   // the service's word on the submit: paid: true, scored
  const e = await entry.entryNow(mine.attempt).catch(() => ({ entry: null }));
  if (e.entry === "paid" || e.entry === "not-paid") { mine.entry = e.entry; if (e.entry === "not-paid") mine.entryWhy = (e.check && e.check.why) || null; }
  await refresh().catch(() => {});
  if (run === mine) showResult({ res, mode: "play", entry: mine.entry || "waiting" });
  if (mine.entry !== "paid" && mine.entry !== "not-paid") watchEntry(mine, res);
  else if (mine.payer) mine.payer.stop();
}
async function watchEntry(mine, res) {
  const until = (mine.deadlineMs || Date.now() + 10 * 60000) + 90000;
  while (run === mine && Date.now() < until && mine.entry !== "paid" && mine.entry !== "not-paid") {
    await new Promise((ok) => setTimeout(ok, 3000));
    const e = await entry.entryNow(mine.attempt).catch(() => ({ entry: null }));
    if (e.entry === "paid" || e.entry === "not-paid") {
      mine.entry = e.entry; if (e.entry === "not-paid") mine.entryWhy = (e.check && e.check.why) || null;
      await refresh().catch(() => {});
      if (run === mine && !$("result").hidden) showResult({ res, mode: "play", entry: mine.entry });
    }
  }
  if (mine.payer) mine.payer.stop();
}

// ---------- the screens ----------
const cellRow = (tr, cells, cls, th) => cells.forEach((c, i) => { const td = document.createElement(th ? "th" : "td"); if (c instanceof Node) td.append(c); else td.textContent = c == null ? "" : c; if (cls && cls[i]) td.className = cls[i]; tr.append(td); });
function paintEntry() {
  if (!run) return;
  const l = entryLine(run.entry || "waiting", run.entryWhy);
  const el = $("rEntry"); el.className = "entry " + l.kind; el.textContent = l.text;
}
function showResult({ res, mode: m, entry: en, sending = false }) {
  const after = S.me ? myBest(S.me, S.board) : null;
  const model = resultModel({ res, parTime: L.parTime, timePerS: rulesOf(L.version).timePerS, entry: en, entryWhy: run && run.entryWhy, before: run && m === "play" ? run.before : null, after: m === "play" && run ? after : null,
    me: m === "play" && run ? S.me : null, max: S.round ? S.round.maxAttempts : 5, mode: m === "play" && !run ? "practice" : m, submitWhy: run && run.submitWhy });
  $("rTitle").textContent = model.title;
  const re = $("rEntry"); re.hidden = !en; if (en) { re.className = "entry " + model.entry.kind; re.textContent = sending ? "Sending your run …" : model.entry.text; }
  const t1 = $("rScore"); t1.textContent = ""; const add = (a, v, cl) => cellRow(t1.insertRow(), [a, v], cl);
  for (const [a, v] of model.rows) add(a, v); add("Total", model.total, [null, "tot"]);
  $("rRefused").hidden = !model.refused; $("rRefused").textContent = model.refused || "";
  if (m === "play" && !run) {   // practice: the browser's own best runs on this chart
    saved.best.push({ score: res.total, time: res.timeS, finished: res.finished }); saved.best.sort((a, z) => z.score - a.score); saved.best = saved.best.slice(0, 5); save();
    model.rank = "Practice best: " + saved.best[0].score; model.left = bridge ? "" : "Open the game in the Arena to play for the pot.";
  }
  $("rRank").textContent = model.rank || ""; $("rBeat").textContent = model.beat || ""; $("rLeft").textContent = model.left || "";
  $("rX").hidden = !model.xPrompt; $("rXText").textContent = model.xPrompt || "";
  $("xBtn").hidden = !(bridge && bridge.linkX) || !(S.me && !S.me.x);
  const used = S.me ? Number(S.me.used || 0) : 0, max = S.round ? Number(S.round.maxAttempts || 5) : 5;
  $("againBtn").textContent = run && used >= max ? "Back" : "Play again";
  $("replayBtn").disabled = !lastLog;
  $("rBoardBtn").hidden = !api;
  showSheet("result"); $("againBtn").focus();
  HOOKS.result = { ...model, entryKind: en, sending };
}
async function showBoard() {
  showSheet("board");
  const t = $("bTable"); t.textContent = ""; $("bLine").textContent = "Reading …";
  if (!api) { $("bLine").textContent = "The leaderboard is in the Arena."; return; }
  const b = await api.get("/board" + (S.round ? "?round=" + encodeURIComponent(S.round.id) : ""));
  if (!b.ok) { $("bLine").textContent = b.why || "not read"; return; }
  S.board = b.board || [];
  const r = b.round;
  $("bLine").textContent = r ? (r.test ? "Test round " : "Round ") + (r.number || "") + " · " + r.players + " players · pot " + fmtSats(r.potSats) + " testnet sats" : "";
  const rows = boardRows(S.board);
  cellRow(t.createTHead().insertRow(), ["#", "Player", "Score", "Time", ""], null, true);
  const body = t.createTBody();
  if (!rows.length) cellRow(body.insertRow(), ["", "No run yet", "", "", ""]);
  // own runs: their replays are always yours to watch (GET /me's attempts)
  const ownBest = S.me ? myBest(S.me, S.board) : null;
  for (const x of rows) {
    const tr = body.insertRow(); if (S.me && x.name === S.me.name) tr.className = "me";
    let rp = x.replay; if (!rp && ownBest && S.me && x.name === S.me.name) rp = "/replay/" + ownBest.attempt;
    let cell = "";
    if (rp) { cell = document.createElement("button"); cell.className = "rp"; cell.type = "button"; cell.textContent = "Replay"; cell.onclick = () => watchReplay(rp); }
    cellRow(tr, [x.rank, x.name + (x.placed ? " ✓" : ""), x.score, x.time, cell], [null, null, "tot", null, null]);
  }
}
async function watchReplay(path) {
  try {
    let j = await api.get(path);
    if (!j.ok && j.status === 403 && wallet() && wallet().pubkey) j = await api.getSigned(path);
    if (!j.ok) { $("bLine").textContent = j.why || "no replay"; return; }
    useLevel(j.level); const bad = validateLog(j.log); if (bad) throw new Error(bad);
    replayLog = j.log; begin("replay");
  } catch (e) { $("bLine").textContent = (e && e.message) || String(e); }
}
function showRules() {
  showSheet("rules"); $("rulesTitle").textContent = RULES_TITLE;
  const ol = $("rulesList"); if (ol.childElementCount) return;
  for (const [k, v] of RULES) { const li = document.createElement("li"), b = document.createElement("b"); b.textContent = k + ". "; li.append(b, v); ol.append(li); }
}

// input: one button. Tap anywhere, Space, ArrowUp; on phones no selection, long-press menu or zoom while playing.
addEventListener("keydown", (e) => { const kk = keyMap[e.code]; if (!kk) return; input[kk] = true; if (running) e.preventDefault(); });
addEventListener("keyup", (e) => { const kk = keyMap[e.code]; if (kk) input[kk] = false; });
{ const bt = $("pJ"); const on = (e) => { input.jump = true; bt.classList.add("held"); e.preventDefault(); }, off = () => { input.jump = false; bt.classList.remove("held"); };
  bt.addEventListener("pointerdown", on); bt.addEventListener("pointerup", off); bt.addEventListener("pointercancel", off); bt.addEventListener("pointerleave", off); }
document.addEventListener("pointerdown", (e) => { if (running && mode === "play" && !e.target.closest("#rbar")) { input.jump = true; if (e.cancelable) e.preventDefault(); } }, { passive: false });
["pointerup", "pointercancel"].forEach((ev) => document.addEventListener(ev, () => { input.jump = false; }));
["touchstart", "touchmove", "gesturestart", "dblclick"].forEach((ev) => document.addEventListener(ev, (e) => { if (running && mode === "play" && e.cancelable) e.preventDefault(); }, { passive: false }));
document.addEventListener("selectstart", (e) => { if (running) e.preventDefault(); });
document.addEventListener("contextmenu", (e) => { if (running) e.preventDefault(); });
$("startBtn").onclick = () => { if (!$("startBtn").disabled) play(); };
$("againBtn").onclick = () => { if (run) { if (run.payer && (run.entry === "paid" || run.entry === "not-paid")) run.payer.stop(); run = null; } pill("", ""); showIntro(); };
$("replayBtn").onclick = () => { if (!lastLog) return; replayLog = lastLog; begin("replay"); };
$("rBoardBtn").onclick = () => showBoard();
$("bBack").onclick = () => showIntro();
$("rulesBack").onclick = () => showIntro();
$("rulesLink").onclick = (e) => { e.preventDefault(); showRules(); };
$("boardLink").onclick = (e) => { e.preventDefault(); showBoard(); };
$("xBtn").onclick = () => { try { bridge.linkX(); } catch (_) { /* the page has no link here */ } };
$("iXBtn").onclick = $("xBtn").onclick;
$("rbPlay").onclick = () => { paused = !paused; $("rbPlay").textContent = paused ? "Play" : "Pause"; };
$("rb2x").onclick = () => { speed = speed === 2 ? 1 : 2; $("rb2x").setAttribute("aria-pressed", String(speed === 2)); };
$("rbClose").onclick = () => { running = false; document.body.classList.remove("playing", "replaying"); $("rbar").hidden = true; showIntro(); };
// kanban #3270: refit whenever the stage changes size, not only the window. The JUMP pad appears when a run starts and takes
// ~70 px from the stage; with a window resize alone the canvas kept its old height and the stage clipped the ground off.
const refit = () => { fit(); if (!running) (W ? drawWorld(W, []) : idle()); };
addEventListener("resize", refit);
if (typeof ResizeObserver === "function") { let sz = ""; new ResizeObserver(() => { const st = $("stage"), k = st.clientWidth + "x" + st.clientHeight; if (k !== sz) { sz = k; refit(); } }).observe($("stage")); }
function idle() { drawWorld(newWorld(L), []); }

// the API for the page and for tests
Object.assign(HOOKS, {
  gameVersion: GAME_VERSION, get level() { return L; }, levelOf: () => levelOf, bridged: !!bridge,
  play: () => begin("play"), enter: () => play(),
  playBot: (opts = {}) => begin("bot", opts),
  replay(log, opts = {}) { const bad = validateLog(log); if (bad) throw new TypeError(bad); replayLog = log; begin("replay", opts); },
  state: () => ({ running, paused, speed, mode, f: W ? W.f : 0, done: W ? W.done : false, run: run ? { attempt: run.attempt, entry: run.entry, status: run.status } : null }),
  view: () => view(W), lastLog: () => lastLog, lastResult: () => lastResult, service: () => ({ ...S }),
  showIntro, showResult: (r) => showResult({ res: r || lastResult, mode: "play", entry: "practice" }), showBoard, showRules,
});
fit(); idle(); showIntro();
if (api) refresh().then(paintIntro).catch(() => {});
if (location.hash === "#rules") showRules(); else if (location.hash === "#board") showBoard();
const q = new URLSearchParams(location.search);
if (q.has("bot")) begin("bot", { bot: +q.get("bot") || 0, speed: +q.get("speed") || 1 });
