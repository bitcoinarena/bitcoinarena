// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE DUTY TO POST THE ROUNDS 24 H AHEAD (2026-10-13 ~18:35Z): "Wir müssen jeden Tag verlässlich follow up rounds
// für alle Spiele und Networks posten, jeden Tag für die nächsten 24h. Das macht immer eine bestimmte deterministische node die gerade
// Dienst hat ... diese node postet die Runden die in 24h starten. Wichtig ist dass keine gap entsteht. Wenn die Node ihren Slot verpasst,
// macht die nächste Node, verantwortlich für die nächste Runde das ... Bis es gepostet ist. Nur eine node postet die runde."
//
//   SLOT          one UTC hour. Slot i's duty is the rounds of hour i + 24: [(i + 24) h, (i + 25) h), for every plan item (a game in a
//                 network/federation) - one grid each.
//   WHO           the census at the slot's anchor - the first block whose median time past is beyond the slot's start less 3 h, fixed for
//                 everybody once it exists - ranked by H('BLWP/v1/DUTY' || network_id || slot || node key); the first is on duty.
//   POSTED        a slot of an item is posted when a transaction carries its marker, OP_RETURN "ARN" 'D' slot item (duty marker), in the
//                 chain or the mempool, beside the grid's series publications.
//   MISSED        the duty node of the CURRENT slot posts every slot of the last DUTY_LOOKBACK_SLOTS not posted yet, oldest first, before
//                 its own - so a missed slot falls to the next slot's node, and the next after that, until it is posted; at any moment
//                 only the current slot's node posts, and a missed slot keeps more than 4 h of lead.
import { Writer } from './encode.js';
import { taggedHash, bytesToBigInt, sha256, toHex } from './hash.js';
import { TAG } from './constants.js';
import { OP_RETURN, parseTransaction, commitmentsOf } from './tx.js';

export const DUTY_SLOT_MS = 3600000;
export const DUTY_AHEAD_SLOTS = 24;
export const DUTY_LOOKBACK_SLOTS = 20;
export const DUTY_ANCHOR_BACK_MS = 3 * 3600000;
/** A grid's committee time is its first start less this: long enough for the publication to confirm and its beacon to be 6 deep. */
export const DUTY_COMMITTEE_LEAD_MS = 6 * 3600000;

export const slotOf = (ms) => Math.floor(Number(ms) / DUTY_SLOT_MS);
export const slotStartMs = (slot) => slot * DUTY_SLOT_MS;
/** The hour whose rounds slot `slot` posts: [start, end) ms. */
export const targetWindow = (slot) => ({ startMs: (slot + DUTY_AHEAD_SLOTS) * DUTY_SLOT_MS, endMs: (slot + DUTY_AHEAD_SLOTS + 1) * DUTY_SLOT_MS });

/**
 * THE SLOT'S ANCHOR HEIGHT: the first block whose median time past is beyond the slot's start less 3 h. `mtpAt(height)` the chain's
 * median time past (s) at a height; `tip`. Median time never falls, so the answer is the same for everybody once the block exists;
 * null while it does not.
 */
export async function anchorHeight(slot, { mtpAt, tip, low = 0, slotMs = DUTY_SLOT_MS }) {
  const want = (slot * slotMs - DUTY_ANCHOR_BACK_MS) / 1000;
  if ((await mtpAt(tip)) <= want) return null;
  let lo = low, hi = tip;                              // the first h with mtp > want, by bisection (mtp is non-decreasing)
  while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if ((await mtpAt(mid)) > want) hi = mid; else lo = mid + 1; }
  return lo;
}

const u32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, false); return b; };

/** A node's rank for a slot: H_duty(network_id || slot || node key). */
export function dutyTicket(networkId, slot, nodeKey) {
  const w = new Writer(); w.bytes32(networkId); w.u32(slot); w.bytes32(nodeKey);
  return bytesToBigInt(taggedHash(TAG.duty, w.finish()));
}

/** The slot's nodes in duty order (node keys, 32 bytes each; one per key): the first is on duty. */
export function dutyOrder({ networkId, slot, nodeKeys }) {
  const keys = [...new Map((nodeKeys || []).map((k) => [toHex(k), k])).values()];
  return keys.map((k) => ({ k, t: dutyTicket(networkId, slot, k) })).sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0)).map((x) => x.k);
}

