// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SEND PLAN COMES ONLY FROM A SEAT OF THE ROUND (kanban #1154, critical).
//
// POST /settle-sends and POST /resend-sends took a plan from anyone: an outsider minted an invoice of its own with the address's
// description hash and the right amount, ground its payment hash until the plan's key sorted lower than the kept one, posted it to every
// seat - and the seats replaced the kept plan with it, the asker adopted it, the settlement built the send contract to the outsider's
// hash and the gateway paid the outsider. Now the plan travels with its proposer's node key and a BIP-340 signature over
//
//   SendPlanAsk = tagged sha256 ("ARENA/v1/SendPlanAsk") of: kind (u8), round id (32), late entry id or 32 zeros, sha256(body)
//
// in the `x-send-plan-ask` header (hex: node key 32 || signature 64). The asked seat takes it only if the key is one of the round's seats
// (the contract's nodes) and the signature covers the very bytes it was sent. A header leaves the body as it was, so a seat that does not
// read it yet takes the plan as before. And a seat's answer to GET /settle-sends is signed the same way (kind 3), so the asker that
// adopts a peer's plan knows which seat kept it.
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256, toHex, fromHex } from '../../arena-protocol/src/hash.js';

export const SEND_PLAN_ASK_HEADER = 'x-send-plan-ask';
/**
 * What the signature is for: a proposed first plan, a re-send, a seat's kept plan as it hands it out - and (kanban #1185) a paid send's preimage
 * handed to the round's other seats (POST /winnings-paid; the body is the 32-byte preimage).
 */
export const PLAN_ASK = Object.freeze({ PROPOSE: 1, RESEND: 2, KEPT: 3, PAID: 4 });

const TAG_HASH = sha256(new TextEncoder().encode('ARENA/v1/SendPlanAsk'));
const bytesOf = (body) => (body instanceof Uint8Array ? body : new TextEncoder().encode(String(body ?? '')));

/** The digest a seat signs: the kind, the round, the late entry (or zeros), and the body's hash. */
export function sendPlanAskDigest({ kind, roundId, lateEntryId = null, body }) {
  if (!Object.values(PLAN_ASK).includes(kind)) throw new Error('a send plan ask is a proposal, a re-send, a kept plan or a paid preimage');
  if (!(roundId instanceof Uint8Array) || roundId.length !== 32) throw new Error('a send plan ask names a 32-byte round');
  if (lateEntryId && (!(lateEntryId instanceof Uint8Array) || lateEntryId.length !== 32)) throw new Error('a late entry is 32 bytes');
  const msg = new Uint8Array(64 + 1 + 32 + 32 + 32);
  msg.set(TAG_HASH, 0); msg.set(TAG_HASH, 32); msg[64] = kind;
  msg.set(roundId, 65); msg.set(lateEntryId || new Uint8Array(32), 97); msg.set(sha256(bytesOf(body)), 129);
  return sha256(msg);
}

/** This seat's signed ask, as the header carries it: hex of its node key and its signature. */
export function signSendPlanAsk({ kind, roundId, lateEntryId = null, body, secret, pubkey }) {
  const sig = schnorr.sign(sendPlanAskDigest({ kind, roundId, lateEntryId, body }), secret);
  return toHex(pubkey) + toHex(sig);
}

/** The headers a seat sends a plan with, or none when it holds no node key (a test's stub store). */
export function sendPlanAskHeaders(round, ask) {
  if (!round || !round.identity || !round.identity.secret || !round.pubkey) return {};
  return { [SEND_PLAN_ASK_HEADER]: signSendPlanAsk({ ...ask, secret: round.identity.secret, pubkey: round.pubkey }) };
}

/** A signed ask against the round's seats and the bytes received: { ok, who } (hex node key) or { ok: false, why }. */
export function checkSendPlanAsk(header, { kind, roundId, lateEntryId = null, body, seats }) {
  const hex = String(header || '').trim().toLowerCase();
  if (!/^[0-9a-f]{192}$/.test(hex)) return { ok: false, why: 'the plan carries no signed ask: a send plan is taken only from a seat of the round, signed by its node key' };
  const who = hex.slice(0, 64);
  if (!(seats || []).some((k) => toHex(k).toLowerCase() === who)) return { ok: false, why: `signed by ${who.slice(0, 16)}, which is not one of the round's seats` };
  let good = false;
  try { good = schnorr.verify(fromHex(hex.slice(64)), sendPlanAskDigest({ kind, roundId, lateEntryId, body }), fromHex(who)); } catch { good = false; }
  return good ? { ok: true, who } : { ok: false, why: `${who.slice(0, 16)}'s signature does not cover this plan for this round` };
}
