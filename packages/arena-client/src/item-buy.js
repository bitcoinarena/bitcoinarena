// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AN IN-GAME ITEM, BOUGHT FROM THE PAGE ('s larger truck the first): the player's wallet pays the item's split
// in one federation transaction, the player signs the record, and the seats keep it as the player's for good.
//
//   1. WHO SERVED: every seat's signed FINALs of the 24 h before now (GET /served?finals=1), merged by round and each FINAL checked
//      here (served-nodes.js) - the same list every seat rebuilds when it checks the purchase.
//   2. THE SPLIT: purchaseOutputs over the item's price, those nodes and the two donation sets (purchase.js).
//   3. THE PAYMENT: the lock client's paySubmit (one transaction of pre-expired payout contracts, the buyer's key as their image),
//      its acceptance read back output by output (lockAccepted).
//   4. THE RECORD: the game, the item, the price, the buyer, the federation, the transaction, every output and the served list,
//      signed with the player's key, handed to a seat (POST /item-purchase), which hands it on to every other.
// No float touches an amount; every step that fails says which, and nothing is paid before the list and the split stand.
import { servedNodes, mergeServedRounds, SERVED_WINDOW_MS } from '../../arena-protocol/src/served-nodes.js';
import { purchaseOutputs, purchaseOutputsReserves, purchaseId, encodePurchase } from '../../arena-protocol/src/purchase.js';
import { itemOf, itemPriceFor, ITEM_DEV_SHARES, ITEM_DEV_SHARE_DEFAULT } from '../../arena-protocol/src/items.js';
import { itemSplitReserves, ITEM_DEV_SHARES_RESERVES, ITEM_DEV_SHARE_RESERVES_DEFAULT } from '../../arena-protocol/src/reserves.js';
import { gameIdOf } from '../../arena-protocol/src/manifest.js';
import { fetchReserveKey } from './reserves-page.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { itemsSecretFor } from '../../arena-protocol/src/player-key.js';
import { entryItemDigest } from '../../arena-protocol/src/contracts.js';
import { ITEMS_VERSION, RESERVES_VERSION } from '../../arena-protocol/src/constants.js';

/**
 * THE TERMS A GAME VERSION SELLS ITS ITEMS ON: a version requiring protocol 11 the reserves' - nodes 40 %, the
 * protocol reserves 20 %, the developers 40/30/20/10/0 % added on top; an older one 's - nodes 50 %, the developers 50 .. 0 %.
 */
export function itemTermsOf(manifest) {
  return Number(manifest && manifest.requiredProtocolVersion) >= RESERVES_VERSION
    ? { reserves: true, shares: [...ITEM_DEV_SHARES_RESERVES], defaultShare: ITEM_DEV_SHARE_RESERVES_DEFAULT, nodesPct: 40, reservesPct: 20 }
    : { reserves: false, shares: [...ITEM_DEV_SHARES], defaultShare: ITEM_DEV_SHARE_DEFAULT, nodesPct: 50, reservesPct: 0 };
}
/** The buyer's kept share on these terms: as kept when they offer it, else their highest (a kept 50 % is 40 % on the reserves'). */
export function itemShareOn(manifest, kept) {
  const t = itemTermsOf(manifest); const v = Number(kept);
  if (t.shares.includes(v)) return v;
  return Number.isFinite(v) && v > Math.max(...t.shares) ? Math.max(...t.shares) : t.defaultShare;
}
/** What the buyer pays for an item of `priceSat` at `devsPct` on the version's terms, in sat (a BigInt). */
export function itemPriceOn(manifest, priceSat, devsPct) {
  const t = itemTermsOf(manifest);
  return t.reserves ? itemSplitReserves({ listMsat: BigInt(priceSat) * 1000n, devsPct: Number(devsPct) }).priceMsat / 1000n : itemPriceFor(BigInt(priceSat), Number(devsPct));
}

/** The served list of the 24 h before `toMs`, from every seat that answers. Answers { ok, served, seats } or { ok: false, why }. */
export async function servedFromSeats({ seats, toMs, fetch, verify, timeoutMs = 15000 }) {
  const fromMs = BigInt(toMs) - BigInt(SERVED_WINDOW_MS);
  const held = [];
  await Promise.all((seats || []).map(async (s) => {
    try {
      const r = await fetch(`${String(s).replace(/\/$/, '')}/served?to=${toMs}&finals=1`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) return;
      const a = await r.json();
      held.push((a.held || []).map((x) => ({ roundId: fromHex(x.roundId), committee: x.committee.map(fromHex), finals: x.finals.map(fromHex) })));
    } catch { /* a seat that does not answer adds nothing */ }
  }));
  if (!held.length) return { ok: false, why: 'no seat answered who served a round in the last 24 hours' };
  const served = servedNodes({ rounds: mergeServedRounds(held).rounds, fromMs, toMs: BigInt(toMs), verify });
  if (!served.nodes.length) return { ok: false, why: 'no node served a round in the last 24 hours: the nodes\' half has nobody to go to' };
  return { ok: true, served, seats: held.length };
}

