// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE PROTOCOL RESERVES' SPLIT (§27A.9.12026-10-16: "4% developer fees (game, protocol), 4% node
// fees, 2% protocol reserves. For ingame items 40% developer donations (game,protocol), 40% node, 20% protocol reserves"; the
// locks: the round split is mandatory; an item's developers' share is the player's choice of "40 30 20 10 0").
//
// Pure arithmetic, nothing paid yet: no live version speaks RESERVES_VERSION (it is not in SUPPORTED_PROTOCOL_VERSIONS), and
// today's versions keep §0A.8's lowerable 5 % donation and 's 50-0 % item share (donation.js, items.js, untouched).
//
// THE REMAINDER RULE (§27A.9.1): every share is floored to the msat; a round's net stake takes what the floors leave, so the
// parts always sum to the gross. An item's price is the sum of its parts.
import { RESERVES_VERSION, GIFTS_IN_FEE_LOCK_VERSION } from './constants.js';
import { donationOutputsExpected } from './donation.js';
import { entryFeeBpsOf, donationInFee } from './fee.js';

/** A paid round's shares on the reserves version, in basis points of the gross stake - all mandatory. */
export const ROUND_SPLIT_BPS = Object.freeze({ nodes: 400, protocolDevs: 200, gameDevs: 200, reserves: 200 });
/** An item's mandatory shares, in percent of its list price; the developers' share is added on top, as in. */
export const ITEM_NODES_PCT = 40;
export const ITEM_RESERVES_PCT = 20;
/** The developers' share a player may choose for an item on the reserves version (it replaces 's 50-0 %). */
export const ITEM_DEV_SHARES_RESERVES = Object.freeze([40, 30, 20, 10, 0]);
export const ITEM_DEV_SHARE_RESERVES_DEFAULT = 40;

const bps = (gross, b) => (gross * BigInt(b)) / 10000n;

/**
 * A PAID ROUND'S MONEY ON THE RESERVES VERSION: { nodesMsat, protocolDevsMsat, gameDevsMsat, reservesMsat, netMsat }.
 * There is no developers' share to choose: `devsBps`, if given, must be the mandatory 400, or the split is refused by name.
 */
// `split`: the fees in force (fee-proposal.js roundSplitBps), else today's ROUND_SPLIT_BPS
export function roundSplit(grossMsat, { split = ROUND_SPLIT_BPS, devsBps = split.protocolDevs + split.gameDevs } = {}) {
  const gross = BigInt(grossMsat);
  if (gross < 1n) throw new Error('a paid round has a stake of at least 1 msat');
  if (Number(devsBps) !== split.protocolDevs + split.gameDevs)
    throw new Error(`on protocol version ${RESERVES_VERSION} the developers' ${(split.protocolDevs + split.gameDevs) / 100} % is mandatory: it is no donation a player can change`);
  const nodesMsat = bps(gross, split.nodes);
  const protocolDevsMsat = bps(gross, split.protocolDevs);
  const gameDevsMsat = bps(gross, split.gameDevs);
  const reservesMsat = bps(gross, split.reserves);
  const netMsat = gross - nodesMsat - protocolDevsMsat - gameDevsMsat - reservesMsat;
  return { nodesMsat, protocolDevsMsat, gameDevsMsat, reservesMsat, netMsat };
}

/**
 * AN ITEM ON THE RESERVES VERSION: its list price in msat and the developers' share the player chose (40, 30, 20, 10 or 0 %).
 * Answers { priceMsat, nodesMsat, reservesMsat, protocolDevsMsat, gameDevsMsat }: nodes 40 % and reserves 20 % of the list
 * price, the developers' share half protocol (floored), half game (the rest), and the price their sum - 60 % + the share.
 */
/**
 * THE DEVELOPERS' SHARES A BUYER MAY CHOOSE under a fee set: its devs' part, then today's lower steps below it. With
 * today's fees, 40 30 20 10 0 as before.
 */
export const itemDevChoices = (fees = null) => { const top = fees ? fees.itemDevsPct : ITEM_DEV_SHARE_RESERVES_DEFAULT;
  return [...new Set([top, ...ITEM_DEV_SHARES_RESERVES.filter((x) => x < top)])]; };
// `fees`: the fee set in force (fee-proposal.js): its item nodes', reserves' and developers' parts; unset, today's
export function itemSplitReserves({ listMsat, devsPct = ITEM_DEV_SHARE_RESERVES_DEFAULT, fees = null }) {
  const list = BigInt(listMsat);
  if (list < 1n) throw new Error('an item costs at least 1 msat');
  const choices = itemDevChoices(fees);
  if (!choices.includes(Number(devsPct)))
    throw new Error(`on protocol version ${RESERVES_VERSION} an item's developers' share is one of ${choices.join(', ')} %, not ${devsPct} %`);
  const nodesMsat = (list * BigInt(fees ? fees.itemNodesPct : ITEM_NODES_PCT)) / 100n;
  const reservesMsat = (list * BigInt(fees ? fees.itemReservesPct : ITEM_RESERVES_PCT)) / 100n;
  const devs = (list * BigInt(devsPct)) / 100n;
  const protocolDevsMsat = devs / 2n;
  const gameDevsMsat = devs - protocolDevsMsat;
  return { priceMsat: nodesMsat + reservesMsat + devs, nodesMsat, reservesMsat, protocolDevsMsat, gameDevsMsat };
}

