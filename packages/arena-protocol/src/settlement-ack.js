// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SEAT'S OWN WORD ON A SETTLEMENT (§5A.3, RULED 2026-11-02, kanban #1035, #1040). A FROST signature names nobody, so a settlement it
// signs can show nothing about who signed it. A row of the slash table stands only on bytes the accused signed with its node key, and
// this is that object: before a seat joins the FROST signing it signs
//
//   SettlementAck { round_id, payout_table_id, settlement_txid }
//
// and it joins only holding acks from at least the threshold over the same three. The acks are published with the settlement.
// `payout_table_id` is the id of the table the seat computed: rows name their entry, so what a seat said about each entry is its own word
// and nobody filing a proof can choose which of a player's entries a row meant. No curve lives in this package: `verify` and `sign` are injected.
import { PROTOCOL_VERSION, speaksVersion, TYPE_SETTLEMENT_ACK, TYPE_SETTLEMENT_TABLE, TAG } from './constants.js';
import { Writer, Reader } from './encode.js';
import { taggedHash, toHex } from './hash.js';
import { compareBytes } from './payout.js';
import { receiptsNeeded } from './threshold.js';

export const SETTLEMENT_ACK_BYTES = 1 + 2 + 32 + 32 + 32;
export const SIGNED_SETTLEMENT_ACK_BYTES = SETTLEMENT_ACK_BYTES + 32 + 64;
const ZERO = new Uint8Array(32);
const is32 = (b) => b instanceof Uint8Array && b.length === 32;

export function encodeSettlementAck({ roundId, payoutTableId, settlementTxid }) {
  const w = new Writer();
  w.u8(TYPE_SETTLEMENT_ACK);
  w.u16(PROTOCOL_VERSION);
  w.bytes32(roundId);
  w.bytes32(payoutTableId);
  w.bytes32(settlementTxid);
  return w.finish();
}

export function decodeSettlementAck(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== TYPE_SETTLEMENT_ACK) throw new Error('not a settlement ack');
  if (!speaksVersion(r.u16())) throw new Error('unknown protocol version');
  const out = { roundId: r.bytes32(), payoutTableId: r.bytes32(), settlementTxid: r.bytes32() };
  if (r.at !== bytes.length) throw new Error('trailing bytes after the settlement ack');
  return out;
}

export const settlementAckId = (a) => taggedHash(TAG.settlementAck, encodeSettlementAck(a));

/** The ack as it travels: its body, the seat's node key, the seat's BIP-340 signature over `settlementAckId`. `sign(digest)` -> 64 bytes. */
export function signSettlementAck(ack, nodePubkey, sign) {
  const out = new Uint8Array(SIGNED_SETTLEMENT_ACK_BYTES);
  out.set(encodeSettlementAck(ack), 0);
  out.set(nodePubkey, SETTLEMENT_ACK_BYTES);
  out.set(sign(settlementAckId(ack)), SETTLEMENT_ACK_BYTES + 32);
  return out;
}

export function splitSignedAck(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== SIGNED_SETTLEMENT_ACK_BYTES)
    throw new Error(`a signed settlement ack is ${SIGNED_SETTLEMENT_ACK_BYTES} bytes`);
  return {
    ack: decodeSettlementAck(bytes.slice(0, SETTLEMENT_ACK_BYTES)),
    nodePubkey: bytes.slice(SETTLEMENT_ACK_BYTES, SETTLEMENT_ACK_BYTES + 32),
    signature: bytes.slice(SETTLEMENT_ACK_BYTES + 32),
  };
}

/** One seat's ack, checked: { ok, who, nodePubkey } or { ok: false, why } naming what was wrong. */
export function checkAck(bytes, { seats, roundId, payoutTableId, settlementTxid, verify }) {
  let got;
  try { got = splitSignedAck(bytes); } catch (e) { return { ok: false, why: `no signed ack (${e.message})` }; }
  const who = toHex(got.nodePubkey);
  if (!seats.some((k) => toHex(k) === who)) return { ok: false, why: `signed by ${who.slice(0, 16)}, which is not one of the round's seats` };
  if (toHex(got.ack.roundId) !== toHex(roundId)) return { ok: false, why: `${who.slice(0, 16)} acked another round` };
  if (toHex(got.ack.settlementTxid) !== toHex(settlementTxid)) return { ok: false, why: `${who.slice(0, 16)} acked another settlement (${toHex(got.ack.settlementTxid).slice(0, 16)})` };
  if (toHex(got.ack.payoutTableId) !== toHex(payoutTableId)) return { ok: false, why: `${who.slice(0, 16)} computed another table (${toHex(got.ack.payoutTableId).slice(0, 16)})` };
  let good = false;
  try { good = verify(got.signature, settlementAckId(got.ack), got.nodePubkey) === true; } catch { good = false; }
  if (!good) return { ok: false, why: `${who.slice(0, 16)}'s signature over the ack does not verify` };
  return { ok: true, who, nodePubkey: got.nodePubkey };
}

