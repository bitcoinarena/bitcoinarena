// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE CERTIFIED REVEAL SET OF A HEAD-TO-HEAD ROUND (kanban #2832, ruling 2026-11-16 (a); the twin of the lock set, lock-set.js / #2116).
// PREPARED, NOT ROLLED: REVEAL_SET_VERSION (32) is not spoken by any build yet; the seats' book, the verdict from the set and the page's wait
// come with the roll that speaks it (see the card's build plan).
//
// Finding wf1489-r24-h2h-1: one dishonest seat served a losing player's reveal (posted to it alone) to some honest seats and not to others, so
// each honest seat decided at once over a different reveal set and signed a different verdict - the liar chose which reached the threshold, or
// split the round into VOID. A per-seat rule cannot both carry an honest reveal that landed at one seat only (#1589) and refuse a liar's
// selective one; one signed set every honest seat holds can. So, after the reveal window closes:
//
//   1. GATHER. Each seat serves every stood reveal it holds (it opens its commitment, bound to round and entry, receipted inside the window by
//      the seat that took it) and pulls the others' for REVEAL_GATHER_MS (2 s; regtest 1 s).
//   2. SIGN ONCE. Each seat signs one RevealSet { round_id, entries[]: (entry_id, H(move || salt)) } over the reveals it holds after the gather.
//      A seat whose set differs from the leading one re-pulls the reveals that set names (each must open its commitment) and signs that one;
//      a seat never signs a set naming a reveal it cannot open (revealSetToSign).
//   3. CERTIFY. The committee's threshold of signatures over ONE set is the certificate; the verdict is decided from it alone. An entry absent
//      from it has no stood reveal (FORFEIT, as today).
//   No certificate by close + gather + REVEAL_SET_WINDOW_MS (3 s): the round is VOID, every stake and fee lock back at once (#2872).
//   Two certificates over different sets: VOID, and signing two RevealSets of one round is the slashing offence (the two signed sets the proof).
//
//   bytes       u8 TYPE_REVEAL_SET, u16 version (32), round_id 32, vec<entry_id 32, reveal_hash 32> (entry ids ascending, no repeat)
//   id          H(ARENA/v1/RevealSet, bytes)
//   signature   BIP-340 by a committee seat's node key over H(ARENA/v1/RevealSetSignature, id || u64 at_ms) - at_ms the seat's own clock
//   certificate u8 TYPE_REVEAL_SET_CERTIFICATE, u16 version, the set's bytes (u16 length + bytes), vec<key 32, at_ms u64, sig 64> (keys ascending)
// A certificate stands when at least `threshold` distinct committee keys signed the same set with open <= at_ms <= open + gather + window, `open`
// the reveal window's close.
import { Writer, Reader } from './encode.js';
import { taggedHash, toHex, fromHex, sha256 } from './hash.js';
import { TAG, TYPE_REVEAL_SET, TYPE_REVEAL_SET_CERTIFICATE, REVEAL_SET_VERSION } from './constants.js';

/** The gather after the reveal window: seats serve and pull each other's stood reveals this long before they sign (regtest: 1 s). */
export const REVEAL_GATHER_MS = 2000;
export const REVEAL_GATHER_MS_REGTEST = 1000;
/** No certificate by the reveal window's close + the gather + this: the round is VOID. */
export const REVEAL_SET_WINDOW_MS = 3000;
export const REVEAL_SET_MAX_SIGS = 9;
export const REVEAL_SET_MAX_ENTRIES = 256;

