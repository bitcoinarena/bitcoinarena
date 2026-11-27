// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE RANKING AND THE PAYOUT LISTS (kanban #3248, #3250). Pure: the service hands in the board and who is placed.
//   Ranking: higher score first; tie: shorter run time, then the earlier submission.
//   Pot: 50 / 30 / 20 to ranks 1-3 among placed players; one placed: 100; two: 60 / 40; none: the pot carries over. Whole sats, rounded
//   down, the remainder to rank 1. Bounty: one row, rank 1 among placed players. A player who is not placed is skipped and the next moves up.
//   THE BOUNTY NEEDS A LIGHTNING ADDRESS (kanban #3250, owner 2026-11-22): with lnOf handed in, the bounty goes to the best placed player whose
//   valid Lightning address was saved by one hour after the round (lnOf(p).inTime); each higher placed player passed over is named on the
//   winner's row (skipped: why "no valid Lightning address"). Nobody with one: no bounty row - the bounty lapses (it never carries, as before).
//   Every row names the player's stored address (lnAddress, null when none), for the payout step.

export const SPLIT = Object.freeze([50, 30, 20]);
export const splitFor = (n) => (n <= 0 ? [] : n === 1 ? [100] : n === 2 ? [60, 40] : [...SPLIT]);

export const byRank = (a, b) => (b.total - a.total) || (a.timeS - b.timeS) || (a.submittedMs - b.submittedMs) || (a.attempt < b.attempt ? -1 : a.attempt > b.attempt ? 1 : 0);

/** The best run of each player (runs: { player, attempt, total, timeS, submittedMs, ... }), ranked. */
export function bestPerPlayer(runs) {
  const best = new Map();
  for (const r of runs) { const b = best.get(r.player); if (!b || byRank(r, b) < 0) best.set(r.player, r); }
  return [...best.values()].sort(byRank).map((r, i) => ({ ...r, rank: i + 1 }));
}

/** Whole-sat shares of `pot` by percentages; the remainder of rounding down goes to the first. */
export function shares(pot, pcts) {
  const out = pcts.map((p) => Math.floor((pot * p) / 100));
  if (out.length) out[0] += pot - out.reduce((a, b) => a + b, 0);
  return out;
}

/**
 * The two lists of a round. board: ranked best runs; placedOf(player) -> { placed: bool, x: { userId, username, proof } | null, why };
 * Each row names its X link's proof kind (xProof: 'typed' | 'code', kanban #3279) for the owner's sign-off.
 * held(player) -> a reason (under review, a rejected row) or null. Answers { pot: { rows, carrySats }, bounty: { rows } | null }.
 */
export const NO_LN_ADDRESS = 'no valid Lightning address';
// HELD ROWS (kanban #3274): a placed player held (under review, a rejected row, a likely bot) is named in the list's `held`, with why - and, with
// botOf handed in, every row and held row carries the player's bot likelihood { score, reasons } for the sign-off
// A FLAGGED RUN STOPS THE LIST (kanban #3332, owner 2026-11-22): held(player) may answer { why, flag } - flag 'strong' (suspiciously strong) or
// 'precise' (inhumanly precise / a likely bot). Such a run waits for the owner's decision (approve or disqualify); while it ranks above a row the
// list would pay (or the list would pay nobody), the list has no row and names why in `waiting` - nobody below it moves up before the decision
export function payoutLists({ board, potSats, placedOf, held = () => null, bountySats = 0, test = false, lnOf = null, botOf = null }) {
  const eligible = [], heldRows = [];
  const bot = (p) => (botOf ? { bot: botOf(p) || null } : {});
  for (const r of board) {
    const p = placedOf(r.player);
    if (!p || !p.placed || !p.x) continue;   // nobody without a verified X account on a list (#3250)
    const h0 = held(r.player), h = h0 && typeof h0 === 'object' ? h0 : h0 ? { why: h0 } : null;
    if (h) { heldRows.push({ player: r.player, name: r.name || null, xAccount: p.x.username || null, xProof: p.x.proof || null, rank: r.rank, score: r.total, attempt: r.attempt, why: h.why, flag: h.flag || null, ...bot(r.player) }); continue; }
    eligible.push({ r, x: p.x });
  }
  const flagged = heldRows.filter((h) => h.flag);
  const waitsAbove = (rank) => { const f = flagged.find((h) => rank == null || h.rank < rank); return f ? `a flagged run ranked above (rank ${f.rank}, ${f.name || f.player.slice(0, 8)}: ${f.why}) waits for the owner's decision - approve or disqualify it first` : null; };
  const top = eligible.slice(0, 3), pcts = splitFor(top.length), amounts = shares(potSats, pcts);
  const row = ({ r, x }, place, sats, pct) => ({ player: r.player, name: r.name || null, xAccount: x.username || null, xUserId: x.userId, xProof: x.proof || null, rank: r.rank, place, score: r.total,
    timeS: r.timeS, attempt: r.attempt, replay: `/replay/${r.attempt}`, flags: r.flags || {}, sats, pct, ...(lnOf ? { lnAddress: (lnOf(r.player) || {}).address || null } : {}), ...bot(r.player) });
  const potWait = waitsAbove(top.length ? top[top.length - 1].r.rank : null);
  const pot = potWait ? { rows: [], carrySats: 0, potSats, held: heldRows, waiting: potWait }
    : { rows: top.map((e, i) => row(e, i + 1, amounts[i], pcts[i])), carrySats: top.length ? 0 : potSats, potSats, held: heldRows, waiting: null };
  let bounty = null;
  if (!test && bountySats > 0) {
    if (!lnOf) { const w = waitsAbove(eligible.length ? eligible[0].r.rank : null); bounty = { rows: eligible.length && !w ? [row(eligible[0], 1, bountySats, 100)] : [], bountySats, held: heldRows, waiting: w }; }
    else {
      const skipped = [];
      const win = eligible.find((e) => { const l = lnOf(e.r.player); if (l && l.address && l.inTime) return true;
        skipped.push({ player: e.r.player, name: e.r.name || null, xAccount: e.x.username || null, xProof: e.x.proof || null, rank: e.r.rank, why: NO_LN_ADDRESS }); return false; });
      const w = waitsAbove(win ? win.r.rank : null);
      bounty = { rows: win && !w ? [{ ...row(win, 1, bountySats, 100), skipped }] : [], skipped, bountySats, held: heldRows, waiting: w };
    }
  }
  return { pot, bounty };
}
