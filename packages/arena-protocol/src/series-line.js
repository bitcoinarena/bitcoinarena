// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// ONE SERIES A LINE (ARENA_SERIES_FILE, the body of POST /series, and GET /series-template): its template, hex; then `count=N` for
// a tail (the 82/90 fork: fewer than a day's 960 rounds - its id is taken over that count) and `cut=N` for a series replaced from
// round N by its tail; and for a grid series (2026-10-12: an RPS grid published as a short series) `grid`,
// `period=N` (ms) and `count=N` - all three in its id. A series whose template names its creator carries
// `creator=<128 hex>`: the creator's signature over the series id (creator.js seriesCreatorStands) - beside the id, not in it.
//
// IN THE PROTOCOL, NOT THE NODE: a page reads a line too - the template of a market on a game's series source round,
// taken from any seat and believed only once it hashes to the series id the round names (series.js seriesId). No Buffer here.
import { decodeRoundContract, encodeRoundContract } from './contracts.js';
import { toHex, fromHex } from './hash.js';

export function parseSeriesLine(line) {
  const [h, ...more] = String(line).trim().split(/\s+/);
  if (!h || !/^[0-9a-f]+$/i.test(h) || h.length % 2) throw new Error('a series line starts with its template, hex');
  const t = decodeRoundContract(fromHex(h.toLowerCase()));
  for (const m of more) {
    if (m === 'grid') { t.seriesGrid = true; continue; }
    const cr = /^creator=([0-9a-f]{128})$/i.exec(m);
    if (cr) { t.creatorSignature = fromHex(cr[1].toLowerCase()); continue; }
    const kv = /^(count|cut|period)=(\d+)$/.exec(m);
    if (!kv) throw new Error(`a series line names ${m}, not count=N, cut=N, period=N, grid or creator=<signature>`);
    if (kv[1] === 'count') t.seriesCount = Number(kv[2]);
    else if (kv[1] === 'cut') t.seriesCutFrom = Number(kv[2]);
    else t.seriesPeriodMs = BigInt(kv[2]);
  }
  return t;
}

export const readSeriesLines = (text) => String(text).split(/\n/).map((l) => l.trim())
  .filter((l) => /^[0-9a-f]/i.test(l)).map(parseSeriesLine);

/** The line for a template: what parseSeriesLine reads back. (`encode` is kept for the node's callers; the protocol's is used.) */
export function seriesLineOf(template, encode = encodeRoundContract) {
  const { seriesId: _s, roundIndex: _i, seriesCount, seriesCutFrom, seriesPeriodMs, seriesGrid, creatorSignature, ...rest } = template; void _s; void _i;
  const words = [toHex(encode(rest))];
  if (seriesGrid) words.push('grid');
  if (seriesPeriodMs !== undefined && seriesPeriodMs !== null) words.push(`period=${seriesPeriodMs}`);
  if (Number.isInteger(seriesCount)) words.push(`count=${seriesCount}`);
  if (Number.isInteger(seriesCutFrom)) words.push(`cut=${seriesCutFrom}`);
  if (creatorSignature instanceof Uint8Array) words.push(`creator=${toHex(creatorSignature)}`);
  return words.join(' ');
}
