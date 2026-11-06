// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// LEVEL 2 OF PROOF (a), "WHO IS PAID" (§5A.3 row (a), protocol 27, kanban #1044 B1, rulings #1138 2, #1139 A, #1140 A-C). For a claim whose table is not
// shown exactly F there is no single correct table, so the accepted transaction is read against bounds. This module reads the first of them: every output
// pays a key the round may pay, and the node row is not paid more than the fee locks the transaction claims.
//
// The closed payee list (#1140):
//   qualifier refund keys                 refundKeyOf(player) of an Entry Contract of the round, or the refund key of an Arena lock this transaction claims
//   website keys                          an Entry Contract's frontendPk
//   KeyAgg(S)                             a send or held contract refunding to the signer set's key (the transaction's own agg_key)
//   the node row                          seats, the remainder node, auditors (census-eligible), guardians / gateways / liquidity providers (seated, own advert
//                                         payout key or node key), the publisher's fee-back key - together at most the fee locks the transaction claims
//   donation recipients                   the donation set the Round Contract names
//   reserve key                           the federation's reserve key
//
// What the caller cannot read is left out and never counts against a seat: a payee set passed as null makes every output it could be unread, and the
// cap on a row whose keys are unread is not checked. The donation and reserve caps are not read here (the caller's shares, not yet built). Pure.
import { toHex } from './hash.js';
import { refundKeyOf } from './stake-lock.js';
import { OFF_TABLE_CLAIM } from './named-claim-offence.js';
import { lnv2FeeMsat, REMAINDER_NODES_PERCENT } from './lock-settlement.js';

const low = (x) => String(x || '').toLowerCase();
const keyHex = (k) => (k instanceof Uint8Array ? toHex(k) : low(k));
const setOf = (xs) => (xs === null || xs === undefined ? null : new Set([...xs].map(keyHex)));

/**
 * The keys an Entry Contract of the round names as payees: { players } the players' refund keys, { sites } the websites' payout keys. A website is not a
 * qualifier: a walk-away's remainder (#1143 1) is read only where no qualifier is paid, and a website's line may stand beside it.
 */
export function entryPayeeKeys(entries) {
  const players = new Set(), sites = new Set();
  for (const e of entries || []) {
    if (e && e.playerPubkey instanceof Uint8Array) players.add(toHex(refundKeyOf(e.playerPubkey)));
    if (e && e.frontendPk instanceof Uint8Array) sites.add(toHex(e.frontendPk));
  }
  return { players, sites };
}

/**
 * ONE ACCEPTED CLAIM, READ BY WHO IT PAYS. `spends` the reader's spends of ONE transaction (its claims of this round's locks, each with `outputs`,
 * `agg_key`, `lock`); `entryKeys` entryPayeeKeys of the round's entries ({ players, sites }; a bare Set is read as players); `payees` { nodeKeys,
 * donationKeys, reserveKeys, gameDonationKeys?, market?: { nodeBps, donationBps }, fees?: { ppm, baseMsat } } (33-byte keys, hex or bytes; null where unread).
 *
 * THE NODE ROW'S CAP: the fee locks the transaction claims, and - ONLY IN A TRANSACTION THAT PAYS NO QUALIFIER (#1143 1, a walk-away's remainder) - 75 % of
 * what its stake locks pay after the guardians' input fees, as the planner rounds it (`fees`; without them the gross, never less than the planner's);
 * there the donation set gets at most the other 25 %. Where a qualifier is paid there is no remainder room.
 * A MARKET'S DONATION (#1143 2): the round's donation set and its game's own (`gameDonationKeys`, the manifest's) together at most `market.donationBps` of
 * the whole rate on everything the transaction claims; without `market` that sum is unread, as before.
 * Answers { false: true, why } or { false: false, unread: [why...] }.
 */
