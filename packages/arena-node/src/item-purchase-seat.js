// AN ITEM PURCHASE, AS A SEAT KEEPS IT (kanban #365 step 3): the buyer's signed record (protocol purchase.js) checked twice - by
// its own terms against this seat's manifest, donation sets and merged served list (purchaseStands), and against the federation,
// output by output, as a round's donation outputs are (stake-lock-signer-node.js verifyDonationOutputs): at each outpoint the
// federation holds the pre-expired payout contract to that payee for exactly that msat with the buyer's key as its image. A
// transaction already kept for another purchase is refused: one payment is one purchase. Kept, it is the buyer's ownership.
import { purchaseStands, purchaseId, encodePurchase } from '../../arena-protocol/src/purchase.js';
import { donationContractFields } from './stake-lock-signer-node.js';
import { toHex } from '../../arena-protocol/src/hash.js';

export const ITEM_PURCHASES_SQL = `CREATE TABLE IF NOT EXISTS item_purchases (
  id TEXT PRIMARY KEY, player TEXT NOT NULL, game_dev TEXT NOT NULL, game_name TEXT NOT NULL, item_id TEXT NOT NULL,
  txid TEXT NOT NULL UNIQUE, bytes BLOB NOT NULL, signature BLOB NOT NULL, kept_ms INTEGER NOT NULL)`;

/**
 * CHECK AND KEEP ONE PURCHASE. `p` the decoded record with its `signature`; `manifest`, `networkSet`, `gameSet`, `served` as
 * purchaseStands takes them; `port` the federation's lock port (status, contractId); `db` the seat's store; `verify` BIP340.
 * Answers { ok, id, kept: 'new' | 'held' } or { ok: false, status, why }.
 */
export async function keepItemPurchase({ p, manifest, networkSet, gameSet, served, port, db, verify, nowMs = Date.now() }) {
  const no = (status, why) => ({ ok: false, status, why });
  const st = purchaseStands(p, { manifest, networkSet, gameSet, served, verify });
  if (!st.ok) return no(422, st.why);
  const id = toHex(st.id);
  db.exec(ITEM_PURCHASES_SQL);
  const had = db.prepare('SELECT id FROM item_purchases WHERE txid = ?').get(toHex(p.txid));
  if (had && had.id === id) return { ok: true, id, kept: 'held' };
  if (had) return no(409, `transaction ${toHex(p.txid).slice(0, 16)} already paid for purchase ${had.id.slice(0, 16)}: one payment is one purchase`);
  if (!port) return no(503, 'this seat reaches no federation of that purchase, so it cannot check its outputs');
  for (const o of p.outputs) {
    const outpoint = { txid: p.txid, outIdx: BigInt(o.outIdx) };
    const at = `${toHex(p.txid).slice(0, 16)}…:${o.outIdx}`;
    const [stored, want] = await Promise.all([port.status(outpoint), port.contractId(donationContractFields({ recipientPk: o.pk, amountMsat: o.msat, image: p.playerPubkey }))]);
    if (!stored || !stored.stored) return no(409, `the federation holds nothing at ${at} (not accepted yet, or never)`);
    if (String(stored.stored.contractId) !== String(want)) return no(422, `the output at ${at} is not ${o.msat} msat to key ${toHex(o.pk).slice(0, 16)}… from the buyer`);
  }
  db.prepare('INSERT OR IGNORE INTO item_purchases (id, player, game_dev, game_name, item_id, txid, bytes, signature, kept_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, toHex(p.playerPubkey), toHex(p.gameDevPubkey), p.gameName, p.itemId, toHex(p.txid), Buffer.from(encodePurchase(p)), Buffer.from(p.signature), nowMs);
  return { ok: true, id, kept: 'new' };
}

/** THE ITEMS A PLAYER OWNS here (optionally of one game): [{ id, gameDev, gameName, itemId, txid, purchase (hex), signature (hex) }]. */
export function itemsOwned(db, { player, gameDev = null, gameName = null }) {
  db.exec(ITEM_PURCHASES_SQL);
  const rows = db.prepare('SELECT * FROM item_purchases WHERE player = ? ORDER BY kept_ms').all(String(player).toLowerCase());
  return rows.filter((r) => (!gameDev || r.game_dev === String(gameDev).toLowerCase()) && (!gameName || r.game_name === gameName))
    .map((r) => ({ id: r.id, gameDev: r.game_dev, gameName: r.game_name, itemId: r.item_id, txid: r.txid,
      purchase: Buffer.from(r.bytes).toString('hex'), signature: Buffer.from(r.signature).toString('hex') }));
}
/** ONE KEPT PURCHASE BY ITS ID (kanban #369: an entry names it, its buyer's key checks the entry's proof), or null. */
export function itemPurchaseKept(db, id) {
  db.exec(ITEM_PURCHASES_SQL);
  const r = db.prepare('SELECT * FROM item_purchases WHERE id = ?').get(String(id).toLowerCase());
  return r ? { id: r.id, player: r.player, gameDev: r.game_dev, gameName: r.game_name, itemId: r.item_id, txid: r.txid } : null;
}
export { purchaseId };
