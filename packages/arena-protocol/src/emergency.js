// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OWNER'S EMERGENCY KEY (spec §23A.5a, protocol 17): a node that will be offline longer than it may be absent is taken out by its
// owner, from any other node or the Arena site, with a key that can do nothing else - and keeps its bond.
//
//   THE CODE     16 bytes derived from the node's 24 words (seed) under ARENA/v1/EmergencyKey, written as ARN-XXXX-... (Crockford
//                base32 with a check byte). The owner writes it down at install; the 24 words are never typed anywhere else.
//   THE KEY      its secret is ARENA/v1/EmergencySecret over the code's 16 bytes; the bond advert names its public key (advert.js).
//   THE REQUEST  (node_key, posted_at), signed by that key under ARENA/v1/EmergencyDeparture, posted to any seat.
//   THE EFFECT   no guardian role: out of the seating from posted_at, bond untouched. A guardian: DEPARTED at once when the request
//                was posted before abandon_blocks from his last seen height, bond untouched; later, abandonment as before.
//
// NO CURVE: `sign(digest)` and `verify(signature, digest, pubkey)` are injected (BIP-340), as in absence.js.
import { Writer, Reader } from './encode.js';
import { taggedHash, toHex } from './hash.js';
import { TAG, PROTOCOL_VERSION, TYPE_EMERGENCY_DEPARTURE } from './constants.js';

const emIs32 = (b) => b instanceof Uint8Array && b.length === 32;
const emHeight = (h, what) => { if (!Number.isInteger(h) || h < 0 || h > 0xffffffff) throw new Error(`${what} is a block height`); };

/**
 * A REQUEST IS TAKEN ONLY FRESH: posted_at is the signer's own word, so a seat takes a request (POST /emergency-departure, or from a
 * peer) only while its tip is at most this many blocks past posted_at - a late owner cannot date a request back into time. A seat
 * signs a guardian DEPARTED only for a request it took itself (federation-records.js).
 */
export const EMERGENCY_FRESH_BLOCKS = 6;

// THE CODE: Crockford base32 (no I, L, O, U; read I/L as 1 and O as 0), 16 bytes and 1 check byte = 136 bits = 28 characters
const EM_B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const EM_CODE_BYTES = 16;
const emCheckByte = (bytes) => taggedHash(TAG.emergencyKey, bytes)[0];

/** The 16 bytes of a node's emergency code, from its seed (the 24 words' 32 bytes). */
export function emergencyCodeBytes(seed) {
  if (!(seed instanceof Uint8Array) || seed.length < 16) throw new Error('an emergency code is derived from the node\'s seed');
  return taggedHash(TAG.emergencyKey, seed).slice(0, EM_CODE_BYTES);
}

/** The code as the owner writes it: ARN-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX. */
export function emergencyCodeText(codeBytes) {
  if (!(codeBytes instanceof Uint8Array) || codeBytes.length !== EM_CODE_BYTES) throw new Error('an emergency code is 16 bytes');
  const all = new Uint8Array(EM_CODE_BYTES + 1); all.set(codeBytes); all[EM_CODE_BYTES] = emCheckByte(codeBytes);
  let bits = 0, acc = 0, out = '';
  for (const b of all) { acc = (acc << 8) | b; bits += 8; while (bits >= 5) { out += EM_B32[(acc >> (bits - 5)) & 31]; bits -= 5; } }
  if (bits) out += EM_B32[(acc << (5 - bits)) & 31];
  return 'ARN-' + out.match(/.{1,4}/g).join('-');
}

/** The code's 16 bytes from what the owner typed (case, spaces and dashes ignored; I/L read as 1, O as 0), or throws why not. */
export function parseEmergencyCode(text) {
  const raw = String(text || '').toUpperCase().replace(/^\s*ARN[-\s]*/, '').replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
  if (!/^[0-9A-HJKMNP-TV-Z]{28}$/.test(raw)) throw new Error('an emergency code is ARN- and 28 letters and digits');
  let bits = 0, acc = 0; const out = [];
  for (const ch of raw) { acc = (acc << 5) | EM_B32.indexOf(ch); bits += 5; if (bits >= 8) { out.push((acc >> (bits - 8)) & 255); bits -= 8; } }
  const all = Uint8Array.from(out.slice(0, EM_CODE_BYTES + 1));
  const codeBytes = all.slice(0, EM_CODE_BYTES);
  if (all[EM_CODE_BYTES] !== emCheckByte(codeBytes)) throw new Error('that emergency code is mistyped (its check does not match)');
  return codeBytes;
}

