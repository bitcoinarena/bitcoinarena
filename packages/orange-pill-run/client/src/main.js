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
import { introModel, resultModel, entryLine, myBest, boardRows, fmtSats, fmtTime, lnFieldModel, usedOf, isFree, xFieldModel, xSaveAnswer, xHandleOf } from "./screens.js";
import { RULES, RULES_TITLE } from "./rules.js";
import { makeAudio, snapWorld, worldEvents } from "./audio.js";
import { makeClock, snapMovers, drawBetween } from "./frameloop.js";

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
// THE X HANDLE'S CHECK (kanban #3328, #3331): the round service's own POST /x - the game keeps its X link per game key, never in the bug bounty's
// book (owner 2026-11-22: the game must not be tied to feedback reports); the game never opens the page's My feedback dialog
const api = bridge ? makeApi({ base: bridge.apiBase || location.origin + "/api/opr", signBase: bridge.signBase || bridge.apiBase || location.origin + "/api/opr", bridge, fetch: (u, o) => fetch(u, o) }) : null;
let vault = null; try { vault = window.localStorage; } catch (_) { vault = null; }
const entry = api ? createEntry({ api, bridge, store: vault, log: (m) => console.log("[opr] " + m) }) : null;
const wallet = () => {
  if (!bridge) return null;
  let pubkey = null, balance = null, welcomeComing = false, topUpComing = false, canTopUp = false;
  try { pubkey = bridge.pubkey(); } catch (_) { pubkey = null; }
  try { balance = bridge.balance(); } catch (_) { balance = null; }
  try { welcomeComing = !!bridge.welcomeComing(); } catch (_) { welcomeComing = false; }
  try { topUpComing = typeof bridge.topUpComing === "function" && !!bridge.topUpComing(); } catch (_) { topUpComing = false; }
  try { canTopUp = typeof bridge.topUp === "function" && (typeof bridge.canTopUp !== "function" || !!bridge.canTopUp()); } catch (_) { canTopUp = false; }
  return { pubkey, balance, welcomeComing, topUpComing, canTopUp };
};

