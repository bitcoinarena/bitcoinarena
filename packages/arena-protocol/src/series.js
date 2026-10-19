// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A ROUND SERIES: ONE PUBLICATION, A NEW ROUND EVERY 90 s, WRITTEN 72 h AHEAD (multiplayer_p2p.md §5A.5 "Round series";
// 2026-09-28, 18738972 and HORIZON72-1131 / NODE72-1131).
//
// The unit anchored on chain is a SERIES: its template - every field of a Round Contract, its committee_time and its
// start - is hashed once, and `OP_RETURN "ARN" SERIES series_id` publishes it. Round `i` of it is derived, never
// authored: the template with start_time = series_start + i * 90 s and its entry closing at that start (every run of a
// round starts together). Nothing per round is chosen after the beacon, so a series grinds no better than one round.
//
// THE TIMES ARE THE SPEC'S, counted back from the series' start:
//
//     committee_time(k)  = series_start(k) - committee lead   (mainnet 72 h, testnet4 24 h)
//     census_height(k)   = the highest block whose MTP <= series_start(k) - census lead   (mainnet 72 h, testnet4 36 h)
//     series_lead_min    = mainnet 72 h, testnet4 24 h: a node refuses a series whose start is less than that after
//                          its committee_time; the writer still lays 72 h of rounds ahead on every network
//
// A ROUND OF A SERIES CARRIES ITS SERIES ID AND ITS INDEX, and its id is round_id(i) = H(series_id || i)
// (ALL-BUT-MIN-1727, 2026-09-29 17:27; contracts.js). A node holds such a round only when its contract is
// exactly the one the series derives - index inside 0 .. round_count - 1, entry window the derived one
// (seriesRoundCheck) - and refuses entries, locks and settlements for any other.
import { msForTicks } from './tick.js';
import { taggedHash } from './hash.js';
import { isOldTestnet4Id, isOldTestnet4Series } from './old-series.js';
import { encodeRoundContract, idBodyOf } from './contracts.js';
import { PUBLICATION_MAGIC, PUBLICATION_BYTES } from './publication.js';
import { OP_RETURN, parseTransaction, commitmentsOf } from './tx.js';
import { NETWORK_ID_TESTNET4 } from './genesis-ids.js';
import { genesisFor } from './genesis.js';
import { networkOf } from './constants.js';

// THE GRID ITSELF LIVES IN constants.js (the manifest reads it there, so a client bundle carrying manifests
// does not carry the series code); every series reader takes it from here as before.
export { ROUND_PERIOD_MS } from './constants.js';
import { ROUND_PERIOD_MS } from './constants.js';
// LATE JOIN (2026-10-03: "Joining an existing round is possible with 45 seconds in"): a series may close each round's
// entry LATE_JOIN_MS after its start instead of at it. The template's own entry_close - start is the series' late join
// (0 or LATE_JOIN_MS), and every round derives the same: it is in the template's bytes, so in the series id.
export const LATE_JOIN_MS = 45000n;
// The last entry of a late-join round is contracts.js LATE_JOIN_LAST_ENTRY_MS.
export { LATE_JOIN_LAST_ENTRY_MS } from './contracts.js';
const lateJoinOf = (template) => {
  const late = template.entryCloseMs - template.startTimeMs;
  return late === 0n || late === LATE_JOIN_MS ? late : null;
};
export const SERIES_MAX_MS = 86400000n;                     // a series lasts at most 24 h

