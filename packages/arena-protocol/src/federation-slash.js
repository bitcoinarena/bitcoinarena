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
import { splitNodesDevelopers } from './constants.js';

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
 * developers; one that froze pays its note holders at face value FIRST and splits only what is left
 * over the same way. Nothing is burned on either road - `burned` stays in the answer at 0n so a burn
 * cannot come back unnoticed.
 */
export function slashSplit({ amountMsat, halted = false, notesOwedMsat = 0n }) {
  if (typeof amountMsat !== 'bigint' || amountMsat < 0n)
    return { ok: false, why: 'a slashed bond is a number of msat' };
  if (!halted) {
    // The running case, unchanged: 75% to the active census nodes, 25% to the donation set.
    const { nodes, developers } = splitNodesDevelopers(amountMsat);
    return { ok: true, halted: false, notes: 0n, nodes, developers, burned: 0n };
  }
  if (typeof notesOwedMsat !== 'bigint' || notesOwedMsat < 0n)
    return { ok: false, why: 'the notes owed are a number of msat' };
  // THE HALT CASE, AND THE ORDER IS THE RULE. Every unspent note is paid at face value first; only the
  // remainder - what no player claimed inside the window - is split 75/25. A short escrow pays the notes
  // pro rata and leaves nothing over, so nobody who runs the network is paid at all.
  const notes = notesOwedMsat < amountMsat ? notesOwedMsat : amountMsat;
  const rest = amountMsat - notes;
  const { nodes, developers } = splitNodesDevelopers(rest);
  return { ok: true, halted: true, notes, nodes, developers, burned: 0n,
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
 * TESTNET RUNS THE SAME CLOCKS AT ABOUT A TWENTIETH (2026-09-21: much shorter), so a whole
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
  // THE WINDOW OPENS WHEN THE LIQUIDATION DOES (§23A.5: "A federation that has been HALTED for abandon_blocks ... is liquidated
  // ... 2. The arbitration set opens a claim window of claim_blocks"), and runs claim_blocks from there. It closed at halt +
  // claim_blocks before (found by the claim book's test): on mainnet 72 blocks BEFORE it opened at halt + 288, and
  // a seat listed liquidatesAt 892 beside claimWindowCloses 889.
  return {
    ok: true,
    claimWindowOpens: haltHeight + clocks.abandonBlocks,
    claimWindowCloses: haltHeight + clocks.abandonBlocks + clocks.claimBlocks,
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

/**
 * THE CLAIMS ON A HALTED FEDERATION'S ESCROW, SETTLED (spec §23A.5 liquidation steps 3-4). `claims`: notes presented
 * as [{ nonce (hex), amountMsat, height }], each checked by the injected `noteSigned(claim)` (the federation's signature on the
 * note); `spentNonces`: the published spent-note set (hex), or null when no seated guardian published one. In this order:
 *   1. refused by name: not the federation's note, already spent, claimed before (the first presentation counts), or presented
 *      after drain_blocks
 *   2. the claims inside the window: at face value, or pro rata when the escrow is short (the rate is answered, the client
 *      shows it)
 *   3. the late ones, up to drain_blocks after the halt: from what is left, in order of height then nonce, each at face value
 *      while it lasts
 *   4. only then the remainder, 75 % / 25 % (slashSplit), and only once remainderMaySplit says so at `atHeight`
 */
export function settleClaims({ escrowMsat, claims = [], spentNonces = null, haltHeight, atHeight, clocks = MAINNET_CLOCKS, noteSigned }) {
  const when = liquidationSchedule({ haltHeight, clocks });
  if (!when.ok) return when;
  if (typeof escrowMsat !== 'bigint' || escrowMsat < 0n) return { ok: false, why: 'the escrow is a number of msat' };
  const spent = new Set((spentNonces || []).map((n) => String(n).toLowerCase()));
  const seen = new Set();
  const refused = []; const inWindow = []; const late = [];
  const ordered = [...claims].sort((a, b) => (a.height - b.height) || (String(a.nonce) < String(b.nonce) ? -1 : 1));
  for (const c of ordered) {
    const nonce = String(c.nonce).toLowerCase();
    if (typeof noteSigned !== 'function' || !noteSigned(c)) { refused.push({ nonce, why: 'that note does not carry the federation\'s signature' }); continue; }
    if (spent.has(nonce)) { refused.push({ nonce, why: 'that note\'s nonce is in the published spent set' }); continue; }
    if (seen.has(nonce)) { refused.push({ nonce, why: 'that note was claimed before' }); continue; }
    if (c.height > when.lateClaimsUntil) { refused.push({ nonce, why: `presented at ${c.height}, after drain_blocks (until ${when.lateClaimsUntil}): the holder's loss` }); continue; }
    seen.add(nonce);
    (c.height <= when.claimWindowCloses ? inWindow : late).push({ nonce, amountMsat: BigInt(c.amountMsat), height: c.height });
  }
  const owed = inWindow.reduce((a, c) => a + c.amountMsat, 0n);
  const short = owed > escrowMsat;
  const paid = inWindow.map((c) => ({ nonce: c.nonce, msat: short ? (c.amountMsat * escrowMsat) / owed : c.amountMsat, late: false }));
  let left = escrowMsat - paid.reduce((a, p) => a + p.msat, 0n);
  for (const c of late) {
    const msat = c.amountMsat <= left ? c.amountMsat : left;
    paid.push({ nonce: c.nonce, msat, late: true }); left -= msat;
  }
  const may = remainderMaySplit({ haltHeight, atHeight, clocks });
  const split = may.ok && may.may ? slashSplit({ amountMsat: left }) : null;
  return { ok: true, paid, refused, proRata: short, rate: short ? Number((escrowMsat * 10000n) / owed) / 10000 : 1,
    spentSetPublished: spentNonces !== null, remainderMsat: left, split: split ? { nodes: split.nodes, developers: split.developers } : null,
    remainderSplitsAt: when.remainderSplitsAt };
}

const hexKey = (k) => (k instanceof Uint8Array ? Array.from(k, (b) => b.toString(16).padStart(2, '0')).join('') : String(k || '')).toLowerCase();

/**
 * MAY A GONE GUARDIAN'S BOND BE SLASHED (§23A.5's table, FEDERATION.md rehearsal 14). `proof`: abandonmentProof's answer for the
 * peer (absence.js); `departure`: departureStands' answer for the same peer's notice, or null. "Leaving is legitimate" (RULED,
 * 2026-09-21): an absence that begins at or after a standing notice's leave_after is the departure - DEPARTED, the bond
 * untouched. "A departure that stops serving before its leave_after" is abandonment, and so is an absence with no notice.
 * Answers { ok, slash, kind: 'ABANDONED' | 'DEPARTED', why }.
 */
export function guardianSlashStands({ proof, departure = null }) {
  if (!proof || !proof.ok) return { ok: false, slash: false, why: `no abandonment proof stands${proof && proof.why ? `: ${proof.why}` : ''}` };
  if (departure && departure.ok) {
    if (hexKey(departure.peerKey) !== hexKey(proof.peerKey)) return { ok: false, slash: false, why: 'the notice and the proof name different peers' };
    if (proof.sinceHeight >= departure.leaveAfterHeight)
      return { ok: true, slash: false, kind: 'DEPARTED', why: `gone since ${proof.sinceHeight}, at or after the notice's leave_after ${departure.leaveAfterHeight}: departed with notice, the bond untouched (§23A.5)` };
    return { ok: true, slash: true, kind: 'ABANDONED', why: `stopped at ${proof.sinceHeight}, before the notice's leave_after ${departure.leaveAfterHeight}: a departure that stops serving early is abandonment (§23A.5)` };
  }
  return { ok: true, slash: true, kind: 'ABANDONED', why: `absent since ${proof.sinceHeight}, attested by ${proof.signers}: abandonment (§23A.4)` };
}

/**
 * WHO A SLASHED GUARDIAN'S BOND PAYS once its federation is CLOSED with nothing lost (§23A.5, FEDERATION.md rehearsal 14):
 * 75 % evenly to the census nodes active at the slash height LESS EVERY GUARDIAN OF THAT FEDERATION (they guarded the federation
 * that lost one), 25 % to the donation set (splitNodesDevelopers). Amounts in sat, BigInt; the nodes' division's leftover
 * satoshi go to the first node in key order, so the outputs sum to the amount. Answers { ok, nodes: [{ key, sats }], developers }.
 */
export function guardianSlashPayees({ amountSats, censusNodes, record }) {
  if (typeof amountSats !== 'bigint' || amountSats <= 0n) return { ok: false, why: 'a slashed bond is a positive number of sat' };
  const guardians = new Set((record && record.guardians || []).map((g) => hexKey(g.nodePubkey)));
  const keys = [...new Set((censusNodes || []).map(hexKey))].filter((k) => k && !guardians.has(k)).sort();
  if (!keys.length) return { ok: false, why: 'no census node outside the federation\'s guardians to pay' };
  const { nodes, developers } = splitNodesDevelopers(amountSats);
  const each = nodes / BigInt(keys.length);
  const out = keys.map((key) => ({ key, sats: each }));
  out[0].sats += nodes - each * BigInt(keys.length);
  return { ok: true, nodes: out, developers, guardiansLeftOut: guardians.size };
}

/**
 * A LIQUIDATION'S REMAINDER, BY NAME (§23A.5: "only the remainder then, 75% / 25% as above" - "75% evenly to every active census
 * node at that height ... minus the slashed nodes and minus every guardian of the federation concerned; 25% to the donation set
 * of §22A - the developers - by share_bps"). `msat` BigInt; `censusNodes` keys at the spending height; `slashed` keys; `record`
 * the federation's; `donation` the donation set in force, recipients with `recipientPk` (x-only, hex or bytes) and `shareBps`.
 * The division's leftover goes to the first payee of each part in key order, so the payees sum to `msat`. Answers
 * { ok, payees: [{ key, msat, part: 'node' | 'donation' }] } or why not.
 */
export function liquidationRemainderPayees({ msat, censusNodes, slashed = [], record, donation }) {
  if (typeof msat !== 'bigint' || msat <= 0n) return { ok: false, why: 'a remainder is a positive number of msat' };
  const out = new Set((slashed || []).map(hexKey));
  const nodes = guardianSlashPayees({ amountSats: msat, censusNodes: (censusNodes || []).filter((k) => !out.has(hexKey(k))), record });
  if (!nodes.ok) return nodes;
  const keyed = (donation || []).filter((r) => r && r.recipientPk !== undefined && Number.isInteger(r.shareBps) && r.shareBps > 0)
    .map((r) => ({ key: hexKey(r.recipientPk), bps: BigInt(r.shareBps) })).sort((a, b) => (a.key < b.key ? -1 : 1));
  const bps = keyed.reduce((a, r) => a + r.bps, 0n);
  if (!keyed.length || bps !== 10000n) return { ok: false, why: 'the donation set in force names no key recipients whose shares make 10000 bps' };
  const dev = keyed.map((r) => ({ key: r.key, msat: (nodes.developers * r.bps) / 10000n, part: 'donation' }));
  dev[0].msat += nodes.developers - dev.reduce((a, r) => a + r.msat, 0n);
  return { ok: true, payees: [...nodes.nodes.map((n) => ({ key: n.key, msat: n.sats, part: 'node' })), ...dev] };
}
