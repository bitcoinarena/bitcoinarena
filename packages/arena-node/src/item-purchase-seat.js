// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AN ITEM PURCHASE, AS A SEAT KEEPS IT: the buyer's signed record (protocol purchase.js) checked twice - by
// its own terms against this seat's manifest, donation sets and merged served list (purchaseStands), and against the federation,
// output by output, as a round's donation outputs are (stake-lock-signer-node.js verifyDonationOutputs): at each outpoint the
// federation holds the pre-expired payout contract to that payee for exactly that msat with the buyer's key as its image. A
// transaction already kept for another purchase is refused: one payment is one purchase. Kept, it is the buyer's ownership.
import { purchaseStands, purchaseId, encodePurchase, decodePurchase, purchaseImage } from '../../arena-protocol/src/purchase.js';
import { donationContractFields } from './stake-lock-signer-node.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

export const ITEM_PURCHASES_SQL = `CREATE TABLE IF NOT EXISTS item_purchases (
  id TEXT PRIMARY KEY, player TEXT NOT NULL, game_dev TEXT NOT NULL, game_name TEXT NOT NULL, item_id TEXT NOT NULL,
  txid TEXT NOT NULL UNIQUE, bytes BLOB NOT NULL, signature BLOB NOT NULL, kept_ms INTEGER NOT NULL)`;

/**
 * A PURCHASE ROW'S STATES (kanban #1180), one column and one transition function:
 *   PENDING  its txid claimed in one immediate transaction BEFORE the federation is asked: a second record of that txid is refused
 *            (409) while the first is checked - the check and the insert were split by awaits, so two records of one txid both passed and
 *            the second, ignored by INSERT OR IGNORE, still answered kept 'new', wrote reserve and donation rows and was handed on
 *   KEPT     the federation holds every output: the buyer's ownership (itemsOwned, itemPurchaseKept, purchasesSince read KEPT rows only)
 *   (none)   a failed check drops its own PENDING claim; a claim left by a crash goes stale after PURCHASE_PENDING_MS and is taken again
 * A KEPT row never changes.
 */
export const PURCHASE_STATE = Object.freeze({ PENDING: 'PENDING', KEPT: 'KEPT' });
export const PURCHASE_PENDING_MS = 10 * 60 * 1000;
export function purchaseStep(row, ev, nowMs) {
  const s = row ? row.state || PURCHASE_STATE.KEPT : null;
  if (ev.kind === 'claim') {
    if (!s) return { ok: true, state: PURCHASE_STATE.PENDING };
    if (row.id !== ev.id) {
      if (s === PURCHASE_STATE.PENDING && nowMs - Number(row.kept_ms) > PURCHASE_PENDING_MS) return { ok: true, state: PURCHASE_STATE.PENDING, takeover: true };
      return { ok: false, status: 409, why: `transaction ${String(row.txid).slice(0, 16)} already ${s === PURCHASE_STATE.KEPT ? 'paid for' : 'claimed by'} purchase ${row.id.slice(0, 16)}: one payment is one purchase` };
    }
    if (s === PURCHASE_STATE.KEPT) return { ok: true, held: true };
    if (nowMs - Number(row.kept_ms) > PURCHASE_PENDING_MS) return { ok: true, state: PURCHASE_STATE.PENDING, takeover: true };
    return { ok: false, status: 409, why: `purchase ${row.id.slice(0, 16)} is being checked with the federation: ask again shortly` };
  }
  if (ev.kind === 'keep') return s === PURCHASE_STATE.PENDING && row.id === ev.id ? { ok: true, state: PURCHASE_STATE.KEPT } : { ok: false, status: 409, why: 'the claim on that transaction is gone' };
  if (ev.kind === 'drop') return s === PURCHASE_STATE.PENDING && row.id === ev.id ? { ok: true } : { ok: false, why: 'no claim of that purchase to drop' };
  return { ok: false, why: 'no such step' };
}
// ONE READ-AND-WRITE IN ONE IMMEDIATE TRANSACTION (node:sqlite): inside a caller's transaction it is part of that one
function immediately(db, fn) {
  const own = !db.isTransaction;
  if (own) db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); if (own) db.exec('COMMIT'); return r; } catch (e) { if (own) { try { db.exec('ROLLBACK'); } catch { /* none open */ } } throw e; }
}
// the state column on a store from before kanban #1180: every row it holds was kept
const stateReady = new WeakSet();
export function ensurePurchaseState(db) {
  if (stateReady.has(db)) return;
  db.exec(ITEM_PURCHASES_SQL);
  const cols = db.prepare('PRAGMA table_info(item_purchases)').all().map((c) => c.name);
  if (!cols.includes('state')) db.exec(`ALTER TABLE item_purchases ADD COLUMN state TEXT NOT NULL DEFAULT 'KEPT'`);
  stateReady.add(db);
}

