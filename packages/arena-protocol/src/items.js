// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// IN-GAME ITEMS (2026-10-15: "ein Spiel kann ingame items haben zb ein neuer Trick. Der kostet X Satoshi, wobei 25% an
// die protocol devs gehen, 25% an den a game dev und 50% an die nodes die in den letzten 24h an einer Runde beteiligt waren"; rulings the
// same day: the nodes' half EQUAL per node; an item bound to the buyer's player key and the game across its versions, not transferable;
// payable through every federation; the nodes named by the merged signed FINALs of every seat - served-nodes.js).
//
// THE CATALOGUE is part of the signed manifest, after its own marker (0x07, behind a top split's shares, before the required version):
// each item an id (what a round's entry names), a name, a price in whole sat, and the hash of what it unlocks (the trick's core data
// or config - what the game's core is handed when an entry names the item). A price changes only with a new manifest version. Only
// under protocol version 10 or later (constants.js ITEMS_VERSION), so no node that cannot sell or check an item hosts the game.
//
// THE SPLIT (itemSplit): of the price in msat, 50 % in equal parts to the nodes that served a round in the 24 hours before the
// purchase (each floored), and the rest - the developers' half and what the node shares' floors leave - in two halves exactly as a
// round's donation is split over its two sets (donation.js splitTwoSets, ruled 2026-10-06): the protocol devs' half floored, the
// game dev's the rest. So 25 % / 25 % / 50 %, integer msat, the parts always adding up to the price exactly.
import { toHex } from './hash.js';
import { protocolVersionName } from './protocol-version.js';
import { ITEMS_VERSION } from './constants.js';

export const ITEMS_MARKER = 0x07;
export const ITEMS_MAX = 64;
export const ITEM_NAME_MAX = 48;
/** The highest price an item may name: 10 BTC in sat. */
export const ITEM_PRICE_MAX_SAT = 1000000000n;
const ITEM_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const itIs32 = (b) => b instanceof Uint8Array && b.length === 32;

/** Does a catalogue fit its manifest? { ok } or { ok: false, why }. Items sorted by id, each id once. */
export function itemsFit(items, m) {
  if (!Array.isArray(items) || items.length < 1 || items.length > ITEMS_MAX) return { ok: false, why: `an item catalogue names 1 to ${ITEMS_MAX} items` };
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it || typeof it !== 'object') return { ok: false, why: 'an item is an object' };
    if (typeof it.id !== 'string' || !ITEM_ID.test(it.id)) return { ok: false, why: `an item id is 1 to 32 of a-z, 0-9 and "-", starting with a letter or digit: ${JSON.stringify(it.id)}` };
    if (i > 0 && !(items[i - 1].id < it.id)) return { ok: false, why: `the catalogue is sorted by id, each id once: "${items[i - 1].id}" then "${it.id}"` };
    if (typeof it.name !== 'string' || it.name.trim().length < 1 || it.name.length > ITEM_NAME_MAX) return { ok: false, why: `item "${it.id}" names itself in 1 to ${ITEM_NAME_MAX} characters` };
    if (typeof it.priceSat !== 'bigint' || it.priceSat < 1n || it.priceSat > ITEM_PRICE_MAX_SAT) return { ok: false, why: `item "${it.id}" costs 1 to ${ITEM_PRICE_MAX_SAT} sat` };
    if (!itIs32(it.unlock)) return { ok: false, why: `item "${it.id}" names what it unlocks by a 32-byte hash` };
  }
  if (!(m && Number.isInteger(m.requiredProtocolVersion) && m.requiredProtocolVersion >= ITEMS_VERSION))
    return { ok: false, why: `a game with items requires protocol version ${protocolVersionName(ITEMS_VERSION)} or later (#349): no node that cannot sell or check one hosts it` };
  return { ok: true };
}

/** Writes the catalogue (marker, then the sorted items) into a manifest's Writer. */
export function writeItems(w, items) {
  w.u8(ITEMS_MARKER);
  w.vec(items, (it, ww) => { ww.str(it.id); ww.str(it.name); ww.u64(it.priceSat); ww.bytes32(it.unlock); }, { sortedBy: (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) });
}

