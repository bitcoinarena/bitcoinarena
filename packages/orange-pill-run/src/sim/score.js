// Orange Pill Run - the score of a world (kanban #3246), as in the prototype: sats (coins + 5 per ₿ block),
// 10 per stomp (+5 per printer), 100 for the flag, 2 per second under par, 50 for the day high; x1.5 for a
// finished run without a death.
export function scoreOf(W) {
  const s = W.stats, par = W.L.parTime, timeBonus = s.finished ? Math.max(0, Math.round((par - W.time) * 2)) : 0;
  const parts = { sats: s.coins + s.blocks * 5, stomps: s.stomps * 10 + (s.printers || 0) * 5, goal: s.finished ? 100 : 0, time: timeBonus, high: s.high ? 50 : 0 };
  const base = parts.sats + parts.stomps + parts.goal + parts.time + parts.high, clean = s.finished && s.hits === 0;
  return { parts, base, clean, par, total: Math.round(base * (clean ? 1.5 : 1)) };
}
