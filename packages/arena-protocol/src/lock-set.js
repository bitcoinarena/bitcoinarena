// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE CERTIFIED LOCK SET OF A HEAD-TO-HEAD ROUND (protocol 28, kanban #2561; ruling on #2116 (b), 2026-11-12; multiplayer_p2p.md §17A).
//
// #1598: a session key is free, so a player entered rock, paper and scissors under three keys with no stake lock, read the honest move
// once reveals were out and locked only the entry that beat it. Each seat then judged alone, by its own clock and its peers' word, whether a
// lock came before any reveal - and every rule of that kind had another way round it (a clock ahead or behind, a lying partner, a slow seat).
// From protocol 28 one signed decision replaces them: at the entry close the round's committee signs, at its threshold,
//
//   LockSet { round_id, entries[] }     the entries whose stake lock each signer verified before the close
//
// and nothing is revealed before that certificate exists. Only its entries are seated, revealed and decided; a lock that arrives later is
// in no round. No certificate by the close + LOCK_SET_WINDOW_MS: the round is VOID, every stake back - never a partial round.
//
//   bytes       u8 TYPE_LOCK_SET, u16 version (28), round_id 32, vec<entry_id 32> (ascending, no repeat)
//   id          H(ARENA/v1/LockSet, bytes)
//   signature   BIP-340 by a committee seat's node key over H(ARENA/v1/LockSetSignature, id || u64 at_ms) - at_ms the seat's own clock
//   view        the same set signed over H(ARENA/v1/LockSetView, id || u64 at_ms): what ONE seat verified; never a certificate signature
//   certificate u8 TYPE_LOCK_SET_CERTIFICATE, u16 version, the set's bytes (u16 length + bytes), vec<key 32, at_ms u64, sig 64> (keys ascending)
//
// A certificate stands when at least `threshold` distinct committee keys signed the same set with close <= at_ms <= close + window. Its time
// is the latest of those signers' at_ms: the reveal window opens there.
import { Writer, Reader } from './encode.js';
import { taggedHash, toHex, fromHex } from './hash.js';
import { TAG, TYPE_LOCK_SET, TYPE_LOCK_SET_CERTIFICATE, LOCK_SET_VERSION, speaksVersion } from './constants.js';

/** No certificate by the entry close + this: the round is VOID (the ruling's "close + 3 s"). */
export const LOCK_SET_WINDOW_MS = 3000;
/** A seat signs its set once it holds every committee seat's view, or at the latest this long after the close (with a threshold of views). */
export const LOCK_SET_VIEW_WAIT_MS = 1200;
/** At most a committee's worth of signatures in a certificate (9 drawn for 7 seats). */
export const LOCK_SET_MAX_SIGS = 9;
/** A head-to-head round seats a handful of players; the set is bounded so a certificate stays a short message. */
export const LOCK_SET_MAX_ENTRIES = 256;

