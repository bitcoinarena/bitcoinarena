// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE FIXTURES' SHARED CLOCK THAT SKIPS (§13A, WINDOW-10-SPEC, RULED 2026-10-01): the objection window is exactly
// 600 s of wall time from the round's end, and no test waits ten real minutes. Every fixture daemon reads this clock as
// its round store's (`roundClock`): the wall clock plus an offset that only grows. `skipTo(ms)` moves every daemon in the
// process to that instant at once - one network, one time - and nothing in between happens: the windows close as they
// would ten minutes later. One clock per process; node --test runs each file in its own.
let offset = 0;

/** Now, on the fixtures' clock (ms). */
export const testNow = () => Date.now() + offset;

/** Move the clock forward to `ms` (never back). Returns the offset now in force. */
export function skipTo(ms) {
  const d = Number(ms) - testNow();
  if (d > 0) offset += d;
  return offset;
}

/** Move the clock forward by `ms`. */
export function skipBy(ms) {
  if (ms > 0) offset += Number(ms);
  return offset;
}

/** The instant a seat decides a round's §13C result window and may sign FINAL: its end + 600 s + 5 s (WINDOW-10-SPEC). */
export async function decidesFromMs(contract) {
  const { windowsOf } = await import('../../arena-protocol/src/window.js');
  return Number(windowsOf(contract).finalAfterMs);
}
