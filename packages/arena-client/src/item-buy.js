// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AN IN-GAME ITEM, BOUGHT FROM THE PAGE ('s larger truck the first): the player's wallet pays the item's split
// in one federation transaction, the player signs the record, and the seats keep it as the player's for good.
//
//   1. WHO SERVED: every seat's signed FINALs of the 24 h before now (GET /served?finals=1), merged by round and each FINAL checked
//      here (served-nodes.js) - the same list every seat rebuilds when it checks the purchase.
//   2. THE SPLIT: purchaseOutputs over the item's price, those nodes and the two donation sets (purchase.js).
//   3. THE PAYMENT: the lock client's paySubmit (one transaction of pre-expired payout contracts, purchaseImage as their image - kanban #1180),
//      its acceptance read back output by output (lockAccepted).
//   4. THE RECORD: the game, the item, the price, the buyer, the federation, the transaction, every output and the served list,
//      signed with the player's key, handed to a seat (POST /item-purchase), which hands it on to every other.
// No float touches an amount; every step that fails says which, and nothing is paid before the list and the split stand.
import { servedNodes, mergeServedRounds, SERVED_WINDOW_MS, SERVED_HELD_MAX, SERVED_ANSWER_BYTES_MAX } from '../../arena-protocol/src/served-nodes.js';
import { purchaseOutputs, purchaseOutputsReserves, purchaseId, encodePurchase, purchaseImage } from '../../arena-protocol/src/purchase.js';
import { itemOf, itemPriceFor, ITEM_DEV_SHARES, ITEM_DEV_SHARE_DEFAULT } from '../../arena-protocol/src/items.js';
import { itemSplitReserves, ITEM_DEV_SHARES_RESERVES, ITEM_DEV_SHARE_RESERVES_DEFAULT } from '../../arena-protocol/src/reserves.js';
import { gameIdOf } from '../../arena-protocol/src/manifest.js';
import { fetchReserveKey } from './reserves-page.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { itemsSecretFor } from '../../arena-protocol/src/player-key.js';
import { entryItemDigest } from '../../arena-protocol/src/contracts.js';
import { ITEMS_VERSION, RESERVES_VERSION } from '../../arena-protocol/src/constants.js';
import { newestCheckedCensus } from './committee.js';
import { PAID_PURCHASE_PREFIX, PAID_GIFT_PREFIX, paidRecordGet, paidRecordPut, paidRecordDrop, paidRecordKeys } from './paid-records.js';

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

/**
 * ONE SEAT'S ANSWER, READ UP TO `maxBytes` (kanban #2365, #1489 a45 refute 9 skeptic 3 of #2239): the bound the seat's own reader keeps
 * (server.js readJsonCapped). A stated length over it is refused unread; a body is read as a stream and dropped once past it. Measured
 * before: a 33.6 MB answer was parsed whole and taken by the page.
 */
export async function readJsonUpTo(r, maxBytes) {
  const len = Number(r.headers && typeof r.headers.get === 'function' ? r.headers.get('content-length') : NaN);
  if (Number.isFinite(len) && len > maxBytes) { try { await r.body?.cancel(); } catch { /* gone already */ } throw new Error(`its answer of ${len} bytes is over ${maxBytes}`); }
  if (!r.body || typeof r.body.getReader !== 'function') {
    if (typeof r.text === 'function') { const t = await r.text(); if (t.length > maxBytes) throw new Error(`its answer is over ${maxBytes} bytes`); return JSON.parse(t); }
    return r.json();                                          // a stand-in fetch with no body stream (tests)
  }
  const reader = r.body.getReader(), parts = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { try { await reader.cancel(); } catch { /* gone already */ } throw new Error(`its answer is over ${maxBytes} bytes`); }
    parts.push(value);
  }
  const all = new Uint8Array(total); let at = 0;
  for (const p of parts) { all.set(p, at); at += p.byteLength; }
  return JSON.parse(new TextDecoder().decode(all));
}

