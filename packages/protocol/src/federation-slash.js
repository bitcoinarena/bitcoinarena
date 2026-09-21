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
//   a slashed bond        goes 75% to the active census nodes and 25% to the developers while the
//                         federation still runs - but on a HALT it goes to the note holders at face
//                         value first, and whatever is left is BURNED. Nodes 0%, developers 0%.
//                         The operator must not profit from a technical freeze.
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
  // THE HALT CASE. Notes at face value first; what is left is burned, and nobody who runs the network
  // takes a share of a freeze. If the escrow is short the notes are paid pro rata and nothing is burned.
  const notes = notesOwedMsat < amountMsat ? notesOwedMsat : amountMsat;
  return { ok: true, halted: true, notes, nodes: 0n, developers: 0n, burned: amountMsat - notes,
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
