// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A HALTED FEDERATION'S SPENT-NOTE SET (spec §23A.5 liquidation step 1, RULED 2026-09-21): "The guardians
// still seated publish, signed, their copy of the federation's spent-note set (the nonces the consensus has already redeemed)
// as of the last session they hold. Any one copy suffices; the newest session wins."
//
//   COPY  (federation_id, session, nonces sorted and distinct, signer node key) signed by a guardian of the federation's record
//   PICK  of the copies that stand, the newest session; copies of one session that disagree are named, and the one most
//         guardians signed is kept (their union never is: a nonce one guardian alone calls spent would refuse a valid note)
//
// A nonce is a Fedimint note nonce, a 33-byte public key. NO CURVE: `sign(digest)` and `verify(signature, digest, nodePubkey)`
// are injected (BIP-340 over node keys), as for the record itself. What settleClaims (federation-slash.js) takes as
// `spentNonces` is `spentNonceSet(pick.copy)`; no copy standing at all is `null` there - pro rata.
import { Writer, Reader } from './encode.js';
import { taggedHash, toHex } from './hash.js';
import { TAG, PROTOCOL_VERSION, TYPE_SPENT_SET } from './constants.js';

const is32 = (b) => b instanceof Uint8Array && b.length === 32;
const NONCE = 33;

/** Encodes a copy; its nonces must already be sorted (bytewise) and distinct, so one set has one encoding. */
export function encodeSpentSet(s) {
  if (!is32(s.federationId) || !is32(s.signer)) throw new Error('a spent set names its federation (32) and its signer\'s node key (32)');
  if (!Number.isInteger(s.session) || s.session < 0 || s.session > 0xffffffff) throw new Error('session is a u32 session index');
  const nonces = s.nonces || [];
  const w = new Writer();
  w.u8(TYPE_SPENT_SET); w.u16(PROTOCOL_VERSION);
  w.bytes32(s.federationId); w.u32(s.session); w.u32(nonces.length);
  let last = '';
  for (const n of nonces) {
    if (!(n instanceof Uint8Array) || n.length !== NONCE) throw new Error('a nonce is a 33-byte note nonce');
    const h = toHex(n);
    if (h <= last) throw new Error('nonces are sorted and distinct');
    last = h; w.bytes(n, NONCE);
  }
  w.bytes32(s.signer);
  return w.finish();
}
export function decodeSpentSet(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== TYPE_SPENT_SET) throw new Error('not a spent set');
  if (r.u16() !== PROTOCOL_VERSION) throw new Error('unknown protocol version');
  const federationId = r.bytes32(); const session = r.u32(); const count = r.u32();
  if (count * NONCE > bytes.length) throw new Error('more nonces named than the bytes hold');
  const nonces = Array.from({ length: count }, () => r.bytes(NONCE));
  const s = { federationId, session, nonces, signer: r.bytes32() };
  r.end(); encodeSpentSet(s); return s;
}
/** Sorts and dedups raw nonces into a copy's order. */
export const sortNonces = (nonces) => [...new Map(nonces.map((n) => [toHex(n), n])).entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map((e) => e[1]);
export const spentSetId = (s) => taggedHash(TAG.spentSet, encodeSpentSet(s));
export const signSpentSet = (s, sign) => { const c = { ...s, nonces: sortNonces(s.nonces || []) }; return { ...c, signature: sign(spentSetId(c)) }; };
/** The nonces of a copy as the hex list settleClaims reads. */
export const spentNonceSet = (s) => (s.nonces || []).map(toHex);

/** A COPY THAT STANDS: well formed, of this record's federation, signed by the node key of one of its guardians. */
export function spentSetStands(s, { record, verify }) {
  try { encodeSpentSet(s); } catch (e) { return { ok: false, why: e.message }; }
  if (toHex(s.federationId) !== toHex(record.federationId)) return { ok: false, why: 'that spent set names another federation' };
  if (!(record.guardians || []).some((g) => toHex(g.nodePubkey) === toHex(s.signer))) return { ok: false, why: 'its signer is not a guardian of this federation' };
  if (!verify(s.signature, spentSetId(s), s.signer)) return { ok: false, why: 'the spent set is not signed by its signer' };
  return { ok: true };
}

/**
 * THE COPY THAT COUNTS: of `copies`, those that stand; the newest session wins. Copies of that session that differ are named
 * in `disagree` and the content the most distinct guardians signed is kept (ties: the smaller set - a nonce not proven spent
 * is the player's). Answers { copy, session, signers, disagree, refused } or { copy: null, why } when none stands.
 */
export function newestSpentSet(copies, { record, verify }) {
  const refused = []; const bySession = new Map();
  for (const c of copies || []) {
    const st = spentSetStands(c, { record, verify });
    if (!st.ok) { refused.push(st.why); continue; }
    const content = toHex(taggedHash(TAG.spentSet, encodeSpentSet({ ...c, signer: new Uint8Array(32) })));
    const s = bySession.get(c.session) || new Map(); bySession.set(c.session, s);
    const k = s.get(content) || { copy: c, signers: new Set() }; s.set(content, k);
    k.signers.add(toHex(c.signer));
  }
  if (!bySession.size) return { copy: null, why: refused.length ? `no copy stands: ${refused[0]}` : 'no guardian published a spent set', refused };
  const session = Math.max(...bySession.keys());
  const kinds = [...bySession.get(session).values()]
    .sort((a, b) => b.signers.size - a.signers.size || a.copy.nonces.length - b.copy.nonces.length);
  return { copy: kinds[0].copy, session, signers: kinds[0].signers.size, disagree: kinds.length - 1, refused };
}