/**
 * THE RESERVE OUTPUT AN ENTRY OR A PURCHASE MUST CARRY (§27A.9.2): one output in its own federation, held there by the
 * federation's guardians. `kind` 'entry' (gross stake) or 'item' (list price and the chosen share). Answers
 * [{ federationId, amountMsat, to: 'reserves' }] - empty only for a free round, which pays nothing at all.
 */
export function reserveOutputsExpected({ kind, federationId, grossMsat, listMsat, devsPct, free = false, split = ROUND_SPLIT_BPS, fees = null }) {
  if (!(federationId instanceof Uint8Array) || federationId.length !== 32) throw new Error('a reserve output is paid in a 32-byte federation');
  if (kind === 'entry') {
    if (free) return [];
    return [{ federationId, amountMsat: roundSplit(grossMsat, { split }).reservesMsat, to: 'reserves' }];
  }
  if (kind === 'item') return [{ federationId, amountMsat: itemSplitReserves({ listMsat, devsPct, fees }).reservesMsat, to: 'reserves' }];
  throw new Error('a reserve output is paid by an entry or an item');
}

/**
 * DOES THIS ROUND PAY THE RESERVES (§27A.9): a paid round of protocol version 11 or later. Its node fee is then the
 * mandatory 4 % (400 bps) and its developers' donation the mandatory 4 %; before it, §0A.8's 5 % fee and lowerable 5 % donation.
 * A market keeps the fee its terms name (§0A.7a) - the reserves on markets are a later slice.
 */
export const paysReserves = (contract) => !!contract && Number(contract.protocolVersion) >= RESERVES_VERSION && !(contract.stakeMsat === 0n);
export const RESERVES_NODE_FEE_BPS = ROUND_SPLIT_BPS.nodes;
export const RESERVES_DONATION_BPS = ROUND_SPLIT_BPS.protocolDevs + ROUND_SPLIT_BPS.gameDevs;

/**
 * WHAT A VERSION-11 ENTRY MUST PAY AND NAME (§27A.9.2), from its gross stake: the fee lock the nodes' 4 %;
 * its `donationMsat` the developers' 4 % AND the reserves' 2 % (both leave the wallet beside the stake, so the pool's net is the
 * same 90 % `netStakeMsat` takes); its donation outputs the developers' part split over the round's sets as any donation is
 * (donationOutputsExpected); and its `reserveOutpoint` the reserves' part, a payout contract to the federation's reserve key.
 * Answers { ok, fee, outputs, reserve: { outpoint, recipientPk, amountMsat } } or why not, by name.
 */
// `split`: the round's split in force at its census height (fee-proposal.js roundSplitBps); unset, today's
export function reservesEntryExpected({ entry, recipients, reserveKey, split = ROUND_SPLIT_BPS }) {
  if (!entry || typeof entry.stakeMsat !== 'bigint') return { ok: false, why: 'that entry names no stake' };
  if (!(reserveKey instanceof Uint8Array) || reserveKey.length !== 33) return { ok: false, why: 'no reserve key is known for that round\'s federation' };
  const parts = roundSplit(entry.stakeMsat, { split });
  const devs = parts.protocolDevsMsat + parts.gameDevsMsat;
  if (entry.feeMsat !== parts.nodesMsat) return { ok: false, why: `on protocol version ${RESERVES_VERSION} the node fee is ${parts.nodesMsat} msat (${split.nodes / 100} %), not ${entry.feeMsat}` };
  if (entry.donationMsat !== devs + parts.reservesMsat)
    return { ok: false, why: `on protocol version ${RESERVES_VERSION} the developers' ${(split.protocolDevs + split.gameDevs) / 100} % and the reserves' ${split.reserves / 100} % are ${devs + parts.reservesMsat} msat, not ${entry.donationMsat}` };
  if (!entry.reserveOutpoint) return { ok: false, why: `on protocol version ${RESERVES_VERSION} an entry names its reserve lock` };
  const dev = donationOutputsExpected({ ...entry, donationMsat: devs }, recipients);
  if (!dev.ok) return dev;
  return { ok: true, fee: parts.nodesMsat, outputs: dev.outputs,
    reserve: { outpoint: entry.reserveOutpoint, recipientPk: reserveKey, amountMsat: parts.reservesMsat },
    why: `${dev.outputs.length} developer output(s) of ${devs} msat and ${parts.reservesMsat} msat to the reserves` };
}