// A GRID SERIES (2026-10-12: "Pick S ... Publish the grid as a short series, the format the spec
// already has: one ARN S series_id output per table, two per grid"): an on-demand head-to-head grid - Rock Paper Scissors'
// 2 tables of 8 s rounds - published as one series per table instead of one OP_RETURN per round (450 outputs, ~21,000 sat
// at 1 sat/vB). Its own rule, in the owner's words: "lead of at least 45 minutes, as path B already uses; any start time; at
// most 30 minutes of rounds; its own entry window". Still published on demand, about 1 h ahead: a series only in how it
// is written on chain. Nothing per round is chosen after the beacon - every round is derived from the template.
// 24 HOURS OF ROUNDS (2026-10-12 ~09:55Z: "Make sure each grid has 24 hours of gameplay, and cost as less as possible
// on chain"): a grid runs at most a day - 10,800 slots of 8 s per table - published once a day for ~20 sat at 0.1 sat/vB;
// the 30 minutes ruled at ~06:20Z gave way to it.
// A template is one by `seriesGrid: true`, its period (`seriesPeriodMs`) and count (`seriesCount`) named; all three are
// in its series id (H(template || period || count || 'G')), so a grid's id is never a day series' or a tail's.
export const GRID_SERIES_MAX_MS = SERIES_MAX_MS;            // 24 h
export const GRID_SERIES_LEAD_MIN_MS = 45n * 60000n;
const GRID_ID_MARK = 0x47;                                  // 'G'
export const isGridSeries = (template) => !!template && template.seriesGrid === true;
// A GRID'S ENTRY WINDOW IS ITS OWN: entry_close - start, as the template names it, for every round of it
const gridLateOf = (template) => template.entryCloseMs - template.startTimeMs;
export const ROUNDS_PER_SERIES = Number(SERIES_MAX_MS / ROUND_PERIOD_MS);   // 960

// A SERIES RUNS ON ITS GAME'S OWN round_period (§0A.7b.4 "Market rounds on their own 15 min period
// instead of the 90 s grid"): a template may carry `seriesPeriodMs` - the node sets it from the game's manifest
// (series-writer.js) - and every function here reads the period, and the day's round count, off the template. A template
// without one is on the 90 s grid, as every series before this: its id, rounds and count are unchanged.
const periodOf = (template, periodMs) => (periodMs !== undefined && periodMs !== null ? BigInt(periodMs)
  : (template && template.seriesPeriodMs !== undefined && template.seriesPeriodMs !== null ? BigInt(template.seriesPeriodMs) : ROUND_PERIOD_MS));
/** A day's rounds on a period: 960 on 90 s, 96 on 15 min. */
export const roundsPerSeries = (periodMs = ROUND_PERIOD_MS) => Number(SERIES_MAX_MS / BigInt(periodMs));
const HOUR = 3600000n;
// THE WRITER'S HORIZON IS 72 h ON EVERY NETWORK (TN24-1405): the schedule is laid 72 h ahead whatever the clock below.
export const SERIES_WRITE_AHEAD_MS = 72n * HOUR;

/**
 * THE SERIES CLOCK, PER NETWORK. Mainnet (CENSUS3D-1401): census cut, committee_time and lead are one 72 h.
 * Testnet4 (TN24-1405, and the owner 14:1x: "Take the 36 h census lead"): committee_time 24 h before the start and a
 * 24 h lead, so a round can be tested the next day - and the census 36 h before the start, because a census cut at the
 * committee_time puts the beacon (the first block past committee_time) one block after the census block, below any
 * publication that names that census: measured on census 154206, committee_time 1 s after its median and block 154207
 * already past it. The 12 h between census and committee_time is the publication window.
 */
export const SERIES_CLOCKS = Object.freeze({
  mainnet: Object.freeze({ censusLeadMs: 72n * HOUR, committeeLeadMs: 72n * HOUR, leadMinMs: 72n * HOUR }),
  testnet4: Object.freeze({ censusLeadMs: 36n * HOUR, committeeLeadMs: 24n * HOUR, leadMinMs: 24n * HOUR }),
});
const seriesSameBytes = (a, b) => a instanceof Uint8Array && b instanceof Uint8Array && a.length === b.length && a.every((x, i) => x === b[i]);
/** The clock a contract's network runs: testnet4's for its network id, mainnet's for every other. */
export const seriesClockFor = (networkId) => (seriesSameBytes(networkId, NETWORK_ID_TESTNET4) || isOldTestnet4Id(networkId)
  ? SERIES_CLOCKS.testnet4 : SERIES_CLOCKS.mainnet);
