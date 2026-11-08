// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// ONLY NODES SEEN IN THE LAST 24 H ARE DRAWN (multiplayer_p2p.md §5A.3 "Absent from its seatings", protocol 22, kanban #727).
//
// Measured on testnet4 2026-10-27: every Up/Down v23 round drew 9 nodes, 7-9 of them stopped test nodes whose bonds were still locked,
// so no round was seated all day. the owner 14:00Z: "Können die adverts nur gezogen werden von nodes die in den letzten 24h auch online
// waren?" - yes, from 2.0. "Online" from pings is no shared fact, so the rule reads only threshold-signed seating certificates:
//
//   window      (T - 24 h, T], T the median time past of the census block
//   a seating   one (round, role) whose seating_close (seating.js) falls in the window and whose 22 certificate stands - every seated
//               node signed it and signed who it held a PRESENT of at the close (seating.js SEEN)
//   present     listed by any seated node of the certificate, or seated in it
//   missed      drawn for the seating by the round's own draw - or left out of the round's census as absent, as every seated node
//               says - and not present
//   absent      in the chain census, present at no window seating, and missed at ABSENCE_PROOF_SEATINGS (3) or more seatings or
//               heartbeat slots whose closes lie at least ABSENCE_PROOF_SPACING_MS (1 h) apart
//   census      from protocol 22 the census is the chain census less every output of an absent node; its root commits to that set
//
// ABSENCE ONLY WITH PROOF (the owner 2026-10-27, "can it be manipulated which nodes are offline so others are chosen?"). As first built the
// posting node chose the absent from the PRESENTs it collected, and a seat could refuse it only with a signature it happened to hold: a
// posting node could leave out honest nodes to raise its own share of the draw. Now every absent node in a claim comes with three
// certificates the round's seated signed, and any seat and the client check them alone: the signers are the seated of the round's own
// draw, the node was drawn there (or left out already) and no seated node listed it. A claim without that is not a census at all.
// To hide an honest node's PRESENT every seated node of a seating must lie, three times at three moments.
//
// AND NOT FOR A FEW MISSED SEATINGS (the owner 2026-10-27, an attacker flooding a node while it is drawn): fewer than 3 missed seatings,
// or present once, and the node is kept. 3 closes at least 1 h apart (ABSENCE_PROOF_SPACING_MS), so one blackout - on two games' grids,
// or a restart across several heartbeat slots - counts once.
//
// AND THE HEARTBEAT, SO A DAY IS ENOUGH (kanban #727, the owner 2026-10-27): a seating proves only its 9 drawn missed, and only when 5 of
// them are present, so on 10-27 the stopped nodes took three days to be proven out. A heartbeat certificate (heartbeat.js) proves EVERY
// node of its round's census missed that it does not list, one slot per round (the owner 2026-10-27). A proof names a seating (role game or
// settlement) or a heartbeat slot (role heartbeat-0); both count towards the 3 closes an hour apart, and a listing in either keeps the node in.
//
// AND ONLY THE DUTY POSTINGS' ROUNDS PROVE (kanban #727, the heartbeat helper's open hole: rounds anyone posts add draws, so a group that
// posts many rounds of its own gets more chances to land 5 of its nodes in one). A proof's round must be of a duty posting of its day -
// the primary, the backup or an emergency grid: its publication marked for that day and item, its creator within the first 3 of the
// day's duty order (duty.js dutyRoundStands) - which an attacker cannot be on demand: that order is the chain census's rank. A round of
// any other series proves nothing; its certificate still keeps the nodes it lists in. Every seat and the client decide it the same way
// (`dutyOf` below: presence-book.js at a seat, client-committee.js at the client).
import { toHex } from './hash.js';
import { PRESENCE_VERSION, ABSENCE_PROOF_SEATINGS, ABSENCE_PROOF_SPACING_MS, ABSENCE_CAP_BPS } from './constants.js';
import { medianTimePast } from './beacon.js';
import { verifySeating } from './seating.js';
import { provenHeartbeat, heartbeatSlotOf } from './heartbeat.js';