export function claimPayees({ spends, entryKeys, payees }) {
  const first = spends[0];
  const agg = low(first.agg_key);
  const node = setOf(payees.nodeKeys), donation = setOf(payees.donationKeys), reserve = setOf(payees.reserveKeys);
  const game = payees.gameDonationKeys === undefined ? new Set() : setOf(payees.gameDonationKeys);
  const allRead = node !== null && donation !== null && reserve !== null && game !== null;
  const keys = entryKeys instanceof Set ? { players: entryKeys, sites: new Set() } : (entryKeys || { players: new Set(), sites: new Set() });
  const qualifiers = new Set(keys.players || []);
  const sites = new Set(keys.sites || []);
  let feeClaimed = 0n, stakeClaimed = 0n, stakeFees = 0n;
  for (const s of spends) {
    if (!s.lock) continue;
    if (s.lock.refund_pk) qualifiers.add(low(s.lock.refund_pk));
    const msat = BigInt(s.lock.amount_msat);
    if (s.lock.payment_image && s.lock.payment_image.hash !== undefined) feeClaimed += msat;
    else { stakeClaimed += msat; if (payees.fees) stakeFees += lnv2FeeMsat(payees.fees, msat); }
  }
  const unread = [];
  let nodeRow = 0n, donated = 0n, qualifierPaid = false;
  for (const o of first.outputs || []) {
    if (o.kind !== 'outgoing') return { false: true, why: `output ${o.out_idx} is ${o.kind ? `a ${o.kind} output` : `an output of module ${o.module}`}, which no settlement makes` };
    const refund = low(o.refund_pk), claim = low(o.claim_pk);
    const msat = BigInt(o.amount_msat);
    if (agg && refund.slice(2) === agg) continue;
    if (claim !== refund) return { false: true, why: `output ${o.out_idx} is a send refunding to ${refund.slice(0, 18)}, not to the signer set's key` };
    if (qualifiers.has(refund)) { qualifierPaid = true; continue; }
    if (sites.has(refund) || (reserve && reserve.has(refund))) continue;
    if ((donation && donation.has(refund)) || (game && game.has(refund))) { donated += msat; continue; }
    if (node && node.has(refund)) { nodeRow += msat; continue; }
    if (!allRead) { unread.push(`output ${o.out_idx} pays ${refund.slice(0, 18)}, which no payee read here names`); continue; }
    return { false: true, why: `output ${o.out_idx} pays ${msat} msat to ${refund.slice(0, 18)}, a key the round may not pay` };
  }
  // THE REMAINDER ROOM (#1143 1): 75 % of the claimed stake after its input fees, where nobody qualified
  const spendable = stakeClaimed - stakeFees;
  const remainderNodes = qualifierPaid || spendable <= 0n ? 0n : (spendable * REMAINDER_NODES_PERCENT) / 100n;
  if (node !== null && nodeRow > feeClaimed + remainderNodes)
    return { false: true, why: `the node row is paid ${nodeRow} msat and the fee locks the transaction claims hold ${feeClaimed}`
      + `${qualifierPaid ? ' (it pays a qualifier: no remainder room)' : `, the remainder room ${remainderNodes}`}` };
  if (!qualifierPaid && remainderNodes > 0n && !payees.market && donated > spendable - remainderNodes)
    return { false: true, why: `the donation set is paid ${donated} msat and a walk-away's remainder gives it at most ${spendable - remainderNodes}` };
  if (payees.market) {
    const total = BigInt(payees.market.nodeBps) + BigInt(payees.market.donationBps);
    const cap = total > 0n ? ((feeClaimed + stakeClaimed) * BigInt(payees.market.donationBps)) / total : 0n;
    if (donated > cap) return { false: true, why: `the donation sets are paid ${donated} msat and the market's donation share of what the transaction claims is ${cap}` };
  }
  return { false: false, unread };
}

/**
 * LEVEL 2 OVER A READ: every accepted claim of round `roundId` (hex) in the reader's `spends`, by transaction. Answers
 * [{ offence, level: 2, txid, session, why, offenders }] for each false one, the named signers its offenders; a transaction whose lock's funding was not
 * read (no lock, no named keys) is not judged. `read`, an array when given, gets one line per claim read: { txid, outputs, false, why, unread }.
 */