// the mainnet figures under their old names, for callers that name no network
export const SERIES_LEAD_MIN_MS = SERIES_CLOCKS.mainnet.leadMinMs;
export const SERIES_COMMITTEE_LEAD_MS = SERIES_CLOCKS.mainnet.committeeLeadMs;
export const SERIES_CENSUS_LEAD_MS = SERIES_CLOCKS.mainnet.censusLeadMs;
export const PUBLICATION_KIND_SERIES = 0x53;                // 'S', beside ROUND's 'R'

const u64 = (v) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(v)); return b; };
const u32 = (v) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v); return b; };

/** When series 0 starts on the network a contract names: its genesis parameter (ALL-BUT-MIN-1727). */
export function genesisSeriesStart(networkId) {
  const network = networkOf(networkId);
  if (!network) throw new Error('that contract names a network this build has no genesis for, so no series start');
  return genesisFor(network).genesisSeriesStartMs;
}

/** series_start(k) = genesis_series_start + k * series_max. */
export function seriesStartOf(networkId, k) {
  if (!Number.isInteger(k) || k < 0) throw new Error('a series is numbered 0, 1, 2 ...');
  return genesisSeriesStart(networkId) + BigInt(k) * SERIES_MAX_MS;
}

/** The first series whose start is at or after `ms` on that network. */
export function seriesIndexAt(networkId, ms) {
  const g = genesisSeriesStart(networkId);
  const at = BigInt(ms);
  return at <= g ? 0 : Number((at - g + SERIES_MAX_MS - 1n) / SERIES_MAX_MS);
}

/**
 * SERIES k's TEMPLATE from any Round Contract of its committee: its start the network's genesis_series_start + k * 24 h
 * (a series does not name its own start), committee_time its network's lead before it, entry closing at it.
 */
export function seriesTemplate(contract, k) {
  const start = seriesStartOf(contract.networkId, k);
  const clock = seriesClockFor(contract.networkId);
  return { ...contract, committeeTimeMs: start - clock.committeeLeadMs, startTimeMs: start, entryCloseMs: start };
}

/** HORIZON72-1131: a series whose start is less than 72 h after its committee_time is refused - listed, opened, entered never. */
export function seriesLeadIsValid(template) {
  if (!template || typeof template.startTimeMs !== 'bigint' || typeof template.committeeTimeMs !== 'bigint')
    return { ok: false, why: 'a series names its committee time and its start' };
  const lead = template.startTimeMs - template.committeeTimeMs;
  if (isGridSeries(template)) return gridIsValid(template, lead);
  // A TAIL (the 82/90 fork, 2026-10-01: "the partial-day tail"): fewer rounds than a day's, starting on the 90 s grid
  // inside its day and running to that day's end, on testnet4 only, with a committee lead of at least 12 h.
  if (Number.isInteger(template.seriesCount) && template.seriesCount !== roundsPerSeries(periodOf(template))) return tailIsValid(template, lead);
  const min = seriesClockFor(template.networkId).leadMinMs;
  if (lead < min)
    return { ok: false, why: `that series starts ${lead} ms after its committee time, and a round must exist ${min} ms (${min / HOUR} h) before its first entry` };
  if (lateJoinOf(template) === null)
    return { ok: false, why: `a series round's entry closes at its start or ${LATE_JOIN_MS} ms after it (late join)` };
  // PICK B (old-series.js): series 3cfbe516 of testnet4's old id predates genesis_series_start - no grid to be on
  if (isOldTestnet4Id(template.networkId) && isOldTestnet4Series(seriesId(template))) return { ok: true, leadMs: lead, oldSeries: true };
  // ON THE GENESIS GRID (ALL-BUT-MIN-1727): a series starts at genesis_series_start + k * 24 h, never where it names
  let g;
  try { g = genesisSeriesStart(template.networkId); } catch (e) { return { ok: false, why: e.message }; }
  if (template.startTimeMs < g || (template.startTimeMs - g) % SERIES_MAX_MS !== 0n)
    return { ok: false, why: `that series starts at ${template.startTimeMs}, and a series starts at genesis_series_start ${g} + k * ${SERIES_MAX_MS} ms` };
  return { ok: true, leadMs: lead };
}