export { ABSENCE_PROOF_SEATINGS, ABSENCE_PROOF_SPACING_MS, ABSENCE_CAP_BPS };
/**
 * HOW MANY OF THESE CLOSES COUNT: the most that lie pairwise at least ABSENCE_PROOF_SPACING_MS apart (newest first, each the next
 * one at least 1 h older - the greedy pick is the largest such set on a line).
 */
export function spacedCloses(closes) {
  let n = 0, last = null;
  for (const c of [...new Set([...closes].map(BigInt))].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0))) {
    if (last === null || last - c >= ABSENCE_PROOF_SPACING_MS) { n++; last = c; }
  }
  return n;
}
/** The window's length: 24 h of median time past before the census block (the owner 2026-10-27). */
export const PRESENCE_WINDOW_MS = 24n * 3600n * 1000n;
/** What a census says of an output it leaves out as absent. */
export const ABSENT_WHY = `proven drawn and not present at ${ABSENCE_PROOF_SEATINGS} or more seatings of the 24 h before the census, and present at none: left out of the census, its bond untouched`;

/** Does this round's census leave out its absent nodes (protocol 22 on)? */
export const dropsAbsent = (contract) => !!contract && Number(contract.protocolVersion) >= PRESENCE_VERSION;

const hexOfPresence = (k) => (typeof k === 'string' ? k.toLowerCase() : toHex(k));

/** The window of a census whose block's median time past is `censusTimeMs`: (from, to]. */
export function presenceWindow(censusTimeMs) {
  const to = BigInt(censusTimeMs);
  return { fromMs: to - PRESENCE_WINDOW_MS, toMs: to };
}
/** T: the median time past of the census block, in ms, off a view's headers - null where the view does not reach it. */
export function censusTimeMs(view, censusHeight) {
  if (!view || !Array.isArray(view.blocks)) return null;
  const t = medianTimePast(view.blocks.map((b) => b.header), view.firstHeight, censusHeight);
  return t === null ? null : BigInt(t) * 1000n;
}
export const inWindow = (w, ms) => BigInt(ms) > w.fromMs && BigInt(ms) <= w.toMs;

/**
 * A SEATING AS PROOF: a 22 certificate checked against the draw the checker computed itself (`drawn`, `slots`) and the seating's close.
 * Answers { ok, seating: { roundId, role, closeMs, drawn, seated, present, leftOut } } (keys hex) or { ok: false, why }.
 */
export function provenSeating(bytes, { roundId, role, drawn, slots, closeMs, verify }) {
  const v = verifySeating(bytes, { roundId: typeof roundId === 'string' ? Uint8Array.from(roundId.match(/../g).map((h) => parseInt(h, 16))) : roundId,
    role, drawn: drawn.map((k) => (typeof k === 'string' ? Uint8Array.from(k.match(/../g).map((h) => parseInt(h, 16))) : k)), slots, verify, listsPresent: true });
  if (!v.ok) return v;
  return { ok: true, seating: { roundId: toHex(v.seating.roundId), role: v.seating.role, closeMs: BigInt(closeMs), drawn: drawn.map(hexOfPresence),
    seated: v.seating.seated.map(toHex), present: v.present, leftOut: v.leftOut } };
}
/** Was `node` present at this seating (listed by a seated node, or seated)? */
export const presentAt = (node, s) => s.present.includes(node) || s.seated.includes(node);
/**
 * Did `node` miss this seating: drawn for it, or left out of its census already - and not present? A heartbeat slot expects every node
 * of its round's census (`expected`), not only its committee.
 */
export const missedAt = (node, s) => ((s.expected || s.drawn).includes(node) || s.leftOut.includes(node)) && !presentAt(node, s);

/**
 * ONE PROOF, CHECKED ON THE CHECKER'S OWN DRAW: a seating certificate (`d` { drawn, slots, closeMs }) or a heartbeat certificate (`d`
 * { heartbeat: j, drawn: the slot's committee, census: the round's census keys, closeMs }). Answers { ok, seating } as provenSeating.
 */
