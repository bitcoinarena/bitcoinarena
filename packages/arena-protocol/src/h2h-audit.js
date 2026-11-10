// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE HEAD-TO-HEAD AUDIT BEFORE FINAL (spec §13A.1, RULED 2026-11-10 kanban #1400, build #1412; the owner: "when the objection window is just
// 60 seconds, some other node need to check the result, not just the 5 of 7", and: "the reveal phase must stay fast; the audit runs in the background").
//
//   WHO        the §13A.1 lottery over the same eligible set (auditor.js auditEligible), AUDITORS_H2H = 5 expected per round: auditor iff
//              int(beta[0..8]) / 2^64 < 5 x weight / W, with (beta, pi) = ECVRF(node secret, H_tag(ARENA/v1/Auditor, round_id))
//   THE CHECK  every entry's commitment against its reveal (head-to-head.js revealStands: the hash, a move the game offers, bound to the round and
//              the entry, inside the reveal window), FORFEIT for no stood reveal, VOID with fewer entries than players, the decide adapter's
//              verdict over the stood reveals (headToHeadResults) - a check, not a replay
//   THE SIGNED H2H_AUDIT { round_id, results_hash, node_pubkey, at_ms, beta, pi } over the per-entry outcomes in entry id order
//              (entry_id || outcome || score), signed by the node key under ARENA/v1/H2hAudit
//   FINAL      inside the 60 s window: the committee's 5 of 7 AND k = 2 valid H2H_AUDITs over the same results_hash from distinct drawn auditors,
//              held before the window closes; too few -> the window extends to 600 s and FINAL comes then without audits (never VOID for want
//              of auditors)
//
// Nothing here waits in the round's own clock: commit, reveal and decide are unchanged; auditors start at PROVISIONALLY_FINAL.
import { Writer, Reader } from './encode.js';
import { taggedHash, toHex } from './hash.js';
import { PROTOCOL_VERSION, OBJECTION_WINDOW_MS, OBJECTION_WINDOW_H2H_MS } from './constants.js';
import { auditAlpha, vrfPublicKey, AUDIT_PROOF_BYTES } from './auditor.js';
import { revealStands, headToHeadResults } from './head-to-head.js';
import { DELIVERED, FAILED, FORFEIT, VOID } from './payout.js';

export const AUDITORS_H2H = 5n;
export const H2H_AUDITS_NEEDED = 2;
export const TYPE_H2H_AUDIT = 0x4d;
export const H2H_AUDIT_TAG = 'ARENA/v1/H2hAudit';
export const H2H_RESULTS_TAG = 'ARENA/v1/H2hAuditResults';
const OUTCOME_CODE = Object.freeze({ [DELIVERED]: 1, [FAILED]: 2, [FORFEIT]: 3, [VOID]: 4 });

const is32 = (b) => b instanceof Uint8Array && b.length === 32;
const beInt = (b) => b.reduce((n, x) => (n << 8n) | BigInt(x), 0n);

/** Drawn to audit a head-to-head round: the §13A.1 rule with five expected in place of three. */
export function isH2hAuditor({ beta, weight, total }) {
  if (!(beta instanceof Uint8Array) || beta.length < 8) throw new Error('a VRF output is at least 8 bytes');
  if (typeof weight !== 'bigint' || typeof total !== 'bigint' || weight <= 0n || total <= 0n) return false;
  return beInt(beta.subarray(0, 8)) * total < AUDITORS_H2H * weight * (1n << 64n);
}

/** What an H2H_AUDIT vouches for: H_tag(ARENA/v1/H2hAuditResults, n || (entry_id 32, outcome u8, score u32)*), in entry id order. */
export function h2hResultsHash(results) {
  const rows = (results || []).map((r) => {
    if (!is32(r.entryId)) throw new Error('an audited entry is named by its 32-byte id');
    const code = OUTCOME_CODE[r.outcome];
    if (!code) throw new Error(`an audited outcome is DELIVERED, FAILED, FORFEIT or VOID, not ${r.outcome}`);
    if (!Number.isInteger(r.score) || r.score < 0) throw new Error('an audited score is a whole number');
    return { entryId: r.entryId, code, score: r.score };
  }).sort((a, b) => (toHex(a.entryId) < toHex(b.entryId) ? -1 : 1));
  const w = new Writer();
  w.u32(rows.length);
  for (const r of rows) { w.bytes32(r.entryId); w.u8(r.code); w.u32(r.score); }
  return taggedHash(H2H_RESULTS_TAG, w.finish());
}

/**
 * THE AUDITOR'S CHECK of one head-to-head round, from what the round's seats publish. `entries`: [{ entryId, entryKey, commit, reveal: { move,
 * salt, atMs } | null }]; `decide`/`config` the game's adapter; `moveCount`, `players`, `entryCloseMs`, `revealWindowMs` (BigInt) the round's.
 * Answers { results: [{ entryId, outcome, score }], resultsHash, refused: [{ entryId, why }] } - a refused reveal is FORFEIT, as at the seats.
 */