const lsIs32 = (b) => b instanceof Uint8Array && b.length === 32;
const lsCmp = (a, b) => { for (let i = 0; i < 32; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
const lsBytes = (x) => (x instanceof Uint8Array ? x : fromHex(String(x)));

/** Does this round play under the certified lock set? A paying head-to-head round of protocol 28 or later (`headToHead`: its game is one). */
export const certifiesLockSet = (contract, headToHead) => !!headToHead && !!contract && Number.isInteger(contract.protocolVersion)
  && contract.protocolVersion >= LOCK_SET_VERSION && typeof contract.stakeMsat === 'bigint' && contract.stakeMsat > 0n;

/** The set in its one encoding: entries ascending, each once. */
export function encodeLockSet({ roundId, entries }) {
  if (!lsIs32(roundId)) throw new Error('a lock set names its 32-byte round');
  if (!Array.isArray(entries) || entries.length > LOCK_SET_MAX_ENTRIES) throw new Error(`a lock set holds at most ${LOCK_SET_MAX_ENTRIES} entries`);
  const list = entries.map(lsBytes);
  for (const e of list) if (!lsIs32(e)) throw new Error('a lock set entry is a 32-byte entry id');
  const w = new Writer();
  w.u8(TYPE_LOCK_SET); w.u16(LOCK_SET_VERSION); w.bytes32(roundId);
  w.vec(list, (e, ww) => ww.bytes32(e), { sortedBy: (a, b) => (lsCmp(a, b) === 0 ? 1 : lsCmp(a, b)) });
  return w.finish();
}

/** The set, sorted for its caller: entry ids (bytes or hex) ascending, each once. */
export function lockSetOf({ roundId, entries }) {
  const seen = new Map();
  for (const e of entries) { const b = lsBytes(e); seen.set(toHex(b), b); }
  return { roundId: lsBytes(roundId), entries: [...seen.values()].sort(lsCmp) };
}

export function decodeLockSet(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== TYPE_LOCK_SET) throw new Error('not a lock set');
  const v = r.u16();
  if (v !== LOCK_SET_VERSION || !speaksVersion(v)) throw new Error(`lock set version ${v}`);
  const roundId = r.bytes32();
  const entries = r.vec((rr) => rr.bytes32());
  r.end();
  if (entries.length > LOCK_SET_MAX_ENTRIES) throw new Error('too many entries');
  for (let i = 1; i < entries.length; i++) if (lsCmp(entries[i - 1], entries[i]) >= 0) throw new Error('a lock set\'s entries are ascending and unique');
  return { roundId, entries };
}

export const lockSetId = (set) => taggedHash(TAG.lockSet, encodeLockSet(set));

const lsTimed = (tag, id, atMs) => {
  if (!lsIs32(id)) throw new Error('a lock set id is 32 bytes');
  const w = new Writer(); w.bytes32(id); w.u64(BigInt(atMs));
  return taggedHash(tag, w.finish());
};
/** What a seat signs to certify the set with id `setId` at its own time `atMs`. */
export const lockSetSignatureId = ({ setId, atMs }) => lsTimed(TAG.lockSetSignature, setId, atMs);
/** What a seat signs to say what IT verified (its view) - another tag, so a view never counts toward a certificate. */
export const lockSetViewId = ({ setId, atMs }) => lsTimed(TAG.lockSetView, setId, atMs);

/** A certificate's bytes: the set, then each signature [key, at_ms, sig] with keys ascending. */
export function encodeLockSetCertificate({ set, sigs }) {
  const setBytes = encodeLockSet(set);
  if (!Array.isArray(sigs) || sigs.length === 0 || sigs.length > LOCK_SET_MAX_SIGS) throw new Error(`a certificate carries 1 to ${LOCK_SET_MAX_SIGS} signatures`);
  const list = sigs.map((s) => ({ key: lsBytes(s.key), atMs: BigInt(s.atMs), sig: lsBytes(s.sig) }));
  const w = new Writer();
  w.u8(TYPE_LOCK_SET_CERTIFICATE); w.u16(LOCK_SET_VERSION);
  w.u16(setBytes.length); w.bytes(setBytes);
  w.vec(list, (s, ww) => { ww.bytes32(s.key); ww.u64(s.atMs); ww.bytes(s.sig, 64); }, { sortedBy: (a, b) => (lsCmp(a.key, b.key) === 0 ? 1 : lsCmp(a.key, b.key)) });
  return w.finish();
}

export function decodeLockSetCertificate(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== TYPE_LOCK_SET_CERTIFICATE) throw new Error('not a lock set certificate');
  const v = r.u16();
  if (v !== LOCK_SET_VERSION || !speaksVersion(v)) throw new Error(`lock set certificate version ${v}`);
  const set = decodeLockSet(r.bytes(r.u16()));
  const sigs = r.vec((rr) => ({ key: rr.bytes32(), atMs: rr.u64(), sig: rr.bytes(64) }));
  r.end();
  if (sigs.length === 0 || sigs.length > LOCK_SET_MAX_SIGS) throw new Error('signature count');
  for (let i = 1; i < sigs.length; i++) if (lsCmp(sigs[i - 1].key, sigs[i].key) >= 0) throw new Error('a certificate\'s keys are ascending and unique');
  return { set, sigs };
}

