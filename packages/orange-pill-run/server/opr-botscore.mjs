// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// HOW LIKELY A RUN IS A BOT (kanban #3274, owner 2026-11-22: "how likely it is that a bot plays - we want to see that"). Server only: these
// rules are never sent to a page or a public route. A likelihood 0-100 per run and per player with its top reasons, for the admin's runs view
// and the payout lists; a row above HOLD_ABOVE is held for review (never banned automatically). Pure: the service hands in the sim, the level,
// the log, the page's telemetry and what it knows across runs.
//
//   runFeatures(sim, L, log)        once per run, at submit (stored): press timing, and the reactions to hazards measured on the replayed world
//   nearLogs(a, b)                  two press lists within a step or two of each other (a replayed or shared run)
//   scoreRun({ feat, flags, client, cross })  -> { score, reasons: [{ points, why }] }, reasons strongest first
import { createHash } from 'node:crypto';

export const HOLD_ABOVE = 70;
const REACT_BEFORE = 30, REACT_AFTER = 40;   // a press belongs to a hazard when it goes down from 30 steps before to 40 after it showed

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const sd = (xs) => { if (xs.length < 2) return 0; const m = mean(xs); return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / xs.length); };
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
const r3 = (x) => Math.round(x * 1000) / 1000;

/**
 * The run's own features. Hazard onsets: the steps where the world first puts a gap, a wall, spikes, a foe or a bill in the runner's way
 * (the scripted player's own look-ahead, sim.botInput, asked fresh each step), replayed with the run's presses.
 */
export function runFeatures(sim, L, log) {
  const ps = (log && log.presses) || [];
  const holds = ps.map(([d, u]) => u - d), downs = ps.map(([d]) => d);
  const ipi = downs.slice(1).map((d, i) => d - downs[i]);
  const counts = new Map(); for (const h of holds) counts.set(h, (counts.get(h) || 0) + 1);
  const f = { n: ps.length, holdSd: r3(sd(holds)), holdKinds: counts.size, holdMode: holds.length ? r3(Math.max(...counts.values()) / holds.length) : null, ipiCv: ipi.length && mean(ipi) > 0 ? r3(sd(ipi) / mean(ipi)) : null, firstDown: ps.length ? ps[0][0] : null };
  if (!sim || typeof sim.newWorld !== 'function' || typeof sim.stepWorld !== 'function' || typeof sim.botInput !== 'function' || !L) return f;
  const W = sim.newWorld(L), onsets = [];
  const cap = Math.min(sim.MAX_STEPS || 10800, 10800);
  let i = 0, before = false;
  while (!W.done && W.f < cap) {
    const s = W.f;
    let seen = false;
    if (!(W.p.dying > 0)) { try { seen = !!sim.botInput(W, { react: 0, jumpFrames: 2, billDist: 40 }).jump; } catch { seen = false; } }
    if (seen && !before) onsets.push(s);
    before = seen;
    while (i < ps.length && ps[i][1] <= s) i++;
    sim.stepWorld(W, { jump: i < ps.length && ps[i][0] <= s });
  }
  // each hazard: the press nearest to it in the window, its delay in steps (negative: pressed before it showed)
  const deltas = [];
  let j = 0;
  for (const o of onsets) {
    while (j < downs.length && downs[j] < o - REACT_BEFORE) j++;
    let best = null;
    for (let k = j; k < downs.length && downs[k] <= o + REACT_AFTER; k++) { const d = downs[k] - o; if (best === null || Math.abs(d) < Math.abs(best)) best = d; }
    if (best !== null) deltas.push(best);
  }
  f.hazards = onsets.length; f.reacted = deltas.length;
  f.exact = deltas.length ? r3(deltas.filter((d) => d === 0 || d === 1).length / deltas.length) : null;
  f.reactMedian = median(deltas); f.reactSd = r3(sd(deltas));
  return f;
}

/** Two press lists that are the same run within a step or two: about as many presses, nearly every one at the same step. */
export function nearLogs(a, b) {
  const x = (a && a.presses) || [], y = (b && b.presses) || [];
  if (x.length < 10 || y.length < 10) return false;
  if (Math.abs(x.length - y.length) > Math.max(1, Math.floor(Math.min(x.length, y.length) * 0.05))) return false;
  const n = Math.min(x.length, y.length);
  let close = 0;
  for (let i = 0; i < n; i++) if (Math.abs(x[i][0] - y[i][0]) <= 2 && Math.abs((x[i][1] - x[i][0]) - (y[i][1] - y[i][0])) <= 2) close++;
  return close / n >= 0.9;
}

