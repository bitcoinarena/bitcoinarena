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
//                 everybody once it exists - ranked by H(duty tag || network_id || slot || node key) (BLWP/v1/DUTY, ARENA/v1/DUTY from the switch: tag-switch.js); the first is on duty.
//   POSTED        a slot of an item is posted when a transaction carries its marker, OP_RETURN "ARN" 'D' slot item (duty marker), in the
//                 chain or the mempool, beside the grid's series publications.
//   MISSED        the duty node of the CURRENT slot posts every slot of the last DUTY_LOOKBACK_SLOTS not posted yet, oldest first, before
//                 its own - so a missed slot falls to the next slot's node, and the next after that, until it is posted; at any moment
//                 only the current slot's node posts, and a missed slot keeps more than 4 h of lead.
import { Writer } from './encode.js';
import { taggedHash, bytesToBigInt, sha256, toHex } from './hash.js';
import { TAG } from './constants.js';
import { OP_RETURN, parseTransaction, commitmentsOf } from './tx.js';
import { tagAt } from './tag-switch.js';

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

/** A node's rank for a slot: H_duty(network_id || slot || node key) - the tag by the slot's hour (tag-switch.js, kanban #525). */
export function dutyTicket(networkId, slot, nodeKey) {
  const w = new Writer(); w.bytes32(networkId); w.u32(slot); w.bytes32(nodeKey);
  return bytesToBigInt(taggedHash(tagAt('duty', { ms: slot * 3_600_000 }), w.finish()));
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

/**
 * THE SERIES A POSTING PUBLISHES: the ids of its "ARN" SERIES outputs (36 bytes, kind 'S'), hex - so who posted a day can be read from
 * the series' own signed lines, their creator key (kanban #702, 2026-10-26: "In health also say who posted that round")
 */
export function postedSeriesOf(raw) {
  let tx; try { tx = typeof raw === 'object' && raw.outputs ? raw : parseTransaction(raw); } catch { return []; }
  return commitmentsOf(tx).filter((p) => p.length === 36 && p[0] === 0x41 && p[1] === 0x52 && p[2] === 0x4e && p[3] === 0x53).map((p) => toHex(p.subarray(4, 36)));
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

// THE BACKUP GRID (2026-10-26, the owner: "Yes make it part of the design, in the spec" - a second grid for every day from another node, so
// a day is never without a round; kanban #702). Every day gets a PRIMARY grid from the day's duty node (rank 1, above) and a BACKUP grid from
// the next node in the same order (rank 2; rank 3 an hour later if rank 2 has not posted it, up to DUTY_BACKUP_RANK_CAP), posted on its
// own: its own coins and publication, a census DUTY_BACKUP_CENSUS_DEPTH below the tip (the primary's is 6) taken from DUTY_BACKUP_AFTER_MS
// into the day, so at a later block, and a committee time DUTY_BACKUP_COMMITTEE_LEAD_MS before the day (the primary's 12 h) - one fork,
// reorg or conflicted coin does not take both. It carries the backup marker OP_RETURN "ARN" 'B' day item_tag (12 bytes) in place of the
// duty marker. The node that posted the primary never posts the backup.
//   PLAYED     one grid per window: a round of a backup series is offered, and takes entries, only while no round of the same game,
//              federation and start from a series that is not a backup is drawn on that seat - the primary is played while its committee
//              is drawable, otherwise the backup. A seat that holds an entry in a window's backup round takes none in its other rounds.
//   MISSED     a backup nobody posted leaves the day to its primary (and to the emergency grid when that dies) - nothing more.
export const DUTY_BACKUP_AFTER_MS = 2 * 3600000;
export const DUTY_BACKUP_COMMITTEE_LEAD_MS = 9 * 3600000;
export const DUTY_BACKUP_CENSUS_DEPTH = 12;
export const DUTY_BACKUP_RANK_CAP = 3;
const BACKUP_MAGIC = [0x41, 0x52, 0x4e, 0x42];            // "ARN" 'B'
/** The backup marker's output: "ARN" 'B' || day (u32) || item tag - zero value, OP_RETURN, one direct push. */
export function backupMarkerOutput(slot, itemName) {
  const payload = new Uint8Array(12); payload.set(BACKUP_MAGIC, 0); payload.set(u32(slot), 4); payload.set(itemTag(itemName), 8);
  const script = new Uint8Array(14); script[0] = OP_RETURN; script[1] = 12; script.set(payload, 2);
  return { value: 0n, script };
}
/** Every duty and backup marker a transaction carries: [{ slot, tag hex, kind: 'D' | 'B' }]. */
export function dayMarkersOf(raw) {
  let tx; try { tx = typeof raw === 'object' && raw.outputs ? raw : parseTransaction(raw); } catch { return []; }
  return commitmentsOf(tx).filter((p) => p.length === 12 && p[0] === 0x41 && p[1] === 0x52 && p[2] === 0x4e && (p[3] === 0x44 || p[3] === 0x42))
    .map((p) => ({ slot: new DataView(p.buffer, p.byteOffset).getUint32(4, false), tag: toHex(p.subarray(8, 12)), kind: p[3] === 0x42 ? 'B' : 'D' }));
}
/** Is a series publication a backup grid's: its transaction carries a backup marker. */
export const isBackupPublication = (raw) => dayMarkersOf(raw).some((m) => m.kind === 'B');
/**
 * Is the day's backup due from the node at `rank` (0 = the day's duty node, which never posts it) now: rank 1 from DUTY_BACKUP_AFTER_MS into
 * the day, each next rank an hour later, up to `cap` - not once the day's backup marker is seen, never from the node that posted the primary.
 */
export function backupPostDue({ nowMs, slot, rank, posted, postedPrimary = false, cap = DUTY_BACKUP_RANK_CAP }) {
  if (posted || postedPrimary || !Number.isInteger(rank) || rank < 1) return false;
  return Number(nowMs) >= dayStartMs(slot) + DUTY_BACKUP_AFTER_MS + (Math.min(rank, cap) - 1) * DUTY_FALLBACK_MS && Number(nowMs) < dayStartMs(slot + 1);
}
/**
 * WHICH ROUNDS OF ONE WINDOW ARE PLAYED (the rule above), from what a seat sees of the rounds of one game, federation and start: `rows`
 * [{ id, backup: bool|null, drawn: bool, entries: n }] -> the Set of ids offered. A row whose role is not known yet (its publication not
 * read) counts as not a backup.
 */
export function playedOfWindow(rows) {
  const primaryDrawn = rows.some((r) => !r.backup && r.drawn);
  const backupTaken = rows.some((r) => r.backup && r.entries > 0);
  const out = new Set();
  for (const r of rows) if (r.backup ? !primaryDrawn || r.entries > 0 : !backupTaken || r.entries > 0) out.add(r.id);
  return out;
}