/**
 * DOES THIS CERTIFICATE STAND for that round? `cert` decoded (or its bytes); `committee` the round's seat keys (hex or bytes);
 * `threshold` its signatures needed; `entryCloseMs` the round's close; `verify(sig, msg, key)` BIP-340, injected.
 * Answers { ok, entries (hex), atMs (the latest counted signer's, a number), signers (hex) } or { ok: false, why }.
 * A signature from outside the committee, outside [close, close + window], or that does not verify counts nothing.
 */
export function lockSetCertificateStands(cert, { roundId, committee, threshold, entryCloseMs, verify, windowMs = LOCK_SET_WINDOW_MS }) {
  let c = cert;
  try { if (cert instanceof Uint8Array) c = decodeLockSetCertificate(cert); } catch (e) { return { ok: false, why: `that certificate does not read: ${e.message}` }; }
  if (!c || !c.set || !Array.isArray(c.sigs)) return { ok: false, why: 'no certificate' };
  if (typeof verify !== 'function') return { ok: false, why: 'checking a certificate needs a verifier, and none was injected' };
  if (!Number.isInteger(threshold) || threshold < 1) return { ok: false, why: 'no threshold' };
  if (toHex(lsBytes(roundId)) !== toHex(c.set.roundId)) return { ok: false, why: 'that certificate is about another round' };
  const members = new Set((committee || []).map((k) => toHex(lsBytes(k))));
  const close = BigInt(entryCloseMs), last = close + BigInt(windowMs);
  let setId;
  try { setId = lockSetId(c.set); } catch (e) { return { ok: false, why: e.message }; }
  const signers = [];
  let atMs = null;
  for (const s of c.sigs.slice(0, LOCK_SET_MAX_SIGS)) {
    const key = toHex(s.key);
    if (!members.has(key) || signers.includes(key)) continue;
    const at = BigInt(s.atMs);
    if (at < close || at > last) continue;
    let good = false;
    try { good = !!verify(s.sig, lockSetSignatureId({ setId, atMs: at }), s.key); } catch { good = false; }
    if (!good) continue;
    signers.push(key);
    if (atMs === null || at > atMs) atMs = at;
  }
  if (signers.length < threshold) return { ok: false, why: `that certificate carries ${signers.length} good committee signatures, ${threshold} needed` };
  return { ok: true, entries: c.set.entries.map(toHex), atMs: Number(atMs), signers, setId: toHex(setId) };
}

/**
 * THE SET A SEAT SIGNS, from the views it holds (each a list of entry hex ids, its own included): the entries of its own view that at least
 * `threshold` views name. With the same views every seat answers the same set; an entry only some seats verified leaves the round
 * rather than splitting the committee, and an entry this seat did not verify itself it never signs.
 */
export function lockSetToSign({ own, views, threshold }) {
  const count = new Map();
  for (const v of views) for (const e of new Set(v)) count.set(e, (count.get(e) || 0) + 1);
  return [...new Set(own)].filter((e) => (count.get(e) || 0) >= threshold).sort();
}

/**
 * A SIGNED LOCK SET, AS EVIDENCE (ruling #2587, kanban #2606): the set's bytes (u16 length + LockSet), the signer's u64 at_ms and its 64-byte
 * BIP-340 signature over lockSetSignatureId({ setId, atMs }). What a seat serves as its set signature, in one encoding a slash proof can carry:
 * two of these by one key over two different sets of one round are the offence (slash.js slashHoldsOnTwoLockSets).
 */
export function encodeSignedLockSet({ set, atMs, sig }) {
  const setBytes = encodeLockSet(set);
  const w = new Writer();
  w.u16(setBytes.length); w.bytes(setBytes); w.u64(BigInt(atMs)); w.bytes(lsBytes(sig), 64);
  return w.finish();
}
export function decodeSignedLockSet(bytes) {
  const r = new Reader(bytes);
  const set = decodeLockSet(r.bytes(r.u16()));
  const atMs = r.u64();
  const sig = r.bytes(64);
  r.end();
  return { set, atMs, sig };
}
