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
import { PROTOCOL_VERSION, speaksVersion, TYPE_SETTLEMENT_ACK, TYPE_SETTLEMENT_TABLE, TYPE_SETTLEMENT_COMMIT, TAG } from './constants.js';
import { Writer, Reader } from './encode.js';
import { taggedHash, toHex, fromHex } from './hash.js';
import { compareBytes } from './payout.js';
import { OUTCOMES, outcomeByte } from './result.js';
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
 * A SEAT'S SIGNED SETTLEMENT COMMIT (§5A.3 "Stalled in its rounds", RULED 2026-11-02, kanban #1052): from protocol 26 a seat answers a settlement's commit with this beside its
 * nonce commitment, signed by its node key, one signature per seat per settlement as the ack is. It names the transaction and hashes the two nonce points, so the seat that
 * asked holds that seat's word that it committed, and only a seat that did is left off a StallNote.
 */
export const SETTLEMENT_COMMIT_BYTES = 1 + 2 + 32 + 32 + 32;
export const SIGNED_SETTLEMENT_COMMIT_BYTES = SETTLEMENT_COMMIT_BYTES + 32 + 64;
export function settlementCommitBody({ roundId, settlementTxid, hiding, binding }) {
  const nonces = new Uint8Array(hiding.length + binding.length);
  nonces.set(hiding, 0); nonces.set(binding, hiding.length);
  const w = new Writer();
  w.u8(TYPE_SETTLEMENT_COMMIT); w.u16(PROTOCOL_VERSION);
  w.bytes32(roundId); w.bytes32(settlementTxid); w.bytes32(taggedHash(TAG.settlementCommit, nonces));
  return w.finish();
}
/** The commit as it travels: its body, the seat's node key, the seat's BIP-340 signature over the tagged body. `sign(digest)` -> 64 bytes. */
export function signSettlementCommit(commit, nodePubkey, sign) {
  const body = settlementCommitBody(commit);
  const out = new Uint8Array(SIGNED_SETTLEMENT_COMMIT_BYTES);
  out.set(body, 0);
  out.set(nodePubkey, SETTLEMENT_COMMIT_BYTES);
  out.set(sign(taggedHash(TAG.settlementCommit, body)), SETTLEMENT_COMMIT_BYTES + 32);
  return out;
}
/** One seat's signed commit, against what it was asked: { ok, who } or { ok: false, why }. */
export function checkSettlementCommit(bytes, { seats, commit, verify }) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== SIGNED_SETTLEMENT_COMMIT_BYTES) return { ok: false, why: `a signed settlement commit is ${SIGNED_SETTLEMENT_COMMIT_BYTES} bytes` };
  const body = bytes.slice(0, SETTLEMENT_COMMIT_BYTES), nodePubkey = bytes.slice(SETTLEMENT_COMMIT_BYTES, SETTLEMENT_COMMIT_BYTES + 32), who = toHex(nodePubkey);
  if (!seats.some((k) => toHex(k) === who)) return { ok: false, why: `signed by ${who.slice(0, 16)}, which is not one of the round's seats` };
  if (toHex(body) !== toHex(settlementCommitBody(commit))) return { ok: false, why: `${who.slice(0, 16)} committed to other bytes` };
  let good = false;
  try { good = verify(bytes.slice(SETTLEMENT_COMMIT_BYTES + 32), taggedHash(TAG.settlementCommit, body), nodePubkey) === true; } catch { good = false; }
  return good ? { ok: true, who } : { ok: false, why: `${who.slice(0, 16)}'s signature over its commit does not verify` };
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
 * THE TABLE A SEAT ACKS. `rows` are { entryId, pubkey, amountMsat, outcome, score, atTheDoor }, sorted here. `lateEntryId` is the late loser a
 * second settlement is for, zero on the round's own; `federationId` the federation one part of a round that takes any federation settles
 * in, zero otherwise. A round's own settlement of played entries names each row's entry and what the seat held for it; a table with no such
 * entry (a market's, a late loser's: what the plan pays) has entryId zero and no outcome in its rows, and F does not read it.
 *
 * AND THE TRANSACTION IT REBUILDS TO (§5A.3, RULED 2026-11-02, kanban #1043): `claims` and `payouts` in the transaction's order, and its
 * `nonce`. A settlement_txid is the hash of these and the P of each stake claim, so a pair the seat acked either rebuilds or is false by
 * itself. A claim names the entry whose lock it spends: the Entry Contract says which lock that is, and which P opens it.
 */
export const NO_OUTCOME = 255;
export const CLAIM_STAKE = 0;
export const CLAIM_FEE = 1;
const NONCE_BYTES = 8;
const PK_BYTES = 33;
export function encodeSettlementTable({ roundId, lateEntryId = ZERO, federationId = ZERO, nonce = new Uint8Array(NONCE_BYTES), claimPk = new Uint8Array(PK_BYTES), rows, claims = [], payouts = [] }) {
  const w = new Writer();
  w.u8(TYPE_SETTLEMENT_TABLE);
  w.u16(PROTOCOL_VERSION);
  w.bytes32(roundId);
  w.bytes32(lateEntryId);
  w.bytes32(federationId);
  w.bytes(nonce, NONCE_BYTES);
  w.bytes(claimPk, PK_BYTES);
  const sorted = [...rows].sort((a, b) => compareBytes(a.entryId, b.entryId) || compareBytes(a.pubkey, b.pubkey)
    || (a.amountMsat < b.amountMsat ? -1 : a.amountMsat > b.amountMsat ? 1 : 0));
  w.vec(sorted, (row, ww) => {
    ww.bytes32(row.entryId); ww.bytes32(row.pubkey); ww.u64(row.amountMsat);
    ww.u8(row.outcome ? outcomeByte(row.outcome) : NO_OUTCOME); ww.u32(row.score || 0); ww.u8(row.atTheDoor ? 1 : 0);
  });
  w.vec(claims, (c, ww) => {
    ww.bytes32(c.entryId); ww.bytes32(c.outpoint.txid); ww.u64(BigInt(c.outpoint.outIdx)); ww.u64(c.amountMsat); ww.u8(c.kind === 'fee' ? CLAIM_FEE : CLAIM_STAKE);
  });
  w.vec(payouts, (p, ww) => {
    ww.bytes(p.payoutPk, PK_BYTES); ww.u64(p.msat); ww.u8(p.sent ? 1 : 0);
    if (p.sent) { ww.bytes32(fromHex(p.sent.paymentHash)); ww.bytes(fromHex(p.sent.gatewayPk), PK_BYTES); ww.u64(BigInt(p.sent.expiration)); }
  });
  return w.finish();
}

export function decodeSettlementTable(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== TYPE_SETTLEMENT_TABLE) throw new Error('not a settlement table');
  if (!speaksVersion(r.u16())) throw new Error('unknown protocol version');
  const out = { roundId: r.bytes32(), lateEntryId: r.bytes32(), federationId: r.bytes32(), nonce: r.bytes(NONCE_BYTES), claimPk: r.bytes(PK_BYTES),
    rows: r.vec((rr) => {
      const row = { entryId: rr.bytes32(), pubkey: rr.bytes32(), amountMsat: rr.u64() };
      const said = rr.u8(), score = rr.u32(), door = rr.u8();
      if (said !== NO_OUTCOME && !OUTCOMES[said]) throw new Error(`${said} is no outcome`);
      return { ...row, ...(said === NO_OUTCOME ? {} : { outcome: OUTCOMES[said] }), score, ...(door ? { atTheDoor: true } : {}) };
    }),
    claims: r.vec((rr) => {
      const c = { entryId: rr.bytes32(), outpoint: { txid: rr.bytes32(), outIdx: rr.u64() }, amountMsat: rr.u64() };
      return { ...c, kind: rr.u8() === CLAIM_FEE ? 'fee' : 'stake' };
    }),
    payouts: r.vec((rr) => {
      const p = { payoutPk: rr.bytes(PK_BYTES), msat: rr.u64() };
      if (!rr.u8()) return p;
      return { ...p, sent: { paymentHash: toHex(rr.bytes32()), gatewayPk: toHex(rr.bytes(PK_BYTES)), expiration: rr.u64() } };
    }) };
  if (r.at !== bytes.length) throw new Error('trailing bytes after the settlement table');
  return out;
}

export const settlementTableId = (t) => taggedHash(TAG.settlementTable, encodeSettlementTable(t));

/** The table of a plan with no entries of its own: what it pays, by the x-only half of each payout key. */
export const planTableRows = (plan) => (plan.payouts || []).map((p) => ({ entryId: ZERO, pubkey: p.payoutPk.subarray(p.payoutPk.length - 32), amountMsat: p.msat }));

/** A plan's claims and payouts as a table lists them: each claim by the entry whose lock it spends (`entryOf(claim)`), zero if it has none. */
export const planTableBuild = (plan, entryOf) => ({
  nonce: plan.nonce,
  claims: (plan.claims || []).map((c) => ({ entryId: entryOf(c) || ZERO, outpoint: c.outpoint, amountMsat: c.amountMsat, kind: c.kind === 'fee' ? 'fee' : 'stake' })),
  payouts: (plan.payouts || []).map((p) => ({ payoutPk: p.payoutPk, msat: p.msat, ...(p.sent ? { sent: p.sent } : {}) })),
});

export const namesNoEntry = (row) => !is32(row.entryId) || row.entryId.every((b) => b === 0);