const is32 = (b) => b instanceof Uint8Array && b.length === 32;
const cmp = (a, b) => { for (let i = 0; i < 32; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
const bytesOf = (x) => (x instanceof Uint8Array ? x : fromHex(String(x)));

/** Does this round decide its verdict from a certified reveal set? A paying head-to-head round of REVEAL_SET_VERSION or later. */
export const certifiesRevealSet = (contract, headToHead) => !!headToHead && !!contract && Number.isInteger(contract.protocolVersion)
  && contract.protocolVersion >= REVEAL_SET_VERSION && typeof contract.stakeMsat === 'bigint' && contract.stakeMsat > 0n;

/** H(move || salt): the reveal's hash a set names (`move` a byte, `salt` 32 bytes) - what every seat holding the same reveal computes alike. */
export function revealHash({ move, salt }) {
  const s = bytesOf(salt);
  if (!Number.isInteger(move) || move < 0 || move > 255) throw new Error('a move is one byte');
  if (!is32(s)) throw new Error('a reveal\'s salt is 32 bytes');
  return sha256(Uint8Array.from([move, ...s]));
}

/** The set, sorted for its caller: [{ entryId, revealHash }] (bytes or hex), entry ids ascending, each once (two hashes for one entry throw). */
export function revealSetOf({ roundId, entries }) {
  const by = new Map();
  for (const e of entries) {
    const id = bytesOf(e.entryId), h = bytesOf(e.revealHash), k = toHex(id);
    if (by.has(k) && toHex(by.get(k).revealHash) !== toHex(h)) throw new Error(`two reveals for entry ${k.slice(0, 16)}`);
    by.set(k, { entryId: id, revealHash: h });
  }
  return { roundId: bytesOf(roundId), entries: [...by.values()].sort((a, b) => cmp(a.entryId, b.entryId)) };
}

export function encodeRevealSet({ roundId, entries }) {
  if (!is32(roundId)) throw new Error('a reveal set names its 32-byte round');
  if (!Array.isArray(entries) || entries.length > REVEAL_SET_MAX_ENTRIES) throw new Error(`a reveal set holds at most ${REVEAL_SET_MAX_ENTRIES} entries`);
  const list = entries.map((e) => ({ entryId: bytesOf(e.entryId), revealHash: bytesOf(e.revealHash) }));
  for (const e of list) if (!is32(e.entryId) || !is32(e.revealHash)) throw new Error('a reveal set entry is a 32-byte entry id and a 32-byte reveal hash');
  for (let i = 1; i < list.length; i++) if (cmp(list[i - 1].entryId, list[i].entryId) >= 0) throw new Error('a reveal set\'s entries are ascending and unique');
  const w = new Writer();
  w.u8(TYPE_REVEAL_SET); w.u16(REVEAL_SET_VERSION); w.bytes32(roundId);
  w.vec(list, (e, ww) => { ww.bytes32(e.entryId); ww.bytes32(e.revealHash); }, { sortedBy: (a, b) => (cmp(a.entryId, b.entryId) === 0 ? 1 : cmp(a.entryId, b.entryId)) });
  return w.finish();
}

export function decodeRevealSet(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== TYPE_REVEAL_SET) throw new Error('not a reveal set');
  const v = r.u16();
  if (v !== REVEAL_SET_VERSION) throw new Error(`reveal set version ${v}`);
  const roundId = r.bytes32();
  const entries = r.vec((rr) => ({ entryId: rr.bytes32(), revealHash: rr.bytes32() }));
  r.end();
  if (entries.length > REVEAL_SET_MAX_ENTRIES) throw new Error('too many entries');
  for (let i = 1; i < entries.length; i++) if (cmp(entries[i - 1].entryId, entries[i].entryId) >= 0) throw new Error('a reveal set\'s entries are ascending and unique');
  return { roundId, entries };
}

export const revealSetId = (set) => taggedHash(TAG.revealSet, encodeRevealSet(set));

/** What a seat signs to certify the set with id `setId` at its own time `atMs`. */
export function revealSetSignatureId({ setId, atMs }) {
  if (!is32(setId)) throw new Error('a reveal set id is 32 bytes');
  const w = new Writer(); w.bytes32(setId); w.u64(BigInt(atMs));
  return taggedHash(TAG.revealSetSignature, w.finish());
}

export function encodeRevealSetCertificate({ set, sigs }) {
  const setBytes = encodeRevealSet(set);
  if (!Array.isArray(sigs) || sigs.length === 0 || sigs.length > REVEAL_SET_MAX_SIGS) throw new Error(`a certificate carries 1 to ${REVEAL_SET_MAX_SIGS} signatures`);
  const list = sigs.map((s) => ({ key: bytesOf(s.key), atMs: BigInt(s.atMs), sig: bytesOf(s.sig) })).sort((x, y) => cmp(x.key, y.key));   // keys ascending, the one encoding
  const w = new Writer();
  w.u8(TYPE_REVEAL_SET_CERTIFICATE); w.u16(REVEAL_SET_VERSION);
  w.u16(setBytes.length); w.bytes(setBytes);
  w.vec(list, (s, ww) => { ww.bytes32(s.key); ww.u64(s.atMs); ww.bytes(s.sig, 64); }, { sortedBy: (a, b) => (cmp(a.key, b.key) === 0 ? 1 : cmp(a.key, b.key)) });
  return w.finish();
}

export function decodeRevealSetCertificate(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== TYPE_REVEAL_SET_CERTIFICATE) throw new Error('not a reveal set certificate');
  const v = r.u16();
  if (v !== REVEAL_SET_VERSION) throw new Error(`reveal set certificate version ${v}`);
  const set = decodeRevealSet(r.bytes(r.u16()));
  const sigs = r.vec((rr) => ({ key: rr.bytes32(), atMs: rr.u64(), sig: rr.bytes(64) }));
  r.end();
  if (sigs.length === 0 || sigs.length > REVEAL_SET_MAX_SIGS) throw new Error('signature count');
  for (let i = 1; i < sigs.length; i++) if (cmp(sigs[i - 1].key, sigs[i].key) >= 0) throw new Error('a certificate\'s keys are ascending and unique');
  return { set, sigs };
}

