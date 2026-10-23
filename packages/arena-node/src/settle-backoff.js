// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHEN THE SETTLE SWEEP ASKS A REFUSED ROUND AGAIN (kanban #576, measured 2026-10-21 22:5xZ): the sweep over attested rounds
// asked every round with no ACCEPTED settlement to settle every 5 s. A seat held 1,961 attested rounds, most refused for good
// ("an attested round with no counted entry: nothing is claimed") or waiting on another signer node's turn, and each pass asked
// them all again - about a third of a core per seat. A round refused without a settlement state is asked again after a wait
// that doubles from `firstMs` to `maxMs`; any other answer clears it, so a round that can settle is asked as before.
// A REFUSAL THAT CANNOT CHANGE WAITS LONGER (measured 2026-10-23, 2,350 attested rounds a seat with 20 market bots: a closed,
// attested round with no counted entry - every round of the federation the bots do not pay through - was asked every 60 s for
// good): `refused(k, { maxMs })` lets the caller cap that one round's wait higher.
export function createSettleBackoff({ now = () => Date.now(), firstMs = 5000, maxMs = 60000 } = {}) {
  const waits = new Map();                   // round hex -> { at, tries }
  return {
    /** Whether the round is due to be asked now. */
    due: (k) => { const w = waits.get(k); return !w || now() >= w.at; },
    /** The round was refused without a state: ask it again after the next wait. */
    refused: (k, { maxMs: cap = maxMs } = {}) => {
      const tries = (waits.get(k)?.tries || 0) + 1;
      waits.set(k, { at: now() + Math.min(cap, firstMs * 2 ** tries), tries });
    },
    /** The round answered with a state (settled, held, or on its way): asked on every pass again. */
    clear: (k) => { waits.delete(k); },
    /** Only the rounds still waiting keep a wait. */
    keep: (keys) => { for (const k of waits.keys()) if (!keys.has(k)) waits.delete(k); },
    size: () => waits.size,
  };
}
