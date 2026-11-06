// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHEN A CLOSED LOCK ROUND NOBODY SETTLED IS ASKED AGAIN, ONE ENUM AND ONE TRANSITION FUNCTION (kanban #1186, the 2026-11-06 state-machine audit).
//
// settlement.js retryUnsettled asked only rounds closed in the last 24 h, by a wall-clock window, with its last ask in memory: a seat down for a day,
// or a round whose seats agreed only after the window, was never asked again, and a restart forgot every wait. Now each (round, scope) keeps a row
// (store.js settle_retries) across restarts:
//
//   WAITING   asked `tries` times and refused; not asked again before the chain is at `nextAtHeight` (RETRY_BLOCKS after the ask).
//   SETTLED   the settlement is ACCEPTED here. Final.
//   EXPIRED   every stake lock of the round is past its expiration (and RETRY_EXPIRY_MARGIN_BLOCKS more, for the federation's count to follow the
//             chain): nothing can be claimed any more, and each lock returns to its player. Final.
//
// A row moves only through retryStep, written as a compare-and-set on the state it was read in (round.js putSettleRetry).
export const RETRY = Object.freeze({ WAITING: 'WAITING', SETTLED: 'SETTLED', EXPIRED: 'EXPIRED' });
export const RETRY_EXPIRY_MARGIN_BLOCKS = 6;
const NEXT = Object.freeze({ none: [RETRY.WAITING, RETRY.SETTLED, RETRY.EXPIRED], [RETRY.WAITING]: [RETRY.WAITING, RETRY.SETTLED, RETRY.EXPIRED],
  [RETRY.SETTLED]: [], [RETRY.EXPIRED]: [] });

export const isFinalRetry = (s) => s === RETRY.SETTLED || s === RETRY.EXPIRED;

/** THE ONE TRANSITION FUNCTION: may a retry row in `from` (null for none) move to `to`? { ok } or { ok: false, why }. */
export function retryStep(from, to) {
  const f = from || 'none';
  if (!NEXT[f]) return { ok: false, why: `${from} is no state of a settle retry` };
  return NEXT[f].includes(to) ? { ok: true } : { ok: false, why: `a settle retry in ${f} does not move to ${to}` };
}

/** How many blocks after its `tries`-th refused ask a round waits: the first three at once (the 5-minute pacing still holds), then 1, 2, 4 ... 12. */
export const retryBlocks = (tries) => (tries < 3 ? 0 : Math.min(2 ** (tries - 3), 12));

/** Whether every stake lock of the round is past its expiration at `tip` (null when either is not known). */
export function locksExpired(lastExpiration, tip) {
  if (!Number.isInteger(lastExpiration) || !Number.isInteger(tip)) return null;
  return tip >= lastExpiration + RETRY_EXPIRY_MARGIN_BLOCKS;
}
