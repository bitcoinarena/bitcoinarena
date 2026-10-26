// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AN ITEM PURCHASE, AS A SEAT KEEPS IT: the buyer's signed record (protocol purchase.js) checked twice - by
// its own terms against this seat's manifest, donation sets and merged served list (purchaseStands), and against the federation,
// output by output, as a round's donation outputs are (stake-lock-signer-node.js verifyDonationOutputs): at each outpoint the
// federation holds the pre-expired payout contract to that payee for exactly that msat with the buyer's key as its image. A
// transaction already kept for another purchase is refused: one payment is one purchase. Kept, it is the buyer's ownership.
import { purchaseStands, purchaseId, encodePurchase, decodePurchase } from '../../arena-protocol/src/purchase.js';
import { donationContractFields } from './stake-lock-signer-node.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

export const ITEM_PURCHASES_SQL = `CREATE TABLE IF NOT EXISTS item_purchases (
  id TEXT PRIMARY KEY, player TEXT NOT NULL, game_dev TEXT NOT NULL, game_name TEXT NOT NULL, item_id TEXT NOT NULL,
  txid TEXT NOT NULL UNIQUE, bytes BLOB NOT NULL, signature BLOB NOT NULL, kept_ms INTEGER NOT NULL)`;

/**
 * CHECK AND KEEP ONE PURCHASE. `p` the decoded record with its `signature`; `manifest`, `networkSet`, `gameSet`, `served` as
 * purchaseStands takes them; `port` the federation's lock port (status, contractId); `db` the seat's store; `verify` BIP340.
 * Answers { ok, id, kept: 'new' | 'held' } or { ok: false, status, why }.
 */