// ---------- the loop ----------
let W = null, running = false, paused = false, mode = "idle";
// #3335: fixed steps, every frame drawn between the last two (frameloop.js)
const clock = makeClock(STEP); let prevMovers = null;
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
  input.seen = input.seen || input.jump;
  return input.jump;
}
// sound (#3251): read from the world after each step, never written into it
let audio = null; try { audio = makeAudio({ store: window.localStorage }); } catch (_) { audio = null; }
let snap = null;
function step() {
  const s = W.f, j = jumpNow();
  if (j && down < 0) down = s; else if (!j && down >= 0) { presses.push([down, s]); down = -1; }
  stepWorld(W, { jump: j });
  if (input.letGo && input.seen) { input.jump = false; input.letGo = false; }
  if (audio) { const n = snapWorld(W); for (const e of worldEvents(snap, n)) audio.play(e); snap = n; }
}
function paintSound() {
  const b = $("sndBtn"); if (!b || !audio) { if (b) b.hidden = true; return; }
  const m = audio.mode; b.textContent = m === "on" ? "🔊" : m === "fx" ? "🔉" : "🔇"; b.title = m === "on" ? "Music and effects" : m === "fx" ? "Effects only" : "Sound off";
  b.setAttribute("aria-label", m === "on" ? "Sound: music and effects" : m === "fx" ? "Sound: effects only" : "Sound off");
}
const SHEETS = ["intro", "result", "board", "rules", "rend"];
// A REPLAY OWNS THE SCREEN (#3251, owner 2026-11-22: "nach ein paar Sekunden kommt das Overlay des letzten Runs wieder"): while one runs no sheet
// opens over it - the last run's submit (POST /attempt/submit, GET /me, the entry's poll) still answering asked for its result screen and got it.
// What they ask is kept (resultArgs) and shown on Back from the replay's own end card.
const replayOn = () => running && mode === "replay";
let heldWhileReplay = 0;
const showSheet = (id) => { if (id && replayOn()) { heldWhileReplay++; return false; } for (const s of SHEETS) $(s).hidden = s !== id; return true; };
// THE RUN'S TELEMETRY (kanban #3274), sent with the log for the fair-play review: how the presses came in and how the tab was used - counts and
// spreads only, no personal data (no positions are sent, no identifiers)
let TEL = null;
const telNew = () => ({ at: performance.now(), src: { touch: 0, mouse: 0, pen: 0, key: 0 }, xs: [], ys: [], blur: 0, hidden: 0, hiddenMs: 0, hidAt: null, first: null });
const telSpread = (xs) => { if (xs.length < 2) return null; const m = xs.reduce((a, b) => a + b, 0) / xs.length; return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / xs.length); };
function telOut() {
  const T = TEL; if (!T) return null;
  if (T.hidAt != null) { T.hiddenMs += performance.now() - T.hidAt; T.hidAt = null; }
  const sx = telSpread(T.xs), sy = telSpread(T.ys);
  let nav = {}; try { nav = navigator; } catch (_) { nav = {}; }
  const ua = String(nav.userAgent || ""), auto = [];
  if (/HeadlessChrome|PhantomJS|Electron|SlimerJS/i.test(ua)) auto.push("headless");
  try { if (!nav.languages || !nav.languages.length) auto.push("no languages"); } catch (_) {}
  try { if (window.outerWidth === 0 && window.outerHeight === 0) auto.push("no window"); } catch (_) {}
  try { if (window.callPhantom || window._phantom || window.__nightmare || window.domAutomation || window.domAutomationController) auto.push("driver object"); } catch (_) {}
  let small = 0; try { small = Math.min(screen.width, screen.height); } catch (_) { small = 0; }
  const touch = "ontouchstart" in window || (nav.maxTouchPoints || 0) > 0;
  return { src: T.src, taps: T.xs.length, jit: sx == null || sy == null ? null : Math.round((sx + sy) * 5) / 10, blur: T.blur, hidden: T.hidden, hiddenMs: Math.round(T.hiddenMs),
    first: T.first == null ? null : Math.round(T.first), wd: nav.webdriver === true, auto, dc: touch ? (small && small < 600 ? "phone" : "tablet") : "desktop", dpr: Math.round((window.devicePixelRatio || 1) * 100) / 100 };
}
function telPress(kind, e) {
  if (!TEL || !running || mode !== "play") return;
  TEL.src[kind] = (TEL.src[kind] || 0) + 1;
  if (TEL.first == null) TEL.first = performance.now() - TEL.at;
  if (e && kind !== "key" && TEL.xs.length < 400 && Number.isFinite(e.clientX)) { TEL.xs.push(e.clientX); TEL.ys.push(e.clientY); }
}
addEventListener("blur", () => { if (TEL && running && mode === "play") TEL.blur++; });
document.addEventListener("visibilitychange", () => { if (!TEL || !running || mode !== "play") return; if (document.hidden) { TEL.hidden++; TEL.hidAt = performance.now(); } else if (TEL.hidAt != null) { TEL.hiddenMs += performance.now() - TEL.hidAt; TEL.hidAt = null; } });
// A RUN HAS THE THREAD (kanban #3335, owner 2026-11-22 "Es ruckelt immer noch!" in the Arena page): the page around the frame shares this
// thread; while a run or a replay plays it holds its background work (lobby, payout and pending looks, balance read, owed scan) - bridge.playing
const inPlay = (on) => { if (bridge && typeof bridge.playing === "function") try { bridge.playing(!!on); } catch (_) { /* an older page */ } };
function begin(m, opts = {}) {
  inPlay(true);
  mode = m; TEL = m === "play" ? telNew() : null; W = newWorld(L); snap = audio ? snapWorld(W) : null; presses = []; down = -1; replayIdx = 0; speed = opts.speed || 1; paused = false; input.jump = false; input.letGo = false; input.seen = false;
  botCfg = m === "bot" ? { ...BOT_CONFIGS[opts.bot || 0] } : null;
  document.body.classList.add("playing"); document.body.classList.toggle("replaying", m === "replay"); running = true; clock.reset(performance.now()); prevMovers = null;
  showSheet(null); if (m !== "play") pill("", "");
  $("rbar").hidden = m !== "replay"; paintRbar();
  if (HOOKS.onStart) try { HOOKS.onStart({ mode, gameVersion: GAME_VERSION }); } catch (_) {}
  if (audio) { audio.unlock(); audio.startMusic(); }
  // the hint instead of a JUMP button (#3251, owner 2026-11-22): 2 s at the start of a run
  { const h = $("hint"); clearTimeout(h._t); h.hidden = m !== "play"; if (m === "play") h._t = setTimeout(() => { h.hidden = true; }, 2000); }   // every start is a tap or a key: the iOS rule holds
  requestAnimationFrame(loop);
}
function loop(now) {
  if (!running) return;
  clock.advance(now, speed, paused, () => !W.done && W.f < MAX_STEPS, () => { prevMovers = snapMovers(W); step(); });
  drawBetween(W, prevMovers, clock.alpha(), (fr) => drawWorld(W, [], fr));
  if (W.done || W.f >= MAX_STEPS) return finish();
  requestAnimationFrame(loop);
}
function finish() {
  inPlay(false);
  if (audio) audio.stopMusic();
  $("hint").hidden = true;
  running = false; document.body.classList.remove("playing", "replaying"); $("rbar").hidden = true; pill("", "");
  if (down >= 0) { presses.push([down, W.f]); down = -1; }
  const res = resultOf(W);
  if (mode !== "replay") { lastLog = { v: L.version, presses }; lastResult = { ...res, mode }; }
  if (HOOKS.onFinish) { try { if (HOOKS.onFinish(lastLog, { ...res, mode }, W) === false) return; } catch (_) {} }
  if (mode === "replay") return showReplayEnd(res);   // the replay's own end card, never the last run's result (#3251)
  if (mode === "play" && run) return sendRun(res);
  showResult({ res, mode, entry: mode === "play" ? "practice" : null });
}

