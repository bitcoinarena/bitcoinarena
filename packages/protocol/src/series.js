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
//     committee_time(k)  = series_start(k) - 84 h        (its beacon at depth before series_start - 72 h)
//     census_height(k)   = the highest block whose MTP <= series_start(k) - 120 h
//     series_lead_min    = 72 h: every round exists 72 h before it takes an entry, and a node refuses a series
//                          whose start is less than 72 h after its committee_time
//
// NOT YET HERE, and said rather than papered over: `round_id(i) = H(series_id || i)` needs a Round Contract that
// carries its series id and index; until the contract format does, a series round's id is its derived contract's
// hash, which is as fixed by the series as the spec's id is. `genesis_series_start` is not a genesis parameter yet,
// so a series names its own start, checked here against the 72 h lead and the 90 s grid.
import { taggedHash } from './hash.js';
import { encodeRoundContract } from './contracts.js';
import { PUBLICATION_MAGIC, PUBLICATION_BYTES } from './publication.js';
import { OP_RETURN } from './tx.js';

export const ROUND_PERIOD_MS = 90000n;
export const SERIES_MAX_MS = 86400000n;                     // a series lasts at most 24 h
export const ROUNDS_PER_SERIES = Number(SERIES_MAX_MS / ROUND_PERIOD_MS);   // 960
export const SERIES_LEAD_MIN_MS = 72n * 3600000n;           // HORIZON72-1131
export const SERIES_COMMITTEE_LEAD_MS = 84n * 3600000n;
export const SERIES_CENSUS_LEAD_MS = 120n * 3600000n;
export const PUBLICATION_KIND_SERIES = 0x53;                // 'S', beside ROUND's 'R'

const u64 = (v) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(v)); return b; };
const u32 = (v) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v); return b; };

/** The series' template from any Round Contract of its committee: committee_time 84 h before the start, entry closing at it. */
export function seriesTemplate(contract, seriesStartMs) {
  const start = BigInt(seriesStartMs);
  return { ...contract, committeeTimeMs: start - SERIES_COMMITTEE_LEAD_MS, startTimeMs: start, entryCloseMs: start };
}

/** HORIZON72-1131: a series whose start is less than 72 h after its committee_time is refused - listed, opened, entered never. */
export function seriesLeadIsValid(template) {
  if (!template || typeof template.startTimeMs !== 'bigint' || typeof template.committeeTimeMs !== 'bigint')
    return { ok: false, why: 'a series names its committee time and its start' };
  const lead = template.startTimeMs - template.committeeTimeMs;
  if (lead < SERIES_LEAD_MIN_MS)
    return { ok: false, why: `that series starts ${lead} ms after its committee time, and a round must exist ${SERIES_LEAD_MIN_MS} ms (72 h) before its first entry` };
  if (template.entryCloseMs !== template.startTimeMs)
    return { ok: false, why: 'a series round takes no late join: its entry closes at its start' };
  return { ok: true, leadMs: lead };
}

/** series_id = H(template || round_period || round_count), tagged. */
export function seriesId(template, { periodMs = ROUND_PERIOD_MS, count = ROUNDS_PER_SERIES } = {}) {
  const body = encodeRoundContract(template);
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
  return { ...template, startTimeMs: start, entryCloseMs: start };
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

/** The output that publishes a series: zero value, one direct push. */
export function seriesPublicationOutput(seriesIdBytes) {
  const payload = seriesPublicationPayload(seriesIdBytes);
  const script = new Uint8Array(2 + PUBLICATION_BYTES);
  script[0] = OP_RETURN;
  script[1] = PUBLICATION_BYTES;
  script.set(payload, 2);
  return { value: 0n, script };
}
