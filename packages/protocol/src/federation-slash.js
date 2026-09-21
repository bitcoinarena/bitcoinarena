// WHAT A FEDERATION'S BONDS COVER, AND WHERE A SLASHED ONE GOES.
//
// §23A.3 and §23A.5, as rules a caller can run rather than paragraphs somebody has to remember. Three
// numbers live here and each has a way of being got wrong that this file exists to refuse:
//
//   the exposure cap      is (f + 1) x the SMALLEST seated bond, not the sum of the bonds. `f + 1` gone
//                         is the smallest set that halts the federation, and their bonds are what a
//                         liquidation pays players from - so the reserve may never exceed what the
//                         cheapest possible set of leavers forfeits. Summing all ten would let a
//                         federation hold cover it can only produce if EVERY guardian is slashed.
//   a slashed bond        never goes straight to anybody: it waits in the federation's liquidation
//                         escrow under the arbitration keys, and spends only when the federation is
//                         CLOSED (nothing was lost: 75% census nodes, 25% developers) or HALTED. On a
//                         HALT the ORDER is the whole of it - every unspent note is paid at face value
//                         FIRST, and only what no player claimed is split 75/25. The people who run the
//                         network are never paid out of money a player could still have claimed.
//   the abandonment proof needs `2f + 1` attestations normally, and on a halt cannot have them: the
//                         federation no longer has that many guardians. Then it is whoever is left,
//                         plus the halt itself, which anyone can see.
//
// Amounts are msat as BigInt, like every other money number in this protocol.

/** The smallest number of guardians whose loss halts a federation of `nominal` with threshold `2f + 1`. */
export const haltsAt = (f) => f + 1;

/**
 * §23A.3: `exposure_cap = (f + 1) x the smallest bond among its seated guardians`.
 *
 * At ten guardians and 7 of 10, `f = 3`, so four of the smallest bond - NOT the sum of all ten.
 */
export function exposureCap({ bonds, f }) {
  if (!Array.isArray(bonds) || !bonds.length) return { ok: false, why: 'a federation has seated guardians' };
  if (!bonds.every((b) => typeof b === 'bigint' && b > 0n))
    return { ok: false, why: 'every bond is a positive number of msat' };
  if (!Number.isInteger(f) || f < 0) return { ok: false, why: 'f is how many faults the threshold tolerates' };
  const smallest = bonds.reduce((a, b) => (b < a ? b : a));
  return { ok: true, cap: BigInt(haltsAt(f)) * smallest, smallest, halts: haltsAt(f) };
}

/** Is a reserve within what the bonds actually cover? */
export function reserveFits({ reserve, bonds, f }) {
  const capped = exposureCap({ bonds, f });
  if (!capped.ok) return capped;
  if (typeof reserve !== 'bigint' || reserve < 0n)
    return { ok: false, why: 'a reserve is a number of msat' };
  return { ok: true, fits: reserve <= capped.cap, cap: capped.cap, reserve,
    over: reserve > capped.cap ? reserve - capped.cap : 0n };
}

/**
 * §23A.5: where a slashed guardian bond goes.
 *
 * `halted` is the whole of the difference. A federation that kept running pays the census and the
 * developers; one that froze pays its note holders and burns the rest.
 */
export function slashSplit({ amountMsat, halted = false, notesOwedMsat = 0n }) {
  if (typeof amountMsat !== 'bigint' || amountMsat < 0n)
    return { ok: false, why: 'a slashed bond is a number of msat' };
  if (!halted) {
    // The running case, unchanged: 75% to the active census nodes, 25% to the donation set.
    const nodes = (amountMsat * 75n) / 100n;
    return { ok: true, halted: false, notes: 0n, nodes, developers: amountMsat - nodes, burned: 0n };
  }
  if (typeof notesOwedMsat !== 'bigint' || notesOwedMsat < 0n)
    return { ok: false, why: 'the notes owed are a number of msat' };
  // THE HALT CASE, AND THE ORDER IS THE RULE. Every unspent note is paid at face value first; only the
  // remainder - what no player claimed inside the window - is split 75/25. A short escrow pays the notes
  // pro rata and leaves nothing over, so nobody who runs the network is paid at all.
  const notes = notesOwedMsat < amountMsat ? notesOwedMsat : amountMsat;
  const rest = amountMsat - notes;
  const nodes = (rest * 75n) / 100n;
  return { ok: true, halted: true, notes, nodes, developers: rest - nodes, burned: 0n,
    proRata: notesOwedMsat > amountMsat };
}

/**
 * §23A.4 / §23A.5: what an abandonment proof needs.
 *
 * Normally `2f + 1` guardian attestations. On a halt the federation no longer has that many, so the
 * proof is whoever is still seated plus the halt itself - no consensus session for `abandon_blocks`,
 * which anyone can observe at every guardian's endpoint.
 */