/**
 * DOES THIS CERTIFICATE STAND? `openMs` the reveal window's close; signatures count inside [open, open + gather + window]. Answers { ok, entries:
 * [{ entryId, revealHash }] (hex), atMs, signers, setId } or { ok: false, why }. As lockSetCertificateStands: outside the committee, outside the
 * time or not verifying counts nothing.
 */
export function revealSetCertificateStands(cert, { roundId, committee, threshold, openMs, verify, gatherMs = REVEAL_GATHER_MS, windowMs = REVEAL_SET_WINDOW_MS }) {
  let c = cert;
  try { if (cert instanceof Uint8Array) c = decodeRevealSetCertificate(cert); } catch (e) { return { ok: false, why: `that certificate does not read: ${e.message}` }; }
  if (!c || !c.set || !Array.isArray(c.sigs)) return { ok: false, why: 'no certificate' };
  if (typeof verify !== 'function') return { ok: false, why: 'checking a certificate needs a verifier, and none was injected' };
  if (!Number.isInteger(threshold) || threshold < 1) return { ok: false, why: 'no threshold' };
  if (toHex(bytesOf(roundId)) !== toHex(c.set.roundId)) return { ok: false, why: 'that certificate is about another round' };
  const members = new Set((committee || []).map((k) => toHex(bytesOf(k))));
  const open = BigInt(openMs), last = open + BigInt(gatherMs) + BigInt(windowMs);
  let setId;
  try { setId = revealSetId(c.set); } catch (e) { return { ok: false, why: e.message }; }
  const signers = [];
  let atMs = null;
  for (const s of c.sigs.slice(0, REVEAL_SET_MAX_SIGS)) {
    const key = toHex(s.key);
    if (!members.has(key) || signers.includes(key)) continue;
    const at = BigInt(s.atMs);
    if (at < open || at > last) continue;
    let good = false;
    try { good = !!verify(s.sig, revealSetSignatureId({ setId, atMs: at }), s.key); } catch { good = false; }
    if (!good) continue;
    signers.push(key);
    if (atMs === null || at > atMs) atMs = at;
  }
  if (signers.length < threshold) return { ok: false, why: `that certificate carries ${signers.length} good committee signatures, ${threshold} needed` };
  return { ok: true, entries: c.set.entries.map((e) => ({ entryId: toHex(e.entryId), revealHash: toHex(e.revealHash) })), atMs: Number(atMs), signers, setId: toHex(setId) };
}

/**
 * THE SET A SEAT SIGNS after the gather: the union of the stood reveals it holds and those every other seat's served set names - but only
 * those it can open itself (`opens(entryHex, revealHashHex)`: it holds that reveal, re-pulled if needed, and it opens the entry's commitment).
 * Unlike the lock set, ONE honest seat holding a reveal is enough for it to enter the set: a liar cannot keep it out once an honest seat
 * served it in the gather, and a reveal only the liar holds is in every set or in none. Two different hashes for one entry: neither.
 */
export function revealSetToSign({ own, served = [], opens }) {
  const seen = new Map(), bad = new Set();
  for (const list of [own, ...served]) for (const e of list || []) {
    const k = String(e.entryId).toLowerCase(), h = String(e.revealHash).toLowerCase();
    if (seen.has(k) && seen.get(k) !== h) bad.add(k);
    seen.set(k, h);
  }
  return [...seen].filter(([k, h]) => !bad.has(k) && (typeof opens !== 'function' || opens(k, h)))
    .map(([entryId, revealHash]) => ({ entryId, revealHash })).sort((a, b) => (a.entryId < b.entryId ? -1 : 1));
}

/** A signed reveal set as evidence (the slash proof carries two of these by one key over two sets of one round). */
export function encodeSignedRevealSet({ set, atMs, sig }) {
  const setBytes = encodeRevealSet(set);
  const w = new Writer();
  w.u16(setBytes.length); w.bytes(setBytes); w.u64(BigInt(atMs)); w.bytes(bytesOf(sig), 64);
  return w.finish();
}
export function decodeSignedRevealSet(bytes) {
  const r = new Reader(bytes);
  const set = decodeRevealSet(r.bytes(r.u16()));
  const atMs = r.u64(); const sig = r.bytes(64);
  r.end();
  return { set, atMs, sig };
}
/** Two signed sets by one key over one round's two different sets: the offence (ruling #2832, as #2587 for lock sets). */
export function twoRevealSets(a, b, verify) {
  const x = decodeSignedRevealSet(a), y = decodeSignedRevealSet(b);
  if (toHex(x.set.roundId) !== toHex(y.set.roundId)) return { ok: false, why: 'two rounds' };
  const ix = revealSetId(x.set), iy = revealSetId(y.set);
  if (toHex(ix) === toHex(iy)) return { ok: false, why: 'the same set' };
  return { ok: true, round: toHex(x.set.roundId), verify: (key) => !!verify(x.sig, revealSetSignatureId({ setId: ix, atMs: x.atMs }), key)
    && !!verify(y.sig, revealSetSignatureId({ setId: iy, atMs: y.atMs }), key) };
}
