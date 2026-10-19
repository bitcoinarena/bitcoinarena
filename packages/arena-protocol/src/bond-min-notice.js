// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// BOND_MIN CHANGES WITH NOTICE, AND WITH ESCALATION (§27A.3). "A rise in bond_min takes effect notice_period after the median
// first crosses it - reference 30 days, and never less than bond_maturity minus the confirmation depth. A fall takes effect immediately:
// nobody is harmed by a floor dropping." And a node the rise will pass "SHOULD escalate to its operator rather than warn once":
//   T-30d informational, T-14d actionable (the shortfall), T-3d urgent (the last point a new bond can confirm in time), T+0 status change.
// The median at each height is census-median.js's; this file is the clock over them.

/**
 * THE BOND_MIN IN FORCE AT `height`, from `history` [{ height, median }] (each census's bond-weighted median): the LOWEST median that
 * stood over the last `noticeBlocks` - the one standing at height - noticeBlocks and every one since. So a fall applies at once and a
 * rise only once it has held the whole notice; a rise in two steps takes effect in two steps. `pending`: the newest median, when it is
 * above the floor in force, and the height it takes effect at if it holds (its run's start + noticeBlocks).
 */
export function bondMinInForce(history, height, noticeBlocks) {
  const hs = (history || []).filter((x) => x && typeof x.median === 'bigint' && x.height <= height).sort((a, b) => a.height - b.height);
  if (!hs.length) return { inForce: null, pending: null };
  const from = height - noticeBlocks;
  const standing = [...hs].reverse().find((x) => x.height <= from);
  const window = hs.filter((x) => x.height > from).map((x) => x.median);
  const inForce = [...(standing ? [standing.median] : []), ...window].reduce((a, b) => (b < a ? b : a));
  const newest = hs[hs.length - 1].median;
  if (newest <= inForce) return { inForce, pending: null };
  // the run of medians at or above the newest, back from the newest: the rise to it counts from the run's start
  let start = hs.length - 1;
  while (start > 0 && hs[start - 1].median >= newest) start--;
  return { inForce, pending: { value: newest, crossedAt: hs[start].height, effectiveAt: hs[start].height + noticeBlocks } };
}

const DAY_MS = 86400000;
/**
 * THE ESCALATION for a node whose bond the pending floor will pass: at T-30d, T-14d, T-3d, T+0. `blockMs` the network's block time;
 * `nowHeight`. null when nothing is pending or the node's bond holds the new floor.
 */
export function bondMinWarning({ pending, ownBondSats, nowHeight, blockMs = 600000, feeRateSatVb = null }) {
  if (!pending || ownBondSats === null || ownBondSats === undefined || BigInt(ownBondSats) >= pending.value) return null;
  const leftMs = (pending.effectiveAt - nowHeight) * blockMs;
  const days = leftMs / DAY_MS;
  const shortfall = pending.value - BigInt(ownBondSats);
  const when = `at block ${pending.effectiveAt} (in ${Math.max(0, days).toFixed(1)} days)`;
  if (leftMs <= 0) return { step: 'T+0', urgent: true, says: `bond_min rose to ${pending.value} sat: this node's ${ownBondSats} sat bond no longer serves the rounds at that floor. It continues to serve every round below it - the floor moving is not an eviction.` };
  if (days <= 3) return { step: 'T-3d', urgent: true, says: `bond_min rises to ${pending.value} sat ${when}: this is the last point at which a second bond of ${shortfall} sat can confirm in time.` };
  if (days <= 14) return { step: 'T-14d', urgent: false, says: `bond_min rises to ${pending.value} sat ${when}: this node is ${shortfall} sat short; a second bond of that size closes it${feeRateSatVb ? ` (its funding transaction at ${feeRateSatVb} sat/vB)` : ''}.` };
  if (days <= 30) return { step: 'T-30d', urgent: false, says: `the floor will rise to ${pending.value} sat ${when}; this node is at ${ownBondSats} sat and keeps every round below that floor.` };
  return null;
}

/** notice_period per network (§27A.6's table): ~30 days on mainnet, ~1 day on testnet, 10 blocks on regtest. */
export const NOTICE_BLOCKS = Object.freeze({ mainnet: 4320, testnet4: 144, testnet: 144, regtest: 10 });

/**
 * THE MEDIAN HISTORY A SEAT HOLDS: one census per census height, from the rounds it holds - `rounds` [{ censusHeight,
 * entries }] (entries with bondSats and advert.declares) - as [{ height, median }] for bondMinInForce, ascending, nulls dropped.
 */
export function medianHistory(rounds, bondWeightedMedian) {
  const by = new Map();
  for (const r of rounds || []) if (r && Number.isInteger(r.censusHeight) && !by.has(r.censusHeight)) {
    const m = bondWeightedMedian(r.entries || [], 'bondMinSats');
    if (typeof m === 'bigint') by.set(r.censusHeight, m);
  }
  return [...by.entries()].map(([height, median]) => ({ height, median })).sort((a, b) => a.height - b.height);
}
