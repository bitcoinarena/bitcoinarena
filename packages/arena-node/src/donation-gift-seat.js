// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A DONATION TO THE DEVELOPERS, AS A SEAT KEEPS IT (protocol donation-gift.js): the donor's signed record checked twice -
// by its own terms against the set this seat holds for its target (giftStands: the split of its total over those keys), and against
// the federation, output by output, as an item purchase's are (item-purchase-seat.js): at each outpoint the federation holds the
// pre-expired payout contract to that key for exactly that msat with the donor's key as its image. One transaction is one gift.
// Kept, each output is indexed under its recipient key (donation_outputs), where GET /donations?key= serves a round's donations, so
// the developer's own client redeems it as it redeems those.
import { giftStands, encodeDonationGift, decodeDonationGift, GIFT_TO_BOTH } from '../../arena-protocol/src/donation-gift.js';
import { donationContractFields } from './stake-lock-signer-node.js';
import { toHex } from '../../arena-protocol/src/hash.js';

export const DONATION_GIFTS_SQL = `CREATE TABLE IF NOT EXISTS donation_gifts (
  id TEXT PRIMARY KEY, donor TEXT NOT NULL, target INTEGER NOT NULL, game_dev TEXT NOT NULL, game_name TEXT NOT NULL,
  txid TEXT NOT NULL UNIQUE, total_msat TEXT NOT NULL, bytes BLOB NOT NULL, signature BLOB NOT NULL, kept_ms INTEGER NOT NULL)`;

/**
 * CHECK AND KEEP ONE GIFT. `g` the decoded record with its `signature`; `recipients` the set this seat holds for its target; `port`
 * the federation's lock port (status, contractId); `db` the seat's store; `verify` BIP340; `keepRows(rows)` the store's
 * putDonationOutputs. Answers { ok, id, kept: 'new' | 'held' } or { ok: false, status, why }.
 */
export async function keepDonationGift({ g, recipients, networkSet = null, gameSet = null, port, db, verify, keepRows, nowMs = Date.now() }) {
  const no = (status, why) => ({ ok: false, status, why });
  const st = giftStands(g, { recipients, networkSet, gameSet, verify, nowMs });
  if (!st.ok) return no(422, st.why);
  const id = toHex(st.id);
  db.exec(DONATION_GIFTS_SQL);
  const had = db.prepare('SELECT id FROM donation_gifts WHERE txid = ?').get(toHex(g.txid));
  if (had && had.id === id) return { ok: true, id, kept: 'held' };
  if (had) return no(409, `transaction ${toHex(g.txid).slice(0, 16)} already paid gift ${had.id.slice(0, 16)}: one payment is one gift`);
  if (!port) return no(503, 'this seat reaches no federation of that gift, so it cannot check its outputs');
  const rows = [];
  for (const o of g.outputs) {
    const outpoint = { txid: g.txid, outIdx: BigInt(o.outIdx) };
    const at = `${toHex(g.txid).slice(0, 16)}…:${o.outIdx}`;
    const [stored, want] = await Promise.all([port.status(outpoint), port.contractId(donationContractFields({ recipientPk: o.pk, amountMsat: o.msat, image: g.donor }))]);
    if (!stored || !stored.stored) return no(409, `the federation holds nothing at ${at} (not accepted yet, or never)`);
    if (String(stored.stored.contractId) !== String(want)) return no(422, `the output at ${at} is not ${o.msat} msat to key ${toHex(o.pk).slice(0, 16)}… from the donor`);
    rows.push({ outpoint, entryId: st.id, roundId: new Uint8Array(32), federationId: g.federationId, recipientPk: o.pk, amountMsat: o.msat,
      contractId: String(stored.stored.contractId), senderOnContract: true, image: toHex(g.donor), item: giftItem(g) });
  }
  db.prepare('INSERT OR IGNORE INTO donation_gifts (id, donor, target, game_dev, game_name, txid, total_msat, bytes, signature, kept_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, toHex(g.donor), g.target, toHex(g.gameDevPubkey), g.gameName || '', toHex(g.txid), String(g.totalMsat), Buffer.from(encodeDonationGift(g)), Buffer.from(g.signature), nowMs);
  if (keepRows) keepRows(rows);
  return { ok: true, id, kept: 'new', outputs: rows.length };
}

/**
 * WHAT A GIFT'S OUTPUTS ARE LISTED AS (GET /donations `item`): a zap, or the set and - from version 2 (kanban #672) - where it was given:
 * "donation · protocol · from site", "donation · protocol + rock-paper-scissors · from app:rock-paper-scissors".
 */
export function giftItem(g) {
  if (g.target === 2) return 'zap';
  const set = g.target === GIFT_TO_BOTH ? `protocol + ${g.gameName}` : g.gameName ? g.gameName : 'protocol';
  return `donation · ${set}${g.origin ? ` · from ${g.origin}` : ''}`;
}

/** The gifts a donor made, as this seat kept them, newest first: [{ id, target, gameName, txid, totalMsat, keptMs }]. */
export function giftsOf(db, donorHex) {
  db.exec(DONATION_GIFTS_SQL);
  return db.prepare('SELECT id, target, game_name, txid, total_msat, kept_ms FROM donation_gifts WHERE donor = ? ORDER BY kept_ms DESC LIMIT 200').all(String(donorHex).toLowerCase())
    .map((r) => ({ id: r.id, target: r.target, gameName: r.game_name, txid: r.txid, totalMsat: r.total_msat, keptMs: r.kept_ms }));
}

// EVERY GIFT AND ZAP FOR THE EXPLORER (kanban #683, 2026-10-26: "I don't see item purchases in the explorer"; #682: a gift "doesn't show in
// the explorer"): the gifts this seat kept after `since` (ms), oldest first, at most `limit` - a seat keeps every gift of its network (each
// is handed on to all), so one seat's list is the network's. By kept_ms, indexed: the explorer asks every minute.
export const DONATION_GIFTS_KEPT_SQL = 'CREATE INDEX IF NOT EXISTS donation_gifts_kept ON donation_gifts (kept_ms)';
export function giftsSince(db, { since = 0, limit = 200 } = {}) {
  db.exec(DONATION_GIFTS_SQL); db.exec(DONATION_GIFTS_KEPT_SQL);
  return db.prepare('SELECT id, bytes, kept_ms FROM donation_gifts WHERE kept_ms > ? ORDER BY kept_ms, id LIMIT ?').all(Number(since), Number(limit)).map((r) => {
    let g; try { g = decodeDonationGift(new Uint8Array(r.bytes)); } catch { return null; }
    return { id: r.id, kind: g.target === 2 ? 'zap' : 'donation', item: giftItem(g), target: g.target, donor: toHex(g.donor),
      gameDev: g.target === 0 ? null : toHex(g.gameDevPubkey), gameName: g.gameName || null, origin: g.origin || null, federation: toHex(g.federationId),
      txid: toHex(g.txid), totalMsat: String(g.totalMsat), outputs: g.outputs.map((o) => ({ outIdx: o.outIdx, pk: toHex(o.pk), msat: String(o.msat) })),
      atMs: Number(g.atMs), keptMs: Number(r.kept_ms) };
  }).filter(Boolean);
}
