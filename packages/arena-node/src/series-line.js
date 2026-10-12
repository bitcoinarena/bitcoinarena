// ONE SERIES A LINE (ARENA_SERIES_FILE, and the body of POST /series): its template, hex; then `count=N` for a tail (the
// 82/90 fork: fewer than a day's 960 rounds - its id is taken over that count) and `cut=N` for a series replaced from round
// N by its tail; and for a grid series (kanban #293, the owner 2026-10-12: an RPS grid published as a short series) `grid`,
// `period=N` (ms) and `count=N` - all three in its id.
import { decodeRoundContract } from '../../arena-protocol/src/contracts.js';

export function parseSeriesLine(line) {
  const [h, ...more] = String(line).trim().split(/\s+/);
  if (!h || !/^[0-9a-f]+$/i.test(h)) throw new Error('a series line starts with its template, hex');
  const t = decodeRoundContract(new Uint8Array(Buffer.from(h, 'hex')));
  for (const m of more) {
    if (m === 'grid') { t.seriesGrid = true; continue; }
    const kv = /^(count|cut|period)=(\d+)$/.exec(m);
    if (!kv) throw new Error(`a series line names ${m}, not count=N, cut=N, period=N or grid`);
    if (kv[1] === 'count') t.seriesCount = Number(kv[2]);
    else if (kv[1] === 'cut') t.seriesCutFrom = Number(kv[2]);
    else t.seriesPeriodMs = BigInt(kv[2]);
  }
  return t;
}

export const readSeriesLines = (text) => String(text).split(/\n/).map((l) => l.trim())
  .filter((l) => /^[0-9a-f]/i.test(l)).map(parseSeriesLine);

/** The line for a template: what parseSeriesLine reads back. */
export function seriesLineOf(template, encodeRoundContract) {
  const { seriesId: _s, roundIndex: _i, seriesCount, seriesCutFrom, seriesPeriodMs, seriesGrid, ...rest } = template; void _s; void _i;
  const words = [Buffer.from(encodeRoundContract(rest)).toString('hex')];
  if (seriesGrid) words.push('grid');
  if (seriesPeriodMs !== undefined && seriesPeriodMs !== null) words.push(`period=${seriesPeriodMs}`);
  if (Number.isInteger(seriesCount)) words.push(`count=${seriesCount}`);
  if (Number.isInteger(seriesCutFrom)) words.push(`cut=${seriesCutFrom}`);
  return words.join(' ');
}