export function h2hCheck({ roundId, entries, decide, config, moveCount, players = 2, entryCloseMs, revealWindowMs }) {
  if (!is32(roundId)) throw new Error('a round id is 32 bytes');
  const refused = [];
  const judged = entries.map((e) => {
    if (!e.reveal) return { key: toHex(e.entryKey), entryId: e.entryId, move: null };
    const st = revealStands({ roundId, entryKey: e.entryKey, commit: e.commit, move: e.reveal.move, salt: e.reveal.salt, moveCount,
      atMs: e.reveal.atMs, entryCloseMs, revealWindowMs });
    if (!st.ok) { refused.push({ entryId: toHex(e.entryId), why: st.why }); return { key: toHex(e.entryKey), entryId: e.entryId, move: null }; }
    return { key: toHex(e.entryKey), entryId: e.entryId, move: e.reveal.move };
  });
  const byKey = headToHeadResults(judged.map((j) => ({ key: j.key, move: j.move })), decide, config, { players });
  const results = judged.map((j) => ({ entryId: j.entryId, outcome: byKey[j.key].outcome, score: byKey[j.key].score }));
  return { results, resultsHash: h2hResultsHash(results), refused };
}

export function encodeH2hAudit(a) {
  if (!is32(a.roundId) || !is32(a.resultsHash) || !is32(a.nodePubkey) || !is32(a.beta)) throw new Error('an H2H_AUDIT names a round, its results, its node and its VRF output (32 bytes each)');
  if (!(a.vrfProof instanceof Uint8Array) || a.vrfProof.length !== AUDIT_PROOF_BYTES) throw new Error(`an H2H_AUDIT carries its ${AUDIT_PROOF_BYTES}-byte VRF proof`);
  if (typeof a.atMs !== 'bigint' || a.atMs < 0n) throw new Error('an H2H_AUDIT carries the time it was signed (BigInt ms)');
  const w = new Writer();
  w.u8(TYPE_H2H_AUDIT); w.u16(PROTOCOL_VERSION);
  w.bytes32(a.roundId); w.bytes32(a.resultsHash); w.bytes32(a.nodePubkey); w.u64(a.atMs); w.bytes32(a.beta); w.bytes(a.vrfProof, AUDIT_PROOF_BYTES);
  return w.finish();
}

export function decodeH2hAudit(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== TYPE_H2H_AUDIT) throw new Error('not an H2H_AUDIT');
  r.u16();
  const a = { roundId: r.bytes32(), resultsHash: r.bytes32(), nodePubkey: r.bytes32(), atMs: r.u64(), beta: r.bytes32(), vrfProof: r.bytes(AUDIT_PROOF_BYTES) };
  r.end();
  return a;
}

/** What the node key signs. */
export const h2hAuditId = (a) => taggedHash(H2H_AUDIT_TAG, encodeH2hAudit(a));

/**
 * A SEAT'S CHECK OF ONE H2H_AUDIT: signed by its node, its VRF proof good for the round under that node's key and giving the beta it names, the
 * node eligible and drawn (five expected), over the results hash being settled, and held before the 60 s window closed. Answers { ok } or why not.
 */
export function h2hAuditStands(a, { signature, vrf, verify, eligible, total, resultsHash, windowCloseMs }) {
  if (!(signature instanceof Uint8Array) || signature.length !== 64) return { ok: false, why: 'an H2H_AUDIT is signed (64 bytes)' };
  if (!verify(signature, h2hAuditId(a), a.nodePubkey)) return { ok: false, why: 'the H2H_AUDIT is not signed by the node it names' };
  if (windowCloseMs !== undefined && windowCloseMs !== null && a.atMs > BigInt(windowCloseMs)) return { ok: false, why: 'signed after the 60 s window closed' };
  const weight = eligible.get(toHex(a.nodePubkey));
  if (!weight) return { ok: false, why: 'that node may not audit this round (not in its eligible set)' };
  const beta = vrf.verify(vrfPublicKey(a.nodePubkey), auditAlpha(a.roundId), a.vrfProof);
  if (!beta) return { ok: false, why: 'the VRF proof does not verify for that node and round' };
  if (toHex(beta) !== toHex(a.beta)) return { ok: false, why: 'the beta it names is not its proof\'s output' };
  if (!isH2hAuditor({ beta, weight, total })) return { ok: false, why: 'that node was not drawn to audit this round' };
  if (resultsHash && toHex(resultsHash) !== toHex(a.resultsHash)) return { ok: false, why: 'the H2H_AUDIT vouches for other results than these' };
  return { ok: true };
}

/**
 * WHEN A HEAD-TO-HEAD ROUND IS FINAL: `provisionalAtMs` when the committee's PROVISIONALLY_FINAL stood, `committeeFinal` whether 5 of 7 signed,
 * `audits` the valid H2H_AUDITs held ([{ nodePubkey, resultsHash, heldAtMs }]), `resultsHash` the one being settled. Answers { final, atMs, window,
 * audited } - inside the 60 s window with H2H_AUDITS_NEEDED distinct auditors over that hash; otherwise the 600 s window, without audits.
 */
export function h2hFinality({ provisionalAtMs, committeeFinal, audits, resultsHash, nowMs }) {
  const shortClose = BigInt(provisionalAtMs) + OBJECTION_WINDOW_H2H_MS, longClose = BigInt(provisionalAtMs) + OBJECTION_WINDOW_MS;
  const want = toHex(resultsHash);
  const inTime = new Set((audits || []).filter((x) => toHex(x.resultsHash) === want && BigInt(x.heldAtMs) <= shortClose).map((x) => toHex(x.nodePubkey)));
  const audited = inTime.size >= H2H_AUDITS_NEEDED;
  const now = BigInt(nowMs);
  if (!committeeFinal) return { final: false, window: audited ? 'short' : 'long', audited, why: 'the committee has not signed FINAL' };
  if (audited) return { final: now >= shortClose, atMs: shortClose, window: 'short', audited: true };
  return { final: now >= longClose, atMs: longClose, window: 'long', audited: false };
}
