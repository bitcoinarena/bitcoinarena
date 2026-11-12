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
 * a round's FINALs are joined (each signed FINAL once) and servedNodes then checks every FINAL itself, so a seat that hands over a
 * forged one adds nothing.
 *
 * ONE SEAT'S ANSWER DOES NOT DECIDE WHO IS PAID (kanban #1522, measured: one seat answering an invented round whose "committee" was
 * 20 keys it made up, each with a FINAL, took 217,380 msat of a 500-sat item; naming a real round with another committee dropped the
 * round, and the nodes that served it were paid nothing):
 *   - a committee larger than any round may name is refused: genesis binds 7 slots, and a round names at most its draw, 9
 *     (contracts.js sittingSeatsFitTheSlots, sortition.js drawnForRole);
 *   - each seat's answer is read up to SERVED_HELD_MAX rounds;
 *   - two seats naming one round with different committees no longer drop the round: the committee most seats name stands, and
 *     between equally many the one held first (the caller's own record first, then the seats in the order it lists them).
 */
export const SERVED_COMMITTEE_MAX = 9;
export const SERVED_HELD_MAX = 20000;
// kanban #2239 (#1489 a45 refute 9 of #1815): what one seat's answer makes the reader verify is bounded IN ALL, not per round entry.
//   - a round is read once per answer: the first entry naming it stands, a repeat adds no FINAL and no vote for its committee
//     (measured before: the same real round listed 2,000 times in one answer cost 12,003 BIP-340 checks, 7.6 s on the M1 Max);
//   - a round that only one answer names (no other seat, and not the reader's own record, holds it) is read from that answer up to
//     SERVED_LONE_FINALS_MAX new FINALs in all; past that its FINALs are not kept (measured before: 1,200 made-up rounds with a
//     made-up committee each cost 21,603 checks). A real round is held by every seat of its committee, so it is named by more than one;
//   - a reader reads one seat's answer up to SERVED_ANSWER_BYTES_MAX bytes (server.js, item-buy.js).
export const SERVED_LONE_FINALS_MAX = 360;
export const SERVED_ANSWER_BYTES_MAX = 32 * 1024 * 1024;
export function mergeServedRounds(held) {
  const hx = (b) => toHex(b);
  const rounds = new Map(), conflicts = new Set();
  // each answer's rounds, each round once (the first entry naming it), and how many answers name each round
  const answers = [], namedBy = new Map();
  for (const seat of held || []) {
    if (!Array.isArray(seat)) continue;
    const seen = new Set(), list = [];
    for (const r of seat.slice(0, SERVED_HELD_MAX)) {
      if (!r || !snIs32(r.roundId) || !Array.isArray(r.committee) || !r.committee.length || r.committee.length > SERVED_COMMITTEE_MAX || !r.committee.every(snIs32)) continue;
      const k = hx(r.roundId);
      if (seen.has(k)) continue;
      seen.add(k); list.push([k, r]);
      namedBy.set(k, (namedBy.get(k) || 0) + 1);
    }
    answers.push(list);
  }
  for (const list of answers) {
    let lone = 0;
    for (const [k, r] of list) {
      const committee = [...new Set(r.committee.map(hx))].sort().join();
      if (!rounds.has(k)) rounds.set(k, { roundId: r.roundId, copies: new Map(), finals: new Map() });
      const into = rounds.get(k);
      if (!into.copies.has(committee)) into.copies.set(committee, { committee: r.committee, seats: 0 });
      into.copies.get(committee).seats++;
      if (into.copies.size > 1) conflicts.add(k);
      // kanban #1815: what one seat's answer makes the reader verify is bounded. A round counts once per node, so from each seat's
      // answer at most two FINALs per signer are kept - its earliest and its latest (a node's FINALs on one round fall inside minutes,
      // so when any of them lies in a window, one of these two does) - and at most SERVED_COMMITTEE_MAX signers, the first listed (a
      // seat keeps FINALs only from the round's committee). What is no FINAL at all is not kept; servedNodes still checks the rest.
      // Measured before: one padded answer of 20,000 made-up FINALs under a real committee's keys, junk signatures, cost 20,003
      // BIP-340 checks (28 s on a seat's main thread) on every item purchase and funding decision.
      if (namedBy.get(k) < 2 && lone >= SERVED_LONE_FINALS_MAX) continue;   // kanban #2239: the budget is spent, nothing more is read
      const bySigner = new Map();
      for (const f of Array.isArray(r.finals) ? r.finals : []) {
        if (!(f instanceof Uint8Array)) continue;
        let x; try { const { signature } = splitSignedFinalSig(f); x = decodeFinalSig(f.subarray(0, f.length - signature.length)); } catch { continue; }
        const key = hx(x.signerPubkey), b = bySigner.get(key);
        if (!b) { if (bySigner.size < SERVED_COMMITTEE_MAX) bySigner.set(key, { first: [x.signedAtMs, f], last: [x.signedAtMs, f] }); continue; }
        if (x.signedAtMs < b.first[0]) b.first = [x.signedAtMs, f];
        if (x.signedAtMs > b.last[0]) b.last = [x.signedAtMs, f];
      }
      const add = new Map();
      for (const b of bySigner.values()) for (const [, f] of [b.first, b.last]) { const h = hx(f); if (!into.finals.has(h)) add.set(h, f); }
      // kanban #2239: a round no other answer names spends this answer's budget of new FINALs; past it they are not kept
      if (namedBy.get(k) < 2) { if (lone + add.size > SERVED_LONE_FINALS_MAX) continue; lone += add.size; }
      for (const [h, f] of add) into.finals.set(h, f);
    }
  }
  const pick = (copies) => { let best = null; for (const c of copies.values()) if (!best || c.seats > best.seats) best = c; return best.committee; };
  return { rounds: [...rounds.values()].map((r) => ({ roundId: r.roundId, committee: pick(r.copies), finals: [...r.finals.values()] })),
    conflicts: [...conflicts] };
}
