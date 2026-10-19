// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AN ITEM, BOUGHT (kanban #365 step 2): the buyer's signed record of one purchase, and the check any node makes of it.
//
// THE MONEY IS ONE FEDERATION TRANSACTION from the buyer's e-cash whose outputs are pre-expired payout contracts, each spendable only
// by its payee's key - the same outputs a round's donation pays its recipients in today (page-lock.js lockSubmit, role "donation").
// Its outputs are exactly the split (items.js itemSplit): the nodes' half equal per served node (each to refundKeyOf(node key)), the
// developers' half over the network's and the game's donation sets as a round's donation is split (donation.js splitTwoSets).
//
// THE RECORD names what was bought and how it was paid - the game (its developer key and name, so the item outlives versions), the
// item and its price, the buyer's key, the federation and the transaction, every output (index, payee key, msat), and the served list
// it paid (its window and root, served-nodes.js) - and the buyer signs it (BIP340, injected). `purchaseStands` rebuilds the outputs
// from the manifest, the two donation sets and the reader's own merged served list and compares them one by one; a record whose
// outputs pay anybody else, or anything else, does not stand. Whether the federation accepted the transaction is the federation's
// to say (the seats ask it, as for a stake lock) - this file only says what that transaction must be.
//
// OWNERSHIP is a standing record whose transaction the federation accepted: bound to the buyer's key and the game, not transferable
// (no record names a second owner), the same across the game's versions while the item's id stays in its catalogue.
import { Writer, Reader } from './encode.js';
import { taggedHash, toHex, fromHex } from './hash.js';
import { itemOf, itemSplit, itemDevShareOk, ITEM_DEV_SHARES, ITEM_DEV_SHARE_DEFAULT } from './items.js';
import { splitTwoSets } from './donation.js';
import { refundKeyOf } from './stake-lock.js';
import { ITEMS_VERSION, RESERVES_VERSION } from './constants.js';
import { itemSplitReserves, itemDevChoices, ITEM_DEV_SHARES_RESERVES, ITEM_DEV_SHARE_RESERVES_DEFAULT } from './reserves.js';
import { gameIdOf } from './manifest.js';
import { SERVED_WINDOW_MS } from './served-nodes.js';

export const TAG_ITEM_PURCHASE = 'ARENA/v1/ItemPurchase';
export const TYPE_ITEM_PURCHASE = 0x49;          // 'I'
export const PURCHASE_OUTPUTS_MAX = 255;
/**
 * A RECORD WITH THE BUYER'S DEVELOPERS' SHARE (kanban #377): written as version PURCHASE_SHARE_VERSION, the share (a u8 percent, one of
 * ITEM_DEV_SHARES) after the price. A purchase at the full 50 % is written as before (ITEMS_VERSION, no share byte) - the same bytes
 * and id a seat that has not rolled yet reads - and a version-10 record reads as 50 %.
 */
export const PURCHASE_SHARE_VERSION = 11;
/** How far before the purchase its served window may end: the buyer's client merges the seats' lists just before it pays. */
export const PURCHASE_WINDOW_SLACK_MS = 3600000;
/**
 * A RECORD ON THE RESERVES' TERMS (§27A.9.1, kanban #397 slice 5): the purchase of an item a game version requiring protocol 11 sells
 * pays nodes 40 %, the protocol reserves 20 % and the developers the buyer's 40/30/20/10/0 % (itemSplitReserves). Its record is
 * written as LAYOUT 12 - a record layout, not a protocol version - naming after the price the share (a u8, always written), the
 * game version's id it was bought under (32 bytes) and the reserve key it paid (33 bytes): the 5-of-7 key of the payment's federation.
 */
export const PURCHASE_RESERVES_LAYOUT = 12;
const pIs32 = (b) => b instanceof Uint8Array && b.length === 32;
const pIs33 = (b) => b instanceof Uint8Array && b.length === 33 && (b[0] === 2 || b[0] === 3);