/** Reads a catalogue after its marker (the caller took the marker). */
export function readItems(r) {
  return r.vec((rr) => ({ id: rr.str(), name: rr.str(), priceSat: rr.u64(), unlock: rr.bytes32() }));
}

/** The item of a catalogue by id, or null. */
export const itemOf = (m, id) => (m && Array.isArray(m.items) ? m.items.find((it) => it.id === id) || null : null);

/**
 * THE DEVELOPERS' SHARE IS THE BUYER'S CHOICE (2026-10-16 ~06:58Z: "50% of the fees go to protocol devs and game
 * devs (25/25) but are fully optional ... 50% 40% 30% 20% 10% 0% ... if the ingame donations are zero the price is 250 Sats instead of
 * 500 sats. Node fees are never optional."). A share is a percent of the item's list price, one of ITEM_DEV_SHARES; the nodes' half
 * is always paid. 50 is the list price itself, the split as it was.
 */
export const ITEM_DEV_SHARES = Object.freeze([50, 40, 30, 20, 10, 0]);
export const ITEM_DEV_SHARE_DEFAULT = 50;
export const itemDevShareOk = (pct) => ITEM_DEV_SHARES.includes(Number(pct));
/** What a buyer pays for an item of `priceSat` at a developers' share of `devsPct` %: the nodes' half and the share, in sat. */
export const itemPriceFor = (priceSat, devsPct = ITEM_DEV_SHARE_DEFAULT) => {
  if (!itemDevShareOk(devsPct)) throw new Error(`a developers' share is one of ${ITEM_DEV_SHARES.join(', ')} %`);
  const list = BigInt(priceSat);
  return list / 2n + (list * BigInt(devsPct)) / 100n;
};

/**
 * THE SPLIT OF ONE PURCHASE, in msat. `priceMsat` a BigInt (the list price); `nodes` the served nodes' keys (hex, any order; each
 * once - the served list's keys); `devsPct` the developers' share (ITEM_DEV_SHARES, default 50). Answers { protocolMsat, gameMsat,
 * devsMsat, nodesMsat, perNodeMsat, nodes: [{ key, msat }] sorted by key, sumMsat }, or throws on a price below 1 msat, a share
 * that is not one of ITEM_DEV_SHARES, or no served node (a purchase with nobody to pay half to is refused before any money moves).
 * At 50 % the developers take the list price less the node shares' floors, as always; at a lower share that part scaled by
 * devsPct / 50, floored.
 */
export function itemSplit({ priceMsat, nodes, devsPct = ITEM_DEV_SHARE_DEFAULT }) {
  const price = BigInt(priceMsat);
  if (price < 1n) throw new Error('an item costs at least 1 msat');
  if (!itemDevShareOk(devsPct)) throw new Error(`a developers' share is one of ${ITEM_DEV_SHARES.join(', ')} %`);
  const keys = [...new Set((nodes || []).map((k) => String(k).toLowerCase()))].sort();
  if (!keys.length) throw new Error('no node served a round in the window: an item\'s half for the nodes has nobody to go to');
  if (!keys.every((k) => /^[0-9a-f]{64}$/.test(k))) throw new Error('a served node is named by its 32-byte key in hex');
  const perNodeMsat = (price / 2n) / BigInt(keys.length);
  const nodesMsat = perNodeMsat * BigInt(keys.length);
  const devsMsat = ((price - nodesMsat) * BigInt(devsPct)) / 50n;   // the developers' half and the node shares' floors, at the share
  const protocolMsat = devsMsat / 2n;                          // as splitTwoSets: the protocol devs' half floored,
  const gameMsat = devsMsat - protocolMsat;                    // the game dev's the rest
  return { protocolMsat, gameMsat, devsMsat, nodesMsat, perNodeMsat, nodes: keys.map((key) => ({ key, msat: perNodeMsat })), sumMsat: protocolMsat + gameMsat + nodesMsat };
}

/** A short line for logs and pages: "trick-x (Double jump) 2,100 sat". */
export const itemLine = (it) => `${it.id} (${it.name}) ${String(it.priceSat).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} sat`;
export const itemsHex = (items) => (items || []).map((it) => ({ ...it, priceSat: String(it.priceSat), unlock: toHex(it.unlock) }));