export function provenProof(bytes, { roundId, role, d, verify }) {
  if (heartbeatSlotOf(role) !== null) {
    if (d.heartbeat !== heartbeatSlotOf(role) || !Array.isArray(d.census)) return { ok: false, why: `that draw is not of heartbeat slot ${role}` };
    return provenHeartbeat(bytes, { roundId, slot: d.heartbeat, committee: d.drawn, census: d.census, closeMs: d.closeMs, verify });
  }
  return provenSeating(bytes, { roundId, role, drawn: d.drawn, slots: d.slots, closeMs: d.closeMs, verify });
}

/**
 * THE ABSENT, AS A POSTING NODE FINDS THEM. `seatings` the window's proven seatings it holds (provenSeating), `census` the chain census's
 * node keys, `seen` node keys it holds any other window evidence of (a PRESENT a seat would refuse the claim with). Answers the claims
 * sorted by node: [{ node, proofs: [{ roundId, role }] }], each naming the ABSENCE_PROOF_SEATINGS newest seatings it missed, at different
 * closes. ABSENT STAYS ABSENT UNTIL SEEN: a node the census of a window seating left out is missed there too, so it is not back the day
 * after for having been drawn for nothing; it comes back by signing a PRESENT that a seated node lists.
 * ONLY THE DUTY POSTINGS' ROUNDS PROVE (kanban #727, duty.js): `dutyOf(ridHex)` answers { ok } for a round of a duty posting of its
 * day, { ok: false } for any other (or null: not known yet - treated as no proof). A certificate of any round keeps the nodes it lists
 * in (it is evidence of presence); only a duty round's certificate is named as proof of a miss.
 */
export function absentFrom({ seatings, census, window, seen = [], dutyOf = null, weights = null }) {
  const inCensus = [...new Set([...census].map(hexOfPresence))].sort();
  const sawIt = new Set([...seen].map(hexOfPresence));
  const evidence = (seatings || []).filter((s) => inWindow(window, s.closeMs))
    .sort((a, b) => (a.closeMs === b.closeMs ? (a.roundId + a.role < b.roundId + b.role ? -1 : 1) : (a.closeMs > b.closeMs ? -1 : 1)));
  for (const s of evidence) { for (const k of s.present) sawIt.add(k); for (const k of s.seated) sawIt.add(k); }
  const dutyKept = new Map();
  const isDuty = (s) => { if (!dutyOf) return true; if (!dutyKept.has(s.roundId)) { const d = dutyOf(s.roundId); dutyKept.set(s.roundId, !!(d && d.ok)); } return dutyKept.get(s.roundId); };
  const proven = evidence.filter(isDuty);
  const claims = [];
  for (const node of inCensus) {
    if (sawIt.has(node)) continue;
    const proofs = [];
    let last = null;
    for (const s of proven) {
      if (proofs.length >= ABSENCE_PROOF_SEATINGS) break;
      if ((last !== null && last - s.closeMs < ABSENCE_PROOF_SPACING_MS) || !missedAt(node, s)) continue;
      last = s.closeMs;
      proofs.push({ roundId: s.roundId, role: s.role });
    }
    if (proofs.length >= ABSENCE_PROOF_SEATINGS) claims.push({ node, proofs, sinceMs: BigInt(last) });
  }
  // THE CAP (kanban #1291): with the census's weights, at most ABSENCE_CAP_BPS of it, those whose oldest named miss is oldest first
  const kept = weights ? absenceCapKept(claims, weights) : claims;
  return kept.map(({ node, proofs }) => ({ node, proofs }));
}

/** The census's bonded weight by node (hex key -> bigint sats): every output of a node counts to it. */
export function weightsOf(entries) {
  const w = new Map();
  for (const e of entries || []) { const k = hexOfPresence(e.pubkey); w.set(k, (w.get(k) || 0n) + BigInt(e.bondSats)); }
  return w;
}
const totalOf = (weights) => { let t = 0n; for (const v of weights.values()) t += v; return t; };

