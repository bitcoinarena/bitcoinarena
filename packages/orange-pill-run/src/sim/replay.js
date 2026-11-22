// Orange Pill Run - replay of an input log (kanban #3246). The log is the whole input of a run:
//   { v: the level's game version (L.version), presses: [[downStep, upStep], ...] }
// Jump is held at step s (s = W.f before the step, from 0) iff downStep <= s < upStep for some press.
// Presses are sorted, non-overlapping integers (down < up, next down > previous up). Presses that start after the
// run ended (flag or 180 s) are cut: they do not count. The browser records the same structure (client/src/main.js).
import { GAME_VERSION, VERSIONS, MAX_STEPS } from "./constants.js";
import { newWorld, stepWorld } from "./world.js";
import { scoreOf } from "./score.js";

export const MAX_PRESSES = MAX_STEPS;                 // more presses than steps cannot be real
const MAX_STEP_VALUE = 10_000_000;

// null when the log is well formed, else the reason; version = the level's (a log replays only on its own version)
export function validateLog(log, version = GAME_VERSION) {
  if (!log || typeof log !== "object") return "log is not an object";
  if (log.v !== version || !Object.prototype.hasOwnProperty.call(VERSIONS, log.v)) return "wrong game version";
  const ps = log.presses;
  if (!Array.isArray(ps)) return "presses is not an array";
  if (ps.length > MAX_PRESSES) return "too many presses";
  let prevUp = -1;
  for (const pr of ps) {
    if (!Array.isArray(pr) || pr.length !== 2) return "a press is not [down, up]";
    const [d, u] = pr;
    if (!Number.isSafeInteger(d) || !Number.isSafeInteger(u) || d < 0 || u > MAX_STEP_VALUE) return "a press is not two step numbers";
    if (u <= d) return "a press ends before it starts";
    if (d <= prevUp) return "presses overlap or are not sorted";
    prevUp = u;
  }
  return null;
}

// a press list from a per-step jump function (the bot, a test script)
export function recordLog(L, inputAt, { maxSteps = MAX_STEPS } = {}) {
  const W = newWorld(L), presses = []; let down = -1;
  while (!W.done && W.f < maxSteps) {
    const s = W.f, j = !!inputAt(W, s).jump;
    if (j && down < 0) down = s; else if (!j && down >= 0) { presses.push([down, s]); down = -1; }
    stepWorld(W, { jump: j });
  }
  if (down >= 0) presses.push([down, W.f]);
  return { log: { v: L.version || GAME_VERSION, presses }, W };
}

export function resultOf(W) {
  const sc = scoreOf(W);
  return { total: sc.total, parts: sc.parts, clean: sc.clean, finished: W.stats.finished, steps: W.f, deaths: W.stats.hits, timeS: Math.round(W.time * 1000) / 1000 };
}

// runs a log on a fresh world of L; throws a TypeError for a malformed log or another game version
export function runLog(L, log, { maxSteps = MAX_STEPS, onStep } = {}) {
  const bad = validateLog(log, L.version || GAME_VERSION); if (bad) throw new TypeError("runLog: " + bad);
  const ps = log.presses, W = newWorld(L); let i = 0;
  const cap = Math.min(maxSteps, MAX_STEPS);
  while (!W.done && W.f < cap) {
    const s = W.f;
    while (i < ps.length && ps[i][1] <= s) i++;
    const jump = i < ps.length && ps[i][0] <= s;
    stepWorld(W, { jump });
    if (onStep) onStep(W);
  }
  const r = resultOf(W);
  let cut = 0; for (const pr of ps) if (pr[0] >= W.f) cut++;
  r.cutPresses = cut;                                   // presses that start after the end of the run
  return r;
}