/** The record's bytes, without the signature. Outputs sorted by index. */
export function encodePurchase(p) {
  if (!pIs32(p.gameDevPubkey) || !pIs32(p.playerPubkey) || !pIs32(p.federationId) || !pIs32(p.txid) || !pIs32(p.servedRoot))
    throw new Error('a purchase names the game\'s developer, the buyer, the federation, the transaction and the served root by 32 bytes each');
  if (!Array.isArray(p.outputs) || p.outputs.length < 1 || p.outputs.length > PURCHASE_OUTPUTS_MAX) throw new Error(`a purchase pays 1 to ${PURCHASE_OUTPUTS_MAX} outputs`);
  for (const o of p.outputs) if (!Number.isInteger(o.outIdx) || o.outIdx < 0 || !pIs33(o.pk) || typeof o.msat !== 'bigint' || o.msat < 1n)
    throw new Error('an output names its index, its payee\'s 33-byte key and its msat');
  const reserves = p.reserveKey !== undefined && p.reserveKey !== null;
  const share = p.devsPct === undefined || p.devsPct === null ? (reserves ? ITEM_DEV_SHARE_RESERVES_DEFAULT : ITEM_DEV_SHARE_DEFAULT) : Number(p.devsPct);
  if (reserves) {
    if (!Number.isInteger(share) || share < 0 || share > 100) throw new Error('on the reserves\' terms a developers\' share is a whole percent; which ones the fees in force allow, purchaseStands says');
    if (!pIs32(p.gameId) || !pIs33(p.reserveKey)) throw new Error('a purchase on the reserves\' terms names its game version by 32 bytes and the reserve key by 33');
  } else if (!itemDevShareOk(share)) throw new Error(`a purchase's developers' share is one of ${ITEM_DEV_SHARES.join(', ')} %`);
  const w = new Writer();
  w.u8(TYPE_ITEM_PURCHASE); w.u16(reserves ? PURCHASE_RESERVES_LAYOUT : share === ITEM_DEV_SHARE_DEFAULT ? ITEMS_VERSION : PURCHASE_SHARE_VERSION);
  w.bytes32(p.gameDevPubkey); w.str(p.gameName); w.str(p.itemId); w.u64(BigInt(p.priceSat));
  if (reserves) { w.u8(share); w.bytes32(p.gameId); w.bytes(p.reserveKey, 33); }
  else if (share !== ITEM_DEV_SHARE_DEFAULT) w.u8(share);
  w.bytes32(p.playerPubkey); w.bytes32(p.federationId); w.bytes32(p.txid);
  w.u64(BigInt(p.servedFromMs)); w.u64(BigInt(p.servedToMs)); w.bytes32(p.servedRoot);
  w.vec(p.outputs, (o, ww) => { ww.u32(o.outIdx); ww.bytes(o.pk, 33); ww.u64(o.msat); }, { sortedBy: (a, b) => a.outIdx - b.outIdx });
  w.u64(BigInt(p.boughtAtMs));
  return w.finish();
}

export function decodePurchase(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== TYPE_ITEM_PURCHASE) throw new Error('not an item purchase');
  const version = r.u16();
  if (version !== ITEMS_VERSION && version !== PURCHASE_SHARE_VERSION && version !== PURCHASE_RESERVES_LAYOUT) throw new Error(`an item purchase of version ${version}`);
  const head = { gameDevPubkey: r.bytes32(), gameName: r.str(), itemId: r.str(), priceSat: r.u64() };
  const devsPct = version === ITEMS_VERSION ? ITEM_DEV_SHARE_DEFAULT : r.u8();
  if (version === PURCHASE_SHARE_VERSION && (devsPct === ITEM_DEV_SHARE_DEFAULT || !itemDevShareOk(devsPct)))
    throw new Error(`a version-${PURCHASE_SHARE_VERSION} purchase names a developers' share below ${ITEM_DEV_SHARE_DEFAULT} %, one of ${ITEM_DEV_SHARES.join(', ')}`);
  const terms = {};
  if (version === PURCHASE_RESERVES_LAYOUT) {
    if (!Number.isInteger(devsPct) || devsPct < 0 || devsPct > 100) throw new Error('on the reserves\' terms a developers\' share is a whole percent');
    terms.gameId = r.bytes32(); terms.reserveKey = r.bytes(33);
    if (!pIs33(terms.reserveKey)) throw new Error('a reserve key is a 33-byte compressed key');
  }
  const p = { ...head, devsPct, ...terms, playerPubkey: r.bytes32(), federationId: r.bytes32(),
    txid: r.bytes32(), servedFromMs: r.u64(), servedToMs: r.u64(), servedRoot: r.bytes32(),
    outputs: r.vec((rr) => ({ outIdx: rr.u32(), pk: rr.bytes(33), msat: rr.u64() })), boughtAtMs: r.u64() };
  r.end();
  return p;
}

/** What the buyer signs, and the purchase's id. */
export const purchaseId = (p) => taggedHash(TAG_ITEM_PURCHASE, encodePurchase(p));

/**
 * THE OUTPUTS A PURCHASE MUST PAY: [{ pk (33 bytes), msat }] sorted by key, one per payee (a key paid as a node and as a developer
 * is paid once, the sum), none of 0 msat. `servedKeys` the served nodes' keys in hex; `networkSet` / `gameSet` the two donation
 * sets' recipients (they must pay keys).
 */
