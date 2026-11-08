// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
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
//                         CLOSED (nothing was lost: the whole bond to the protocol reserves) or HALTED.
//                         On a HALT the ORDER is the whole of it - every unspent note is paid at face
//                         value FIRST, and only what no player claimed goes to the reserves (§5A.3,
//                         RULED 2026-11-02, kanban #976).
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
export function exposureCap({ bonds, f, threshold = null }) {
  if (!Array.isArray(bonds) || !bonds.length) return { ok: false, why: 'a federation has seated guardians' };
  if (!bonds.every((b) => typeof b === 'bigint' && b > 0n))
    return { ok: false, why: 'every bond is a positive number of msat' };
  if (!Number.isInteger(f) || f < 0) return { ok: false, why: 'f is how many faults the threshold tolerates' };
  const smallest = bonds.reduce((a, b) => (b < a ? b : a));
  // (seated - 2f), RULED 2026-11-07 (kanban #1295/#1321): it was (f + 1), which holds only at full seating - 4, 3, 2 at 10, 9, 8 seated of a ten.
  // In general the leavers that halt it: seated - threshold + 1 (threshold 2f + 1, so seated - 2f; a 2 of 2 testnet federation, threshold 2: 1)
  const t = Number.isInteger(threshold) ? threshold : 2 * f + 1;
  const places = Math.max(0, bonds.length - t + 1);
  return { ok: true, cap: BigInt(places) * smallest, smallest, halts: places };
}

/**
 * A GUARDIAN'S BOND STAYS LOCKED WHILE IT SERVES (kanban #1093 part 7, ruling #1104, 2026-11-03). Only a bond that cannot leave before a
 * drain could finish covers anything:
 *   qualifying  a guardian whose outputs maturing after record height + drain_blocks sum to at least bond_min_guardian
 *   k           the seated guardians that are not qualifying (they stay seated and sign; they only cover nothing)
 *   cap         max(0, f + 1 - k) x the smallest qualifying bond (its outputs past the line)
 * One lapsing guardian lowers the cap by one share; f + 1 of them make it 0. All qualifying bonds sum to at least (n - k) x the smallest,
 * more than the cap for every k, so the theft cover holds. `guardians` [{ outputs: [{ bondSats, maturity }] }] or, with no outputs
 * listed, { bondSats, maturity }.
 */
export function lockedExposureCap({ guardians, f, height, drainBlocks, bondMinGuardian, threshold = null }) {
  if (!Array.isArray(guardians) || !guardians.length) return { ok: false, why: 'a federation has seated guardians' };
  if (!Number.isInteger(f) || f < 0) return { ok: false, why: 'f is how many faults the threshold tolerates' };
  if (!Number.isInteger(height) || !Number.isInteger(drainBlocks) || drainBlocks < 0) return { ok: false, why: 'the lock is judged at a record height against drain_blocks' };
  const floor = BigInt(bondMinGuardian || 0);
  const line = height + drainBlocks;
  const locked = guardians.map((g) => (Array.isArray(g.outputs) && g.outputs.length ? g.outputs : [{ bondSats: g.bondSats, maturity: g.maturity }])
    .filter((o) => Number.isInteger(Number(o.maturity)) && o.maturity !== null && Number(o.maturity) > line)
    .reduce((a, o) => a + BigInt(o.bondSats || 0), 0n));
  const qualifying = locked.filter((x) => x > 0n && x >= floor);
  const lapsing = guardians.length - qualifying.length;
  const places = Math.max(0, guardians.length - (Number.isInteger(threshold) ? threshold : 2 * f + 1) + 1 - lapsing);   // (seated - 2f) less the lapsing (#1295/#1321)
  const smallest = qualifying.length ? qualifying.reduce((a, b) => (b < a ? b : a)) : 0n;
  return { ok: true, cap: BigInt(places) * smallest, smallest, places, lapsing, qualifying: qualifying.length, line };
}

/**
 * WHEN A GUARDIAN'S BOND STOPS COVERING (kanban #1093 part 7, ruling #1104: "the dashboard warns drain_blocks ahead of the moment, with
 * Add to bond"). It qualifies at height h while its outputs maturing after h + drain_blocks sum to at least bond_min_guardian, so it lapses
 * at m* - drain_blocks, m* the maturity at which the latest outputs first reach the floor. Answers { qualifying, lapsesAt, blocksLeft, warn }:
 * `warn` from drain_blocks before the lapse; lapsesAt null when no outputs reach the floor at all.
 */