/**
 * THE DEVELOPERS' AND THE RESERVES' PARTS IN THE FEE LOCK (protocol 27, kanban #1486, ruled 2026-11-11: "Er sollte keine fees entgegen
 * nehmen wenn die order nicht angenommen wird"): a paid round of version 27 or later takes the whole 10 % in the entry's fee lock - nodes,
 * developers and reserves - and no donation or reserve output, so a refused, void or refunded entry gets all of it back with its stake,
 * and only a counted entry pays it, at settlement (lock-settlement.js feeSettlement `gifts`). A market already does (donationInFee).
 */
export const giftsInFeeLock = (contract) => paysReserves(contract) && Number(contract.protocolVersion) >= GIFTS_IN_FEE_LOCK_VERSION;
/** The whole rate a protocol-27 game entry's fee lock holds, in bps of its stake: nodes + developers + reserves (10 % today). */
export const giftsFeeBps = (split = ROUND_SPLIT_BPS) => split.nodes + split.protocolDevs + split.gameDevs + split.reserves;
/** Does this round's entry carry the developers' and the reserves' parts in its fee lock - a version-27 round of a game? */
export const entryGiftsInFee = (contract, manifest) => giftsInFeeLock(contract) && !donationInFee(manifest);

/**
 * WHAT A VERSION-27 GAME ENTRY MUST NAME (kanban #1486): a fee of the whole rate of its stake (giftsFeeBps, floored once - the
 * rate every fee is, entryFeeMsat), a donation of 0 and no donation or reserve outpoint. Of that fee the nodes' part is their rate
 * (floored) and the reserves' theirs (floored, roundSplit), and the developers' the rest - so the three are the fee to the msat.
 * Answers { ok, fee, nodesMsat, devsMsat, reservesMsat } or why not, by name.
 */
export function giftsEntryExpected({ entry, split = ROUND_SPLIT_BPS }) {
  if (!entry || typeof entry.stakeMsat !== 'bigint' || typeof entry.feeMsat !== 'bigint') return { ok: false, why: 'that entry names no stake and fee' };
  if (entry.stakeMsat < 1n) return { ok: false, why: 'a paid entry stakes at least 1 msat' };
  const parts = roundSplit(entry.stakeMsat, { split });
  const fee = bps(entry.stakeMsat, giftsFeeBps(split));
  const devsMsat = fee - parts.nodesMsat - parts.reservesMsat;
  const v = GIFTS_IN_FEE_LOCK_VERSION;
  if (entry.donationMsat !== 0n)
    return { ok: false, why: `on protocol version ${v} the developers' and the reserves' parts are in the fee lock: that entry names a donation of ${entry.donationMsat} msat beside it` };
  if ((entry.donationOutpoints || []).length || (entry.reserveOutpoint !== undefined && entry.reserveOutpoint !== null))
    return { ok: false, why: `on protocol version ${v} an entry pays no donation or reserve output at its lock: they are in its fee lock, paid only if it is counted` };
  if (entry.feeMsat !== fee)
    return { ok: false, why: `on protocol version ${v} the fee lock holds the nodes' ${split.nodes / 100} %, the developers' ${(split.protocolDevs + split.gameDevs) / 100} % and the reserves' ${split.reserves / 100} %: ${fee} msat, not ${entry.feeMsat}` };
  return { ok: true, fee, nodesMsat: parts.nodesMsat, devsMsat, reservesMsat: parts.reservesMsat };
}

/**
 * THE ENTRY FEE RATE OF A ROUND (§27A.9.1): a version-11 round of a game takes the nodes' mandatory 4 %, and from version 27 the whole 10 %
 * its fee lock holds (giftsFeeBps); a market, and every older round, the rate its manifest gives (entryFeeBpsOf: the network's 5 %, or a
 * market's own).
 */
// `split`: the round's split in force at its census height (fee-proposal.js roundSplitBps of GET /fees?height=) - read by a protocol-27
// round only, so the door, the gates and the settlement size its fee lock alike (kanban #1486); a round below 27 is as before
export const entryFeeBpsForRound = (contract, manifest, split = undefined) => (entryGiftsInFee(contract, manifest) ? giftsFeeBps(split || ROUND_SPLIT_BPS)
  : paysReserves(contract) && !donationInFee(manifest) ? RESERVES_NODE_FEE_BPS : entryFeeBpsOf(manifest));
/** Does this round's entry pay the reserves BY AN OUTPUT AT ITS LOCK - a version-11 to 26 round of a game (from 27 they ride in the fee lock)? */
export const entryPaysReserves = (contract, manifest) => paysReserves(contract) && !donationInFee(manifest) && !giftsInFeeLock(contract);