export function purchaseOutputs({ priceSat, servedKeys, networkSet, gameSet, devsPct = ITEM_DEV_SHARE_DEFAULT }) {
  const split = itemSplit({ priceMsat: BigInt(priceSat) * 1000n, nodes: servedKeys, devsPct });
  const devs = splitTwoSets({ donationMsat: split.devsMsat, networkSet, gameSet });
  if (!devs.owed) throw new Error(`the developers' half cannot be paid: ${devs.why}`);
  const by = new Map();
  const add = (pk, msat) => { if (msat <= 0n) return; const k = toHex(pk); by.set(k, { pk, msat: (by.get(k) ? by.get(k).msat : 0n) + msat }); };
  for (const n of split.nodes) add(refundKeyOf(fromHex(n.key)), n.msat);
  for (const s of devs.shares) {
    if (!(s.recipientPk instanceof Uint8Array)) throw new Error('an item is paid in the federation: both donation sets must pay keys, not LNURLs');
    add(s.recipientPk, s.amountMsat);
  }
  return { outputs: [...by.values()].sort((a, b) => (toHex(a.pk) < toHex(b.pk) ? -1 : 1)), split, devs };
}

/**
 * THE OUTPUTS A PURCHASE ON THE RESERVES' TERMS MUST PAY (§27A.9.1, kanban #397 slice 5): nodes 40 % of the list price, equal per
 * served node (each floored; what the floors leave is not paid); the protocol reserves exactly 20 %, ONE output to `reserveKey`;
 * the developers the buyer's share over the two donation sets as a round's donation is split. [{ pk, msat }] sorted by key, with
 * `reserve` { pk, msat } named apart. A reserve key that is also another payee's key is refused: the reserves' output stands alone.
 */
export function purchaseOutputsReserves({ priceSat, servedKeys, networkSet, gameSet, devsPct = ITEM_DEV_SHARE_RESERVES_DEFAULT, reserveKey, fees = null }) {
  if (!pIs33(reserveKey)) throw new Error('no reserve key to pay the reserves\' 20 % to');
  const split = itemSplitReserves({ listMsat: BigInt(priceSat) * 1000n, devsPct: Number(devsPct), fees });
  const keys = [...new Set((servedKeys || []).map((k) => String(k).toLowerCase()))].sort();
  if (!keys.length) throw new Error('no node served a round in the window: an item\'s 40 % for the nodes has nobody to go to');
  if (!keys.every((k) => /^[0-9a-f]{64}$/.test(k))) throw new Error('a served node is named by its 32-byte key in hex');
  const perNodeMsat = split.nodesMsat / BigInt(keys.length);
  const devs = splitTwoSets({ donationMsat: split.protocolDevsMsat + split.gameDevsMsat, networkSet, gameSet });
  if (!devs.owed) throw new Error(`the developers' share cannot be paid: ${devs.why}`);
  const by = new Map();
  const add = (pk, msat) => { if (msat <= 0n) return; const k = toHex(pk); by.set(k, { pk, msat: (by.get(k) ? by.get(k).msat : 0n) + msat }); };
  for (const k of keys) add(refundKeyOf(fromHex(k)), perNodeMsat);
  for (const s of devs.shares) {
    if (!(s.recipientPk instanceof Uint8Array)) throw new Error('an item is paid in the federation: both donation sets must pay keys, not LNURLs');
    add(s.recipientPk, s.amountMsat);
  }
  if (by.has(toHex(reserveKey))) throw new Error('the reserve key is also another payee\'s key: the reserves\' output must stand alone');
  add(reserveKey, split.reservesMsat);
  return { outputs: [...by.values()].sort((a, b) => (toHex(a.pk) < toHex(b.pk) ? -1 : 1)), split: { ...split, perNodeMsat, nodes: keys },
    devs, reserve: { pk: reserveKey, msat: split.reservesMsat } };
}

/**
 * DOES A PURCHASE STAND? `p` the record with `signature`; `manifest` the game's (any version naming the item); `networkSet` /
 * `gameSet` the donation sets; `served` the reader's own merged list for the record's window ({ fromMs, toMs, nodes, root });
 * `verify(sig, digest, key)` BIP340. Answers { ok, id } or { ok: false, why }.
 */
