// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A PAID RECORD IS KEPT UNTIL THE SEATS KEEP IT (kanban #2274): an item purchase (item-buy.js) or a gift / zap (donation-gift-page.js) pays
// first and hands its signed record to the seats after (handToSeats: kept when two seats keep it, #2420). A record the seats did not keep
// was dropped before, and the next press of Buy or Give paid a second time - the first payment's outputs named by no record. Now the
// purchase (the gift) is written ahead from the moment the federation answers the payment, and again with its signed body; the next press
// of THE SAME purchase (the same item by the same buyer) or THE SAME gift (the same donor, target and amount) hands that body again
// instead of paying, and the record goes once the seats kept it. A different gift is paid as before. resendPaidRecords (item-buy.js)
// hands every kept body again when the page loads.
// Invariant: one item (one gift press), one payment - a paid purchase's record is handed again, never paid again.
import { putRoomy } from './page-lock.js';

export const PAID_PURCHASE_PREFIX = 'arena.purchase.';
export const PAID_GIFT_PREFIX = 'arena.gift.';

// a caller that hands no storage (a tool, a test) keeps them for the life of the module
const paidRecordsInMemory = new Map();
const paidRecordsMemStore = { getItem: (k) => (paidRecordsInMemory.has(k) ? paidRecordsInMemory.get(k) : null), setItem: (k, v) => paidRecordsInMemory.set(k, String(v)),
  removeItem: (k) => paidRecordsInMemory.delete(k), key: (i) => [...paidRecordsInMemory.keys()][i] ?? null, get length() { return paidRecordsInMemory.size; } };
export const paidRecordStore = (storage) => storage || paidRecordsMemStore;

export function paidRecordGet(storage, key) {
  try { const v = paidRecordStore(storage).getItem(key); return v ? JSON.parse(v) : null; } catch { return null; }
}
/** Written with putRoomy: a write the browser refuses throws, and nothing is paid on a record that could not be written ahead. */
export function paidRecordPut(storage, key, rec) { putRoomy(paidRecordStore(storage), key, JSON.stringify(rec)); }
/** Dropped once the seats kept it (a storage with no removeItem gets it emptied, which reads as none). */
export function paidRecordDrop(storage, key) {
  try { const st = paidRecordStore(storage); if (typeof st.removeItem === 'function') st.removeItem(key); else st.setItem(key, ''); } catch { /* kept: handed again, a seat answers it the same */ }
}
/** A NEW WRITE-AHEAD'S OWN MARK (kanban #3105, refute of #3081): a random id, so the drop below can tell this record from another tab's. */
export function paidRecordMark() {
  const r = new Uint8Array(12);
  try { globalThis.crypto.getRandomValues(r); } catch { for (let i = 0; i < r.length; i++) r[i] = Math.floor(Math.random() * 256); }
  return [...r].map((b) => b.toString(16).padStart(2, '0')).join('');
}
/**
 * DROPPED ONLY WHEN THE KEY STILL HOLDS THIS PAYMENT (kanban #3105, refute of #3081): two tabs of one player share the key of one purchase
 * (one gift). Tab A awaited the guardians' refusal of payment T1 while tab B read the same refusal first, dropped it, was pressed again and
 * paid T2 under the same key; A's late refusal then dropped T2's paid record (not yet kept by two seats), and the next press paid a third
 * time. Every drop now reads the key again and drops only the record `rec` stands for: the same submitted txid, or - not submitted yet -
 * the same write-ahead mark. Another payment kept there since stays.
 */