function gridIsValid(template, lead) {
  const period = template.seriesPeriodMs, count = template.seriesCount;
  if (typeof period !== 'bigint' || period <= 0n) return { ok: false, why: 'a grid series names its period' };
  if (!Number.isInteger(count) || count < 1) return { ok: false, why: 'a grid series names its round count' };
  if (BigInt(count) * period > GRID_SERIES_MAX_MS)
    return { ok: false, why: `a grid series of ${count} rounds every ${period} ms runs ${BigInt(count) * period} ms, and a grid runs at most ${GRID_SERIES_MAX_MS} ms (24 h)` };
  if (lead < GRID_SERIES_LEAD_MIN_MS)
    return { ok: false, why: `that grid starts ${lead} ms after its committee time, and a grid needs ${GRID_SERIES_LEAD_MIN_MS} ms (45 min)` };
  if (typeof template.entryCloseMs !== 'bigint' || gridLateOf(template) < 0n)
    return { ok: false, why: 'a grid round\'s entry closes at or after its start' };
  return { ok: true, leadMs: lead, grid: true };
}

function tailIsValid(template, lead) {
  if (seriesClockFor(template.networkId) !== SERIES_CLOCKS.testnet4) return { ok: false, why: 'a tail series is testnet4\'s only: the mainnet clock is one 72 h' };
  if (lateJoinOf(template) === null) return { ok: false, why: `a series round's entry closes at its start or ${LATE_JOIN_MS} ms after it (late join)` };
  let g;
  try { g = genesisSeriesStart(template.networkId); } catch (e) { return { ok: false, why: e.message }; }
  const into = template.startTimeMs - g;
  if (template.startTimeMs < g || into % ROUND_PERIOD_MS !== 0n) return { ok: false, why: `a tail starts on the 90 s grid from genesis_series_start ${g}` };
  const index = Number((into % SERIES_MAX_MS) / ROUND_PERIOD_MS);
  if (index === 0 || template.seriesCount !== ROUNDS_PER_SERIES - index)
    return { ok: false, why: `a tail from round ${index} of its day runs ${ROUNDS_PER_SERIES - index} rounds, to the day's end - not ${template.seriesCount}` };
  if (lead < TAIL_COMMITTEE_LEAD_MIN_MS)
    return { ok: false, why: `that tail starts ${lead} ms after its committee time, and a tail needs ${TAIL_COMMITTEE_LEAD_MIN_MS} ms (12 h)` };
  return { ok: true, leadMs: lead, tail: true, fromIndex: index };
}

/** A contract without its series fields: what a series' template is. */
const withoutSeries = (c) => { const { seriesId: _s, roundIndex: _i, seriesCount: _n, seriesCutFrom: _c, seriesPeriodMs: _p, seriesGrid: _g, ...rest } = c; void _s; void _i; void _n; void _c; void _p; void _g; return rest; };

/**
 * A HELD SERIES' ROUND COUNT AND CUT (the 82/90 tail, 2026-10-01): a template may carry `seriesCount` - a tail's
 * rounds, fewer than a day's 960 - and `seriesCutFrom` - the index from which a held series is replaced by a tail. Neither
 * is in the template's bytes; the count is in its series id (H(template || period || count)), the cut is the node's.
 */
const countOf = (template, count) => (count !== undefined ? count
  : (template && Number.isInteger(template.seriesCount) ? template.seriesCount : roundsPerSeries(periodOf(template))));
export const TAIL_COMMITTEE_LEAD_MIN_MS = 12n * HOUR;

// ONE TEMPLATE'S ID IS WORKED OUT ONCE PER PERIOD AND COUNT (measured on seat 3's start 2026-10-18:
// seriesRoundCheck - every door that touches a round asks it - encoded and hashed every held template again on every ask,
// 4.5 % of the main thread's first minute). Kept per template object: a series file read again makes new objects; nothing
// changes a template after it is read.
const idsOf = new WeakMap();   // template -> Map(`${periodMs}|${count}` -> id)