// `warnBlocks` (#1318, RULED #1288: "the owner page says so a season ahead"): warn this far ahead when it is longer than drain_blocks; `departsAt` the latest
// output's maturity - the guardian departs on schedule there (scheduledDeparture)
export function bondLapseOf({ outputs, drainBlocks, bondMinGuardian, tip, warnBlocks = 0 }) {
  const floor = BigInt(bondMinGuardian || 0);
  const outs = (outputs || []).filter((o) => o && Number.isInteger(Number(o.maturity)) && o.maturity !== null)
    .map((o) => ({ sats: BigInt(o.bondSats ?? o.sats ?? 0), maturity: Number(o.maturity) })).sort((a, b) => b.maturity - a.maturity);
  let sum = 0n, mStar = null;
  for (const o of outs) { sum += o.sats; if (sum >= floor && sum > 0n) { mStar = o.maturity; break; } }
  const departsAt = outs.length ? outs[0].maturity : null;
  if (mStar === null) return { qualifying: false, lapsesAt: null, blocksLeft: 0, warn: true, departsAt };
  const lapsesAt = mStar - drainBlocks;
  const blocksLeft = Math.max(0, lapsesAt - Number(tip));
  const ahead = Math.max(drainBlocks, Number.isInteger(warnBlocks) ? warnBlocks : 0);
  return { qualifying: Number(tip) < lapsesAt, lapsesAt, blocksLeft, warn: blocksLeft <= ahead, warnBlocks: ahead, departsAt };
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
 * §23A.5: where a slashed guardian bond goes (§5A.3, RULED 2026-11-02, kanban #976).
 *
 * `halted` is the whole of the difference. A federation that kept running lost nothing, so the whole bond goes to the protocol reserves;
 * one that froze pays its note holders at face value FIRST and the remainder goes to the reserves. Nothing is burned on either road -
 * `burned` stays in the answer at 0n so a burn cannot come back unnoticed.
 */
export function slashSplit({ amountMsat, halted = false, notesOwedMsat = 0n }) {
  if (typeof amountMsat !== 'bigint' || amountMsat < 0n)
    return { ok: false, why: 'a slashed bond is a number of msat' };
  if (!halted) return { ok: true, halted: false, notes: 0n, reserves: amountMsat, burned: 0n };
  if (typeof notesOwedMsat !== 'bigint' || notesOwedMsat < 0n)
    return { ok: false, why: 'the notes owed are a number of msat' };
  // THE HALT CASE, AND THE ORDER IS THE RULE. Every unspent note is paid at face value first; only the remainder - what no player claimed
  // inside the window - goes to the reserves. A short escrow pays the notes pro rata and leaves nothing over.
  const notes = notesOwedMsat < amountMsat ? notesOwedMsat : amountMsat;
  return { ok: true, halted: true, notes, reserves: amountMsat - notes, burned: 0n, proRata: notesOwedMsat > amountMsat };
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
 *   claim_blocks       the old 36 h claim window, still hashed into each network id; no longer read (below)
 *   liquidation_claim_blocks  HOW LONG A PLAYER HAS TO CLAIM (kanban #1093 part 8, the owner 2026-11-03): 3 months from the halt -
 *                      mainnet 12,960, testnet4 at its short clocks (a twentieth), regtest its own. A claim is paid when it is made;
 *                      what is left goes to the protocol reserves only after the window, never earlier. A code rule, not a genesis
 *                      byte, so the live testnet4 network id does not change.
 */
export const MAINNET_CLOCKS = Object.freeze({
  abandonBlocks: 288, departureNotice: 432, foundingWindow: 432, drainBlocks: 4032, claimBlocks: 216, liquidationClaimBlocks: 12960,
});

/**
 * TESTNET RUNS THE SAME CLOCKS AT ABOUT A TWENTIETH (2026-09-21: much shorter), so a whole
 * federation lifetime can be watched in a day instead of a month: 2 h / 3 h / 3 h / 24 h / 1.5 h.
 * Regtest counts in tens of blocks, because its blocks come when somebody presses a button.
 */
export const TESTNET_CLOCKS = Object.freeze({
  abandonBlocks: 12, departureNotice: 18, foundingWindow: 18, drainBlocks: 144, claimBlocks: 9, liquidationClaimBlocks: 648,
});
export const REGTEST_CLOCKS = Object.freeze({
  abandonBlocks: 10, departureNotice: 10, foundingWindow: 10, drainBlocks: 100, claimBlocks: 10, liquidationClaimBlocks: 100,
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
 * WHEN A HALTED FEDERATION'S CLAIMS OPEN AND CLOSE, and when its remainder may be split - not one block sooner.
 *
 * The window opens when the liquidation does (§23A.5: halted for abandon_blocks) and closes liquidation_claim_blocks after the halt:
 * 3 months on mainnet (kanban #1093 part 8, the owner 2026-11-03; it was claim_blocks plus a drain_blocks late tail). A claim is paid
 * when it is made. Only after the window does the rest go to the reserves: e-cash is anonymous, so nobody can know every holder came.
 * `lateClaimsUntil` is the same height as the close, kept for readers that name it.
 */
export function liquidationSchedule({ haltHeight, clocks = MAINNET_CLOCKS }) {
  if (!Number.isInteger(haltHeight) || haltHeight < 0)
    return { ok: false, why: 'a halt happens at a block height' };
  const window = clocks && clocks.liquidationClaimBlocks;
  if (!Number.isInteger(window) || window <= 0) return { ok: false, why: 'those clocks name no liquidation claim window (liquidationClaimBlocks)' };
  const opens = haltHeight + clocks.abandonBlocks;
  const closes = Math.max(opens, haltHeight + window);
  return { ok: true, claimWindowOpens: opens, claimWindowCloses: closes, lateClaimsUntil: closes, remainderSplitsAt: closes + 1 };
}

/** May the remainder go to the reserves yet? Never while a player may still claim. */
export function remainderMaySplit({ haltHeight, atHeight, clocks = MAINNET_CLOCKS }) {
  const when = liquidationSchedule({ haltHeight, clocks });
  if (!when.ok) return when;
  if (!Number.isInteger(atHeight)) return { ok: false, why: 'ask at a block height' };
  return { ok: true, may: atHeight >= when.remainderSplitsAt, notBefore: when.remainderSplitsAt };
}

/**
 * THE CLAIMS ON A HALTED FEDERATION'S ESCROW, SETTLED (spec §23A.5, kanban #1093 part 8). `claims`: notes presented as
 * [{ nonce (hex), amountMsat, height }], each checked by the injected `noteSigned(claim)` (the federation's signature on the note);
 * `spentNonces`: the published spent-note set (hex), or null when no seated guardian published one. In this order:
 *   1. refused by name: not the federation's note, already spent, claimed before (the first presentation counts), or presented
 *      after the window closed
 *   2. every other claim at face, in the order it was made (height, then nonce): paid when made, nobody waits for anyone. The cap keeps
 *      the escrow at least the reserve at the halt; should it still run short, the first claims are paid in full and `short` says so -
 *      a later claim never takes from one made before it
 *   3. only after the window, the remainder to the protocol reserves (slashSplit)
 * `proRata` is always false now and `rate` 1, kept for readers that name them.
 */
export function settleClaims({ escrowMsat, claims = [], spentNonces = null, haltHeight, atHeight, clocks = MAINNET_CLOCKS, noteSigned }) {
  const when = liquidationSchedule({ haltHeight, clocks });
  if (!when.ok) return when;
  if (typeof escrowMsat !== 'bigint' || escrowMsat < 0n) return { ok: false, why: 'the escrow is a number of msat' };
  const spent = new Set((spentNonces || []).map((n) => String(n).toLowerCase()));
  const seen = new Set();
  const refused = []; const taken = [];
  const ordered = [...claims].sort((a, b) => (a.height - b.height) || (String(a.nonce) < String(b.nonce) ? -1 : 1));
  for (const c of ordered) {
    const nonce = String(c.nonce).toLowerCase();
    if (typeof noteSigned !== 'function' || !noteSigned(c)) { refused.push({ nonce, why: 'that note does not carry the federation\'s signature' }); continue; }
    if (spent.has(nonce)) { refused.push({ nonce, why: 'that note\'s nonce is in the published spent set' }); continue; }
    if (seen.has(nonce)) { refused.push({ nonce, why: 'that note was claimed before' }); continue; }
    if (c.height > when.claimWindowCloses) { refused.push({ nonce, why: `presented at ${c.height}, after the claim window closed at ${when.claimWindowCloses}: the holder's loss` }); continue; }
    seen.add(nonce);
    taken.push({ nonce, amountMsat: BigInt(c.amountMsat), height: c.height });
  }
  const paid = []; let left = escrowMsat, shortMsat = 0n;
  for (const c of taken) {
    const msat = c.amountMsat <= left ? c.amountMsat : left;
    shortMsat += c.amountMsat - msat;
    paid.push({ nonce: c.nonce, msat, late: false }); left -= msat;
  }
  const may = remainderMaySplit({ haltHeight, atHeight, clocks });
  const split = may.ok && may.may ? slashSplit({ amountMsat: left }) : null;
  return { ok: true, paid, refused, proRata: false, rate: 1, short: shortMsat > 0n, shortMsat,
    spentSetPublished: spentNonces !== null, remainderMsat: left, split: split ? { reserves: split.reserves } : null,
    claimWindowCloses: when.claimWindowCloses, remainderSplitsAt: when.remainderSplitsAt };
}

const hexKey = (k) => (k instanceof Uint8Array ? Array.from(k, (b) => b.toString(16).padStart(2, '0')).join('') : String(k || '')).toLowerCase();

/**
 * MAY A GONE GUARDIAN'S BOND BE SLASHED (§23A.5's table, FEDERATION.md rehearsal 14). `proof`: abandonmentProof's or bondSpentProof's answer for the
 * peer (absence.js); `departure`: departureStands' answer for the same peer's notice, or null. "Leaving is legitimate" (RULED,
 * 2026-09-21): an absence that begins at or after a standing notice's leave_after is the departure - DEPARTED, the bond
 * untouched. "A departure that stops serving before its leave_after" is abandonment, and so is an absence with no notice.
 * Answers { ok, slash, kind: 'ABANDONED' | 'DEPARTED', why }.
 */
/**
 * A BOND'S MATURITY IS A STANDING NOTICE (RULED 2026-11-07, kanban #1288 / #1343, built by #1318): a guardian reads as having given notice at
 * bond_maturity - departure_notice, so it leaves at its bond's maturity as DEPARTED on schedule, no offence. Before this the bond spent by path A at
 * its maturity read as ABANDONED, and the offence and the spend were one transaction. `outputs` [{ maturity }] (or one { maturity }): the leave_after is
 * the latest maturity; null when none is known.
 */
export function scheduledDeparture({ outputs, maturity = null, departureNotice = null } = {}) {
  const list = Array.isArray(outputs) && outputs.length ? outputs.map((o) => o && o.maturity) : [maturity];
  const known = list.map(Number).filter((m) => Number.isInteger(m) && m > 0);
  if (!known.length) return null;
  const leaveAfterHeight = Math.max(...known);
  return { leaveAfterHeight, postedAt: Number.isInteger(departureNotice) ? leaveAfterHeight - departureNotice : null };
}

export function guardianSlashStands({ proof, departure = null, emergency = null, abandonBlocks = null, scheduled = null }) {
  if (!proof || !proof.ok) return { ok: false, slash: false, why: `no abandonment proof stands${proof && proof.why ? `: ${proof.why}` : ''}` };
  // THE OWNER'S EMERGENCY DEPARTURE (§23A.5a, protocol 17): `emergency` emergencyDepartureStands' answer for this guardian's node.
  // Posted before abandon_blocks from the height he was last seen: DEPARTED, the bond untouched. Later: abandonment, as without it.
  if (emergency && emergency.ok) {
    if (!Number.isInteger(abandonBlocks) || abandonBlocks <= 0) throw new Error('an emergency departure is judged against abandon_blocks');
    if (emergency.postedAt < proof.sinceHeight + abandonBlocks)
      return { ok: true, slash: false, kind: 'DEPARTED', why: `the owner's emergency departure at ${emergency.postedAt}, before abandon_blocks (${abandonBlocks}) from last seen ${proof.sinceHeight}: departed, the bond untouched (§23A.5a)` };
  }
  if (departure && departure.ok) {
    if (hexKey(departure.peerKey) !== hexKey(proof.peerKey)) return { ok: false, slash: false, why: 'the notice and the proof name different peers' };
    if (proof.sinceHeight >= departure.leaveAfterHeight)
      return { ok: true, slash: false, kind: 'DEPARTED', why: `gone since ${proof.sinceHeight}, at or after the notice's leave_after ${departure.leaveAfterHeight}: departed with notice, the bond untouched (§23A.5)` };
    return { ok: true, slash: true, kind: 'ABANDONED', why: `stopped at ${proof.sinceHeight}, before the notice's leave_after ${departure.leaveAfterHeight}: a departure that stops serving early is abandonment (§23A.5)` };
  }
  // ON SCHEDULE (#1318): gone, or the bond spent, at or after the bond's maturity - the standing notice its maturity gives
  if (scheduled && Number.isInteger(scheduled.leaveAfterHeight) && proof.sinceHeight >= scheduled.leaveAfterHeight)
    return { ok: true, slash: false, kind: 'DEPARTED', onSchedule: true, why: `${proof.bondSpent ? 'his bond was spent' : 'gone'} at ${proof.sinceHeight}, at or after his bond's maturity ${scheduled.leaveAfterHeight}: departed on schedule, no offence (§23A.3, kanban #1288)` };
  if (proof.bondSpent) return { ok: true, slash: true, kind: 'ABANDONED', why: `his bond was spent at ${proof.sinceHeight} while seated: abandonment (§23A.5)` };
  return { ok: true, slash: true, kind: 'ABANDONED', why: `absent since ${proof.sinceHeight}, attested by ${proof.signers}: abandonment (§23A.4)` };
}
