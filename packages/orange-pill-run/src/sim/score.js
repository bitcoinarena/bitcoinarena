// Orange Pill Run - the score of a world (kanban #3246), as in the prototype: sats (coins + 5 per ₿ block),
// 10 per stomp (+5 per printer), 100 for the flag, timePerS per second under par (opr-1: 2, opr-2: 20, kanban #3271),
// 50 for the day high; x1.5 for a finished run without a death. An unfinished run gets no time and no flag.
import { rulesOf } from "./constants.js";

export function scoreOf(W) {
  const s = W.stats, par = W.L.parTime, rate = rulesOf(W.L.version || "opr-1").timePerS;
  const timeBonus = s.finished ? Math.max(0, Math.round((par - W.time) * rate)) : 0;
  const parts = { sats: s.coins + s.blocks * 5, stomps: s.stomps * 10 + (s.printers || 0) * 5, goal: s.finished ? 100 : 0, time: timeBonus, high: s.high ? 50 : 0 };
  const base = parts.sats + parts.stomps + parts.goal + parts.time + parts.high, clean = s.finished && s.hits === 0;
  return { parts, base, clean, par, total: Math.round(base * (clean ? 1.5 : 1)) };
}
