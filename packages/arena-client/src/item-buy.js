// AN IN-GAME ITEM, BOUGHT FROM THE PAGE (kanban #365 step 5; #369's larger truck the first): the player's wallet pays the item's split
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
import { purchaseOutputs, purchaseId, encodePurchase } from '../../arena-protocol/src/purchase.js';
import { itemOf, itemPriceFor, itemDevShareOk, ITEM_DEV_SHARES, ITEM_DEV_SHARE_DEFAULT } from '../../arena-protocol/src/items.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { itemsSecretFor } from '../../arena-protocol/src/player-key.js';
import { entryItemDigest } from '../../arena-protocol/src/contracts.js';
import { ITEMS_VERSION } from '../../arena-protocol/src/constants.js';

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
 * `seats` the game's seats; `verify` BIP340; `devsPct` the developers' share the buyer chose (kanban #377: one of ITEM_DEV_SHARES, default
 * 50 - the nodes' half is paid whatever it is). Answers { ok, purchaseId, txid, priceSat, paidSat, devsPct, outputs, keptBy } or { ok: false, step, why }.
 */
export async function buyItem({ manifest, itemId, networkSet, gameSet, wallet, federationId, player, seats, fetch, verify, nowMs = () => Date.now(), devsPct = ITEM_DEV_SHARE_DEFAULT }) {
  const no = (step, why) => ({ ok: false, step, why });
  const item = itemOf(manifest, itemId);
  if (!item) return no('item', `"${manifest && manifest.gameName}" sells no item "${itemId}"`);
  if (!itemDevShareOk(devsPct)) return no('share', `a developers' share is one of ${ITEM_DEV_SHARES.join(', ')} %`);
  const toMs = BigInt(nowMs() - 60000);                     // a minute back: the newest FINALs have reached every seat
  const got = await servedFromSeats({ seats, toMs, fetch, verify });
  if (!got.ok) return no('served', got.why);
  let built;
  try { built = purchaseOutputs({ priceSat: item.priceSat, servedKeys: got.served.nodes.map((n) => n.key), networkSet, gameSet, devsPct: Number(devsPct) }); }
  catch (e) { return no('split', e.message); }
  let submitted, accepted;
  try {
    submitted = JSON.parse(await wallet.paySubmit(JSON.stringify(built.outputs.map((o) => ({ pk: toHex(o.pk), msat: String(o.msat), image: toHex(player.pubkey) })))));
    accepted = JSON.parse(await wallet.lockAccepted(JSON.stringify(submitted)));
  } catch (e) { return no('payment', String(e && e.message || e)); }
  const outs = accepted.donations || [];
  if (outs.length !== built.outputs.length || !outs.every((d) => d.ids_match)) return no('payment', 'the federation does not hold the outputs as they were built');
  const record = { gameDevPubkey: manifest.gameDevPubkey, gameName: manifest.gameName, itemId, priceSat: item.priceSat, devsPct: Number(devsPct), playerPubkey: player.pubkey,
    federationId: fromHex(federationId), txid: fromHex(submitted.txid), servedFromMs: got.served.fromMs, servedToMs: got.served.toMs, servedRoot: fromHex(got.served.root),
    outputs: outs.map((d) => ({ outIdx: Number(d.out_idx), pk: fromHex(d.recipient_pk), msat: BigInt(d.amount_msat) })), boughtAtMs: BigInt(nowMs()) };
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
  return { ok: true, purchaseId: toHex(purchaseId(record)), txid: submitted.txid, priceSat: item.priceSat, paidSat: itemPriceFor(item.priceSat, Number(devsPct)),
    devsPct: Number(devsPct), outputs: outs.length, keptBy };
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
 * THE PLAYER'S ITEMS KEY (kanban #369): the same in every round, from the seed (protocol player-key.js itemsSecretFor) - it buys an
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
 * THE ITEMS AN ENTRY PLAYS WITH (protocol 10, kanban #369): of the purchases this player owns (ownedItems) of the round's game, the
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
