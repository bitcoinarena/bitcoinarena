// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE NODES THAT SERVED A ROUND IN THE LAST 24 HOURS (2026-10-15: an in-game item's price goes "50% an die
// nodes die in den letzten 24h an einer Runde beteiligt waren"). The part of the item plan that moves no money (plan: comment 2310):
// WHICH nodes, and in how many rounds each, read so that every node arrives at the same list.
//
// WHAT COUNTS AS SERVING: a seat's signed FINAL on a round (final-sig.js) - public, signed by the node's own key, and only a member
// of that round's committee can give one. A round counts once per node, however many entries it signed FINAL for. The window is
// [fromMs, toMs) on the signature's own clock; the caller fixes `toMs` from something every node reads alike (a purchase names its
// anchor block, whose time it is), never its own clock.
//
// THE LIST AND ITS ROOT: the nodes sorted by key, each with its count of rounds; root = taggedHash('ARENA/v1/ServedNodes',
// from || to || [key || rounds]...). A purchase names the root; a node that rebuilds another root from the FINAL signatures it holds
// can show exactly which node or count differs (servedNodesDiffer). Equal or weighted shares are both read from this one list.
//
// NO CURVE: `verify(signature, digest, key)` is injected, as final-sig.js takes it.
import { Writer } from './encode.js';
import { taggedHash, toHex } from './hash.js';
import { splitSignedFinalSig, decodeFinalSig, finalSigId } from './final-sig.js';

export const SERVED_WINDOW_MS = 24 * 3600 * 1000;
export const TAG_SERVED_NODES = 'ARENA/v1/ServedNodes';
const snIs32 = (b) => b instanceof Uint8Array && b.length === 32;

/**
 * THE SERVED LIST over `rounds` = [{ roundId, committee: [key32...], finals: [signed FINAL bytes...] }], window [fromMs, toMs).
 * A FINAL counts when it is about that round, signed by a member of its committee, verifies, and was signed inside the window.
 * Answers { fromMs, toMs, nodes: [{ key (hex), rounds }], rounds (counted), root (hex), refused: [{ round, why }] }.
 */
export function servedNodes({ rounds, fromMs, toMs, verify }) {
  if (typeof verify !== 'function') throw new Error('reading who served needs a verifier, and none was injected');
  const from = BigInt(fromMs), to = BigInt(toMs);
  if (!(to > from)) throw new Error('a served window ends after it starts');
  const served = new Map();                                  // key hex -> Set of round hex
  const refused = [];
  let counted = 0;
  for (const round of rounds || []) {
    if (!round || !snIs32(round.roundId) || !Array.isArray(round.committee)) { refused.push({ round: null, why: 'a round is named by its id and committee' }); continue; }
    const rid = toHex(round.roundId);
    const committee = new Set(round.committee.map(toHex));
    let any = false;
    for (const bytes of round.finals || []) {
      let x, signature;
      try { ({ signature } = splitSignedFinalSig(bytes)); x = decodeFinalSig(bytes.subarray(0, bytes.length - signature.length)); }
      catch (e) { refused.push({ round: rid, why: `not a FINAL signature: ${e.message}` }); continue; }
      const key = toHex(x.signerPubkey);
      if (toHex(x.roundId) !== rid) { refused.push({ round: rid, why: `a FINAL about another round (${toHex(x.roundId).slice(0, 16)})` }); continue; }
      if (!committee.has(key)) { refused.push({ round: rid, why: `${key.slice(0, 16)} is not of this round's committee` }); continue; }
      let good = false;
      try { good = !!verify(signature, finalSigId(x), x.signerPubkey); } catch { good = false; }
      if (!good) { refused.push({ round: rid, why: `${key.slice(0, 16)}'s FINAL does not verify` }); continue; }
      if (x.signedAtMs < from || x.signedAtMs >= to) continue;  // outside the window: not refused, just not these 24 h
      if (!served.has(key)) served.set(key, new Set());
      served.get(key).add(rid); any = true;
    }
    if (any) counted++;
  }
  const nodes = [...served.entries()].map(([key, s]) => ({ key, rounds: s.size })).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { fromMs: from, toMs: to, nodes, rounds: counted, root: toHex(servedNodesRoot({ fromMs: from, toMs: to, nodes })), refused };
}

/** The root of a served list: what a purchase names and every node rebuilds. */
export function servedNodesRoot({ fromMs, toMs, nodes }) {
  const w = new Writer();
  w.u64(BigInt(fromMs)); w.u64(BigInt(toMs));
  const sorted = [...nodes].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (let i = 1; i < sorted.length; i++) if (sorted[i].key === sorted[i - 1].key) throw new Error(`node ${sorted[i].key.slice(0, 16)} is listed twice`);
  w.vec(sorted, (n, ww) => { ww.bytes32(Uint8Array.from(n.key.match(/../g).map((h) => parseInt(h, 16)))); ww.u32(n.rounds); });
  return taggedHash(TAG_SERVED_NODES, w.finish());
}

/** WHERE TWO SERVED LISTS DIFFER (a claimed one against the reader's own): [] when they agree. */
export function servedNodesDiffer(claimed, mine) {
  const out = [];
  if (BigInt(claimed.fromMs) !== BigInt(mine.fromMs) || BigInt(claimed.toMs) !== BigInt(mine.toMs)) out.push({ why: 'another window' });
  const a = new Map(claimed.nodes.map((n) => [n.key, n.rounds])), b = new Map(mine.nodes.map((n) => [n.key, n.rounds]));
  for (const [k, r] of a) if (!b.has(k)) out.push({ key: k, why: `named with ${r} round(s), and served none here` }); else if (b.get(k) !== r) out.push({ key: k, why: `named with ${r} round(s), and ${b.get(k)} here` });
  for (const [k, r] of b) if (!a.has(k)) out.push({ key: k, why: `served ${r} round(s) here, and is left out` });
  return out;
}

/**
 * ONE SET OF ROUNDS FROM WHAT SEVERAL SEATS HOLD (measured 2026-10-15 17:3xZ: each seat holds only the FINALs of the
 * rounds it sat on - 14 seats gave 7 roots for one window). `held` is a list of seats' answers, each [{ roundId, committee, finals }];
 * a round's FINALs are joined (each signed FINAL once), and a round two seats name with different committees is left out and
 * named in `conflicts` - servedNodes then checks every FINAL itself, so a seat that hands over a forged one adds nothing.
 */
export function mergeServedRounds(held) {
  const hx = (b) => toHex(b);
  const rounds = new Map(), conflicts = new Set();
  for (const seat of held || []) for (const r of seat || []) {
    if (!r || !snIs32(r.roundId) || !Array.isArray(r.committee)) continue;
    const k = hx(r.roundId), committee = r.committee.map(hx).sort().join();
    if (!rounds.has(k)) rounds.set(k, { roundId: r.roundId, committee: r.committee, key: committee, finals: new Map() });
    const into = rounds.get(k);
    if (into.key !== committee) { conflicts.add(k); continue; }
    for (const f of r.finals || []) if (f instanceof Uint8Array) into.finals.set(hx(f), f);
  }
  return { rounds: [...rounds.entries()].filter(([k]) => !conflicts.has(k)).map(([, r]) => ({ roundId: r.roundId, committee: r.committee, finals: [...r.finals.values()] })),
    conflicts: [...conflicts] };
}