// ---------- the service: round, me, board ----------
const S = { round: null, me: null, board: [], err: null, at: 0, loaded: false, opened: {} };   // loaded: the first GET /round has answered (#3251)
// #3251: the runs this tab opened, per round (POST /attempt's ids) - the counters count them even before GET /me has caught up
const openedIn = () => (S.round && S.opened[S.round.id]) || [];
let run = null;   // the attempt being played: { attempt, token, level, invoice, sats, deadlineMs, before, payer, entry, entryWhy, sent }
// one read at a time (#3251): a refresh asked while one runs waits for it and then reads again, so the answer is never older than the ask
let reading = null, readAgain = null;
function refresh() {
  if (!api) return Promise.resolve();
  if (reading) { if (!readAgain) readAgain = reading.catch(() => {}).then(() => { readAgain = null; return refresh(); }); return readAgain; }
  reading = readNow().finally(() => { reading = null; });
  return reading;
}
async function readNow() {
  const [r, b] = await Promise.all([api.get("/round"), api.get("/board")]);
  S.round = r.ok ? r.round : null; S.err = r.ok ? null : r.why; S.loaded = true;
  S.board = b.ok ? b.board : []; if (b.ok && b.round) S.boardRound = b.round;
  const w = wallet();
  if (w && w.pubkey) { const m = await api.getSigned("/me" + (S.round ? "?round=" + encodeURIComponent(S.round.id) : "")); if (m.ok) S.me = m; else HOOKS.meWhy = m.why || null; }
  S.at = Date.now();
}
// A FREE ROUND SHOWS NO WALLET (kanban #3273): no balance line, no welcome, no top-up - only once a round asks an entry
const freeNow = () => !S.round || isFree(S.round);
function paintWallet() {
  const w = wallet(), el = $("wal");
  if (!w || freeNow()) { el.hidden = true; document.body.classList.add("nowal"); return; }
  el.hidden = false; el.textContent = ""; document.body.classList.remove("nowal");
  if (!w.balance) { el.textContent = w.welcomeComing ? "Welcome sats coming …" : "Wallet opening …"; return; }
  const b = document.createElement("b"); b.textContent = fmtSats(w.balance.sats);
  const coming = Number(w.balance.coming) || 0;   // #3251: sats merging in or being issued, in any federation of the wallet
  // short, one line (owner 2026-11-22): "300 sats · +100 coming"; it truncates, never wraps
  el.append(b, " sats" + (w.welcomeComing && Number(w.balance.sats) < 100 ? " · welcome coming" : coming > 0 ? " · +" + fmtSats(coming) + " coming" : w.topUpComing ? " · top-up coming" : ""));
  el.title = fmtSats(w.balance.sats) + " testnet sats in your Arena wallet" + (coming > 0 ? ", " + fmtSats(coming) + " more on the way" : "");
}
let introTop = 10, introFitH = 0;
// the X / Lightning status (#3251): each part green or red as it stands
function paintStatus(el, st) {
  el.textContent = ""; if (!st) return;
  st.parts.forEach((x, i) => { if (i) el.append(x.sep || " · "); const sp = document.createElement("span"); sp.className = x.ok ? "st-ok" : "st-bad"; sp.textContent = x.text; el.append(sp); });
}
function paintIntro() {
  const m = introModel({ round: S.round, me: S.me, board: S.board, wallet: wallet(), nowMs: Date.now(), loading: !S.loaded, opened: openedIn(), top: introTop });
  $("iLine").textContent = m.line;
  $("iBounty").hidden = true;
  $("iPrize").hidden = !m.prize; $("iPrizeText").textContent = m.prize ? m.prize.text : ""; $("iPrizeSmall").textContent = m.prize ? " " + m.prize.small : "";
  $("iPromo").hidden = !(m.prize && m.prize.promo); $("iPromo").textContent = (m.prize && m.prize.promo) || "";
  const dl = $("iFacts"); dl.textContent = ""; dl.hidden = !m.facts;
  for (const [k, v, cls] of m.facts || []) { const d = document.createElement("div"); if (cls) d.className = cls; const dt = document.createElement("dt"), dd = document.createElement("dd"); dt.textContent = k; dd.textContent = v; d.append(dt, dd); dl.append(d); }
  paintIntroBoard(m.board);
  $("iPrice").hidden = !m.practice;
  // #3270: the X account on the intro, so a player can link it before the first run (it was only on the result screen)
  $("iX").hidden = !m.x || !m.x.parts.length; paintStatus($("iXText"), m.x); $("iX").className = "xline " + (m.x ? (m.x.ok ? "ok" : "bad") : "");
  $("iXBtn").hidden = true;   // #3328 (owner playtest 2026-11-22): the game never opens the page's My feedback dialog - the X field is right here
  // #3328: the X handle field while no X account is linked (or while it is typed or answered)
  { const inp = $("iXfIn"), st = XF.i; paintXf("i", !!(m.x && (m.x.link || st.dirty || st.msg || document.activeElement === inp))); }
  const btn = $("startBtn"); if (!btn.dataset.busy) { btn.textContent = m.button.label; btn.disabled = !!m.button.disabled; }
  if (!$("iWhy").dataset.err) $("iWhy").textContent = m.button.why || (S.err && bridge ? S.err : "");
  $("iTopUp").hidden = !m.topUp; if (m.topUp) $("iTopUp").textContent = m.topUp.label;
  // one top row always (owner 2026-11-22): the round's badge short, "Test round · no play bounty" its tooltip
  // the round's number only (owner 2026-11-22: "zeig nur 4 für Round 4 an"); a test round: a dashed outline and its tooltip
  const tg = $("modeTag"), tt = !bridge ? "Practice" : S.round ? String(S.round.number || "") || "·" : "·";
  if (tg.textContent !== tt) tg.textContent = tt;
  tg.classList.toggle("test", !!(S.round && S.round.test)); tg.title = !bridge ? "Practice: open the game in the Arena to play the round" : S.round ? (S.round.test ? "Test round " : "Round ") + (S.round.number || "") + (m.bounty ? " · no play bounty" : "") : "";
  // the address field right under the line while no address is saved (or while it is being typed or answered)
  { const inp = $("iLnIn"), st = LN.i; paintLn("i", !(m.x && !m.x.ln && !st.dirty && !st.msg && document.activeElement !== inp)); }
  paintWallet();
  HOOKS.intro = m;
  // A SMALL PHONE (owner 2026-11-22, iPhone): the whole intro, Rules and Leaderboard included, fits its frame - if the 10 rows do not, the top 3
  // and the player's own row (the full 10 in the Leaderboard sheet); the 10 again once there is room
  // (the board's own box scrolling counts as not fitting: the rows are shown whole)
  const sh = $("intro"), ib = $("iBoard");
  const tight = () => sh.scrollHeight > sh.clientHeight + 1 || (!ib.hidden && ib.scrollHeight > ib.clientHeight + 1);
  if (!sh.hidden && sh.clientHeight > 0) {
    if (introTop > 3 && tight()) { introTop = 3; paintIntro(); }
    else if (introTop === 3 && sh.clientHeight !== introFitH) { introFitH = sh.clientHeight; introTop = 10; paintIntro(); if (tight()) { introTop = 3; paintIntro(); } }
  }
}
// the intro's top 10 (#3251, owner 2026-11-22): rank, name, score, time; the player's row marked, below a divider when outside the 10
function paintIntroBoard(b) {
  const box = $("iBoard"); box.hidden = !b; if (!b) return;
  const t = $("iBTable"); t.textContent = "";
  $("iBEmpty").hidden = !b.empty; $("iBEmpty").textContent = b.empty || "";
  t.hidden = !!b.empty; if (b.empty) return;
  const body = t.createTBody();
  const add = (x, cls) => { const tr = body.insertRow(); tr.className = [x.me ? "me" : "", cls || ""].join(" ").trim(); cellRow(tr, [x.rank, x.name + (x.placed ? " ✓" : ""), x.score, x.time], ["rk", "nm", "tot", null]); };
  for (const x of b.rows) add(x);
  if (b.own) add(b.own, "gap");
}
function showIntro() {
  if (!showSheet("intro")) return; $("rbar").hidden = true; paintPractice(); paintIntro();
  if (api && Date.now() - S.at > 5000) refresh().then(paintIntro).catch(() => {});
}
function paintPractice() {
  const cs = DAY.candles, open = cs[0][1], lastC = cs[cs.length - 1][4], ch = (lastC - open) / open * 100, el = $("iPrice"); el.textContent = "";
  const bb = document.createElement("b"), sp = document.createElement("span"), sm = document.createElement("small");
  bb.textContent = "BTC " + usd(lastC); sp.className = ch >= 0 ? "up" : "dn"; sp.textContent = (ch >= 0 ? "▲ " : "▼ ") + Math.abs(ch).toFixed(1) + "% in 24 h";
  sm.textContent = "practice chart · " + (DAY.source || "Coinbase BTC-USD");
  el.append(bb, sp, sm);
}
// the intro's board and counters live: read again every 15 s while the intro is open (#3251, owner 2026-11-22)
// #3335: nothing during a run (paintWallet reads bridge.balance, which reads the wallet's payable amount in the page)
setInterval(() => { if (running) return; if (!$("intro").hidden) { paintIntro(); if (api && !reading && Date.now() - S.at > 15000) refresh().then(paintIntro).catch(() => {}); } else paintWallet(); }, 1000);

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
    run = { ...a, round: S.round.id, before, entry: a.free || (isFree(S.round) && a.state === "started") ? "free" : null, status: null };
    (S.opened[S.round.id] = S.opened[S.round.id] || []).push(a.attempt);   // #3251: this run counts from now on
    refresh().catch(() => {});   // and GET /me says so too (read again after POST /attempt)
    if (!a.level || !a.token) {
      // the older service: paid first, then the run
      btn.textContent = "Paying the entry …";
      const st = await entry.waitStarted(a, { onStatus: (k, w) => { const p = PILL[k]; why.textContent = p ? p[1] + (w ? " (" + w + ")" : "") : ""; } });
      if (!st.ok) { run = null; return fail(st.why); }
      Object.assign(run, { token: st.token, level: st.level, deadlineMs: st.deadlineMs, entry: "paid" });
    }
    useLevel(run.level);
    delete btn.dataset.busy;
    if (run.entry !== "paid" && run.entry !== "free") run.payer = entry.payInBackground(run, { onStatus: onEntry });
    begin("play");
  } catch (e) { run = null; fail((e && e.message) || String(e)); }
}
async function sendRun(res) {
  const mine = run; mine.shown = false;
  showResult({ res, mode: "play", entry: mine.entry || "waiting", sending: true });
  mine.shown = true;
  const t = telOut();
  const client = { ua: String(navigator.userAgent || "").slice(0, 160), w: innerWidth, h: innerHeight, touch: "ontouchstart" in window, v: GAME_VERSION, hiddenMs: t ? t.hiddenMs : 0, t };
  const w = wallet();
  const r = await entry.submit({ attempt: mine.attempt, token: mine.token, round: mine.round, log: lastLog, client, deadlineMs: mine.deadlineMs || null, player: (w && w.pubkey) || null },
    { onRetry: (n) => { HOOKS.submitTries = n + 1; if (run === mine && !$("result").hidden) { const re = $("rEntry"); re.hidden = false; re.textContent = "No connection - sending your run again …"; } } });
  mine.sent = r;
  if (!r.ok) mine.submitWhy = r.why || "not taken";
  // the entry's state as the service says it now; a waiting entry is asked again until it is decided or the attempt's time is over
  if (mine.entry === "free") {   // #3273: scored at submit, nothing to wait for
    await refresh().catch(() => {});
    if (run === mine) showResult({ res, mode: "play", entry: "free" });
    return;
  }
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

// ---------- the Lightning address for prizes (kanban #3250): intro and result, one field each ----------
const LN = { i: { dirty: false, msg: null }, r: { dirty: false, msg: null } };
function paintLn(p, show = true) {
  const form = $(p + "Ln"), inp = $(p + "LnIn"), btn = $(p + "LnBtn"), why = $(p + "LnWhy"), st = LN[p];
  const on = show && !!api && !!S.me;   // signed in: GET /me answered
  form.hidden = !on; if (!on) { why.hidden = true; return; }
  const stored = S.me.lnAddress || "";
  if (!st.dirty && document.activeElement !== inp && inp.value !== stored) inp.value = stored;   // prefilled when stored
  const m = st.msg || lnFieldModel(inp.value, stored);
  why.textContent = m.text; why.className = "lnwhy " + (m.kind || ""); why.hidden = !m.text;
  if (!btn.dataset.busy) btn.disabled = !lnFieldModel(inp.value, stored).canSave;
}
async function saveLn(p) {
  const inp = $(p + "LnIn"), btn = $(p + "LnBtn"), st = LN[p];
  if (btn.disabled || btn.dataset.busy) return;
  btn.dataset.busy = "1"; btn.disabled = true; st.msg = { text: "Checking your wallet …", kind: "" }; paintLn(p);
  const r = await api.post("/lnaddress", { address: inp.value.trim() }).catch(() => ({ ok: false, why: "The round service did not answer" }));
  delete btn.dataset.busy;
  if (r.ok) { S.me = { ...S.me, lnAddress: r.lnAddress }; inp.value = r.lnAddress; st.dirty = false; st.msg = null; for (const k of ["i", "r"]) { LN[k].dirty = false; paintLn(k, k === "i" || !$("result").hidden); } }
  else { st.msg = { text: r.why || "Not saved", kind: "bad" }; paintLn(p); }
  HOOKS.ln = { ok: !!r.ok, why: r.ok ? null : r.why || null, lnAddress: S.me && S.me.lnAddress };
}
for (const p of ["i", "r"]) {
  $(p + "LnIn").addEventListener("input", () => { LN[p].dirty = true; LN[p].msg = null; paintLn(p); });
  $(p + "Ln").addEventListener("submit", (e) => { e.preventDefault(); saveLn(p); });
}

// ---------- the X handle (kanban #3328): intro and result, one field each, checked on Save ----------
const XF = { i: { dirty: false, msg: null }, r: { dirty: false, msg: null } };
function paintXf(p, show = true) {
  const form = $(p + "Xf"), inp = $(p + "XfIn"), btn = $(p + "XfBtn"), why = $(p + "XfWhy"), st = XF[p];
  const on = show && !!api && !!S.me;
  form.hidden = !on; if (!on) { why.hidden = true; return; }
  const stored = (S.me.x && S.me.x.username) || "";
  const m = st.msg || xFieldModel(inp.value, stored);
  why.textContent = m.text; why.className = "lnwhy " + (m.kind || ""); why.hidden = !m.text;
  if (!btn.dataset.busy) btn.disabled = !xFieldModel(inp.value, stored).canSave;
}
async function saveX(p) {
  const inp = $(p + "XfIn"), btn = $(p + "XfBtn"), st = XF[p];
  if (btn.disabled || btn.dataset.busy) return;
  const typed = inp.value.trim();
  btn.dataset.busy = "1"; btn.disabled = true; st.msg = { text: "Checking @" + (xHandleOf(typed) || typed) + " on X …", kind: "" }; paintXf(p);
  const j = await api.post("/x", { x: typed }).catch(() => null);
  const a = xSaveAnswer(j, typed);
  delete btn.dataset.busy;
  st.msg = { text: a.text, kind: a.kind }; st.dirty = !a.ok;
  if (a.ok) { const m = await api.getSigned("/me" + (S.round ? "?round=" + encodeURIComponent(S.round.id) : "")).catch(() => null); if (m && m.ok) S.me = m; inp.value = ""; st.dirty = false; }
  paintXf(p); paintIntro(); if (!$("result").hidden && resultArgs) paintResult(resultArgs);
  HOOKS.x = { ok: a.ok, text: a.text };
}
for (const p of ["i", "r"]) {
  $(p + "XfIn").addEventListener("input", () => { XF[p].dirty = true; XF[p].msg = null; paintXf(p); });
  $(p + "Xf").addEventListener("submit", (e) => { e.preventDefault(); saveX(p); });
}

// ---------- the screens ----------
const cellRow = (tr, cells, cls, th) => cells.forEach((c, i) => { const td = document.createElement(th ? "th" : "td"); if (c instanceof Node) td.append(c); else td.textContent = c == null ? "" : c; if (cls && cls[i]) td.className = cls[i]; tr.append(td); });
function paintEntry() {
  if (!run) return;
  const l = entryLine(run.entry || "waiting", run.entryWhy);
  const el = $("rEntry"); el.className = "entry " + l.kind; el.textContent = l.text;
}
const narrow = () => { try { return matchMedia("(max-width: 430px)").matches; } catch (_) { return false; } };
let resultArgs = null;   // the last result screen asked (#3251): Back from a replay shows it as it stands now
function showResult(args) {
  if (args.mode === "play") resultArgs = args;
  if (replayOn()) { heldWhileReplay++; return; }   // the replay runs: nothing opens over it
  paintResult(args);
}
function paintResult({ res, mode: m, entry: en, sending = false }) {
  const after = S.me ? myBest(S.me, S.board) : null;
  const model = resultModel({ res, parTime: L.parTime, timePerS: rulesOf(L.version).timePerS, entry: en, entryWhy: run && run.entryWhy, before: run && m === "play" ? run.before : null, after: m === "play" && run ? after : null,
    me: m === "play" && run ? S.me : null, max: S.round ? S.round.maxAttempts : 5, mode: m === "play" && !run ? "practice" : m, submitWhy: run && run.submitWhy, opened: openedIn(), round: m === "play" && run ? S.round : null, nowMs: Date.now() });
  $("rTitle").textContent = model.title;
  const re = $("rEntry"); re.hidden = !en || (en === "free" && !sending); if (!re.hidden) { re.className = "entry " + model.entry.kind; re.textContent = sending ? "Sending your run …" : model.entry.text; }
  const t1 = $("rScore"); t1.textContent = ""; const add = (a, v, cl) => cellRow(t1.insertRow(), [a, v], cl);
  for (const [a, v] of model.rows) add(a, v); add("Total", model.total, [null, "tot"]);
  $("rRefused").hidden = !model.refused; $("rRefused").textContent = model.refused || "";
  if (m === "play" && !run) {   // practice: the browser's own best runs on this chart
    saved.best.push({ score: res.total, time: res.timeS, finished: res.finished }); saved.best.sort((a, z) => z.score - a.score); saved.best = saved.best.slice(0, 5); save();
    model.rank = "Practice best: " + saved.best[0].score; model.left = bridge ? "" : "Open the game in the Arena to play for the daily prize.";
  }
  $("rPrize").hidden = !model.prize; $("rPrize").textContent = model.prize || "";
  // compact (owner 2026-11-22, iPhone): one facts row when the service answered; the practice and replay lines as before
  if (model.facts) { $("rRank").textContent = model.facts; $("rBeat").textContent = ""; $("rLeft").textContent = ""; }
  else { $("rRank").textContent = model.rank || ""; $("rBeat").textContent = model.beat || ""; $("rLeft").textContent = model.left || ""; }
  $("rNot").hidden = !model.status || !model.status.parts.length; paintStatus($("rNotText"), model.status || null);
  $("rX").hidden = true;   // the line above says it, with the button (#3251)
  $("xBtn").hidden = true;   // #3328: no My feedback dialog from the game
  paintXf("r", m === "play" && !!S.me && (!S.me.x || XF.r.dirty || !!XF.r.msg || document.activeElement === $("rXfIn")));
  // the address field only while none is saved (or while it is typed or answered)
  paintLn("r", m === "play" && !!S.me && (!S.me.lnAddress || LN.r.dirty || !!LN.r.msg || document.activeElement === $("rLnIn")));
  const used = usedOf(S.me, openedIn()), max = S.round ? Number(S.round.maxAttempts || 5) : 5;
  $("againBtn").textContent = run && used >= max ? "Back" : narrow() ? "Again" : "Play again";
  $("replayBtn").disabled = !lastLog;
  $("rBoardBtn").hidden = !api;
  showSheet("result"); $("againBtn").focus();
  HOOKS.result = { ...model, entryKind: en, sending };
}
// THE BOARD AT ONCE FROM WHAT THE INTRO READ (kanban #3289, owner 2026-11-22: "Das Laden des Leaderboards dauert auch zu lang"; GET /board took
// 0.8-5 s on the stage): the sheet draws the rows the intro holds (read with the round, refreshed every 15 s) and then the fresh answer over them
const roundLine = (r) => r ? (r.test ? "Test round " : "Round ") + (r.number || "") + " · " + r.players + " players · " + (isFree(r) ? "free to play" : "pot " + fmtSats(r.potSats) + " testnet sats") : "";
function paintBoard() {
  const t = $("bTable"); t.textContent = "";
  const rows = boardRows(S.board, S.me);
  const C = ["c-rk", "c-nm", "c-sc", "c-tm", "c-rp"];
  cellRow(t.createTHead().insertRow(), ["#", "Player", "Score", "Time", ""], C, true);
  const body = t.createTBody();
  if (!rows.length) cellRow(body.insertRow(), ["", "No run yet", "", "", ""], C);
  // own runs: their replays are always yours to watch (GET /me's attempts)
  const ownBest = S.me ? myBest(S.me, S.board) : null;
  for (const x of rows) {
    const tr = body.insertRow(); if (x.me) tr.className = "me";   // by the row's key, not its name (#3277)
    let rp = x.replay; if (!rp && ownBest && x.me) rp = "/replay/" + ownBest.attempt;
    let cell = "";
    if (rp) { cell = document.createElement("button"); cell.className = "rp"; cell.type = "button"; cell.textContent = "▶"; cell.title = "Watch the replay"; cell.setAttribute("aria-label", "Watch the replay"); cell.onclick = () => { if (audio) audio.unlock(); watchReplay(rp); }; }
    cellRow(tr, [x.rank, x.name + (x.placed ? " ✓" : ""), x.score, x.time, cell], ["c-rk", "c-nm", "c-sc tot", "c-tm", "c-rp"]);
  }
}
let boardAsk = 0;
async function showBoard() {
  if (!showSheet("board")) return;
  const t = $("bTable"); t.textContent = ""; $("bLine").textContent = "Reading …";
  if (!api) { $("bLine").textContent = "The leaderboard is in the Arena."; return; }
  const ask = ++boardAsk;
  const kept = S.loaded && S.board.length > 0;
  if (kept) { paintBoard(); $("bLine").textContent = (S.boardRound ? roundLine(S.boardRound) + " · " : "") + "updating …"; }
  const b = await api.get("/board" + (S.round ? "?round=" + encodeURIComponent(S.round.id) : ""));
  if (ask !== boardAsk) return;   // a newer opening of the sheet draws its own answer
  if (!b.ok) { $("bLine").textContent = kept ? (S.boardRound ? roundLine(S.boardRound) + " · " : "") + "not updated: " + (b.why || "not read") : (b.why || "not read"); return; }
  S.board = b.board || []; if (b.round) S.boardRound = b.round;
  $("bLine").textContent = roundLine(b.round);
  paintBoard();
}
async function watchReplay(path) {
  try {
    let j = await api.get(path);
    if (!j.ok && j.status === 403 && wallet() && wallet().pubkey) j = await api.getSigned(path);
    if (!j.ok) { $("bLine").textContent = j.why || "no replay"; return; }
    useLevel(j.level); const bad = validateLog(j.log, L.version || GAME_VERSION); if (bad) throw new Error(bad);   // kanban #3391: the log replays on its round's version, not the page's newest
    replayLog = j.log; replayFrom = "board"; begin("replay");
  } catch (e) { $("bLine").textContent = (e && e.message) || String(e); }
}
// ---------- the replay viewer (#3251): its controls in a bar below the field, its own end card ----------
let replayFrom = "result";   // where Back goes: the result screen it was opened from, or the leaderboard
function paintRbar() {
  const p = $("rbPlay"); p.textContent = paused ? "▶" : "⏸"; p.setAttribute("aria-label", paused ? "Play" : "Pause"); p.title = paused ? "Play" : "Pause";
  $("rb2x").setAttribute("aria-pressed", String(speed === 2));
}
function showReplayEnd(res) {
  if (!showSheet("rend")) return;
  $("eTitle").textContent = "Replay: " + (res.finished ? "flag in " + fmtTime(res.timeS) : "time is up");
  $("eLine").textContent = "Score " + fmtSats(res.total) + " · " + fmtTime(res.timeS);
  $("eBack").focus();
}
function replayBack() {
  if (replayFrom === "board" && api) return showBoard();
  if (resultArgs) return paintResult(resultArgs);
  if (lastResult && replayFrom === "result") return paintResult({ res: lastResult, mode: lastResult.mode === "bot" ? "bot" : "play", entry: lastResult.mode === "play" ? "practice" : null });
  showIntro();
}
function stopReplay() {
  inPlay(false);
  if (audio) audio.stopMusic();
  running = false; paused = false; document.body.classList.remove("playing", "replaying"); $("rbar").hidden = true;
}
function showRules() {
  if (!showSheet("rules")) return; $("rulesTitle").textContent = RULES_TITLE;
  const ol = $("rulesList"); if (ol.childElementCount) return;
  for (const [k, v] of RULES) { const li = document.createElement("li"), b = document.createElement("b"); b.textContent = k + ". "; li.append(b, v); ol.append(li); }
}

// input: one button. Tap anywhere, Space, ArrowUp; on phones no selection, long-press menu or zoom while playing.
// A TAP SHORTER THAN A FRAME STILL JUMPS (#3251: with the JUMP button gone every jump is a tap on the field): a press is held until one
// simulation step has seen it, then let go - the input log (and so the replay) records it as the steps saw it
const press = () => { input.jump = true; input.seen = false; input.letGo = false; };
const release = () => { if (input.seen) input.jump = false; else input.letGo = true; };
addEventListener("keydown", (e) => { const kk = keyMap[e.code]; if (!kk) return; if (!e.repeat) { telPress("key", e); press(); } if (running) e.preventDefault(); });
addEventListener("keyup", (e) => { const kk = keyMap[e.code]; if (kk) release(); });
document.addEventListener("pointerdown", (e) => { if (running && mode === "play" && !e.target.closest("#rbar, #sndBtn")) { telPress(e.pointerType === "touch" || e.pointerType === "pen" ? e.pointerType : "mouse", e); press(); if (e.cancelable) e.preventDefault(); } }, { passive: false });
["pointerup", "pointercancel"].forEach((ev) => document.addEventListener(ev, () => { if (input.jump) release(); }));
["touchstart", "touchmove", "gesturestart", "dblclick"].forEach((ev) => document.addEventListener(ev, (e) => { if (running && mode === "play" && e.cancelable && !(e.target.closest && e.target.closest("#sndBtn"))) e.preventDefault(); }, { passive: false }));
document.addEventListener("selectstart", (e) => { if (running) e.preventDefault(); });
document.addEventListener("contextmenu", (e) => { if (running) e.preventDefault(); });
// SOUND ON EVERY TAP (#3251, owner 2026-11-22 "Sound geht nicht mehr"): iOS lets an AudioContext start or come back (after the tab was
// hidden, the phone locked, a call) only inside a user gesture. Every tap and key resumes it; a run's taps are preventDefault'ed, so
// pointerup/touchend carry it there (no click comes)
for (const ev of ["pointerup", "touchend", "click", "keydown"]) document.addEventListener(ev, () => { if (!audio) return; audio.unlock(); if (running && !paused && audio.mode === "on") audio.startMusic(); }, { capture: true, passive: true });
$("startBtn").onclick = () => { if (audio) audio.unlock(); if (!$("startBtn").disabled) play(); };
// #3251: the page's faucet top-up ("Get 300 sats"), from the game; Play turns on while it is on its way
$("iTopUp").onclick = () => { let ok = false; try { ok = !!(bridge && bridge.topUp && bridge.topUp()); } catch (_) { ok = false; } if (!ok) $("iWhy").textContent = "The faucet could not be asked now - use Get 300 sats at the bottom right."; paintIntro(); };
$("sndBtn").onclick = (e) => { e.stopPropagation(); if (!audio) return; audio.unlock(); audio.next(); if (running && audio.mode === "on") audio.startMusic(); paintSound(); };
$("sndBtn").addEventListener("pointerdown", (e) => e.stopPropagation());   // a tap on the speaker is not a jump
$("againBtn").onclick = () => { if (run) { if (run.payer && (run.entry === "paid" || run.entry === "not-paid")) run.payer.stop(); run = null; } pill("", ""); showIntro(); };
$("replayBtn").onclick = () => { if (!lastLog) return; if (audio) audio.unlock(); replayLog = lastLog; replayFrom = "result"; begin("replay"); };
$("eAgain").onclick = () => { if (!replayLog) return; if (audio) audio.unlock(); begin("replay"); };
$("eBack").onclick = () => replayBack();
$("rBoardBtn").onclick = () => showBoard();
$("bBack").onclick = () => showIntro();
$("rulesBack").onclick = () => showIntro();
$("rulesLink").onclick = (e) => { e.preventDefault(); showRules(); };
$("boardLink").onclick = (e) => { e.preventDefault(); showBoard(); };
// #3328 (owner playtest 2026-11-22: "Link X" opened My feedback with every community field): no bridge.linkX from the game, the X field checks inline
$("rbPlay").onclick = () => { paused = !paused; if (audio) { audio.unlock(); if (paused) audio.stopMusic(); else audio.startMusic(); } paintRbar(); };
$("rb2x").onclick = () => { speed = speed === 2 ? 1 : 2; paintRbar(); };
$("rbClose").onclick = () => { stopReplay(); replayBack(); };
// kanban #3270: refit whenever the stage changes size, not only the window. (The JUMP pad that appeared when a run started is gone, #3251.) It took
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
  replay(log, opts = {}) { const bad = validateLog(log, (L && L.version) || GAME_VERSION); if (bad) throw new TypeError(bad); replayLog = log; begin("replay", opts); },
  state: () => ({ running, paused, speed, mode, f: W ? W.f : 0, presses: presses.length + (down >= 0 ? 1 : 0), done: W ? W.done : false, run: run ? { attempt: run.attempt, entry: run.entry, status: run.status } : null }),
  view: () => view(W), audio: () => (audio ? { state: audio.state, mode: audio.mode, music: audio.musicOn, gain: audio.gain } : null),
  screen: () => (SHEETS.find((s) => !$(s).hidden) || null), held: () => heldWhileReplay, lastLog: () => lastLog, lastResult: () => lastResult, service: () => ({ ...S }),
  showIntro, showResult: (r) => showResult({ res: r || lastResult, mode: "play", entry: "practice" }), showBoard, showRules,
});
fit(); idle(); paintSound(); showIntro();
if (api) refresh().then(paintIntro).catch(() => {}).then(() => {
  // #3387: a run this tab finished but could not send (the page was closed or reloaded on the way) is sent now, while its attempt is in time
  const w = wallet(); if (!w || !w.pubkey) return;
  return entry.resendUnsent(w.pubkey).then((sent) => { HOOKS.resent = sent.map((x) => ({ attempt: x.attempt, ok: !!(x.r && x.r.ok) })); if (sent.length) return refresh().then(paintIntro); });
}).catch(() => {});
if (location.hash === "#rules") showRules(); else if (location.hash === "#board") showBoard();
const q = new URLSearchParams(location.search);
if (q.has("bot")) begin("bot", { bot: +q.get("bot") || 0, speed: +q.get("speed") || 1 });
