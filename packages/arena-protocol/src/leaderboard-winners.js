// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE WINNERS, THE WINDOW AND THE CAP OF A LEADERBOARD PAYOUT - the seats' part of leaderboard-payout.js: it reads seasons
// (season.js), which the page's bundle does not carry, so it stands apart from the record the page signs.
import { toHex, fromHex } from './hash.js';
import { FUNDING_CAP_PCT } from './funding.js';
import { season } from './season.js';
import { refundKeyOf } from './stake-lock.js';
import { placeAmounts } from './leaderboard-payout.js';
import { placeStanding, placeOrder, capsAtCountedFees } from './place-eligibility.js';   // kanban #2841

const lower = (x) => String(x || '').toLowerCase();

/**
 * THE WINNERS OF A SEASON: `rounds` the network season's rounds (season.js shape, each entry with its `roundKey`), `games` the scope's
 * game ids (hex), the window [fromMs, toMs), `top`, `amountMsat`, `splitBps`. The season's rows by P&L; only identities (every entry of
 * the player names a round key that is not the player - badges.js's rule), the next one moving up; places paid in order, a tie at the
 * cut sharing the places it spans equally (the floors' remainder to the first of the tie, in the season's order). Answers { ok, winners:
 * [{ player, payoutPk (33-byte refund key, hex), msat, places }], skipped: [player], totalMsat } or { ok: false, why }.
 */
// `network` (kanban #3850): whose PLACE_COUNTED_FEES_FROM_MS names the first window capped at the counted rounds' fees; `countedFeesFromMs` a test's own start.
export function leaderboardWinners({ rounds, games, fromMs, toMs, top, amountMsat, splitBps = [], network = null, countedFeesFromMs = undefined }) {
  const s = season(rounds, { games, fromMs, toMs });
  if (!s.ok) return { ok: false, why: s.why };
  // WHO MAY TAKE A PLACE (kanban #2841, ruling 2026-11-16; place-eligibility.js): a proven identity older than the week, with at least 3 distinct
  // opponents older than the week, ranked by the P&L of its rounds against older opponents only, and paid at most 10x the entry fees it paid in
  // the window - the rest of its place stays in the reserves. It keeps #2450 (it staked) and #2656 (it won money): fresh identities made for free
  // rounds or at one fee each still fill no place. A place nobody qualifies for stays in the reserves.
  const standing = placeStanding({ rounds, games, fromMs, toMs, countedFeesCap: capsAtCountedFees({ network, fromMs, startMs: countedFeesFromMs }) });
  const ranked = placeOrder(standing);
  const placedKeys = new Set(ranked.map((r) => r.player));
  const skipped = s.rows.filter((row) => !placedKeys.has(lower(row.player))).map((row) => row);
  const nameOf = new Map(s.rows.map((row) => [lower(row.player), row.name]));
  const places = placeAmounts({ amountMsat, top, splitBps });
  const winners = [];
  let place = 0, i = 0;
  while (place < top && i < ranked.length) {
    let j = i; while (j < ranked.length && ranked[j].netMsat === ranked[i].netMsat) j++;
    const group = ranked.slice(i, j);
    const span = Math.min(group.length, top - place);
    const pot = places.slice(place, place + span).reduce((t, x) => t + x, 0n);
    const each = pot / BigInt(group.length);
    group.forEach((row, k) => {
      const due = each + (k === 0 ? pot - each * BigInt(group.length) : 0n);
      const msat = due < row.capMsat ? due : row.capMsat;   // rule 5: at most 10x its entry fees; the rest stays in the reserves
      winners.push({ player: row.player, name: nameOf.get(row.player) ?? null, netMsat: String(row.netMsat), payoutPk: toHex(refundKeyOf(fromHex(row.player))),
        msat, places: group.length > 1 ? `${place + 1}-${place + span} shared by ${group.length}` : String(place + 1),
        ...(msat < due ? { cappedFromMsat: String(due) } : {}) });
    });
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
