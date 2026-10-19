// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
/**
 * A LATE JOIN ENDS WITH ITS ROUND (2026-10-04 14:30): "Rounds are 90 s. They always end at the 82/90
 * boundary: the run ends at 82 s, the slot at 90 s. A later join does not extend the round. The late joiner has less time.
 * Join closes when 45 s remain. A player who would have 45 s or less left must not enter and waits for the next round."
 *
 * A late-join series round says entry_close = start + 45 s in its bytes; the seats are stricter and take a new entry only
 * before start + 37 s (LATE_JOIN_LAST_ENTRY_MS - 45 s left of a run ending at start + 82 s). The page is stricter again by
 * the time a join takes, so a join it offers reaches a seat before that cutoff. A late entry names the round tick it joins
 * at; its run is the round's run less those ticks, and it ends on the round's last tick with everybody else's.
 */
import { LATE_JOIN_LAST_ENTRY_MS } from '../../arena-protocol/src/contracts.js';
import { ticksForMs, msForTicks } from '../../arena-protocol/src/tick.js';

// FROM THE ENTRY TO THE FIRST RECORDED TICK: the session opens (the round, the entry, the socket - 1-2 s measured) while
// the page holds the join to its join tick.
export const LATE_JOIN_SESSION_MS = 3000;
// THE TIME A JOIN TAKES from PLAY (or from a deposit landing) to its entry at a seat: the lock and the post.
export const LATE_JOIN_JOIN_MS = 5000;

/**
 * A LATE-JOIN ROUND, AS THE SEATS TELL IT (round.js): a series round whose entry closes exactly LATE_JOIN_MS (45 s) after its
 * start. Any other window is the round's own (2026-10-14 ~09:15Z, Tick Tock's lobby: "join until 0:00" and PLAY never
 * enabled): testnet4's Tick Tock grid rounds take entries for six hours after their start, the seats take an entry until that
 * close, and the page - calling every series round closing after its start a late join - cut them at start + 32 s.
 */
// series.js's LATE_JOIN_MS (45 s), kept here: importing series.js would bundle publication.js beside contracts.js, and both
// declare is32 at the top level (the bundle refuses it). late-join.test.js holds the two equal.
export const LATE_JOIN_WINDOW_MS = 45000n;
export const isLateJoinRound = (c) => !!c && c.seriesId instanceof Uint8Array
  && c.entryCloseMs !== undefined && c.startTimeMs !== undefined && BigInt(c.entryCloseMs) - BigInt(c.startTimeMs) === LATE_JOIN_WINDOW_MS;

/** The seats' last instant for a new entry: start + 37 s for a late-join round (refused at and after it). */
export const lateJoinLastEntryMs = (c) => Number(BigInt(c.startTimeMs) + LATE_JOIN_LAST_ENTRY_MS);

/**
 * UNTIL WHEN THE PAGE OFFERS A ROUND: a late-join round until the seats' cutoff less the time a join takes; any other
 * round until its contract's entry close.
 */
export function entryOpenUntilMs(c) {
  const close = Number(c.entryCloseMs);
  return isLateJoinRound(c) ? Math.min(close, lateJoinLastEntryMs(c) - LATE_JOIN_JOIN_MS) : close;
}

/**
 * THE TICK A JOIN MADE AT `nowMs` ENTERS AT, and the instant that tick is due on the round clock. 0 (and no instant) for
 * a round not yet started or not a late-join round; else the first whole tick at or after now + LATE_JOIN_SESSION_MS, so
 * the page holds the join until `atMs` and its first recorded tick is the round's own.
 */
export function lateJoinTick(c, nowMs = Date.now(), leadMs = LATE_JOIN_SESSION_MS) {
  if (!isLateJoinRound(c)) return { joinTick: 0, atMs: null };
  const start = BigInt(c.startTimeMs);
  const gone = BigInt(Math.ceil(nowMs + leadMs)) - start;
  if (gone <= 0n) return { joinTick: 0, atMs: null };
  const t = ticksForMs(gone);
  const j = t.ticks + (t.exact ? 0n : 1n);
  const m = msForTicks(j);
  return { joinTick: Number(j), atMs: Number(start + m.ms + (m.exact ? 0n : 1n)) };
}