/** The page's device as one short hash (no personal data: browser line, viewport, device class) - players per device. */
export function deviceOf(client) {
  if (!client || typeof client !== 'object') return null;
  const t = client.t && typeof client.t === 'object' ? client.t : {};
  const key = [String(client.ua || '').slice(0, 160), client.w | 0, client.h | 0, String(t.dc || ''), t.dpr || ''].join('|');
  return key.length > 6 ? createHash('sha256').update(key).digest('hex').slice(0, 16) : null;
}

/**
 * The likelihood of one run. feat: runFeatures; flags: the #3249 signals (regular, sameHold, hidden, sameLog, ipCrowd, tooFast); client: the page's
 * telemetry ({ t: { src: { touch, mouse, pen, key }, jit, taps, blur, hidden, hiddenMs, first, wd, auto, dc } }); cross: what the service knows across
 * runs { nearOther, repeatOwn, ipPlayers, devicePlayers, ageMs, botX }.
 */
export function scoreRun({ feat = {}, flags = {}, client = {}, cross = {} } = {}) {
  const out = [];
  const add = (points, why) => out.push({ points, why });
  const t = client && client.t && typeof client.t === 'object' ? client.t : null;
  if (cross.botX) add(80, 'a known bot X account');
  if (t && t.wd) add(60, 'the browser says it is automated');
  else if (t && Array.isArray(t.auto) && t.auto.length) add(35, `automation hints in the browser (${t.auto.slice(0, 3).join(', ')})`);
  const src = t && t.src && typeof t.src === 'object' ? t.src : null;
  const events = src ? ['touch', 'mouse', 'pen', 'key'].reduce((a, k) => a + (Number(src[k]) || 0), 0) : null;
  if (t && events === 0 && (feat.n || 0) >= 3) add(50, `${feat.n} presses with no touch, mouse or key event`);
  if (t && Number(t.taps) >= 8 && t.jit != null && Number(t.jit) < 1) add(35, `${t.taps} taps on the same pixel`);
  if (feat.reacted >= 8 && feat.exact != null) {
    if (feat.exact >= 0.5) add(55, `${Math.round(feat.exact * 100)} % of ${feat.reacted} hazards answered on the exact step`);
    else if (feat.exact >= 0.3) add(30, `${Math.round(feat.exact * 100)} % of ${feat.reacted} hazards answered on the exact step`);
    else if (feat.reactSd != null && feat.reactSd < 1.5 && feat.reactMedian != null && Math.abs(feat.reactMedian) <= 4) add(25, 'the same reaction time to every hazard');
  }
  if (flags.sameHold || ((feat.n || 0) >= 12 && (feat.holdKinds <= 1 || feat.holdSd < 0.5))) add(35, `every press held exactly as long (${feat.n} presses)`);
  else if ((feat.n || 0) >= 12 && feat.holdMode >= 0.9) add(35, `${Math.round(feat.holdMode * 100)} % of ${feat.n} presses held exactly as long`);
  else if ((feat.n || 0) >= 20 && feat.holdKinds <= 2) add(15, 'press lengths of only two kinds');
  if (flags.regular || ((feat.n || 0) >= 12 && feat.ipiCv != null && feat.ipiCv < 0.03)) add(25, 'presses at machine-regular intervals');
  if (flags.sameLog) add(45, "the same inputs as another player's run");
  else if (cross.nearOther) add(40, `nearly the same inputs as ${cross.nearOther} other player${cross.nearOther > 1 ? "s'" : "'s"} run${cross.nearOther > 1 ? 's' : ''}`);
  if (cross.repeatOwn) add(35, 'repeats one of its own runs step for step');
  if (flags.tooFast) add(40, "sent faster than the run's game time");
  if (cross.ipPlayers >= 3 || flags.ipCrowd >= 3) add(15, `${Math.max(cross.ipPlayers || 0, flags.ipCrowd || 0)} players from one address`);
  // one phone model looks like every other of its kind (browser line, viewport): many players on one device class is a weak hint only
  if (cross.devicePlayers >= 5) add(5, `${cross.devicePlayers} players on one device type`);
  if (flags.hidden || (t && (Number(t.hidden) > 0 || Number(t.hiddenMs) > 0 || Number(t.blur) > 0))) add(10, 'the game tab was hidden or lost focus during the run');
  if (t && t.first != null && Number(t.first) >= 0 && Number(t.first) < 120 && (feat.n || 0) > 0) add(10, `first press ${Math.round(t.first)} ms after the level showed`);
  if (cross.ageMs != null && cross.ageMs < 10 * 60000 && cross.newNearby >= 3) add(15, `one of ${cross.newNearby} new players within minutes`);
  out.sort((a, b) => b.points - a.points);
  return { score: Math.min(100, out.reduce((a, r) => a + r.points, 0)), reasons: out };
}

/** The top three reasons as text. */
export const topReasons = (s, n = 3) => (s && s.reasons ? s.reasons.slice(0, n).map((r) => r.why) : []);
