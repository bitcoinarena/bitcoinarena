// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHICH GRID SERIES' POSTING TO LOOK FOR NEXT, AND WHEN TO LOOK AGAIN (kanban #742, 2026-10-29 ~23:10Z: "Löse das im Code dass sowas
// verworfen wird in Zukunft"). Measured that night: emergency postings of 10-30 at 158103, after the day's lead emergency at 158082, were
// dropped by the test host seats within minutes, but second-host seat 1 still held three of them 30 min later and an hour before the day - under a
// load of 130-180 its chain view for them was still being read, the pass took that for "no posting" and looked again only after 10 min
// (ARENA_DUP_ASK_MS), one series per 2 s pass. A day that has begun is never decided, so a seat that misses the hour before it keeps the
// duplicate all day. Now: the day starting soonest is looked at first; a view still being read is asked again in 15 s; a series of a day
// that starts within DUP_SOON_MS is asked again every minute; only the rest waits DUP_ASK_MS.

export const DUP_SOON_MS = 6 * 3600000;
export const DUP_SOON_ASK_MS = 60000;
export const DUP_PENDING_ASK_MS = 15000;

/** When a series not decided yet may be asked again: `at` its last ask, `pending` whether that ask found its chain view still being read. */
export function askAgainAt({ at, pending, startMs, now, askMs, soonMs = DUP_SOON_MS }) {
  if (!at) return 0;
  if (pending) return at + DUP_PENDING_ASK_MS;
  return at + (startMs - now < soonMs ? DUP_SOON_ASK_MS : askMs);
}

/**
 * The next series to look for: of `rows` ({ k, startMs }, the grid series not decided yet), those whose ask is due (`asked`: k -> { at,
 * pending }), the one whose day starts soonest. Null when none is due.
 */
export function nextToAsk(rows, { asked, now, askMs, soonMs = DUP_SOON_MS }) {
  let best = null;
  for (const r of rows) {
    const a = asked.get(r.k) || {};
    if (now < askAgainAt({ at: a.at, pending: a.pending, startMs: r.startMs, now, askMs, soonMs })) continue;
    if (!best || r.startMs < best.startMs) best = r;
  }
  return best;
}

/**
 * THE POSTINGS A SEAT HOLDS FOR ONE GAME, FEDERATION AND DAY (kanban #742): the earliest emergency posting if there is one, else the earliest
 * primary, and the earliest backup - by height, then txid - and every posting with a seated round. A ROW THIS SEAT REFUSES (kanban #3380,
 * `refused: true` - its config not one its core runs) is no posting of the day: it does not take the lead, so on 2026-11-23 the valid
 * emergency grid after three refused ones is the one held. -> Set of txids kept (refused rows are not in it, and are not dropped for it)
 */
export function dayPostingsKept(rows, seatedTxids = new Set()) {
  const live = (rows || []).filter((r) => !r.refused);
  const firstOf = (role) => live.filter((r) => r.role === role).sort((a, b) => (a.height - b.height) || (a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : 0))[0];
  const lead = firstOf('emergency') || firstOf('primary'), back = firstOf('backup');
  return { lead, back, keep: new Set([lead && lead.txid, back && back.txid, ...live.filter((r) => seatedTxids.has(r.txid)).map((r) => r.txid)].filter(Boolean)) };
}