/**
 * CHECK AND KEEP ONE PURCHASE. `p` the decoded record with its `signature`; `manifest`, `networkSet`, `gameSet`, `served` as
 * purchaseStands takes them; `port` the federation's lock port (status, contractId); `db` the seat's store; `verify` BIP340.
 * Answers { ok, id, kept: 'new' | 'held' } or { ok: false, status, why }.
 */
// `fees`: the fee set in force: an item's parts on the reserves' terms; unset, today's
export async function keepItemPurchase({ p, manifest, networkSet, gameSet, served, port, db, verify, nowMs = Date.now(), reserveKey = null, keepReserve = null, keepDonations = null, fees = null,
  legacyImage = true }) {
  const no = (status, why) => ({ ok: false, status, why });
  const st = purchaseStands(p, { manifest, networkSet, gameSet, served, verify, reserveKey, fees });
  if (!st.ok) return no(422, st.why);
  const id = toHex(st.id), txid = toHex(p.txid);
  ensurePurchaseState(db);
  if (!port) {
    const had = db.prepare('SELECT id, state FROM item_purchases WHERE txid = ?').get(txid);
    if (had && had.id === id && (had.state || 'KEPT') === PURCHASE_STATE.KEPT) return { ok: true, id, kept: 'held' };
    return no(503, 'this seat reaches no federation of that purchase, so it cannot check its outputs');
  }
  // 1. THE CLAIM: the txid taken as PENDING in one immediate transaction, before any await
  const claim = immediately(db, () => {
    const row = db.prepare('SELECT id, txid, state, kept_ms FROM item_purchases WHERE txid = ? OR id = ?').get(txid, id) || null;
    const s = purchaseStep(row, { kind: 'claim', id }, nowMs);
    if (!s.ok || s.held) return s;
    if (s.takeover) db.prepare("DELETE FROM item_purchases WHERE id = ? AND state = 'PENDING'").run(row.id);
    const ch = db.prepare('INSERT OR IGNORE INTO item_purchases (id, player, game_dev, game_name, item_id, txid, bytes, signature, kept_ms, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, toHex(p.playerPubkey), toHex(p.gameDevPubkey), p.gameName, p.itemId, txid, Buffer.from(encodePurchase(p)), Buffer.from(p.signature), nowMs, PURCHASE_STATE.PENDING).changes;
    return ch === 1 ? s : { ok: false, status: 409, why: `transaction ${txid.slice(0, 16)} is claimed already: one payment is one purchase` };
  });
  if (!claim.ok) return no(claim.status || 409, claim.why);
  if (claim.held) return { ok: true, id, kept: 'held' };
  const drop = () => { db.prepare("DELETE FROM item_purchases WHERE id = ? AND state = 'PENDING'").run(id); };
  // 2. THE FEDERATION: every output the contract to its payee, for its msat, with the image that names this item (kanban #1180)
  const heldIds = new Map();
  try {
    const bound = purchaseImage(p);
    for (const o of p.outputs) {
      const outpoint = { txid: p.txid, outIdx: BigInt(o.outIdx) };
      const at = `${txid.slice(0, 16)}…:${o.outIdx}`;
      const [stored, want, old] = await Promise.all([port.status(outpoint), port.contractId(donationContractFields({ recipientPk: o.pk, amountMsat: o.msat, image: bound })),
        legacyImage ? port.contractId(donationContractFields({ recipientPk: o.pk, amountMsat: o.msat, image: p.playerPubkey })) : Promise.resolve(null)]);
      if (!stored || !stored.stored) { drop(); return no(409, `the federation holds nothing at ${at} (not accepted yet, or never)`); }
      const got = String(stored.stored.contractId);
      if (got !== String(want) && !(legacyImage && old !== null && got === String(old))) {
        drop(); return no(422, `the output at ${at} is not ${o.msat} msat to key ${toHex(o.pk).slice(0, 16)}… paid for this item by this buyer`);
      }
      heldIds.set(o.outIdx, got);
    }
  } catch (e) { drop(); return no(503, `the federation's outputs could not be read: ${e.message}`); }
  // 3. KEPT: compare-and-set from this purchase's own PENDING claim - only the request that holds it goes on to write rows and hand it on
  const kept = immediately(db, () => {
    const row = db.prepare('SELECT id, txid, state, kept_ms FROM item_purchases WHERE id = ?').get(id) || null;
    const s = purchaseStep(row, { kind: 'keep', id }, nowMs);
    if (!s.ok) return s;
    return db.prepare("UPDATE item_purchases SET state = 'KEPT', kept_ms = ? WHERE id = ? AND state = 'PENDING'").run(nowMs, id).changes === 1 ? s : { ok: false, status: 409, why: 'the claim on that transaction is gone' };
  });
  if (!kept.ok) return no(kept.status || 409, kept.why);
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
  ensurePurchaseState(db);
  const rows = db.prepare("SELECT * FROM item_purchases WHERE player = ? AND state = 'KEPT' ORDER BY kept_ms").all(String(player).toLowerCase());
  return rows.filter((r) => (!gameDev || r.game_dev === String(gameDev).toLowerCase()) && (!gameName || r.game_name === gameName))
    .map((r) => ({ id: r.id, gameDev: r.game_dev, gameName: r.game_name, itemId: r.item_id, txid: r.txid,
      purchase: Buffer.from(r.bytes).toString('hex'), signature: Buffer.from(r.signature).toString('hex') }));
}
/** ONE KEPT PURCHASE BY ITS ID (an entry names it, its buyer's key checks the entry's proof), or null. */
export function itemPurchaseKept(db, id) {
  ensurePurchaseState(db);
  const r = db.prepare("SELECT * FROM item_purchases WHERE id = ? AND state = 'KEPT'").get(String(id).toLowerCase());
  return r ? { id: r.id, player: r.player, gameDev: r.game_dev, gameName: r.game_name, itemId: r.item_id, txid: r.txid } : null;
}

// EVERY ITEM BOUGHT, FOR THE EXPLORER (kanban #683, 2026-10-26: "I don't see item purchases in the explorer"): the purchases this seat kept
// after `since` (ms), oldest first, at most `limit` - every seat keeps every purchase of its network (each is handed on to all). By kept_ms,
// indexed: the explorer asks every minute.
export const ITEM_PURCHASES_KEPT_SQL = 'CREATE INDEX IF NOT EXISTS item_purchases_kept ON item_purchases (kept_ms)';
export function purchasesSince(db, { since = 0, limit = 200 } = {}) {
  ensurePurchaseState(db); db.exec(ITEM_PURCHASES_KEPT_SQL);
  return db.prepare("SELECT id, bytes, kept_ms FROM item_purchases WHERE kept_ms > ? AND state = 'KEPT' ORDER BY kept_ms, id LIMIT ?").all(Number(since), Number(limit)).map((r) => {
    let p; try { p = decodePurchase(new Uint8Array(r.bytes)); } catch { return null; }
    return { id: r.id, kind: 'item', item: itemLabel(p.gameName, p.itemId), player: toHex(p.playerPubkey), gameDev: toHex(p.gameDevPubkey), gameName: p.gameName,
      itemId: p.itemId, gameId: p.gameId ? toHex(p.gameId) : null, priceSat: String(p.priceSat), federation: toHex(p.federationId), txid: toHex(p.txid),
      totalMsat: String(p.outputs.reduce((t, o) => t + o.msat, 0n)), outputs: p.outputs.map((o) => ({ outIdx: o.outIdx, pk: toHex(o.pk), msat: String(o.msat),
        ...(p.reserveKey && toHex(o.pk) === toHex(p.reserveKey) ? { reserve: true } : {}) })),
      atMs: Number(p.boughtAtMs), keptMs: Number(r.kept_ms) };
  }).filter(Boolean);
}
export { purchaseId };