/**
 * BUY ONE ITEM. `manifest` the game's (it sells `itemId`); `networkSet` / `gameSet` the donation sets (paying keys); `wallet` the
 * player's lock client in the federation `federationId` (hex); `player` { pubkey (32 bytes), sign(digest) -> 64-byte BIP340 };
 * `seats` the game's seats; `verify` BIP340; `devsPct` the developers' share the buyer chose (one of ITEM_DEV_SHARES, default
 * 50 - the nodes' half is paid whatever it is). Answers { ok, purchaseId, txid, priceSat, paidSat, devsPct, outputs, keptBy } or { ok: false, step, why }.
 */
export async function buyItem({ manifest, itemId, networkSet, gameSet, wallet, federationId, player, seats, fetch, verify, nowMs = () => Date.now(), devsPct = null, reserveNeeded = 5 }) {
  const no = (step, why) => ({ ok: false, step, why });
  const item = itemOf(manifest, itemId);
  if (!item) return no('item', `"${manifest && manifest.gameName}" sells no item "${itemId}"`);
  const terms = itemTermsOf(manifest);
  if (devsPct === null || devsPct === undefined) devsPct = terms.defaultShare;
  if (!terms.shares.includes(Number(devsPct))) return no('share', `a developers' share is one of ${terms.shares.join(', ')} %`);
  // THE RESERVES' KEY FIRST: on the reserves' terms nothing is paid before five of the game's nodes name the
  // same reserve key for the federation the wallet pays from
  let reserveKey = null;
  if (terms.reserves) {
    const rk = await fetchReserveKey({ federationId: fromHex(federationId), nodes: seats, needed: reserveNeeded, fetcher: fetch });
    if (!rk.ok) return no('reserves', rk.why);
    reserveKey = rk.key;
  }
  const toMs = BigInt(nowMs() - 60000);                     // a minute back: the newest FINALs have reached every seat
  const got = await servedFromSeats({ seats, toMs, fetch, verify });
  if (!got.ok) return no('served', got.why);
  let built;
  try {
    built = terms.reserves
      ? purchaseOutputsReserves({ priceSat: item.priceSat, servedKeys: got.served.nodes.map((n) => n.key), networkSet, gameSet, devsPct: Number(devsPct), reserveKey })
      : purchaseOutputs({ priceSat: item.priceSat, servedKeys: got.served.nodes.map((n) => n.key), networkSet, gameSet, devsPct: Number(devsPct) });
  } catch (e) { return no('split', e.message); }
  let submitted, accepted;
  try {
    submitted = JSON.parse(await wallet.paySubmit(JSON.stringify(built.outputs.map((o) => ({ pk: toHex(o.pk), msat: String(o.msat), image: toHex(player.pubkey) })))));
    accepted = JSON.parse(await wallet.lockAccepted(JSON.stringify(submitted)));
  } catch (e) { return no('payment', String(e && e.message || e)); }
  const outs = accepted.donations || [];
  if (outs.length !== built.outputs.length || !outs.every((d) => d.ids_match)) return no('payment', 'the federation does not hold the outputs as they were built');
  const record = { gameDevPubkey: manifest.gameDevPubkey, gameName: manifest.gameName, itemId, priceSat: item.priceSat, devsPct: Number(devsPct), playerPubkey: player.pubkey,
    federationId: fromHex(federationId), txid: fromHex(submitted.txid), servedFromMs: got.served.fromMs, servedToMs: got.served.toMs, servedRoot: fromHex(got.served.root),
    outputs: outs.map((d) => ({ outIdx: Number(d.out_idx), pk: fromHex(d.recipient_pk), msat: BigInt(d.amount_msat) })), boughtAtMs: BigInt(nowMs()),
    ...(terms.reserves ? { gameId: gameIdOf(manifest), reserveKey } : {}) };
  const signature = player.sign(purchaseId(record));
  const body = JSON.stringify({ purchase: toHex(encodePurchase(record)), signature: toHex(signature) });
  // HANDED TO THE FIRST SEAT THAT KEEPS IT: it checks the record and the federation, then hands it on to every other seat
  let keptBy = null, last = 'no seat to hand it to';
  for (const s of seats || []) {
    try {
      const r = await fetch(`${String(s).replace(/\/$/, '')}/item-purchase`, { method: 'POST', body, signal: AbortSignal.timeout(60000) });
      if (r.ok) { keptBy = s; break; }
      last = `${s}: ${r.status} ${(await r.text()).trim().slice(0, 200)}`;
    } catch (e) { last = `${s}: ${e.message}`; }
  }
  if (!keptBy) return { ok: false, step: 'record', why: `paid (transaction ${submitted.txid}), but no seat kept the record yet: ${last}`, purchaseId: toHex(purchaseId(record)), txid: submitted.txid,
    retry: body };
  return { ok: true, purchaseId: toHex(purchaseId(record)), txid: submitted.txid, priceSat: item.priceSat, paidSat: itemPriceOn(manifest, item.priceSat, devsPct),
    devsPct: Number(devsPct), outputs: outs.length, keptBy, ...(terms.reserves ? { reserveKey: toHex(reserveKey), reserveMsat: built.reserve.msat } : {}) };
}

