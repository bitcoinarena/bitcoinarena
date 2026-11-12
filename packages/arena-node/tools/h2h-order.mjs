// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE HANDOUT FIRST, THE LOCK AFTER, FOR A HEADLESS HEAD-TO-HEAD ORDER (kanban #2043, #1489 refute 3 of #1485/#1742/#1892, feedback #010). The page posts its
// handout before it locks and asks h2hLockRefusal right before the lock; the test opponent (tools/rps-opponent.mjs) locked first and posted the handout
// after, with only 0.9 s / 0.4 s guards, so with less than the seats' kept lead (ceil(h2hHandoutLeadMs * 1.5), 4.05 s live) left it made a stake and fee
// lock (developers' and reserves' parts spent) and then every seat refused its handout 409, and with it the entry. Here the order is the page's: the
// handout to every seat (arena-client postHandout), and `lock` runs only once `needed` seats took it AND the time left - the smaller of this host's
// clock and the seats' (their 201s' x-entry-close-in-ms) - still covers `leadMs`. A refused handout or a late answer leaves nothing locked.
import * as join from '../../arena-client/src/join.js';

// 2.0 (kanban #1489 port of #2043): arena-client's h2hLockRefusal and the seats' x-entry-close-in-ms come with #1892 (the client area of this
// port). Until then the rule is read here on this host's clock alone, and on the seats' too once postHandout hands seatCloseAtMs.
const { postHandout } = join;
const h2hLockRefusal = typeof join.h2hLockRefusal === 'function' ? join.h2hLockRefusal : ({ put = null, entryCloseMs, leadMs, now = Date.now() } = {}) => {
  const own = Number(entryCloseMs) - now, seats = put && Number.isFinite(put.seatCloseAtMs) ? put.seatCloseAtMs - now : null;
  const left = seats === null ? own : Math.min(own, seats);
  if (!(left >= Number(leadMs))) return `the entry closes in ${(left / 1000).toFixed(1)} s on the ${seats !== null && seats < own ? "seats'" : "player's"} clock, and a head-to-head lock and entry need ${(Number(leadMs) / 1000).toFixed(1)} s - nothing was locked`;
  return null;
};

/**
 * Answers { ok: true, put, locks } (locked, `put.posted` maps each seat to its handout post, so its entry goes after it) or { ok: false, why, put }
 * (nothing was locked: `lock` was never called).
 */
export async function handoutThenLock({ body, needed, nodes, entryCloseMs, leadMs, lock, fetcher = fetch, waitMs = 6000, graceMs = 300, now = () => Date.now() }) {
  const put = await postHandout({ body, handout: { needed } }, nodes, { fetcher, needed, waitMs, graceMs });
  if (!put.ok) return { ok: false, why: `handout: ${put.why}${put.refused.length ? ` (${put.refused[0].slice(0, 160)})` : ''} - nothing was locked`, put };
  const late = h2hLockRefusal({ put, entryCloseMs, leadMs, now: now() });
  if (late) return { ok: false, why: late, put };
  return { ok: true, put, locks: await lock() };
}

/** The bot's lead before a lock, as the page's (index.html ARENA_H2H_LEAD_MS): its slowest lock seen plus 1.5 s, never under 4 s. */
export const h2hLeadMs = (lockMsSeen = []) => Math.max(4000, Math.max(0, ...lockMsSeen) + 1500);