/** The emergency key's 32-byte secret, from the code's 16 bytes (the caller's curve makes its public key). */
export const emergencySecret = (codeBytes) => taggedHash(TAG.emergencySecret, codeBytes);

// THE REQUEST
export function encodeEmergencyDeparture(d) {
  if (!emIs32(d.nodePubkey) || !emIs32(d.emergencyPubkey)) throw new Error('a leave request names the node (32) and its emergency key (32)');
  emHeight(d.postedAt, 'the height it was posted at');
  const w = new Writer();
  w.u8(TYPE_EMERGENCY_DEPARTURE); w.u16(PROTOCOL_VERSION);
  w.bytes32(d.nodePubkey); w.bytes32(d.emergencyPubkey); w.u32(d.postedAt);
  return w.finish();
}
export function decodeEmergencyDeparture(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== TYPE_EMERGENCY_DEPARTURE) throw new Error('not an emergency leave request');
  if (r.u16() !== PROTOCOL_VERSION) throw new Error('unknown protocol version');
  const d = { nodePubkey: r.bytes32(), emergencyPubkey: r.bytes32(), postedAt: r.u32() };
  r.end(); encodeEmergencyDeparture(d); return d;
}
export const emergencyDepartureId = (d) => taggedHash(TAG.emergencyDeparture, encodeEmergencyDeparture(d));
export const signEmergencyDeparture = (d, sign) => ({ ...d, signature: sign(emergencyDepartureId(d)) });

/**
 * A LEAVE REQUEST THAT STANDS: for a node in the census whose advertisement names this emergency key, signed by that key, posted at a
 * height the seat has seen (not ahead of its tip). `advert` the node's census advertisement; `fresh`: on taking it, posted at most
 * EMERGENCY_FRESH_BLOCKS before the tip. Answers { ok, nodePubkey, postedAt } or why not.
 */
export function emergencyDepartureStands(d, { advert, tip, verify, fresh = false }) {
  try { encodeEmergencyDeparture(d); } catch (e) { return { ok: false, why: e.message }; }
  if (!advert) return { ok: false, why: 'that node is not in the census' };
  if (!emIs32(advert.emergencyPubkey)) return { ok: false, why: 'that node\'s advertisement names no emergency key' };
  if (toHex(advert.emergencyPubkey) !== toHex(d.emergencyPubkey)) return { ok: false, why: 'the request names another emergency key than the node\'s advertisement' };
  if (Number.isInteger(tip) && d.postedAt > tip) return { ok: false, why: `posted at ${d.postedAt}, ahead of the tip ${tip}` };
  if (fresh && !(Number.isInteger(tip) && tip - d.postedAt <= EMERGENCY_FRESH_BLOCKS))
    return { ok: false, why: `posted at ${d.postedAt}, more than ${EMERGENCY_FRESH_BLOCKS} blocks before the tip ${tip}: a request is taken only fresh` };
  if (!d.signature || !verify(d.signature, emergencyDepartureId(d), d.emergencyPubkey)) return { ok: false, why: 'the request is not signed by the node\'s emergency key' };
  return { ok: true, nodePubkey: d.nodePubkey, postedAt: d.postedAt };
}

/**
 * WHAT A STANDING REQUEST DOES (§23A.5a). `guardian`: the node is a seated guardian of a federation; `lastSeenHeight`: the height
 * its federation last saw it in consensus (from the absence attestations), when known; `abandonBlocks`: the network's.
 * Answers { leaves: true, departed: bool, slash: bool, why }.
 */
export function emergencyDepartureEffect(request, { guardian, lastSeenHeight = null, abandonBlocks }) {
  if (!request || !request.ok) return { leaves: false, departed: false, slash: false, why: 'no standing leave request' };
  if (!guardian) return { leaves: true, departed: true, slash: false, why: `no guardian role: out of the seating from ${request.postedAt}, the bond untouched` };
  if (!Number.isInteger(abandonBlocks) || abandonBlocks <= 0) throw new Error('abandon_blocks is a positive block count');
  if (Number.isInteger(lastSeenHeight) && request.postedAt >= lastSeenHeight + abandonBlocks)
    return { leaves: true, departed: false, slash: true, why: `posted at ${request.postedAt}, not before abandon_blocks (${abandonBlocks}) from last seen ${lastSeenHeight}: abandonment` };
  return { leaves: true, departed: true, slash: false, why: `a guardian's emergency departure at ${request.postedAt}, in time: DEPARTED at once, the succession starts, the bond untouched` };
}