export function paidRecordDropIf(storage, key, rec) {
  const now = paidRecordGet(storage, key);
  if (!now || !rec) return;
  const same = rec.submitted
    ? !!(now.submitted && now.submitted.txid && now.submitted.txid === rec.submitted.txid)
    : !now.submitted && (rec.mark ? now.mark === rec.mark : !now.mark && now.boughtAtMs === rec.boughtAtMs && now.atMs === rec.atMs);
  if (same) paidRecordDrop(storage, key);
}
/**
 * WRITTEN ONLY OVER ITS OWN RECORD (kanban #3116, #3117, refute of #3081 / #3105 - the twin of paidRecordDropIf): every put after the
 * write-ahead reads the key again. Tab A's paySubmit answered late; meanwhile tab B dropped A's unanswered write-ahead and the player paid
 * T2 under the same key. A's put then wrote T1 over T2, the guardians refused T1, and A's drop-if matched its own T1: T2's paid record
 * was gone and the next press paid again. Now the record is written where it stands only while the key holds nothing, this record's
 * write-ahead (its mark) or the same submitted txid; when another payment holds the key, this one is kept beside it under
 * `<key>.<its mark>` (paidRecordKeys and paidRecordFind read both). Answers the key the record is kept under; throws as paidRecordPut.
 */
const ALT_SUFFIX = /^[0-9a-f]{24}$/;
export function paidRecordPutIf(storage, key, rec) {
  const now = paidRecordGet(storage, key);
  // a submitted record there is this one only by its txid; an unanswered write-ahead only by its mark
  const mine = !now || (now.submitted ? !!(rec.submitted && now.submitted.txid === rec.submitted.txid) : (rec.mark ? now.mark === rec.mark : !now.mark));
  if (mine) { paidRecordPut(storage, key, rec); return key; }
  if (!rec.mark) rec.mark = paidRecordMark();
  const beside = `${key}.${rec.mark}`;
  paidRecordPut(storage, beside, rec);
  return beside;
}
/**
 * THE KEPT RECORD OF ONE PURCHASE (ONE GIFT) (kanban #3117): the key's own record when it was submitted, else one kept beside it
 * (paidRecordPutIf) that was, else the key's unanswered write-ahead. Answers { key, rec } or null.
 */
export function paidRecordFind(storage, key) {
  const own = paidRecordGet(storage, key);
  if (own && own.submitted) return { key, rec: own };
  for (const k of paidRecordKeys(storage)) {
    if (!k.startsWith(`${key}.`) || !ALT_SUFFIX.test(k.slice(key.length + 1))) continue;
    const rec = paidRecordGet(storage, k);
    if (rec && rec.submitted) return { key: k, rec };
  }
  return own ? { key, rec: own } : null;
}
/**
 * THE WALLET OF A KEPT RECORD'S OWN FEDERATION (kanban #3116, refute of #3081): a payment T1 from F1 is finished - its acceptance or the
 * guardians' refusal read - only by F1's wallet. The page hands the first federation holding the price (buy) or the richest (a gift);
 * once T1 was refused (its notes spent in another tab, F1 short) that was F2, and every press answered "paid from F1, nothing is paid
 * again" forever. `walletOf(fid)` or `wallets` (the page's ARENA_WALLETS map, fid -> lock client) names F1's wallet whatever its
 * balance. Answers the client or null.
 */
export function paidRecordWallet({ walletOf = null, wallets = null } = {}, fid) {
  const want = String(fid || '').toLowerCase();
  if (!want) return null;
  try {
    if (typeof walletOf === 'function') { const w = walletOf(fid); if (w) return w; }
    if (wallets && typeof wallets.get === 'function') {
      const w = wallets.get(fid); if (w) return w;
      for (const [k, c] of wallets) if (String(k).toLowerCase() === want) return c;
    }
  } catch { /* none */ }
  return null;
}
/** Every kept paid record's key in `storage`. */
export function paidRecordKeys(storage) {
  const st = paidRecordStore(storage); const keys = [];
  try { for (let i = 0; i < st.length; i++) { const k = st.key(i); if (k && (k.startsWith(PAID_PURCHASE_PREFIX) || k.startsWith(PAID_GIFT_PREFIX))) keys.push(k); } } catch { /* none */ }
  return keys;
}