/**
 * THE ABSENCE CAP, IN ORDER (§5A.3, kanban #1291): `claims` [{ node, sinceMs (its oldest named miss) }], `weights` weightsOf(the chain
 * census). Kept: oldest miss first (then key), up to the first that would take the kept at most ABSENCE_CAP_BPS past ABSENCE_CAP_BPS of the census - it and every newer one stay in. No exception for the first: a
 * node above the cap alone stays in. Answers the kept claims, by node.
 */
export function absenceCapKept(claims, weights) {
  const total = totalOf(weights);
  const order = [...claims].sort((a, b) => (BigInt(a.sinceMs) === BigInt(b.sinceMs) ? (a.node < b.node ? -1 : 1) : (BigInt(a.sinceMs) < BigInt(b.sinceMs) ? -1 : 1)));
  const kept = [];
  let out = 0n;
  for (const c of order) {
    const w = weights.get(hexOfPresence(c.node)) || 0n;
    if ((out + w) * 10000n > total * ABSENCE_CAP_BPS) break;
    kept.push(c); out += w;
  }
  return kept.sort((a, b) => (a.node < b.node ? -1 : 1));
}

/**
 * IS THE ABSENT SET WITHIN THE CAP: the weight of `chainEntries` whose node `absent` names, against ABSENCE_CAP_BPS of all of them. What
 * every seat and the client check of a committed census (deriveCensus refuses one over it). Answers { ok, outSats, totalSats } or { ok: false, why, ... }.
 */
export function absenceWithinCap(chainEntries, absent) {
  const weights = weightsOf(chainEntries);
  const total = totalOf(weights);
  let outSats = 0n;
  for (const k of new Set((absent || []).map((a) => hexOfPresence(a.node || a)))) outSats += weights.get(k) || 0n;
  if (outSats * 10000n > total * ABSENCE_CAP_BPS) {
    return { ok: false, outSats, totalSats: total, why: `that claim leaves out ${outSats} of ${total} bonded sats as absent, above the ${Number(ABSENCE_CAP_BPS) / 100} % a census may leave out (§5A.3)` };
  }
  return { ok: true, outSats, totalSats: total };
}

/** The census less every output of an absent node (a node is its key: all its bonds go with it). */
export function withoutAbsent(entries, absent) {
  const out = new Set((absent || []).map((a) => hexOfPresence(a.node || a)));
  return (entries || []).filter((e) => !out.has(hexOfPresence(e.pubkey)));
}

/**
 * THE ABSENT A COMMITTED CENSUS IMPLIES: the node keys of the chain census none of whose outputs are in the committed one. A seat
 * that holds the chain census and the round's entries (GET /census) recovers the claim's node list from the root alone.
 */
export function absentImplied(chainEntries, committedEntries) {
  const kept = new Set((committedEntries || []).map((e) => hexOfPresence(e.pubkey)));
  return [...new Set((chainEntries || []).map((e) => hexOfPresence(e.pubkey)))].filter((h) => !kept.has(h)).sort();
}

/**
 * THE CHECK OF AN ABSENT CLAIM'S PROOFS - the same at every seat and at the client. `claims` as absentFrom answers; `census` the node
 * keys the claimed nodes must be in (a seat: its chain census; the client: none, it cannot see a node a census left out); `certOf(ridHex,
 * role)` the certificate bytes the claim attached (or the checker holds); `drawOf(ridHex, role)` the checker's own draw of that seating
 * - { drawn, slots, closeMs } - or null when it cannot draw it yet; `seen` node keys the checker holds other window evidence of (a seat's
 * own PRESENTs and certificates; the owner ruled that refusal stays the seat's own). `dutyOf(ridHex)`: is the named round a duty posting's
 * (duty.js dutyRoundStands) - { ok } / { ok: false, why } / null (not known here yet); a round of any other series proves nothing
 * (kanban #727: rounds anyone posts would add draws). Answers { ok: true } or { ok: false, node, why, proof } - proof 'seen', 'present',
 * 'not-missed', 'certificate', 'too-few', 'outside', 'not-duty' - or { ok: false, notYet: true, node, why } when a named seating cannot
 * be drawn here yet. Any wrong proof makes the census invalid: it is a plain check of what was committed.
 */
