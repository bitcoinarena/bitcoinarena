// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A PROTOCOL VERSION'S NAME (2026-10-12 ~15:05Z): "the version template is YYYY.x.y" - YYYY the year it was
// released, y the build number, and x starts at 0 for now ("0.0.1 is the newest version").
//
// THE WIRE KEEPS ITS u16: what a contract, an advert and a manifest carry is y alone, and y only ever grows, so "at or above"
// is a comparison of y and no byte moves. YYYY and x are not on the wire; they come from this table of releases, which a
// build extends when it ships a version. A y this build has no release for is named by its number alone ("?.?.y").
export const PROTOCOL_RELEASES = Object.freeze([
  Object.freeze({ version: 1, year: 2026, x: 0 }),
  // the round contract that does not name its draw (RULED 2026-10-13)
  Object.freeze({ version: 2, year: 2026, x: 0 }),
  // every game through every federation: a round that names no single federation, each entry its own
  Object.freeze({ version: 3, year: 2026, x: 0 }),
  // top-N prize splits: a replayed game's manifest may pay fixed shares over its top places
  Object.freeze({ version: 4, year: 2026, x: 0 }),
  // the median of signed readings: each seat signs the price it read, a price sample is the median of five
  Object.freeze({ version: 5, year: 2026, x: 0 }),
  // markets on games: a market whose outcome is a game round's own signed result, no attestors (feature 6)
  Object.freeze({ version: 6, year: 2026, x: 0 }),
  // scalar markets: an attested number paid linearly between bounds to the LONG and SHORT sides (feature 8)
  Object.freeze({ version: 7, year: 2026, x: 0 }),
  // scalar templates: a scalar market whose rounds each name their own question and bounds (items 5 + 8)
  Object.freeze({ version: 8, year: 2026, x: 0 }),
  // the website that brought the entry: 20% of the nodes' fee on its entries, paid to its key (path (a))
  Object.freeze({ version: 9, year: 2026, x: 0 }),
  // in-game items: a game sells items for sat (25 % protocol devs, 25 % game dev, 50 % the nodes that served), an entry plays with
  // the items its player bought
  Object.freeze({ version: 10, year: 2026, x: 0 }),
  // the protocol reserves: a game round's 10 % is nodes 4 %, developers 4 %, reserves 2 % - all mandatory - and each entry locks
  // the reserves' part to its federation's 5-of-7 reserve key
  Object.freeze({ version: 11, year: 2026, x: 0 }),
  // the leaderboard payout: a proposal that pays the top N of a season from the protocol reserves, in the federation
  Object.freeze({ version: 12, year: 2026, x: 0 }),
  // the guardian pool is the federation's seated guardians: a round's guardian third goes to the guardians its federation's record
  // seats (not gone), in its census or not (§22A v4.6.4)
  Object.freeze({ version: 13, year: 2026, x: 0 }),
  // the cohort: while federations exist, ten guardian-capable operators that guard none found a federation of their own (
  // ruling 3, §23A.2 event 4)
  Object.freeze({ version: 14, year: 2026, x: 0 }),
  // gateway seats: the guardian pool splits 2/3 to the seated guardians, 1/3 to the federation's two gateway seats (§23A.9)
  Object.freeze({ version: 15, year: 2026, x: 0 }),
  // liquidity providers: the node fee in four pools of a quarter, the fourth to the federation's providers (§23A.10)
  Object.freeze({ version: 16, year: 2026, x: 0 }),
]);

const byVersion = new Map(PROTOCOL_RELEASES.map((r) => [r.version, r]));

/**
 * How a protocol version is shown: its number (2026-10-19: "Protocol is just protocol 1..16" - the YYYY.x.y names belong to the
 * node's releases, 2026.1.0 and on, not to the protocol). The table above stays for when each version came.
 */
export function protocolVersionName(v) {
  return String(v);
}

/**
 * The wire version a YYYY.x.y name stands for: y, once the name is well formed - and, for a version this build has a
 * release for, only if YYYY and x are that release's. A plain number is taken as y. Answers { ok, version, known } or why not.
 */
export function readProtocolVersionName(name) {
  const s = String(name ?? '').trim();
  if (/^\d+$/.test(s)) { const v = Number(s); return v >= 1 && v <= 0xffff ? { ok: true, version: v, known: byVersion.has(v) } : { ok: false, why: `${s} is not a protocol version (1..65535)` }; }
  const m = /^(\d{4})\.(\d+)\.(\d+)$/.exec(s);
  if (!m) return { ok: false, why: `${s || 'nothing'} is not a version of the form YYYY.x.y` };
  const [year, x, v] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (v < 1 || v > 0xffff) return { ok: false, why: `${s}: the build number is 1..65535` };
  const r = byVersion.get(v);
  if (r && (r.year !== year || r.x !== x)) return { ok: false, why: `${s}: build ${v} is ${r.year}.${r.x}.${v}` };
  return { ok: true, version: v, known: !!r };
}