// `fees`: the fee set in force: an item's parts on the reserves' terms; unset, today's
export async function keepItemPurchase({ p, manifest, networkSet, gameSet, served, port, db, verify, nowMs = Date.now(), reserveKey = null, keepReserve = null, keepDonations = null, fees = null }) {
  const no = (status, why) => ({ ok: false, status, why });
  const st = purchaseStands(p, { manifest, networkSet, gameSet, served, verify, reserveKey, fees });
  if (!st.ok) return no(422, st.why);
  const id = toHex(st.id);
  db.exec(ITEM_PURCHASES_SQL);
  const had = db.prepare('SELECT id FROM item_purchases WHERE txid = ?').get(toHex(p.txid));
  if (had && had.id === id) return { ok: true, id, kept: 'held' };
  if (had) return no(409, `transaction ${toHex(p.txid).slice(0, 16)} already paid for purchase ${had.id.slice(0, 16)}: one payment is one purchase`);
  if (!port) return no(503, 'this seat reaches no federation of that purchase, so it cannot check its outputs');
  const heldIds = new Map();
  for (const o of p.outputs) {
    const outpoint = { txid: p.txid, outIdx: BigInt(o.outIdx) };
    const at = `${toHex(p.txid).slice(0, 16)}…:${o.outIdx}`;
    const [stored, want] = await Promise.all([port.status(outpoint), port.contractId(donationContractFields({ recipientPk: o.pk, amountMsat: o.msat, image: p.playerPubkey }))]);
    if (!stored || !stored.stored) return no(409, `the federation holds nothing at ${at} (not accepted yet, or never)`);
    if (String(stored.stored.contractId) !== String(want)) return no(422, `the output at ${at} is not ${o.msat} msat to key ${toHex(o.pk).slice(0, 16)}… from the buyer`);
    heldIds.set(o.outIdx, String(stored.stored.contractId));
  }
  db.prepare('INSERT OR IGNORE INTO item_purchases (id, player, game_dev, game_name, item_id, txid, bytes, signature, kept_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, toHex(p.playerPubkey), toHex(p.gameDevPubkey), p.gameName, p.itemId, toHex(p.txid), Buffer.from(encodePurchase(p)), Buffer.from(p.signature), nowMs);
  // THE RESERVES' 20 %: its output, checked above with the federation like every other, kept as a reserve row
  // under the federation's reserve key - what GET /reserves counts - with the purchase's id in the entry's place
  const reserve = reserveRowOf(p, id, (outIdx) => heldIds.get(outIdx));
  if (reserve && keepReserve) keepReserve(reserve);
  // AND EVERY OTHER OUTPUT - the protocol developers', the game developers' - indexed for its recipient, naming the game and the item
  // (kanban #578, 2026-10-22: "add the item that is being purchased so we can group by it later. Group it by game and item
  // name"): before, only the reserve's output was indexed, so no dev client ever saw an item's donation or which item it was for
  const donations = donationRowsOf(p, id, (outIdx) => heldIds.get(outIdx)).filter((r) => !reserve || toHex(r.recipientPk) !== toHex(reserve.recipientPk));
  if (donations.length && keepDonations) keepDonations(donations);
  return { ok: true, id, kept: 'new', reserve, donations: donations.length };
}

/**
 * THE RESERVE ROW OF A PURCHASE ON THE RESERVES' TERMS, in the shape putDonationOutputs keeps (round id zeros: it is no round's),
 * or null for a purchase on the old terms. The output paying the record's reserve key is the one; the record stood, so there is one.
 */
export function reserveRowOf(p, idHex, contractIdAt = () => null) {
  if (!p || !(p.reserveKey instanceof Uint8Array)) return null;
  const o = p.outputs.find((x) => toHex(x.pk) === toHex(p.reserveKey));
  if (!o) return null;
  return { outpoint: { txid: p.txid, outIdx: BigInt(o.outIdx) }, entryId: fromHex(idHex), roundId: new Uint8Array(32), federationId: p.federationId,
    recipientPk: p.reserveKey, amountMsat: o.msat, contractId: contractIdAt(o.outIdx) || `item:${idHex}`, senderOnContract: true, image: toHex(p.playerPubkey),
    item: itemLabel(p.gameName, p.itemId) };
}

/** AN ITEM'S NAME ON A DONATION ROW: "<game> · <item id>", as the reserve row has named it; itemOfRow splits it back. */
export const itemLabel = (gameName, itemId) => `${gameName} · ${itemId}`;
export function itemOfRow(label) {
  const s = String(label || ''); const at = s.lastIndexOf(' · ');
  return at > 0 ? { game: s.slice(0, at), item: s.slice(at + 3) } : null;
}

/**
 * EVERY OUTPUT OF A PURCHASE AS A DONATION ROW, in the shape putDonationOutputs keeps: round id zeros (it is no round's), the purchase's
 * id in the entry's place, the buyer's key as the image, and the item it paid for (kanban #578).
 */
export function donationRowsOf(p, idHex, contractIdAt = () => null) {
  return (p.outputs || []).map((o) => ({ outpoint: { txid: p.txid, outIdx: BigInt(o.outIdx) }, entryId: fromHex(idHex), roundId: new Uint8Array(32),
    federationId: p.federationId, recipientPk: o.pk, amountMsat: o.msat, contractId: contractIdAt(o.outIdx) || `item:${idHex}`, senderOnContract: true,
    image: toHex(p.playerPubkey), item: itemLabel(p.gameName, p.itemId) }));
}

/** THE ITEMS A PLAYER OWNS here (optionally of one game): [{ id, gameDev, gameName, itemId, txid, purchase (hex), signature (hex) }]. */
export function itemsOwned(db, { player, gameDev = null, gameName = null }) {
  db.exec(ITEM_PURCHASES_SQL);
  const rows = db.prepare('SELECT * FROM item_purchases WHERE player = ? ORDER BY kept_ms').all(String(player).toLowerCase());
  return rows.filter((r) => (!gameDev || r.game_dev === String(gameDev).toLowerCase()) && (!gameName || r.game_name === gameName))
    .map((r) => ({ id: r.id, gameDev: r.game_dev, gameName: r.game_name, itemId: r.item_id, txid: r.txid,
      purchase: Buffer.from(r.bytes).toString('hex'), signature: Buffer.from(r.signature).toString('hex') }));
}
/** ONE KEPT PURCHASE BY ITS ID (an entry names it, its buyer's key checks the entry's proof), or null. */
export function itemPurchaseKept(db, id) {
  db.exec(ITEM_PURCHASES_SQL);
  const r = db.prepare('SELECT * FROM item_purchases WHERE id = ?').get(String(id).toLowerCase());
  return r ? { id: r.id, player: r.player, gameDev: r.game_dev, gameName: r.game_name, itemId: r.item_id, txid: r.txid } : null;
}

// EVERY ITEM BOUGHT, FOR THE EXPLORER (kanban #683, 2026-10-26: "I don't see item purchases in the explorer"): the purchases this seat kept
// after `since` (ms), oldest first, at most `limit` - every seat keeps every purchase of its network (each is handed on to all). By kept_ms,
// indexed: the explorer asks every minute.
export const ITEM_PURCHASES_KEPT_SQL = 'CREATE INDEX IF NOT EXISTS item_purchases_kept ON item_purchases (kept_ms)';
export function purchasesSince(db, { since = 0, limit = 200 } = {}) {
  db.exec(ITEM_PURCHASES_SQL); db.exec(ITEM_PURCHASES_KEPT_SQL);
  return db.prepare('SELECT id, bytes, kept_ms FROM item_purchases WHERE kept_ms > ? ORDER BY kept_ms, id LIMIT ?').all(Number(since), Number(limit)).map((r) => {
    let p; try { p = decodePurchase(new Uint8Array(r.bytes)); } catch { return null; }
    return { id: r.id, kind: 'item', item: itemLabel(p.gameName, p.itemId), player: toHex(p.playerPubkey), gameDev: toHex(p.gameDevPubkey), gameName: p.gameName,
      itemId: p.itemId, gameId: p.gameId ? toHex(p.gameId) : null, priceSat: String(p.priceSat), federation: toHex(p.federationId), txid: toHex(p.txid),
      totalMsat: String(p.outputs.reduce((t, o) => t + o.msat, 0n)), outputs: p.outputs.map((o) => ({ outIdx: o.outIdx, pk: toHex(o.pk), msat: String(o.msat),
        ...(p.reserveKey && toHex(o.pk) === toHex(p.reserveKey) ? { reserve: true } : {}) })),
      atMs: Number(p.boughtAtMs), keptMs: Number(r.kept_ms) };
  }).filter(Boolean);
}
export { purchaseId };
