// THE NODE WRITES EVERY ROUND OF THE NEXT 72 HOURS (the owner 2026-09-28 11:31, NODE72-1131 / HORIZON72-1131: "the node
// writes and lists every round for the next 72 hours. A 48-hour window is not enough").
//
// A series (protocol/src/series.js) fixes every one of its rounds; this is the node putting them in its round store
// ahead of time - each derived contract opened by the same `Round.open` a posted round goes through, so a series round
// is refused for the same reasons any round is - for every start from now to now + 72 h, and again as the clock
// moves. A series that leaves less than the 72 h lead is refused whole, by the spec's rule.
import { toHex } from '../../protocol/src/hash.js';
import { SERIES_LEAD_MIN_MS, seriesLeadIsValid, seriesId, seriesRound, seriesRoundsWithin } from '../../protocol/src/series.js';

export const SERIES_HORIZON_MS = SERIES_LEAD_MIN_MS;          // 72 h

/**
 * One series' writer over a Round store. `write(nowMs)` opens every round of the series starting in
 * [nowMs, nowMs + horizon] that it has not opened yet, and answers what it holds.
 */
export function seriesWriter(round, template, { horizonMs = SERIES_HORIZON_MS } = {}) {
  const lead = seriesLeadIsValid(template);
  if (!lead.ok) throw new Error(`series refused: ${lead.why}`);
  const id = seriesId(template);
  const written = new Map();                                  // index -> { id hex, startTimeMs }
  const write = (nowMs) => {
    const now = BigInt(nowMs);
    let added = 0;
    for (const i of seriesRoundsWithin(template, now, now + BigInt(horizonMs))) {
      if (written.has(i)) continue;
      const c = seriesRound(template, i);
      const rid = round.open(c);
      written.set(i, { id: toHex(rid), startTimeMs: c.startTimeMs });
      added++;
    }
    return added;
  };
  const ids = () => new Set([...written.values()].map((w) => w.id));
  const summary = (nowMs) => {
    const now = BigInt(nowMs);
    const ahead = [...written.entries()].filter(([, w]) => w.startTimeMs >= now).sort((a, b) => a[0] - b[0]);
    const at = (e) => (e ? { index: e[0], id: e[1].id, startTimeMs: String(e[1].startTimeMs) } : null);
    return { series: toHex(id), startTimeMs: String(template.startTimeMs), committeeTimeMs: String(template.committeeTimeMs),
      horizonMs: String(horizonMs), written: written.size, ahead: ahead.length, first: at(ahead[0]), last: at(ahead[ahead.length - 1]) };
  };
  return { id, template, write, ids, summary };
}
