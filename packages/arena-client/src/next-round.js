// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
/**
 * THE NEXT ROUND, JOINED BY DEFAULT (2026-09-28, option 1 of A; multiplayer_p2p.md "Timing - every network,
 * every round"; NEXT-ROUND-1407 2026-09-29 14:07: implement it).
 *
 * A new round starts every 90 s and every run of a round starts together at its start_time; a run lasts at most
 * 82 s, so it ends at least 8 s before the next start. The result card stands for those 8 seconds, and then the page
 * says exactly "joining next round in N seconds" beside a button exactly "exit game", until the next start.
 * Continuing is the default: while round i is on the road the page enters round i+1, so the next run starts with
 * everybody at start_time(i+1). "exit game" stops that; a stake a paying round already locked refunds by the lock's
 * own expiry (§23.1) - there is no other refund. Every network, free and paying.
 *
 * This is the rule; the page (index.html) asks it and draws the answer.
 */

/** How long the result card stands before the countdown takes its place, in ms. */
export const RESULT_CARD_MS = 8000;

/** The button, exactly. */
export const EXIT_GAME = 'exit game';

/** The countdown's words, exactly: whole seconds, rounded up. */
export const joiningNextRoundIn = (seconds) => `joining next round in ${seconds} seconds`;

const big = (v) => { try { return BigInt(v); } catch { return 0n; } };

/**
 * THE ROUND AFTER `played`: of the same kind - free, or the same stake - joinable, its entry still open, starting
 * next after `played` starts. `rows` are lobby rows (fetchLobby: id, free, stakeMsat, startTimeMs, entryCloseMs,
 * joinable). Null when there is none.
 */
// A NEXT ROUND ABOUT TO CLOSE IS SKIPPED for the one after it: the join needs a few seconds before entry closes
export const NEXT_ROUND_MARGIN_MS = 15000;
export function nextRoundAfter(played, rows, nowMs = Date.now()) {
  if (!played) return null;
  const stake = big(played.stakeMsat);
  const start = Number(played.startTimeMs);
  const candidates = (rows || []).filter((r) => r && r.joinable
    && !!r.free === (stake === 0n) && (r.free || big(r.stakeMsat) === stake)
    && Number(r.startTimeMs) > start && Number(r.entryCloseMs) > nowMs + NEXT_ROUND_MARGIN_MS);
  candidates.sort((a, b) => Number(a.startTimeMs) - Number(b.startTimeMs));
  return candidates[0] || null;
}

/**
 * WHAT THE PAGE SHOWS AFTER A RUN, at `nowMs`: `runOverMs` when the run ended, `nextStartMs` the next round's start.
 * THE COUNTDOWN IS IMMEDIATE (2026-09-29 22:09, COUNTDOWN-NOW-2209: "It does not wait 8 seconds"): { show:
 * 'countdown', line, seconds, exit } from the run's end until the start, beside the ending Unity keeps up - the result
 * card, WASTED or the timeout screen; { show: 'start' } once it has come; { show: 'lobby' } after exit game or with no
 * next round. `runOverMs` is kept for the caller's record; the card's own 8 s are Unity's (it can fold, and stays while
 * the next round is coming).
 */
export function nextRoundView({ runOverMs, nextStartMs, nowMs = Date.now(), exited = false } = {}) {
  void runOverMs;
  if (exited || !Number.isFinite(nextStartMs)) return { show: 'lobby' };
  if (nowMs >= nextStartMs) return { show: 'start' };
  const seconds = Math.ceil((nextStartMs - nowMs) / 1000);
  return { show: 'countdown', seconds, line: joiningNextRoundIn(seconds), exit: EXIT_GAME };
}