/** The served list of the 24 h before `toMs`, from every seat that answers. Answers { ok, served, seats } or { ok: false, why }. */
// `bondedKeys` (kanban #1896): the node keys (hex) of a census this page checked. A round's committee counts only when all its keys are
// among them (mergeServedRounds `bonded`); with none the page cannot tell a node from a URL, and nothing is read.
export async function servedFromSeats({ seats, toMs, fetch, verify, timeoutMs = 15000, bondedKeys = null }) {
  const bonded = bondedKeys ? new Set([...bondedKeys].map((k) => String(k).toLowerCase())) : null;
  if (!bonded || !bonded.size) return { ok: false, why: 'this page has checked no census, so it cannot tell which keys are nodes: no served list is read' };
  const fromMs = BigInt(toMs) - BigInt(SERVED_WINDOW_MS);
  // kept in the order the seats are listed, not the order they answer (kanban #1522): between two committees named by equally many
  // seats the one held first stands (mergeServedRounds), and that must not be whichever seat answered fastest
  const held = [];
  // kanban #1698 #1766: one seat is one answer - a seat listed twice (or with a trailing slash) is asked once, as the merge counts
  // seats, not entries
  const once = [...new Set((seats || []).map((s) => String(s).replace(/\/$/, '')))];
  await Promise.all(once.map(async (s, i) => {
    try {
      const r = await fetch(`${String(s).replace(/\/$/, '')}/served?to=${toMs}&finals=1`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) return;
      const a = await readJsonUpTo(r, SERVED_ANSWER_BYTES_MAX);   // kanban #2365: one seat's answer is read up to a bound, as on the seat
      held[i] = (a.held || []).slice(0, SERVED_HELD_MAX).map((x) => ({ roundId: fromHex(x.roundId), committee: x.committee.map(fromHex), finals: x.finals.map(fromHex) }));
    } catch { /* a seat that does not answer adds nothing */ }
  }));
  const answered = held.filter(Boolean).length;
  if (!answered) return { ok: false, why: 'no seat answered who served a round in the last 24 hours' };
  // kanban #2361: the page holds no record of its own - no answer's rounds are taken as the reader's, every answer's checks are charged
  const served = servedNodes({ rounds: mergeServedRounds(held.filter(Boolean), { own: false, bonded }).rounds, fromMs, toMs: BigInt(toMs), verify });
  if (!served.nodes.length) return { ok: false, why: 'no node served a round in the last 24 hours: the nodes\' half has nobody to go to' };
  return { ok: true, served, seats: answered };
}

/**
 * HAND A PAID RECORD TO THE SEATS (kanban #2420): POSTed to every seat at once (60 s each), not stopping at the first 200 - a seat
 * that answers 200 and keeps nothing must not be the only one that ever saw it. Kept when two seats answer 200 (the one seat, when
 * only one is listed): GET /items names a purchase only when two seats do. Answers { keptBy: the first keeping seat in list order or
 * null, kept: how many kept it, last: the last refusal }.
 */
export async function handToSeats({ seats, door, body, fetch, timeoutMs = 60000 }) {
  const list = (seats || []).slice(0, 64);
  const why = [];
  const kept = await Promise.all(list.map(async (s, i) => {
    try {
      const r = await fetch(`${String(s).replace(/\/$/, '')}/${door}`, { method: 'POST', body, signal: AbortSignal.timeout(timeoutMs) });
      if (r.ok) return true;
      why[i] = `${s}: ${r.status} ${(await r.text()).trim().slice(0, 200)}`;
    } catch (e) { why[i] = `${s}: ${e.message}`; }
    return false;
  }));
  const n = kept.filter(Boolean).length;
  const need = Math.min(2, list.length);
  const refusals = why.filter(Boolean);
  const last = !list.length ? 'no seat to hand it to' : refusals.length ? refusals[refusals.length - 1] : 'no seat to hand it to';
  return { keptBy: list.length && n >= need ? list[kept.indexOf(true)] : null, kept: n,
    last: n && n < need ? `only ${n} of ${list.length} seats kept it (two must): ${last}` : last };
}

/**
 * BUY ONE ITEM. `manifest` the game's (it sells `itemId`); `networkSet` / `gameSet` the donation sets (paying keys); `wallet` the
 * player's lock client in the federation `federationId` (hex); `player` { pubkey (32 bytes), sign(digest) -> 64-byte BIP340 };
 * `seats` the game's seats; `verify` BIP340; `devsPct` the developers' share the buyer chose (one of ITEM_DEV_SHARES, default
 * 50 - the nodes' half is paid whatever it is). Answers { ok, purchaseId, txid, priceSat, paidSat, devsPct, outputs, keptBy } or { ok: false, step, why }.
 */
