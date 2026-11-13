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
/** Every kept paid record's key in `storage`. */
export function paidRecordKeys(storage) {
  const st = paidRecordStore(storage); const keys = [];
  try { for (let i = 0; i < st.length; i++) { const k = st.key(i); if (k && (k.startsWith(PAID_PURCHASE_PREFIX) || k.startsWith(PAID_GIFT_PREFIX))) keys.push(k); } } catch { /* none */ }
  return keys;
}