export function checkAbsenceProof(claims, { census = null, window, certOf, drawOf, verify, seen = [], dutyOf = null }) {
  const inCensus = census ? new Set([...census].map(hexOfPresence)) : null;
  const sawIt = new Set([...seen].map(hexOfPresence));
  const proven = new Map();      // `${rid}:${role}` -> the seating, checked once per claim
  const duty = new Map();        // rid -> dutyOf's answer, once per round
  let last = '';
  for (const c of claims || []) {
    const node = hexOfPresence(c.node);
    if (node <= last) return { ok: false, node, why: 'that absent list is not sorted by node key, or names a node twice' };
    last = node;
    const short = node.slice(0, 16);
    if (inCensus && !inCensus.has(node)) return { ok: false, node, why: `that census leaves out ${short} as absent, and it is not in the chain census` };
    if (sawIt.has(node)) return { ok: false, node, proof: 'seen', why: `that census leaves out ${short} as absent, and this seat holds its signature of a seating in the 24 h` };
    const proofs = Array.isArray(c.proofs) ? c.proofs : [];
    const closes = new Set(), named = new Set();
    for (const p of proofs) {
      const rid = hexOfPresence(String(p.roundId || '')), key = `${rid}:${p.role}`;
      if (named.has(key)) return { ok: false, node, proof: 'too-few', why: `the proof that ${short} is absent names one seating twice` };
      named.add(key);
      let s = proven.get(key);
      if (!s) {
        const d = drawOf(rid, p.role);
        if (!d) return { ok: false, notYet: true, node, why: `the seating ${rid.slice(0, 16)} ${p.role} that proves ${short} absent cannot be drawn here yet` };
        if (dutyOf) {
          if (!duty.has(rid)) duty.set(rid, dutyOf(rid));
          const du = duty.get(rid);
          if (!du) return { ok: false, notYet: true, node, why: `whether round ${rid.slice(0, 16)} that proves ${short} absent is a duty posting's cannot be read here yet` };
          if (!du.ok) return { ok: false, node, proof: 'not-duty', why: `the round ${rid.slice(0, 16)} that proves ${short} absent is no duty posting's: ${du.why}` };
        }
        const bytes = certOf(rid, p.role);
        if (!bytes) return { ok: false, node, proof: 'certificate', why: `the proof that ${short} is absent names seating ${rid.slice(0, 16)} ${p.role} and carries no certificate of it` };
        const got = provenProof(bytes, { roundId: rid, role: p.role, d, verify });
        if (!got.ok) return { ok: false, node, proof: 'certificate', why: `the certificate that proves ${short} absent at ${rid.slice(0, 16)} ${p.role} does not stand: ${got.why}` };
        s = got.seating;
        proven.set(key, s);
      }
      if (!inWindow(window, s.closeMs)) return { ok: false, node, proof: 'outside', why: `the seating ${rid.slice(0, 16)} ${p.role} that proves ${short} absent closes outside the census's 24 h` };
      if (presentAt(node, s)) return { ok: false, node, proof: 'present', why: `that census leaves out ${short} as absent, and the certificate of ${rid.slice(0, 16)} ${p.role} lists it present` };
      if (!missedAt(node, s)) return { ok: false, node, proof: 'not-missed', why: `that census leaves out ${short} as absent, and ${rid.slice(0, 16)} ${p.role} neither drew it (a heartbeat slot: held it in its census) nor had it left out` };
      closes.add(s.closeMs);
    }
    const spaced = spacedCloses(closes);
    if (spaced < ABSENCE_PROOF_SEATINGS)
      return { ok: false, node, proof: 'too-few', why: `that census leaves out ${short} as absent on ${spaced} missed close(s) at least 1 h apart; it takes ${ABSENCE_PROOF_SEATINGS}` };
  }
  return { ok: true };
}