// `bondedKeys`: the node keys (hex) of a census this page checked (kanban #1896); left out, the newest census this page checked.
export async function buyItem({ manifest, itemId, networkSet, gameSet, wallet, federationId, player, seats, fetch, verify, nowMs = () => Date.now(), devsPct = null, reserveNeeded = 5, storage = null, bondedKeys = null }) {
  const no = (step, why) => ({ ok: false, step, why });
  const item = itemOf(manifest, itemId);
  if (!item) return no('item', `"${manifest && manifest.gameName}" sells no item "${itemId}"`);
  const terms = itemTermsOf(manifest);
  // THIS ITEM PAID BEFORE AND ITS RECORD NOT KEPT (kanban #2274): the kept purchase goes on - acceptance, record, seats - and nothing is paid again
  const keptKey = `${PAID_PURCHASE_PREFIX}${manifest.gameName}.${itemId}.${toHex(player.pubkey).slice(0, 16)}`;
  const kept = paidRecordGet(storage, keptKey);
  if (kept && kept.submitted) return finishPurchase({ rec: kept, keptKey, storage, manifest, item, itemId, terms, wallet, federationId, player, fetch, again: true });
  if (kept) {   // written ahead, the page gone before the federation answered: whether it paid is the wallet history's to say, so said once
    paidRecordDrop(storage, keptKey);
    return no('payment', `an earlier payment of this item had no answer (the page closed while paying, ${new Date(Number(kept.boughtAtMs)).toISOString()}): look at the wallet history before buying again`);
  }
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
  if (!bondedKeys) { const c = newestCheckedCensus(); bondedKeys = c ? c.entries.map((e) => toHex(e.pubkey)) : null; }
  const got = await servedFromSeats({ seats, toMs, fetch, verify, bondedKeys });
  if (!got.ok) return no('served', got.why);
  let built;
  try {
    built = terms.reserves
      ? purchaseOutputsReserves({ priceSat: item.priceSat, servedKeys: got.served.nodes.map((n) => n.key), networkSet, gameSet, devsPct: Number(devsPct), reserveKey })
      : purchaseOutputs({ priceSat: item.priceSat, servedKeys: got.served.nodes.map((n) => n.key), networkSet, gameSet, devsPct: Number(devsPct) });
  } catch (e) { return no('split', e.message); }
  // THE PAYMENT NAMES THE ITEM (kanban #1180): every contract's image commits to the buyer, the game, the item, its price and the served
  // window (purchaseImage), so this payment stands for this item's record alone
  const image = toHex(purchaseImage({ playerPubkey: player.pubkey, gameDevPubkey: manifest.gameDevPubkey, gameName: manifest.gameName, itemId, priceSat: item.priceSat,
    servedFromMs: got.served.fromMs, servedToMs: got.served.toMs }));
  // WRITTEN AHEAD (kanban #2274): the purchase is kept before the payment and again with its transaction the moment the federation
  // answers it, so a record the seats do not keep is handed again on the next press, never paid again. One that cannot be written pays nothing.
  const rec = { seats: [...(seats || [])], federationId, devsPct: Number(devsPct), servedFromMs: String(got.served.fromMs), servedToMs: String(got.served.toMs),
    servedRoot: got.served.root, reserveKey: reserveKey ? toHex(reserveKey) : null, reserveMsat: built.reserve ? String(built.reserve.msat) : null,
    outputs: built.outputs.length, boughtAtMs: String(nowMs()), submitted: null, body: null };
  try { paidRecordPut(storage, keptKey, rec); } catch (e) { return no('payment', `nothing paid: the purchase could not be written ahead (${e && e.message || e})`); }
  try {
    rec.submitted = JSON.parse(await wallet.paySubmit(JSON.stringify(built.outputs.map((o) => ({ pk: toHex(o.pk), msat: String(o.msat), image })))));
  } catch (e) { paidRecordDrop(storage, keptKey); return no('payment', String(e && e.message || e)); }
  try { paidRecordPut(storage, keptKey, rec); } catch { /* the payment stands; the record is built and handed below */ }
  return finishPurchase({ rec, keptKey, storage, manifest, item, itemId, terms, wallet, federationId, player, fetch, again: false });
}