/** A plan item's 4-byte tag: the first 4 bytes of sha256 of its name ("rps-fed-337ae01a", "updown-fed-...") - fixed by the name. */
export const itemTag = (name) => sha256(new TextEncoder().encode(String(name))).subarray(0, 4);

const MAGIC = [0x41, 0x52, 0x4e, 0x44];                   // "ARN" 'D'
/** The duty marker's payload: "ARN" 'D' || slot (u32) || item tag (4 bytes) - 12 bytes. */
export function dutyMarkerPayload(slot, itemName) {
  const p = new Uint8Array(12); p.set(MAGIC, 0); p.set(u32(slot), 4); p.set(itemTag(itemName), 8); return p;
}
/** The output that carries it: zero value, OP_RETURN, one direct push. */
export function dutyMarkerOutput(slot, itemName) {
  const payload = dutyMarkerPayload(slot, itemName);
  const script = new Uint8Array(2 + payload.length); script[0] = OP_RETURN; script[1] = payload.length; script.set(payload, 2);
  return { value: 0n, script };
}
/** The duty markers a transaction carries: [{ slot, tag hex }]. */
export function dutyMarkersOf(raw) {
  let tx; try { tx = typeof raw === 'object' && raw.outputs ? raw : parseTransaction(raw); } catch { return []; }
  return commitmentsOf(tx).filter((p) => p.length === 12 && MAGIC.every((b, i) => p[i] === b))
    .map((p) => ({ slot: new DataView(p.buffer, p.byteOffset).getUint32(4, false), tag: toHex(p.subarray(8, 12)) }));
}

/** A slot before the current one counts as missed only this long into the current slot: a last-minute post has time to be seen. */
export const DUTY_MISS_GRACE_MS = 5 * 60000;

/**
 * WHAT THE CURRENT SLOT'S DUTY NODE POSTS NOW for one item: its own slot, and - from DUTY_MISS_GRACE_MS into its slot - every earlier
 * slot of the last DUTY_LOOKBACK_SLOTS whose marker is not seen (`posted` a Set of slots), oldest first. [] for a node not on duty.
 */
export function slotsToPost({ nowMs, onDuty, posted, lookback = DUTY_LOOKBACK_SLOTS }) {
  if (!onDuty) return [];
  const nowSlot = slotOf(nowMs);
  const out = [];
  const missedToo = Number(nowMs) - slotStartMs(nowSlot) >= DUTY_MISS_GRACE_MS;
  if (missedToo) for (let i = nowSlot - lookback; i < nowSlot; i++) if (!posted.has(i)) out.push(i);
  if (!posted.has(nowSlot)) out.push(nowSlot);
  return out;
}

// ONE POSTING PER GAME PER DAY (2026-10-14 ~11:22Z: "Each game may only have one round posting per day and the fees must be as low
// as possible"). The slot is a UTC day: day d's duty is the rounds of day d + 1 - one transaction per game carrying every federation's
// series of it, at the lowest fee the network relays. Who posts: the census at the day's anchor in duty order, as above; the first is due
// from the day's start, and each next one an hour after the one before it while the day's marker is not seen - so a missed post falls
// to the next node within the same day, long before the grid's committee time (the next day's start less DUTY_COMMITTEE_LEAD_MS).
export const DUTY_DAY_MS = 86400000;
export const DUTY_FALLBACK_MS = 3600000;
export const daySlotOf = (ms) => Math.floor(Number(ms) / DUTY_DAY_MS);
export const dayStartMs = (slot) => slot * DUTY_DAY_MS;
/** The day whose rounds day `slot` posts: [start, end) ms - the next day. */
export const targetDay = (slot) => ({ startMs: (slot + 1) * DUTY_DAY_MS, endMs: (slot + 2) * DUTY_DAY_MS });
/** Is the day's post due from the node at `rank` (0 = first in duty order) now? Not once the day's marker is seen (`posted`). */
export function dayPostDue({ nowMs, slot, rank, posted }) {
  if (posted || !Number.isInteger(rank) || rank < 0) return false;
  return Number(nowMs) >= dayStartMs(slot) + rank * DUTY_FALLBACK_MS && Number(nowMs) < dayStartMs(slot + 1);
}