/** series_id = H(template || round_period || round_count), tagged; a grid's with 'G' after its count. */
export function seriesId(template, { periodMs, count } = {}) {
  periodMs = periodOf(template, periodMs);
  count = countOf(template, count);
  const memo = template && typeof template === 'object' ? (idsOf.get(template) || (idsOf.set(template, new Map()), idsOf.get(template))) : null;
  const key = `${periodMs}|${count}`;
  if (memo && memo.has(key)) return memo.get(key);
  const id = seriesIdOf(template, periodMs, count);
  if (memo) memo.set(key, id);
  return id;
}
function seriesIdOf(template, periodMs, count) {
  // a v2 template's `nodes` is no part of its id (2026.0.2): its rounds' seats are drawn after it
  const body = encodeRoundContract(idBodyOf(withoutSeries(template)));
  const bytes = new Uint8Array(body.length + 12 + (isGridSeries(template) ? 1 : 0));
  bytes.set(body, 0);
  bytes.set(u64(periodMs), body.length);
  bytes.set(u32(count), body.length + 8);
  if (isGridSeries(template)) bytes[body.length + 12] = GRID_ID_MARK;
  return taggedHash('ARENA/v1/Series', bytes);
}

/** Round `i` of the series, derived: start = series_start + i * 90 s, entry closing at that start. */
export function seriesRound(template, i, { periodMs, count } = {}) {
  periodMs = periodOf(template, periodMs);
  count = countOf(template, count);
  if (!Number.isInteger(i) || i < 0 || i >= count) throw new Error(`round ${i} is outside the series' 0 .. ${count - 1}`);
  const start = template.startTimeMs + BigInt(i) * BigInt(periodMs);
  const late = isGridSeries(template) ? gridLateOf(template)
    : template.entryCloseMs !== undefined && lateJoinOf(template) !== null ? lateJoinOf(template) : 0n;
  return { ...withoutSeries(template), startTimeMs: start, entryCloseMs: start + late,
    seriesId: seriesId(template, { periodMs, count }), roundIndex: i };
}

/**
 * IS THIS THE ROUND A SERIES THIS NODE HOLDS DERIVES? A contract naming no series is not a series round ({ ok, series:
 * false }). One naming a series must name one of `templates` (the series this node holds), an index inside
 * 0 .. round_count - 1, and be byte for byte `seriesRound(template, i)` - its entry window the derived one.
 */
/**
 * A SERIES' RUN FITS ITS 90 s SLOT (the 82/90 hard fork, 2026-10-01; multiplayer_p2p.md "Timing": "a run lasts at
 * most 82 seconds ... run ends <= start_time(i+1) - 8 s"): the run its rounds name (blockTicks, at the core's tick rate)
 * ends at least 8 s before the next round starts. Asked of a series on a core that takes its rounds' run length; a core
 * held to one length (the truck before the fork, 180 s) is that core's own and was posted before the rule.
 */
export const SERIES_RESULT_CARD_MS = 8000n;
export function seriesRunFits(template, { periodMs } = {}) {
  periodMs = periodOf(template, periodMs);
  let runMs;
  try { runMs = msForTicks(template.blockTicks).ms; } catch (e) { return { ok: false, why: `the series names no run length: ${e.message}` }; }
  const most = BigInt(periodMs) - SERIES_RESULT_CARD_MS;
  if (BigInt(runMs) > most)
    return { ok: false, why: `a run of ${template.blockTicks} ticks is ${runMs} ms, and a round of a ${periodMs} ms series runs at most ${most} ms (its next start less ${SERIES_RESULT_CARD_MS} ms)` };
  return { ok: true, runMs: BigInt(runMs) };
}

