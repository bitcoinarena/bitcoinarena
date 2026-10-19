// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OBJECTION WINDOWS OF ONE ROUND, ON THE WALL CLOCK (§13A, WINDOW-10-SPEC, RULED 2026-10-01).
//
//   window_open   = round_end                  the round's end as its contract fixes it (roundEndMs), in UTC
//   window_close  = round_end + 600 s
//   final_after   = window_close + 5 s         a seat signs FINAL only once its own clock reads this
//
// and, for an entry a valid objection suspended, chained from that same close - never from the objection's arrival or
// the block it names (RULED 2026-10-01):
//
//   re-run window       [round_end + 600 s, round_end + 1200 s)    a re-run counts if it arrived before + 1205 s
//   the re-run's own    [round_end + 1200 s, round_end + 1800 s)   FINAL on the re-run after + 1805 s
//
// Every node computes these from the signed contract the round id binds, so every window starts and ends at the same
// instant everywhere and nobody - no node, no signer's timestamp, no miner - can move them.
import { OBJECTION_WINDOW_MS, FINAL_TOLERANCE_MS } from './constants.js';
import { roundEndMs } from './first-mark.js';

export { OBJECTION_WINDOW_MS, FINAL_TOLERANCE_MS };

/** All of a round's window instants (BigInt ms), from its contract alone. */
export function windowsOf(contract) {
  const end = roundEndMs(contract);
  const W = OBJECTION_WINDOW_MS;
  const T = FINAL_TOLERANCE_MS;
  return {
    openMs: end,
    closeMs: end + W,
    finalAfterMs: end + W + T,
    rerunOpenMs: end + W,
    rerunCloseMs: end + 2n * W,
    rerunDeadlineMs: end + 2n * W + T,
    ownOpenMs: end + 2n * W,
    ownCloseMs: end + 3n * W,
    ownFinalAfterMs: end + 3n * W + T,
  };
}

/** Is a signed time within the tolerance of the receiving seat's own clock at arrival? */
export function withinTolerance(signedAtMs, atMs) {
  const d = BigInt(signedAtMs) - BigInt(atMs);
  return (d < 0n ? -d : d) <= FINAL_TOLERANCE_MS;
}