export function abandonmentProofNeeds({ f, halted = false, seated = null }) {
  if (!Number.isInteger(f) || f < 0) return { ok: false, why: 'f is how many faults the threshold tolerates' };
  if (!halted) return { ok: true, attestations: 2 * f + 1, needsHaltFact: false };
  const left = Number.isInteger(seated) && seated >= 0 ? seated : 0;
  return { ok: true, attestations: left, needsHaltFact: true };
}

/**
 * §23A.1's clocks, in blocks, as numbers a caller can run rather than a table somebody has to remember.
 *
 * Everything in that chapter that waits, waits in BLOCKS - a wall clock is not a thing a chain agrees on.
 * The 36 h claim window is the owner's; the others are the spec's, matched to it.
 *
 *   abandon_blocks     absence that is abandonment; halt before liquidation; load before a founding
 *   departure_notice   notice a guardian gives before leaving
 *   founding_window    time a drawn set has to finish its DKG
 *   drain_blocks       how long a draining federation serves, AND the late-claim tail (four weeks)
 *   claim_blocks       the liquidation claim window the arbitration set opens
 */
export const MAINNET_CLOCKS = Object.freeze({
  abandonBlocks: 288, departureNotice: 432, foundingWindow: 432, drainBlocks: 4032, claimBlocks: 216,
});

/**
 * TESTNET RUNS THE SAME CLOCKS AT ABOUT A TWENTIETH (the owner 2026-09-21: much shorter), so a whole
 * federation lifetime can be watched in a day instead of a month: 2 h / 3 h / 3 h / 24 h / 1.5 h.
 * Regtest counts in tens of blocks, because its blocks come when somebody presses a button.
 */
export const TESTNET_CLOCKS = Object.freeze({
  abandonBlocks: 12, departureNotice: 18, foundingWindow: 18, drainBlocks: 144, claimBlocks: 9,
});
export const REGTEST_CLOCKS = Object.freeze({
  abandonBlocks: 10, departureNotice: 10, foundingWindow: 10, drainBlocks: 100, claimBlocks: 10,
});
export const CLOCKS = Object.freeze({
  mainnet: MAINNET_CLOCKS, testnet4: TESTNET_CLOCKS, testnet: TESTNET_CLOCKS, regtest: REGTEST_CLOCKS,
});

/** The clocks a network runs, refused rather than guessed for a network nobody pinned. */
export function clocksFor(network) {
  const said = CLOCKS[network];
  return said ? { ok: true, network, clocks: said }
    : { ok: false, why: `${network} has no pinned federation clocks` };
}

/**
 * HOW LONG A GUARDIAN LEAVING COSTS THE NETWORK, END TO END.
 *
 * Abandonment has to be proven before a succession can be drawn, and §23A.5 starts the succession AT the
 * departure when the federation would otherwise be DRAINING - so the founding runs inside the drain
 * rather than after it. Both are reported: the serial path for a guardian who simply vanishes, and the
 * overlapped one for a departure with notice.
 */
export function lifecycleBlocks(clocks) {
  const serial = clocks.abandonBlocks + clocks.foundingWindow + clocks.drainBlocks;
  const overlapped = clocks.abandonBlocks + Math.max(clocks.foundingWindow, clocks.drainBlocks);
  return { serial, overlapped };
}

/**
 * WHEN A HALTED FEDERATION'S REMAINDER MAY BE SPLIT, and not one block sooner.
 *
 * The claim window closes at `claim_blocks` and every valid claim filed in it is paid. A note shown LATE
 * is still paid from what is left until `drain_blocks` after the halt - the player who was offline for a
 * weekend is not the one the deadline is for. Only the remainder after THAT is split 75/25, and nothing
 * a player could still have claimed is ever destroyed.
 */
export function liquidationSchedule({ haltHeight, clocks = MAINNET_CLOCKS }) {
  if (!Number.isInteger(haltHeight) || haltHeight < 0)
    return { ok: false, why: 'a halt happens at a block height' };
  return {
    ok: true,
    claimWindowCloses: haltHeight + clocks.claimBlocks,
    lateClaimsUntil: haltHeight + clocks.drainBlocks,
    remainderSplitsAt: haltHeight + clocks.drainBlocks,
  };
}

/** May the remainder be split yet? Never before the late-claim tail has run out. */
export function remainderMaySplit({ haltHeight, atHeight, clocks = MAINNET_CLOCKS }) {
  const when = liquidationSchedule({ haltHeight, clocks });
  if (!when.ok) return when;
  if (!Number.isInteger(atHeight)) return { ok: false, why: 'ask at a block height' };
  return { ok: true, may: atHeight >= when.remainderSplitsAt, notBefore: when.remainderSplitsAt };
}