export function unpayableClaims({ spends, roundId, entries, payees, read = null }) {
  const round = low(roundId);
  const byTx = new Map();
  for (const s of spends || []) {
    if (s.kind !== 'claim' || !s.lock || low(s.lock.round_id) !== round) continue;
    if (!byTx.has(low(s.txid))) byTx.set(low(s.txid), []);
    byTx.get(low(s.txid)).push(s);
  }
  const entryKeys = entryPayeeKeys(entries);
  const out = [];
  for (const [txid, list] of byTx) {
    const r = claimPayees({ spends: list, entryKeys, payees });
    // `read` (an array, optional): every claim read, false or not, with what was unread - what a seat logs of its pass
    if (Array.isArray(read)) read.push({ txid, outputs: (list[0].outputs || []).length, false: r.false, why: r.why || null, unread: r.unread || [] });
    if (!r.false) continue;
    const offenders = [...new Set(list.flatMap((s) => (s.named_keys || []).map(low)))].sort();
    out.push({ offence: OFF_TABLE_CLAIM, level: 2, txid, session: list[0].session, why: r.why, offenders });
  }
  return out;
}

/**
 * WHAT LEFT THE ROUND IN ONE ACCEPTED CLAIM (level 2 of row (a)'s loss, RULED 2026-11-06, kanban #1146 B): the msat it paid to keys the round may not pay
 * - an output no settlement makes, a send not refunding to the signer set's key, a key on no payee list - plus what it paid any row over its cap (the node
 * row over the fee locks it claims and the remainder room, the donation set over a walk-away's 25 % or a market's share). The same reading as `claimPayees`,
 * summed instead of stopped at the first. An output whose key is unread here is not counted (`unread` says which). Answers { msat, unread }.
 */
export function leftTheRound({ spends, entryKeys, payees }) {
  const first = spends && spends[0];
  if (!first) return { msat: 0n, unread: [] };
  const agg = low(first.agg_key);
  const node = setOf(payees.nodeKeys), donation = setOf(payees.donationKeys), reserve = setOf(payees.reserveKeys);
  const game = payees.gameDonationKeys === undefined ? new Set() : setOf(payees.gameDonationKeys);
  const allRead = node !== null && donation !== null && reserve !== null && game !== null;
  const keys = entryKeys instanceof Set ? { players: entryKeys, sites: new Set() } : (entryKeys || { players: new Set(), sites: new Set() });
  const qualifiers = new Set(keys.players || []);
  const sites = new Set(keys.sites || []);
  let feeClaimed = 0n, stakeClaimed = 0n, stakeFees = 0n;
  for (const s of spends) {
    if (!s.lock) continue;
    if (s.lock.refund_pk) qualifiers.add(low(s.lock.refund_pk));
    const msat = BigInt(s.lock.amount_msat);
    if (s.lock.payment_image && s.lock.payment_image.hash !== undefined) feeClaimed += msat;
    else { stakeClaimed += msat; if (payees.fees) stakeFees += lnv2FeeMsat(payees.fees, msat); }
  }
  const unread = [];
  let left = 0n, nodeRow = 0n, donated = 0n, qualifierPaid = false;
  for (const o of first.outputs || []) {
    const msat = BigInt(o.amount_msat || 0);
    if (o.kind !== 'outgoing') { left += msat; continue; }
    const refund = low(o.refund_pk), claim = low(o.claim_pk);
    if (agg && refund.slice(2) === agg) continue;
    if (claim !== refund) { left += msat; continue; }
    if (qualifiers.has(refund)) { qualifierPaid = true; continue; }
    if (sites.has(refund) || (reserve && reserve.has(refund))) continue;
    if ((donation && donation.has(refund)) || (game && game.has(refund))) { donated += msat; continue; }
    if (node && node.has(refund)) { nodeRow += msat; continue; }
    if (!allRead) { unread.push(`output ${o.out_idx} pays ${refund.slice(0, 18)}, which no payee read here names`); continue; }
    left += msat;
  }
  const spendable = stakeClaimed - stakeFees;
  const remainderNodes = qualifierPaid || spendable <= 0n ? 0n : (spendable * REMAINDER_NODES_PERCENT) / 100n;
  if (node !== null && nodeRow > feeClaimed + remainderNodes) left += nodeRow - feeClaimed - remainderNodes;
  if (payees.market) {
    const total = BigInt(payees.market.nodeBps) + BigInt(payees.market.donationBps);
    const cap = total > 0n ? ((feeClaimed + stakeClaimed) * BigInt(payees.market.donationBps)) / total : 0n;
    if (donated > cap) left += donated - cap;
  } else if (!qualifierPaid && remainderNodes > 0n && donated > spendable - remainderNodes) left += donated - (spendable - remainderNodes);
  return { msat: left, unread };
}
