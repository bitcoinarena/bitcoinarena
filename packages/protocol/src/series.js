// A ROUND SERIES: ONE PUBLICATION, A NEW ROUND EVERY 90 s, WRITTEN 72 h AHEAD (multiplayer_p2p.md §5A.5 "Round series";
// the owner 2026-09-28, 18738972 and HORIZON72-1131 / NODE72-1131).
//
// The unit anchored on chain is a SERIES: its template - every field of a Round Contract, its committee_time and its
// start - is hashed once, and `OP_RETURN "BLW" SERIES series_id` publishes it. Round `i` of it is derived, never
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
// (ALL-BUT-MIN-1727, the owner 2026-09-29 17:27; contracts.js). A node holds such a round only when its contract is
// exactly the one the series derives - index inside 0 .. round_count - 1, entry window the derived one
// (seriesRoundCheck) - and refuses entries, locks and settlements for any other.
import { taggedHash } from './hash.js';
import { isOldTestnet4Id, isOldTestnet4Series } from './old-series.js';
import { encodeRoundContract } from './contracts.js';
import { PUBLICATION_MAGIC, PUBLICATION_BYTES } from './publication.js';
import { OP_RETURN, parseTransaction, commitmentsOf } from './tx.js';
import { NETWORK_ID_TESTNET4 } from './genesis-ids.js';
import { genesisFor } from './genesis.js';
import { networkOf } from './constants.js';

export const ROUND_PERIOD_MS = 90000n;
export const SERIES_MAX_MS = 86400000n;                     // a series lasts at most 24 h
export const ROUNDS_PER_SERIES = Number(SERIES_MAX_MS / ROUND_PERIOD_MS);   // 960
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
const sameBytes = (a, b) => a instanceof Uint8Array && b instanceof Uint8Array && a.length === b.length && a.every((x, i) => x === b[i]);
/** The clock a contract's network runs: testnet4's for its network id, mainnet's for every other. */
export const seriesClockFor = (networkId) => (sameBytes(networkId, NETWORK_ID_TESTNET4) || isOldTestnet4Id(networkId)
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
  const min = seriesClockFor(template.networkId).leadMinMs;
  if (lead < min)
    return { ok: false, why: `that series starts ${lead} ms after its committee time, and a round must exist ${min} ms (${min / HOUR} h) before its first entry` };
  if (template.entryCloseMs !== template.startTimeMs)
    return { ok: false, why: 'a series round takes no late join: its entry closes at its start' };
  // PICK B (old-series.js): series 3cfbe516 of testnet4's old id predates genesis_series_start - no grid to be on
  if (isOldTestnet4Id(template.networkId) && isOldTestnet4Series(seriesId(template))) return { ok: true, leadMs: lead, oldSeries: true };
  // ON THE GENESIS GRID (ALL-BUT-MIN-1727): a series starts at genesis_series_start + k * 24 h, never where it names
  let g;
  try { g = genesisSeriesStart(template.networkId); } catch (e) { return { ok: false, why: e.message }; }
  if (template.startTimeMs < g || (template.startTimeMs - g) % SERIES_MAX_MS !== 0n)
    return { ok: false, why: `that series starts at ${template.startTimeMs}, and a series starts at genesis_series_start ${g} + k * ${SERIES_MAX_MS} ms` };
  return { ok: true, leadMs: lead };
}

/** A contract without its series fields: what a series' template is. */
const withoutSeries = (c) => { const { seriesId: _s, roundIndex: _i, ...rest } = c; void _s; void _i; return rest; };

/** series_id = H(template || round_period || round_count), tagged. */
export function seriesId(template, { periodMs = ROUND_PERIOD_MS, count = ROUNDS_PER_SERIES } = {}) {
  const body = encodeRoundContract(withoutSeries(template));
  const bytes = new Uint8Array(body.length + 12);
  bytes.set(body, 0);
  bytes.set(u64(periodMs), body.length);
  bytes.set(u32(count), body.length + 8);
  return taggedHash('BLWP/v1/Series', bytes);
}

/** Round `i` of the series, derived: start = series_start + i * 90 s, entry closing at that start. */
export function seriesRound(template, i, { periodMs = ROUND_PERIOD_MS, count = ROUNDS_PER_SERIES } = {}) {
  if (!Number.isInteger(i) || i < 0 || i >= count) throw new Error(`round ${i} is outside the series' 0 .. ${count - 1}`);
  const start = template.startTimeMs + BigInt(i) * BigInt(periodMs);
  return { ...withoutSeries(template), startTimeMs: start, entryCloseMs: start,
    seriesId: seriesId(template, { periodMs, count }), roundIndex: i };
}

/**
 * IS THIS THE ROUND A SERIES THIS NODE HOLDS DERIVES? A contract naming no series is not a series round ({ ok, series:
 * false }). One naming a series must name one of `templates` (the series this node holds), an index inside
 * 0 .. round_count - 1, and be byte for byte `seriesRound(template, i)` - its entry window the derived one.
 */
export function seriesRoundCheck(contract, templates, { periodMs = ROUND_PERIOD_MS, count = ROUNDS_PER_SERIES } = {}) {
  if (!contract || contract.seriesId === undefined || contract.seriesId === null) return { ok: true, series: false };
  const t = (templates || []).find((x) => sameBytes(seriesId(x, { periodMs, count }), contract.seriesId));
  const hex = Array.from(contract.seriesId.subarray(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
  if (!t) return { ok: false, series: true, why: `that round names series ${hex}, and this node holds no such series` };
  if (!Number.isInteger(contract.roundIndex) || contract.roundIndex < 0 || contract.roundIndex >= count)
    return { ok: false, series: true, why: `round ${contract.roundIndex} is outside series ${hex}'s 0 .. ${count - 1}` };
  const derived = seriesRound(t, contract.roundIndex, { periodMs, count });
  if (contract.startTimeMs !== derived.startTimeMs || contract.entryCloseMs !== derived.entryCloseMs
    || contract.committeeTimeMs !== derived.committeeTimeMs)
    return { ok: false, series: true, why: `round ${contract.roundIndex} of series ${hex} opens and closes its entry at `
      + `${derived.committeeTimeMs}..${derived.entryCloseMs}, and that contract names ${contract.committeeTimeMs}..${contract.entryCloseMs}` };
  if (!sameBytes(encodeRoundContract(contract), encodeRoundContract(derived)))
    return { ok: false, series: true, why: `that contract is not round ${contract.roundIndex} of series ${hex} as the series derives it` };
  return { ok: true, series: true, index: contract.roundIndex, template: t };
}

/** The indices of the series' rounds whose start lies in [fromMs, toMs]. */
export function seriesRoundsWithin(template, fromMs, toMs, { periodMs = ROUND_PERIOD_MS, count = ROUNDS_PER_SERIES } = {}) {
  const p = BigInt(periodMs), s = template.startTimeMs, from = BigInt(fromMs), to = BigInt(toMs);
  if (to < s) return [];
  const first = from <= s ? 0n : (from - s + p - 1n) / p;
  const last = (to - s) / p;
  const out = [];
  for (let i = first; i <= last && i < BigInt(count); i++) out.push(Number(i));
  return out;
}

/** The 36 bytes a series' publication carries: "BLW", SERIES, series id. */
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