// `fees`: the fee set in force (kanban #462): the item parts on the reserves' terms; unset, today's
export function purchaseStands(p, { manifest, networkSet, gameSet, served, verify, reserveKey = null, fees = null }) {
  const no = (why) => ({ ok: false, why });
  let id; try { id = purchaseId(p); } catch (e) { return no(`that purchase does not encode: ${e.message}`); }
  if (!manifest || toHex(manifest.gameDevPubkey) !== toHex(p.gameDevPubkey) || manifest.gameName !== p.gameName)
    return no(`the purchase is of game "${p.gameName}" by ${toHex(p.gameDevPubkey).slice(0, 16)}, not of the manifest given`);
  const item = itemOf(manifest, p.itemId);
  if (!item) return no(`"${p.gameName}" sells no item "${p.itemId}"`);
  if (BigInt(p.priceSat) !== item.priceSat) return no(`item "${p.itemId}" costs ${item.priceSat} sat, and the purchase paid ${p.priceSat}`);
  if (BigInt(p.servedToMs) - BigInt(p.servedFromMs) !== BigInt(SERVED_WINDOW_MS)) return no('the served window is 24 hours');
  if (BigInt(p.servedToMs) > BigInt(p.boughtAtMs) || BigInt(p.boughtAtMs) - BigInt(p.servedToMs) > BigInt(PURCHASE_WINDOW_SLACK_MS))
    return no('the served window ends at most an hour before the purchase, and not after it');
  if (!served || BigInt(served.fromMs) !== BigInt(p.servedFromMs) || BigInt(served.toMs) !== BigInt(p.servedToMs) || served.root !== toHex(p.servedRoot))
    return no(`the purchase paid the served list ${toHex(p.servedRoot).slice(0, 16)}, and the one read here is ${served && served.root ? served.root.slice(0, 16) : 'none'}`);
  // WHICH TERMS (kanban #397 slice 5): a game version requiring protocol 11 sells on the reserves' terms only, and a record on
  // them names that very version and the reserve key of its federation that the reader holds; an older version, the old terms
  const reservesTerms = Number(manifest.requiredProtocolVersion) >= RESERVES_VERSION;
  const onReserves = p.reserveKey !== undefined && p.reserveKey !== null;
  if (reservesTerms !== onReserves)
    return no(reservesTerms ? `version ${manifest.version} of "${p.gameName}" requires protocol ${manifest.requiredProtocolVersion}: its items pay the protocol reserves, and this record does not`
      : `this record pays the protocol reserves, and version ${manifest.version} of "${p.gameName}" does not sell on those terms`);
  let want;
  if (onReserves) {
    let mid = null; try { mid = toHex(gameIdOf(manifest)); } catch { mid = null; }
    if (!pIs32(p.gameId) || mid !== toHex(p.gameId)) return no('the record names another version of the game than the manifest given');
    if (!pIs33(reserveKey)) return no(`no reserve key is known here for federation ${toHex(p.federationId).slice(0, 16)}`);
    if (toHex(reserveKey) !== toHex(p.reserveKey)) return no(`the record paid reserve key ${toHex(p.reserveKey).slice(0, 16)}, and federation ${toHex(p.federationId).slice(0, 16)}'s is ${toHex(reserveKey).slice(0, 16)}`);
    if (!itemDevChoices(fees).includes(Number(p.devsPct))) return no(`on the reserves' terms a developers' share is one of ${itemDevChoices(fees).join(', ')} %`);
    try { want = purchaseOutputsReserves({ priceSat: p.priceSat, servedKeys: served.nodes.map((n) => n.key), networkSet, gameSet, devsPct: Number(p.devsPct), reserveKey, fees }).outputs; }
    catch (e) { return no(e.message); }
  } else {
    // THE BUYER'S SHARE (kanban #377): one of ITEM_DEV_SHARES, the nodes' half whatever it is
    const devsPct = p.devsPct === undefined || p.devsPct === null ? ITEM_DEV_SHARE_DEFAULT : Number(p.devsPct);
    if (!itemDevShareOk(devsPct)) return no(`a developers' share is one of ${ITEM_DEV_SHARES.join(', ')} %, and the purchase names ${p.devsPct}`);
    try { want = purchaseOutputs({ priceSat: p.priceSat, servedKeys: served.nodes.map((n) => n.key), networkSet, gameSet, devsPct }).outputs; }
    catch (e) { return no(e.message); }
  }
  const got = [...p.outputs].map((o) => ({ pk: toHex(o.pk), msat: o.msat })).sort((a, b) => (a.pk < b.pk ? -1 : 1));
  const line = (o) => `${typeof o.pk === 'string' ? o.pk : toHex(o.pk)}:${o.msat}`;
  if (got.length !== want.length || got.some((o, i) => line(o) !== line(want[i])))
    return no(`its outputs are not the split: it pays ${got.length} output(s), the split ${want.length}`);
  let good = false;
  try { good = verify(p.signature, id, p.playerPubkey) === true; } catch { good = false; }
  if (!good) return no('the buyer\'s signature does not verify');
  return { ok: true, id };
}