// THE PAID PURCHASE FINISHED (kanban #2274): its acceptance read back, the record signed and kept with its body, handed to every seat
// (kept when two keep it, #2420); dropped only then. A purchase kept from an earlier press goes on from where it stood - its body as it was.
async function finishPurchase({ rec, keptKey, storage, manifest, item, itemId, terms, wallet, federationId, player, fetch, again }) {
  const no = (step, why) => ({ ok: false, step, why });
  const txid = rec.submitted.txid;
  if (!rec.body) {
    if (rec.federationId !== federationId) return no('record', `paid (transaction ${txid}) from federation ${rec.federationId.slice(0, 8)}: open that federation's wallet to finish the record, nothing is paid again`);
    let accepted;
    try { accepted = JSON.parse(await wallet.lockAccepted(JSON.stringify(rec.submitted))); } catch (e) { return no('record', `paid (transaction ${txid}), its acceptance not read yet (${String(e && e.message || e)}): pressed again, it is read again, never paid again`); }
    const outs = accepted.donations || [];
    if (outs.length !== rec.outputs || !outs.every((d) => d.ids_match)) return no('payment', 'the federation does not hold the outputs as they were built');
    const record = { gameDevPubkey: manifest.gameDevPubkey, gameName: manifest.gameName, itemId, priceSat: item.priceSat, devsPct: rec.devsPct, playerPubkey: player.pubkey,
      federationId: fromHex(rec.federationId), txid: fromHex(txid), servedFromMs: BigInt(rec.servedFromMs), servedToMs: BigInt(rec.servedToMs), servedRoot: fromHex(rec.servedRoot),
      outputs: outs.map((d) => ({ outIdx: Number(d.out_idx), pk: fromHex(d.recipient_pk), msat: BigInt(d.amount_msat) })), boughtAtMs: BigInt(rec.boughtAtMs),
      ...(terms.reserves ? { gameId: gameIdOf(manifest), reserveKey: fromHex(rec.reserveKey) } : {}) };
    rec.body = JSON.stringify({ purchase: toHex(encodePurchase(record)), signature: toHex(player.sign(purchaseId(record))) });
    rec.purchaseId = toHex(purchaseId(record));
    try { paidRecordPut(storage, keptKey, rec); } catch { /* handed below; a failed hand-over is then kept in nothing but this answer's retry */ }
  }
  // HANDED TO EVERY SEAT, KEPT ONLY WHEN TWO KEEP IT (kanban #2420): no longer the first seat that answers 200 - one lying seat listed
  // first said 200, dropped the record and never handed it on, the page said "bought" and no honest seat held the paid item
  const { keptBy, last } = await handToSeats({ seats: rec.seats, door: 'item-purchase', body: rec.body, fetch });
  if (!keptBy) return { ok: false, step: 'record', paid: true, why: `${again ? 'an earlier purchase of this item was ' : ''}paid (transaction ${txid}), but no seat kept the record yet: ${last} - it is handed again, never paid again`,
    purchaseId: rec.purchaseId, txid, retry: rec.body };
  paidRecordDrop(storage, keptKey);
  return { ok: true, purchaseId: rec.purchaseId, txid, priceSat: item.priceSat, paidSat: itemPriceOn(manifest, item.priceSat, rec.devsPct),
    devsPct: rec.devsPct, outputs: rec.outputs, keptBy, ...(again ? { earlier: true } : {}), ...(terms.reserves ? { reserveKey: rec.reserveKey, reserveMsat: BigInt(rec.reserveMsat) } : {}) };
}

/** AT LOAD (kanban #2274): every kept paid record that has its signed body is handed again to the seats it names; the kept ones are
 *  dropped. Answers [{ key, ok, why }]. */
export async function resendPaidRecords({ storage, fetch }) {
  const said = [];
  for (const key of paidRecordKeys(storage)) {
    const rec = paidRecordGet(storage, key);
    if (!rec || !rec.body) continue;
    const { keptBy, last } = await handToSeats({ seats: rec.seats, door: key.startsWith(PAID_GIFT_PREFIX) ? 'donation-gift' : 'item-purchase', body: rec.body, fetch });
    if (keptBy) paidRecordDrop(storage, key);
    said.push({ key, ok: !!keptBy, why: keptBy ? `kept by ${keptBy}` : last });
  }
  return said;
}