/** THE ITEMS A PLAYER OWNS, from the first seat that answers (GET /items): [{ id, gameName, itemId, ... }]. */
export async function ownedItems({ seats, player, gameName = null, fetch }) {
  for (const s of seats || []) {
    try {
      const r = await fetch(`${String(s).replace(/\/$/, '')}/items?player=${toHex(player)}${gameName ? `&game=${encodeURIComponent(gameName)}` : ''}`, { signal: AbortSignal.timeout(15000) });
      if (r.ok) return (await r.json()).items || [];
    } catch { /* the next seat */ }
  }
  return [];
}

/**
 * THE PLAYER'S ITEMS KEY: the same in every round, from the seed (protocol player-key.js itemsSecretFor) - it buys an
 * item and signs, per entry, that the entry plays with it. `curve` the page's (pointX, signSchnorr). Answers { secret, pubkey, sign }.
 */
export function itemsKeyFor(seed, curve) {
  const secret = itemsSecretFor(seed);
  const pubkey = curve.pointX(secret);
  return { secret, pubkey, sign: (digest) => curve.signSchnorr(digest, secret) };
}

/** WHAT A GAME'S ITEMS UNLOCK: its manifest's catalogue as { item id: unlock hex } ({} when it sells none). */
export function itemUnlocksOf(manifest) {
  const out = {};
  for (const it of (manifest && manifest.items) || []) out[it.id] = toHex(it.unlock);
  return out;
}

/**
 * THE SHOP OF A GAME: the items its newest manifest that sells any names, from the lobby's games (games.js fetchGames, one entry per
 * version) of that game name. Answers { game, items: [{ id, name, priceSat }] } or null when no version sells anything.
 */
export function shopOf(games, gameName) {
  const selling = (games || []).filter((g) => g && g.manifest && g.manifest.gameName === gameName && (g.manifest.items || []).length)
    .sort((a, b) => Number(b.manifest.version) - Number(a.manifest.version));
  if (!selling.length) return null;
  const game = selling[0];
  return { game, items: game.manifest.items.map((it) => ({ id: it.id, name: it.name, priceSat: it.priceSat })) };
}

/**
 * THE ITEMS AN ENTRY PLAYS WITH (protocol 10): of the purchases this player owns (ownedItems) of the round's game, the
 * ones `use` names and the game sells, each with its owner's proof for THIS entry - the items key's signature over
 * entryItemDigest(round, the entry's per-round key, purchase). Sorted by item id, one purchase per item. [] on a round before
 * version 10, or with nothing to play with: the entry then names no items at all.
 */
export function entryItemsFor({ round, roundId, playerPubkey, owned, use = null, manifest, key }) {
  if (!(Number(round && round.protocolVersion) >= ITEMS_VERSION)) return [];
  const sells = itemUnlocksOf(manifest);
  const byItem = new Map();
  for (const o of owned || []) {
    if (!sells[o.itemId] || (use && !use.includes(o.itemId)) || byItem.has(o.itemId)) continue;
    byItem.set(o.itemId, o);
  }
  return [...byItem.values()].sort((a, b) => (a.itemId < b.itemId ? -1 : 1)).map((o) => {
    const purchaseId = fromHex(o.id);
    return { itemId: o.itemId, purchaseId, ownerSig: key.sign(entryItemDigest({ roundId, playerPubkey, purchaseId })) };
  });
}

/** THE UNLOCKS A RUN STARTS WITH: an entry's items as its game's catalogue unlocks them, in the entry's order ([] for none). */
export function entryUnlocks(entry, manifest) {
  const sells = itemUnlocksOf(manifest);
  return ((entry && entry.items) || []).map((it) => sells[it.itemId]).filter(Boolean);
}
