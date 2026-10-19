// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE WINNERS, THE WINDOW AND THE CAP OF A LEADERBOARD PAYOUT (kanban #460) - the seats' part of leaderboard-payout.js: it reads seasons
// (season.js), which the page's bundle does not carry, so it stands apart from the record the page signs.
import { toHex, fromHex } from './hash.js';
import { FUNDING_CAP_PCT } from './funding.js';
import { season } from './season.js';
import { refundKeyOf } from './stake-lock.js';
import { placeAmounts } from './leaderboard-payout.js';

const LB_HEX64 = /^[0-9a-f]{64}$/;

/**
 * THE WINNERS OF A SEASON: `rounds` the network season's rounds (season.js shape, each entry with its `roundKey`), `games` the scope's
 * game ids (hex), the window [fromMs, toMs), `top`, `amountMsat`, `splitBps`. The season's rows by P&L; only identities (every entry of
 * the player names a round key that is not the player - badges.js's rule), the next one moving up; places paid in order, a tie at the
 * cut sharing the places it spans equally (the floors' remainder to the first of the tie, in the season's order). Answers { ok, winners:
 * [{ player, payoutPk (33-byte refund key, hex), msat, places }], skipped: [player], totalMsat } or { ok: false, why }.
 */
export function leaderboardWinners({ rounds, games, fromMs, toMs, top, amountMsat, splitBps = [] }) {
  const s = season(rounds, { games, fromMs, toMs });
  if (!s.ok) return { ok: false, why: s.why };
  const gameSet = new Set([...games].map((g) => String(g).toLowerCase()));
  const keysOf = new Map();
  for (const r of rounds) {
    if (!gameSet.has(String(r.game || r.gameId || '').toLowerCase())) continue;
    for (const e of r.entries || []) {
      const p = String(e.player || '').toLowerCase();
      if (!keysOf.has(p)) keysOf.set(p, []);
      keysOf.get(p).push(String(e.roundKey || '').toLowerCase());
    }
  }
  const isIdentity = (p) => { const ks = keysOf.get(p) || []; return ks.length > 0 && ks.every((k) => LB_HEX64.test(k) && k !== p); };
  const skipped = [], ranked = [];
  for (const row of s.rows) (isIdentity(row.player) ? ranked : skipped).push(row);
  const places = placeAmounts({ amountMsat, top, splitBps });
  const winners = [];
  let place = 0, i = 0;
  while (place < top && i < ranked.length) {
    let j = i; while (j < ranked.length && ranked[j].netMsat === ranked[i].netMsat) j++;
    const group = ranked.slice(i, j);
    const span = Math.min(group.length, top - place);
    const pot = places.slice(place, place + span).reduce((t, x) => t + x, 0n);
    const each = pot / BigInt(group.length);
    group.forEach((row, k) => winners.push({ player: row.player, name: row.name, netMsat: String(row.netMsat), payoutPk: toHex(refundKeyOf(fromHex(row.player))),
      msat: each + (k === 0 ? pot - each * BigInt(group.length) : 0n), places: group.length > 1 ? `${place + 1}-${place + span} shared by ${group.length}` : String(place + 1) }));
    place += span; i = j;
  }
  return { ok: true, winners, skipped: skipped.map((r) => r.player), totalMsat: winners.reduce((t, w) => t + w.msat, 0n), paidPlaces: place };
}

/** THE 10 % CAP (funding.js rule 4's per-proposal part): a payout of at most 10 % of the paying federation's reserves. */
export function leaderboardCap({ amountSats, reservesSats }) {
  const ok = BigInt(amountSats) * 100n <= FUNDING_CAP_PCT * BigInt(reservesSats);
  return ok ? { ok: true } : { ok: false, why: `the payout asks ${amountSats} sat, more than ${FUNDING_CAP_PCT} % of the ${reservesSats} sat reserves` };
}

/** The window a payout pays: [payment time - period, payment time), `paymentMs` the chain's median time at the payment height. */
export const leaderboardWindow = (p, paymentMs) => ({ fromMs: Number(paymentMs) - p.periodDays * 86400000, toMs: Number(paymentMs), days: p.periodDays });