/**
 * THE THRESHOLD OF ACKS: distinct seats, each verified, over one (round, table, txid), against `receiptsNeeded(slots)`: 2 of 2, 5 of 7.
 * Answers the count, the need, the acks that counted and every one that did not, named.
 */
export function countAcks({ acks, seats, slots = seats.length, roundId, payoutTableId, settlementTxid, verify }) {
  const needed = receiptsNeeded(slots);
  const seen = new Set();
  const kept = [];
  const refused = [];
  for (const bytes of acks || []) {
    const c = checkAck(bytes, { seats, roundId, payoutTableId, settlementTxid, verify });
    if (!c.ok) { refused.push(c.why); continue; }
    if (seen.has(c.who)) continue;
    seen.add(c.who);
    kept.push(bytes);
  }
  return { agreed: kept.length, needed, final: kept.length >= needed, kept, refused };
}

export function joinAcks(list) {
  const out = new Uint8Array(list.length * SIGNED_SETTLEMENT_ACK_BYTES);
  list.forEach((b, i) => out.set(b, i * SIGNED_SETTLEMENT_ACK_BYTES));
  return out;
}

export function splitAcks(bytes) {
  const out = [];
  if (!(bytes instanceof Uint8Array)) return out;
  for (let i = 0; i + SIGNED_SETTLEMENT_ACK_BYTES <= bytes.length; i += SIGNED_SETTLEMENT_ACK_BYTES) out.push(bytes.slice(i, i + SIGNED_SETTLEMENT_ACK_BYTES));
  return out;
}

/**
 * THE TABLE A SEAT ACKS. `rows` are { entryId, pubkey, amountMsat }, sorted here. `lateEntryId` is the late loser a second settlement
 * is for, zero on the round's own. A round's own settlement of played entries names each row's entry; a table with no such entry (a
 * market's, a late loser's: what the plan pays) has entryId zero in its rows, and row 3 does not read it, because F does not make it.
 */
export function encodeSettlementTable({ roundId, lateEntryId = ZERO, rows }) {
  const w = new Writer();
  w.u8(TYPE_SETTLEMENT_TABLE);
  w.u16(PROTOCOL_VERSION);
  w.bytes32(roundId);
  w.bytes32(lateEntryId);
  const sorted = [...rows].sort((a, b) => compareBytes(a.entryId, b.entryId) || compareBytes(a.pubkey, b.pubkey)
    || (a.amountMsat < b.amountMsat ? -1 : a.amountMsat > b.amountMsat ? 1 : 0));
  w.vec(sorted, (row, ww) => { ww.bytes32(row.entryId); ww.bytes32(row.pubkey); ww.u64(row.amountMsat); });
  return w.finish();
}

export function decodeSettlementTable(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== TYPE_SETTLEMENT_TABLE) throw new Error('not a settlement table');
  if (!speaksVersion(r.u16())) throw new Error('unknown protocol version');
  const out = { roundId: r.bytes32(), lateEntryId: r.bytes32(), rows: r.vec((rr) => ({ entryId: rr.bytes32(), pubkey: rr.bytes32(), amountMsat: rr.u64() })) };
  if (r.at !== bytes.length) throw new Error('trailing bytes after the settlement table');
  return out;
}

export const settlementTableId = (t) => taggedHash(TAG.settlementTable, encodeSettlementTable(t));

/** The table of a plan with no entries of its own: what it pays, by key. */
export const planTableRows = (plan) => (plan.payouts || []).map((p) => ({ entryId: ZERO, pubkey: p.payoutPk, amountMsat: p.msat }));

export const namesNoEntry = (row) => !is32(row.entryId) || row.entryId.every((b) => b === 0);