export function seriesRoundCheck(contract, templates, { periodMs, count: given } = {}) {
  if (!contract || contract.seriesId === undefined || contract.seriesId === null) return { ok: true, series: false };
  const t = (templates || []).find((x) => seriesSameBytes(seriesId(x, { periodMs, count: given }), contract.seriesId));
  const count = t ? countOf(t, given) : ROUNDS_PER_SERIES;
  const hex = Array.from(contract.seriesId.subarray(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
  if (!t) return { ok: false, series: true, why: `that round names series ${hex}, and this node holds no such series` };
  if (!Number.isInteger(contract.roundIndex) || contract.roundIndex < 0 || contract.roundIndex >= count)
    return { ok: false, series: true, why: `round ${contract.roundIndex} is outside series ${hex}'s 0 .. ${count - 1}` };
  // REPLACED FROM ITS CUT (the 82/90 tail): a held series cut at index C takes no round from C on - a tail carries them.
  if (Number.isInteger(t.seriesCutFrom) && contract.roundIndex >= t.seriesCutFrom)
    return { ok: false, series: true, why: `round ${contract.roundIndex} of series ${hex} is replaced from index ${t.seriesCutFrom} by its 82 s tail: not announced, entered, locked or settled` };
  const derived = seriesRound(t, contract.roundIndex, { periodMs: periodOf(t, periodMs), count });
  if (contract.startTimeMs !== derived.startTimeMs || contract.entryCloseMs !== derived.entryCloseMs
    || contract.committeeTimeMs !== derived.committeeTimeMs)
    return { ok: false, series: true, why: `round ${contract.roundIndex} of series ${hex} opens and closes its entry at `
      + `${derived.committeeTimeMs}..${derived.entryCloseMs}, and that contract names ${contract.committeeTimeMs}..${contract.entryCloseMs}` };
  // A v2 ROUND'S `nodes` IS ITS SEATS' OWN ANSWER (2026.0.2): compared without it
  if (!seriesSameBytes(encodeRoundContract(idBodyOf(contract)), encodeRoundContract(idBodyOf(derived))))
    return { ok: false, series: true, why: `that contract is not round ${contract.roundIndex} of series ${hex} as the series derives it` };
  return { ok: true, series: true, index: contract.roundIndex, template: t };
}

/** The indices of the series' rounds whose start lies in [fromMs, toMs]. */
export function seriesRoundsWithin(template, fromMs, toMs, { periodMs, count } = {}) {
  periodMs = periodOf(template, periodMs);
  count = countOf(template, count);
  const p = BigInt(periodMs), s = template.startTimeMs, from = BigInt(fromMs), to = BigInt(toMs);
  if (to < s) return [];
  const first = from <= s ? 0n : (from - s + p - 1n) / p;
  const last = (to - s) / p;
  const out = [];
  for (let i = first; i <= last && i < BigInt(count); i++) out.push(Number(i));
  return out;
}

/** The 36 bytes a series' publication carries: "ARN", SERIES, series id. */
export function seriesPublicationPayload(seriesIdBytes) {
  if (!(seriesIdBytes instanceof Uint8Array) || seriesIdBytes.length !== 32) throw new TypeError('a series publication commits to a 32-byte series id');
  const out = new Uint8Array(PUBLICATION_BYTES);
  out.set(PUBLICATION_MAGIC, 0);
  out[3] = PUBLICATION_KIND_SERIES;
  out.set(seriesIdBytes, 4);
  return out;
}

/**
 * WHERE A SERIES WAS PUBLISHED, IN A CHAIN VIEW THIS NODE READ ITSELF: the lowest block carrying its series payload - a
 * series round has no publication of its own, the series' is its (§5A.5 for a series). Null when the view holds none.
 */
export function findSeriesPublication(view, seriesIdBytes) {
  if (!view || !Array.isArray(view.blocks) || !Number.isInteger(view.firstHeight)) return null;
  const want = seriesPublicationPayload(seriesIdBytes);
  for (let i = 0; i < view.blocks.length; i++) {
    for (const raw of view.blocks[i].transactions || []) {
      let tx;
      try { tx = parseTransaction(raw); } catch { continue; }
      if (commitmentsOf(tx).some((p) => p.length === want.length && p.every((b, j) => b === want[j]))) return { tx, height: view.firstHeight + i };
    }
  }
  return null;
}

/** The output that publishes a series: zero value, one direct push. */
export function seriesPublicationOutput(seriesIdBytes) {
  const payload = seriesPublicationPayload(seriesIdBytes);
  const script = new Uint8Array(2 + PUBLICATION_BYTES);
  script[0] = OP_RETURN;
  script[1] = PUBLICATION_BYTES;
  script.set(payload, 2);
  return { value: 0n, script };
}
