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
  // kanban #2312/#2325 (#1489 a45 refute 9 skeptic 2 of #2239): mergeServedRounds names, per FINAL, the answers that hold it
  // (`sources`). Each answer may hand over at most SERVED_FAILED_MAX FINALs that do not verify; once every answer holding a FINAL has
  // spent that, the FINAL is not checked. An honest answer holds FINALs that verify and is never cut, however many rounds it holds
  // and whoever else answers; padding with junk signatures costs the reader at most SERVED_FAILED_MAX checks per answer.
  const failed = new Map(), spent = new Set();               // answer index -> FINALs of it that did not verify
  // kanban #2361/#2365 (#1489 a45 refute 9 skeptic 3 of #2312): a FINAL that VERIFIES costs the same check, and one seat can sign
  // valid FINALs on made-up rounds under keys it made up (18,000 checks for 2,000 such rounds). So every check of a round the reader's
  // own record does not hold is charged to an answer holding the FINAL - the one with the most budget left - and an answer is checked
  // for at most SERVED_CHECKS_MAX of them, valid or not. A round the reader's own record holds (`own`, mergeServedRounds) is real: it
  // costs at most 18 checks per answer and is never cut. A FINAL named by no answer (the caller's own rounds) is not charged.
  const checked = new Map(), exhausted = new Set();          // answer index -> checks charged to it
  let counted = 0;
  for (const round of rounds || []) {
    if (!round || !snIs32(round.roundId) || !Array.isArray(round.committee)) { refused.push({ round: null, why: 'a round is named by its id and committee' }); continue; }
    const rid = toHex(round.roundId);
    const committee = new Set(round.committee.map(toHex));
    const sources = Array.isArray(round.sources) ? round.sources : null;
    let any = false;
    const finals = round.finals || [];
    for (let j = 0; j < finals.length; j++) {
      const bytes = finals[j];
      let x, signature;
      try { ({ signature } = splitSignedFinalSig(bytes)); x = decodeFinalSig(bytes.subarray(0, bytes.length - signature.length)); }
      catch (e) { refused.push({ round: rid, why: `not a FINAL signature: ${e.message}` }); continue; }
      const key = toHex(x.signerPubkey);
      if (toHex(x.roundId) !== rid) { refused.push({ round: rid, why: `a FINAL about another round (${toHex(x.roundId).slice(0, 16)})` }); continue; }
      if (!committee.has(key)) { refused.push({ round: rid, why: `${key.slice(0, 16)} is not of this round's committee` }); continue; }
      if (served.get(key)?.has(rid)) continue;                 // a round counts once per node: no second check for it
      const src = sources && Array.isArray(sources[j]) && sources[j].length ? sources[j] : null;
      if (src && src.every((s) => (failed.get(s) || 0) >= SERVED_FAILED_MAX)) continue;   // its answers spent their bad-signature budget
      if (src && !round.own) {                                 // kanban #2361: a check of a round the reader did not sit on costs an answer
        let payer = null;
        for (const s of src) if ((checked.get(s) || 0) < SERVED_CHECKS_MAX && (payer === null || (checked.get(s) || 0) < (checked.get(payer) || 0))) payer = s;
        if (payer === null) continue;
        const n = (checked.get(payer) || 0) + 1; checked.set(payer, n);
        if (n >= SERVED_CHECKS_MAX && !exhausted.has(payer)) { exhausted.add(payer); refused.push({ round: null, why: `answer ${payer} made this reader check ${n} FINALs of rounds it did not sit on: no more of its FINALs are checked` }); }
      }
      let good = false;
      try { good = !!verify(signature, finalSigId(x), x.signerPubkey); } catch { good = false; }
      if (!good) {
        refused.push({ round: rid, why: `${key.slice(0, 16)}'s FINAL does not verify` });
        if (src) for (const s of src) {
          const n = (failed.get(s) || 0) + 1; failed.set(s, n);
          if (n >= SERVED_FAILED_MAX && !spent.has(s)) { spent.add(s); refused.push({ round: null, why: `answer ${s} handed over ${n} FINALs that do not verify: no more of its FINALs are checked` }); }
        }
        continue;
      }
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
 *     between equally many the one held first (the caller's own record first, then the seats in the order it lists them);
 *   - a seat's answer names each round once (kanban #1698, #1766, measured: one seat listing a real round three times, each with a
 *     committee of one made-up key, outvoted two honest seats and that key took 250,000 msat of a 500-sat item): the first entry
 *     of a round in one seat's answer is that seat's, and its later repeats are skipped - so "most seats" counts seats, not entries.
 */
export const SERVED_COMMITTEE_MAX = 9;
export const SERVED_HELD_MAX = 20000;
// kanban #2239 (#1489 a45 refute 9 of #1815): what one seat's answer makes the reader verify is bounded IN ALL, not per round entry.
//   - a round is read once per answer: the first entry naming it stands, a repeat adds no FINAL and no vote for its committee
//     (measured before: the same real round listed 2,000 times in one answer cost 12,003 BIP-340 checks, 7.6 s on the M1 Max);
//   - a reader reads one seat's answer up to SERVED_ANSWER_BYTES_MAX bytes (server.js, item-buy.js).
// kanban #2312/#2325 (#1489 a45 refute 9 skeptic 2 of #2239): #2239 also kept, per answer, only SERVED_LONE_FINALS_MAX (360) new FINALs
// of the rounds no other answer named. That was both too weak and too strong: two seats naming the same made-up rounds made them
// "named by two" and escaped it (2,000 rounds: 72,000 junk checks), and an honest seat whose committee-mates do not answer - the
// reader's own record included - had its rounds past 120 cut. The bound is now on what costs the reader: each merged FINAL carries
// the answers that hold it (`sources`, by index in `held`), and servedNodes stops checking an answer's FINALs once SERVED_FAILED_MAX
// of them did not verify. FINALs that verify are never cut; how many answers name a round no longer matters.
export const SERVED_LONE_FINALS_MAX = 360;   // kept exported for older imports; no longer read (kanban #2312)
export const SERVED_FAILED_MAX = 64;
// kanban #2361/#2365 (#1489 a45 refute 9 skeptic 3 of #2312): and at most SERVED_CHECKS_MAX checks in all - valid signatures or not -
// per answer for rounds the reader's own record does not hold. #2312 bounded only FINALs that fail; one seat signing valid FINALs
// under keys it made up on 2,000 made-up rounds cost 18,000 checks (300 rounds, real signatures: 3.4 s on the M1 Max). A round the
// reader sat on is not charged; a FINAL several answers hold is charged to the one with the most budget left, so honest rounds held
// by their committee's seats spread over them.
export const SERVED_CHECKS_MAX = 1024;
export const SERVED_ANSWER_BYTES_MAX = 32 * 1024 * 1024;
// `own` (default true): held[0] is the reader's own record (server.js), and the rounds it names are marked `own` - servedNodes does
// not charge their checks to the answers (kanban #2361). A reader with no record of its own (the page, item-buy.js) passes false.
// `bonded` (kanban #1896, decided 2026-11-14 "(b) committee nodes only count"): a Set of node keys (hex) of a census the reader checked,
// or null. Given, a committee copy counts only when every key of it is such a node: a copy naming a key no checked census bonds is
// not taken - no vote, no FINAL - however many seat URLs name it (measured before: one stranger's server at three URLs named a real
// round with a committee of one made-up key, outvoted two honest seats, and that key took the nodes' whole half of a 500-sat item).
// null (the seats' own merges) reads as before.
export function mergeServedRounds(held, { own = true, bonded = null } = {}) {
  const hx = (b) => toHex(b);
  const rounds = new Map(), conflicts = new Set();
  (held || []).forEach((seat, at) => {
    if (!Array.isArray(seat)) return;
    const seen = new Set();
    for (const r of seat.slice(0, SERVED_HELD_MAX)) {
      if (!r || !snIs32(r.roundId) || !Array.isArray(r.committee) || !r.committee.length || r.committee.length > SERVED_COMMITTEE_MAX || !r.committee.every(snIs32)) continue;
      const k = hx(r.roundId);
      if (seen.has(k)) continue;                              // kanban #2239: one answer names a round once
      seen.add(k);
      if (bonded && !r.committee.every((k) => bonded.has(hx(k)))) continue;   // kanban #1896: only bonded nodes are a committee
      const committee = [...new Set(r.committee.map(hx))].sort().join();
      if (!rounds.has(k)) rounds.set(k, { roundId: r.roundId, copies: new Map(), finals: new Map(), sources: new Map(), own: false });
      const into = rounds.get(k);
      if (own && at === 0) into.own = true;
      if (!into.copies.has(committee)) into.copies.set(committee, { committee: r.committee, seats: 0 });
      into.copies.get(committee).seats++;
      if (into.copies.size > 1) conflicts.add(k);
      // kanban #1815: what one seat's answer makes the reader verify is bounded. A round counts once per node, so from each seat's
      // answer at most two FINALs per signer are kept - its earliest and its latest (a node's FINALs on one round fall inside minutes,
      // so when any of them lies in a window, one of these two does) - and at most SERVED_COMMITTEE_MAX signers, the first listed (a
      // seat keeps FINALs only from the round's committee). What is no FINAL at all is not kept; servedNodes still checks the rest.
      // Measured before: one padded answer of 20,000 made-up FINALs under a real committee's keys, junk signatures, cost 20,003
      // BIP-340 checks (28 s on a seat's main thread) on every item purchase and funding decision.
      const bySigner = new Map();
      for (const f of Array.isArray(r.finals) ? r.finals : []) {
        if (!(f instanceof Uint8Array)) continue;
        let x; try { const { signature } = splitSignedFinalSig(f); x = decodeFinalSig(f.subarray(0, f.length - signature.length)); } catch { continue; }
        const key = hx(x.signerPubkey), b = bySigner.get(key);
        if (!b) { if (bySigner.size < SERVED_COMMITTEE_MAX) bySigner.set(key, { first: [x.signedAtMs, f], last: [x.signedAtMs, f] }); continue; }
        if (x.signedAtMs < b.first[0]) b.first = [x.signedAtMs, f];
        if (x.signedAtMs > b.last[0]) b.last = [x.signedAtMs, f];
      }
      // kanban #2312: every FINAL kept names the answers holding it, so servedNodes can stop at an answer's bad-signature budget
      for (const b of bySigner.values()) for (const [, f] of [b.first, b.last]) {
        const h = hx(f);
        if (!into.finals.has(h)) { into.finals.set(h, f); into.sources.set(h, [at]); }
        else if (!into.sources.get(h).includes(at)) into.sources.get(h).push(at);
      }
    }
  });
  const pick = (copies) => { let best = null; for (const c of copies.values()) if (!best || c.seats > best.seats) best = c; return best.committee; };
  return { rounds: [...rounds.values()].map((r) => ({ roundId: r.roundId, committee: pick(r.copies), finals: [...r.finals.values()], sources: [...r.sources.values()], own: r.own })),
    conflicts: [...conflicts] };
}
