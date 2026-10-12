// THE NODE WRITES EVERY ROUND OF THE NEXT 72 HOURS (the owner 2026-09-28 11:31, NODE72-1131 / HORIZON72-1131: "the node
// writes and lists every round for the next 72 hours. A 48-hour window is not enough").
//
// A series (arena-protocol/src/series.js) fixes every one of its rounds; this is the node putting them in its round store
// ahead of time - each derived contract opened by the same `Round.open` a posted round goes through, so a series round
// is refused for the same reasons any round is - for every start from now to now + 72 h, and again as the clock
// moves. A series that leaves less than the 72 h lead is refused whole, by the spec's rule.
import { toHex } from '../../arena-protocol/src/hash.js';
import { SERIES_WRITE_AHEAD_MS, seriesLeadIsValid, seriesId, seriesRound, seriesRoundsWithin, seriesRunFits, isGridSeries } from '../../arena-protocol/src/series.js';
import { pluginForRound } from './plugins.js';
import { seriesPeriodFits } from '../../arena-protocol/src/manifest.js';

export const SERIES_HORIZON_MS = SERIES_WRITE_AHEAD_MS;       // 72 h on every network (TN24-1405)

/**
 * One series' writer over a Round store. `write(nowMs)` opens every round of the series starting in
 * [nowMs, nowMs + horizon] that it has not opened yet, and answers what it holds.
 */
export function seriesWriter(round, template, { horizonMs = SERIES_HORIZON_MS } = {}) {
  const lead = seriesLeadIsValid(template);
  if (!lead.ok) throw new Error(`series refused: ${lead.why}`);
  // AND ITS RUN FITS ITS SLOT (the 82/90 fork): on a core that takes the round's run length, at most 82 s of 90.
  const runs = round && round.plugins ? pluginForRound(template, round.plugins) : null;
  // AND ITS GAME'S round_period (kanban #202; a market's own, #236/#237)
  if (runs && runs.ok) {
    const period = seriesPeriodFits(runs.plugin.manifest);
    if (!period.ok) throw new Error(`series refused: ${period.why}`);
    // ON ITS GAME'S OWN PERIOD (§0A.7b.4): stamped on the template, so its id, its rounds and its day's count follow it
    // wherever the node reads this series (series.js periodOf); a 90 s game's series is exactly what it was
    if (period.periodMs !== 90000n) template.seriesPeriodMs = period.periodMs;
  }
  // NOT A GRID'S (kanban #293, the owner 2026-10-12): its rounds overlap by design - an 8 s grid of 80 s entry windows - and
  // its rule is its own entry window (series.js gridIsValid), not the 90 s grid's slot
  if (runs && runs.ok && runs.core && !Number.isInteger(runs.core.fixedRunTicks) && !isGridSeries(template)) {
    const fits = seriesRunFits(template);
    if (!fits.ok) throw new Error(`series refused: ${fits.why}`);
  }
  const id = seriesId(template);
  const written = new Map();                                  // index -> { id hex, startTimeMs }
  // `untilMs` (wall clock): stop there and say so (`writer.more`), so a node's start - every round of 72 h opened again,
  // ~4,500 on testnet4 with seven series, measured 21-33 s of a loop that answered nothing - is walked in slices, the
  // soonest rounds first, with requests served between them.
  const writer = { more: false };
  const write = (nowMs, untilMs = Infinity) => {
    const now = BigInt(nowMs);
    let added = 0;
    writer.more = false;
    for (const i of seriesRoundsWithin(template, now, now + BigInt(horizonMs))) {
      // NOT FROM ITS CUT ON (the 82/90 tail): those rounds are its tail's.
      if (Number.isInteger(template.seriesCutFrom) && i >= template.seriesCutFrom) continue;
      if (written.has(i)) continue;
      if (Date.now() >= untilMs) { writer.more = true; break; }
      const c = seriesRound(template, i);
      const rid = round.open(c);
      written.set(i, { id: toHex(rid), startTimeMs: c.startTimeMs });
      added++;
    }
    return added;
  };
  const ids = () => new Set([...written.values()].map((w) => w.id));
  /** The rounds written that start in [now, now + ms), soonest first: what the node assigns signer nodes to next. */
  const startingWithin = (nowMs, ms) => [...written.values()]
    .filter((w) => w.startTimeMs >= BigInt(nowMs) && w.startTimeMs < BigInt(nowMs) + BigInt(ms))
    .sort((a, b) => (a.startTimeMs < b.startTimeMs ? -1 : 1)).map((w) => w.id);
  /** The soonest round written that has not started, or null. */
  const soonest = (nowMs) => startingWithin(nowMs, Number.MAX_SAFE_INTEGER - Number(nowMs))[0] || null;
  const summary = (nowMs) => {
    const now = BigInt(nowMs);
    const ahead = [...written.entries()].filter(([, w]) => w.startTimeMs >= now).sort((a, b) => a[0] - b[0]);
    const at = (e) => (e ? { index: e[0], id: e[1].id, startTimeMs: String(e[1].startTimeMs) } : null);
    return { series: toHex(id), startTimeMs: String(template.startTimeMs), committeeTimeMs: String(template.committeeTimeMs),
      horizonMs: String(horizonMs), written: written.size, ahead: ahead.length, first: at(ahead[0]), last: at(ahead[ahead.length - 1]) };
  };
  return Object.assign(writer, { id, template, write, ids, summary, startingWithin, soonest });
}
