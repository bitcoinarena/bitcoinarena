// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SEATS AGREE BEFORE A WINNER IS PAID, AS A THRESHOLD OF SIGNATURES (2026-09-29 17:33, PRIORITIES item 2:
// "Seats agree before a winner payout as a threshold, not over HTTP. Prove it on regtest." §20: nodes sign what the
// round owes and a threshold of matching signatures makes it final; §23.2: every settlement node signs only what it
// rebuilt itself).
//
// Before this, the asker counted the peers whose POST /settle-sends answered 201: a status code, not a vote. Anything
// that could answer 201 on a peer's address - a proxy, a half-restarted node, a stranger - counted as a seat that took
// the plan. Now a seat that checked the plan and kept it answers with its node key's BIP-340 signature over the plan's
// id, and the asker counts only signatures that verify, by keys the round's contract seats, one per key, over the id
// the asker computed from the plan it proposed. HTTP carries the bytes; it decides nothing.
//
// THE ID IS THE PLAN, NOT ITS ORDER KEY. `planKey` names a plan by its payment hashes only; the id here covers every
// field a seat checked - the entry, the attempt, the address, the invoice, the amounts, the gateway, the expiration -
// so a signature over one plan is never a vote for another with the same invoices and different money.
import { schnorr } from '@noble/curves/secp256k1.js';
import { receiptsNeeded } from '../../arena-protocol/src/threshold.js';
import { toHex, sha256 } from '../../arena-protocol/src/hash.js';

const TAG = new TextEncoder().encode('ARENA/v1/SendPlanTaken');
const TAG_HASH = sha256(TAG);

/** node key, the plan id it signed, the signature: a fixed 128 bytes. */
export const PLAN_TAKEN_BYTES = 32 + 32 + 64;

const sorted = (v) => (v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])]))
  : Array.isArray(v) ? v.map(sorted) : v);

/**
 * THE PLAN'S ID: tagged SHA-256 over the round, the late entry (or 32 zero bytes), and the plan's rows in their JSON form
 * (`sendPlanToJson`), each row's keys sorted and the rows sorted by payment hash - what the asker sent and what the seat
 * parsed give the same bytes.
 */
export function planTakenId({ roundId, lateEntryId = null, rows }) {
  const canon = (rows || []).map(sorted).sort((a, b) => (String(a.paymentHash) < String(b.paymentHash) ? -1 : 1));
  const body = new TextEncoder().encode(JSON.stringify(canon));
  const late = lateEntryId || new Uint8Array(32);
  const msg = new Uint8Array(64 + 32 + 32 + body.length);
  msg.set(TAG_HASH, 0); msg.set(TAG_HASH, 32); msg.set(roundId, 64); msg.set(late, 96); msg.set(body, 128);
  return sha256(msg);
}

/** This seat's word that it checked and kept the plan: its key, the id, its signature over the id. */
export function signPlanTaken({ planId, secret, pubkey }) {
  const out = new Uint8Array(PLAN_TAKEN_BYTES);
  out.set(pubkey, 0); out.set(planId, 32); out.set(schnorr.sign(planId, secret), 64);
  return out;
}

export function splitPlanTaken(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== PLAN_TAKEN_BYTES)
    throw new Error(`a seat's signed acceptance of a send plan is ${PLAN_TAKEN_BYTES} bytes`);
  return { nodePubkey: bytes.subarray(0, 32), planId: bytes.subarray(32, 64), signature: bytes.subarray(64) };
}

/**
 * ONE SEAT'S ANSWER, checked: a key the contract seats, a signature that verifies, over this plan's id. Returns
 * { ok, who } or { ok: false, why } naming what was wrong - an unsigned 201 is "no signed acceptance", not a yes.
 */
export function checkPlanTaken(bytes, { seats, planId }) {
  let split;
  try { split = splitPlanTaken(bytes); } catch (e) { return { ok: false, why: `no signed acceptance (${e.message})` }; }
  const who = toHex(split.nodePubkey);
  if (!seats.some((k) => toHex(k) === who)) return { ok: false, why: `signed by ${who.slice(0, 16)}, which is not one of the round's seats` };
  if (toHex(split.planId) !== toHex(planId)) return { ok: false, why: `${who.slice(0, 16)} signed another plan (${toHex(split.planId).slice(0, 16)}), not this one` };
  let good = false;
  try { good = schnorr.verify(split.signature, split.planId, split.nodePubkey); } catch { good = false; }
  if (!good) return { ok: false, why: `${who.slice(0, 16)}'s signature over the plan does not verify` };
  return { ok: true, who };
}

/**
 * THE THRESHOLD: the asker's own signature and the peers' verified ones, one per seat, against `receiptsNeeded` of the
 * round's seats - 2 of 2, 5 of 7. `answers` are { base, bytes } or { base, why }. Returns the count, the need, the
 * certificate (the signed acceptances that counted) and every answer that did not count, named.
 */
export function countPlanTaken({ own, answers, seats, planId }) {
  const needed = receiptsNeeded(seats.length);
  const seen = new Set();
  const certificate = [];
  const refused = [];
  for (const a of [{ base: 'this seat', bytes: own }, ...answers]) {
    if (!a.bytes) { refused.push(`${a.base}: ${a.why || 'no signed acceptance'}`); continue; }
    const c = checkPlanTaken(a.bytes, { seats, planId });
    if (!c.ok) { refused.push(`${a.base}: ${c.why}`); continue; }
    if (seen.has(c.who)) { refused.push(`${a.base}: ${c.who.slice(0, 16)} already counted`); continue; }
    seen.add(c.who);
    certificate.push(a.bytes);
  }
  return { agreed: certificate.length, needed, final: certificate.length >= needed, certificate, refused };
}

/** A certificate on the wire: the signed acceptances, concatenated. */
export const joinCertificate = (list) => {
  const out = new Uint8Array(list.length * PLAN_TAKEN_BYTES);
  list.forEach((b, i) => out.set(b, i * PLAN_TAKEN_BYTES));
  return out;
};
export const splitCertificate = (bytes) => {
  const out = [];
  for (let i = 0; i + PLAN_TAKEN_BYTES <= bytes.length; i += PLAN_TAKEN_BYTES) out.push(bytes.slice(i, i + PLAN_TAKEN_BYTES));
  return out;
};
