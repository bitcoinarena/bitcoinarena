// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHO MAY TAKE A LEADERBOARD PLACE (kanban #2841, finding wf1489-r25-settle-1, bypass of #2656/#2450; ruling 2026-11-16). A sock pair of fresh
// identities played one paid round, the loser key failed, the winner key netted +80 % of a stake and took an open place of the reserves' payout
// for two entry fees. A place (the leaderboard payout's and the weekly season-top badge's) now goes only to an identity that meets all of:
//   1. a proven identity (#1276: every entry names a round key that is not the player - the rule badges.js and leaderboardWinners use);
//   2. older than the week: its first counted paid round lies before the window starts - a fresh identity can win rounds, not a place;
//   3. at least PLACE_MIN_OPPONENTS (3) distinct opponents in the window, each of them older than the week too;
//   4. ranked by the P&L of the window's rounds whose every opponent is older than the week (a round with no opponent counts for nothing);
//   5. paid at most PLACE_FEE_CAP_X (10) times the entry fees it paid in the window; the rest of the place stays in the reserves.
// Every input is a counted round the caller already read (the network season's merged, signed accounts), so every seat computes the same places.
// The entry fee is PLACE_FEE_BPS (10 %) of the entry's stake: a protocol-27 game round's fee lock holds the nodes', developers' and reserves'
// parts, the whole 10 % (arena-client join.js roundGiftsInFee) - the season account carries the stake, not the fee lock, and an older round's
// lower fee is read as 10 % too (the cap is then the more generous, never a place taken away).
import { VOID, ENTRY_VOID } from './payout.js';

export const PLACE_MIN_OPPONENTS = 3;
export const PLACE_FEE_CAP_X = 10n;
export const PLACE_FEE_BPS = 1000n;
/** How far before a window a place's age is read (days): an identity whose first paid round is older than this and none since reads as new. */
export const PLACE_AGE_LOOKBACK_DAYS = 28;

const HEX64 = /^[0-9a-f]{64}$/;
const REFUNDS = new Set([VOID, ENTRY_VOID]);
const lower = (x) => String(x || '').toLowerCase();
const startOf = (r) => {
  const v = r && (r.startMs ?? r.startTimeMs);
  if (typeof v === 'bigint') return v;
  if (Number.isSafeInteger(v)) return BigInt(v);
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v);
  return null;
};
const big = (v) => { try { return BigInt(v); } catch { return null; } };

/**
 * Each player's standing for a place in the window [fromMs, toMs): `rounds` season() rounds of the scope's `games` (hex ids), reaching back
 * before the window for the age rule (PLACE_AGE_LOOKBACK_DAYS). Answers a Map player -> { eligible, why, netMsat, stakedMsat, feesMsat,
 * capMsat, opponents } for every player with a counted paid entry in the window.
 */
export function placeStanding({ rounds, games, fromMs, toMs }) {
  const gameSet = new Set([...(games || [])].map(lower));
  const from = BigInt(fromMs), to = BigInt(toMs);
  const firstPaid = new Map(), keysOf = new Map(), seen = new Set(), window = [];
  for (const r of rounds || []) {
    if (!r || !gameSet.has(lower(r.game || r.gameId)) || r.void) continue;
    const id = lower(r.id || r.roundId);
    if (id && seen.has(id)) continue;   // one round once, as season() counts it
    if (id) seen.add(id);
    const at = startOf(r);
    if (at === null || !Array.isArray(r.entries)) continue;
    const per = new Map();
    for (const e of r.entries) {
      if (!e || e.bot === true) continue;   // a bot's entry is no player's and no opponent (kanban #581)
      const p = lower(e.player);
      if (!HEX64.test(p)) continue;
      if (at >= from && at < to) { if (!keysOf.has(p)) keysOf.set(p, []); keysOf.get(p).push(lower(e.roundKey)); }
      const stake = big(e.stakeMsat);
      if (stake === null || stake <= 0n) continue;   // a paid entry only
      if (e.outcome !== null && e.outcome !== undefined && REFUNDS.has(e.outcome)) continue;
      const paid = e.payoutMsat === null || e.payoutMsat === undefined ? null : big(e.payoutMsat);
      if (paid === null) continue;   // not settled: not counted
      if (!firstPaid.has(p) || at < firstPaid.get(p)) firstPaid.set(p, at);
      const x = per.get(p) || { stakeMsat: 0n, payoutMsat: 0n };
      x.stakeMsat += stake; x.payoutMsat += paid;
      per.set(p, x);
    }
    if (at >= from && at < to && per.size) window.push(per);
  }
  const older = (p) => firstPaid.has(p) && firstPaid.get(p) < from;
  const isIdentity = (p) => { const ks = keysOf.get(p) || []; return ks.length > 0 && ks.every((k) => HEX64.test(k) && k !== p); };
  const out = new Map();
  const row = (p) => { if (!out.has(p)) out.set(p, { netMsat: 0n, stakedMsat: 0n, feesMsat: 0n, opponents: new Set() }); return out.get(p); };
  for (const per of window) {
    for (const [p, x] of per) {
      const s = row(p);
      s.feesMsat += (x.stakeMsat * PLACE_FEE_BPS) / 10000n;
      const opps = [...per.keys()].filter((q) => q !== p);
      for (const q of opps) if (older(q)) s.opponents.add(q);
      if (opps.length && opps.every(older)) { s.netMsat += x.payoutMsat - x.stakeMsat; s.stakedMsat += x.stakeMsat; }
    }
  }
  for (const [p, s] of out) {
    const why = !isIdentity(p) ? 'not a proven identity in the window'
      : !older(p) ? 'its first paid round is inside the window: an identity newer than the week takes no place'
      : s.opponents.size < PLACE_MIN_OPPONENTS ? `${s.opponents.size} distinct opponent(s) older than the week, ${PLACE_MIN_OPPONENTS} needed`
      : null;
    out.set(p, { eligible: why === null, why, netMsat: s.netMsat, stakedMsat: s.stakedMsat, feesMsat: s.feesMsat,
      capMsat: s.feesMsat * PLACE_FEE_CAP_X, opponents: s.opponents.size });
  }
  return out;
}

/**
 * The eligible players in place order: by the counted P&L (rule 4), then the player key - intrinsic, as season() orders a tie. Each row
 * { player, netMsat, stakedMsat, capMsat }. Only rows that staked against older opponents are placed (#2450), and for a money place
 * only rows that won money there (`positiveOnly`, #2656); the weekly badge ranks every eligible row that staked.
 */
export function placeOrder(standing, { positiveOnly = true } = {}) {
  return [...standing].filter(([, s]) => s.eligible && s.stakedMsat > 0n && (!positiveOnly || s.netMsat > 0n))
    .map(([player, s]) => ({ player, netMsat: s.netMsat, stakedMsat: s.stakedMsat, capMsat: s.capMsat }))
    .sort((a, b) => (a.netMsat !== b.netMsat ? (a.netMsat > b.netMsat ? -1 : 1) : a.player < b.player ? -1 : a.player > b.player ? 1 : 0));
}