/**
 * THE ITEMS A PLAYER OWNS (GET /items): [{ id, gameName, itemId, ... }]. Kanban #1558: every seat is asked (15 s each) and the answers
 * are merged by purchase id - no longer the first seat's answer as it is, where one seat answering [] hid a purchase every other seat
 * keeps, or named a made-up one. A purchase is kept when two seats name it (one, when only one seat answered); the record kept is the
 * first seat's in list order.
 * Kanban #2421: agreement is on the record that matters (id, itemId, gameName), not the id alone - one seat naming the player's real
 * purchase id with another itemId was counted with the honest seats and its record kept, so the entry named an item never bought and
 * every seat refused it. A purchase of another game than the one asked is skipped; an id two variants both reach `need` for is not kept.
 */
export async function ownedItems({ seats, player, gameName = null, fetch }) {
  const answers = await Promise.all((seats || []).map(async (s) => {
    try {
      const r = await fetch(`${String(s).replace(/\/$/, '')}/items?player=${toHex(player)}${gameName ? `&game=${encodeURIComponent(gameName)}` : ''}`, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) return null;
      const items = (await r.json()).items;
      return Array.isArray(items) ? items.slice(0, 1000) : [];
    } catch { return null; }
  }));
  const answered = answers.filter((a) => a);
  const need = answered.length >= 2 ? 2 : 1;
  const byRecord = new Map();
  for (const items of answered) {
    const seen = new Set();
    for (const it of items) {
      if (!it || typeof it.id !== 'string' || seen.has(it.id)) continue;
      if (gameName && it.gameName !== gameName) continue;     // kanban #2421: only the game asked
      seen.add(it.id);
      const k = JSON.stringify([it.id, String(it.itemId), String(it.gameName)]);
      const e = byRecord.get(k);
      if (e) e.n++; else byRecord.set(k, { it, n: 1 });
    }
  }
  // kanban #2421: one variant per purchase id reaches `need`, else the seats disagree on what was bought and none is kept
  const byId = new Map();
  for (const e of byRecord.values()) if (e.n >= need) byId.set(e.it.id, byId.has(e.it.id) ? null : e.it);
  return [...byId.values()].filter(Boolean);
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
 * version) of that game. Answers { game, items: [{ id, name, priceSat }] } or null when no version sells anything.
 * `game` is the chosen tile ({ name, devKey }) or a game name.
 * ONE DEVELOPER KEY, NOT ONE NAME (kanban #2243, #1810 variant): #1810 keeps only manifests their own key signed, and any stranger
 * signs with a key of his own - one seat listing a same-name manifest under its own key, version + 1, took the shop of the honest
 * tile (its items, its price, its seats). A version of a game is a new manifest under the same developer key and name (§5,
 * oneTilePerGame's group), so the shop is the newest selling version of the tile's own key; for a bare name, the key of the
 * name's first game that names one (fetchGames' order, the tile the page chooses).
 */
export const devKeyOfGame = (g) => (g && (g.devKey || (g.manifest && g.manifest.gameDevPubkey && toHex(g.manifest.gameDevPubkey)))) || null;
export function gameDevKeyFor(games, game) {
  if (game && typeof game === 'object') return devKeyOfGame(game);
  const first = (games || []).find((g) => g && g.manifest && (g.name === game || g.manifest.gameName === game) && devKeyOfGame(g));
  return devKeyOfGame(first);
}
export function shopOf(games, game) {
  const gameName = game && typeof game === 'object' ? game.name : game;
  const devKey = gameDevKeyFor(games, game);
  const selling = (games || []).filter((g) => g && g.manifest && g.manifest.gameName === gameName && devKeyOfGame(g) === devKey
    && (g.manifest.items || []).length)
    .sort((a, b) => Number(b.manifest.version) - Number(a.manifest.version));
  if (!selling.length) return null;
  const chosen = selling[0];
  return { game: chosen, items: chosen.manifest.items.map((it) => ({ id: it.id, name: it.name, priceSat: it.priceSat })) };
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
