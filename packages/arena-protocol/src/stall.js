// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// STALLED NODES LEAVE THE DRAW (multiplayer_p2p.md §5A.3 "Stalled in its rounds", protocol 26, RULED 2026-11-02, kanban #1044 option 2, #1052).
//
// 3 of a round's 7 seats can stop an entry at its result or a whole round at its settlement. That is silence, it leaves no bytes to slash,
// and a player with friends on those seats gets a free bet at every such round. This does not stop the one bet. It stops doing it all day,
// on the path absence already walks (presence.js): signed proofs in the census claim, checked at every seat and at the client.
//
//   StallNote    { round_id, stage, silent[] }, signed by a seat's node key, after a failed round only:
//                RESULT      an entry of the round went VOID by no quorum; silent: the seats that gave this seat no signed result for it
//                FINAL       an entry was short of its FINAL signatures at the moment entries are due (RULED 2026-11-03, #1066); silent: the seats that did not sign FINAL for it
//                SETTLEMENT  the round's settlement has not landed 2 h after final_after; silent: the seats that gave no signed word at the step the seat's last pass stopped at
//                            (plan, ack, commit or share), or refused there after signing FINAL. A seat that refused and never signed FINAL is not listed: the FINAL stage answers for it.
//                            OFF behind STALL_SETTLEMENT_HEIGHT (RULED 2026-11-03, #1069): below it no seat signs such a note and no check counts one
//   named        a round names a node when STALL_NOTE_QUORUM = 4 of its seats signed notes listing it, none of them itself. The lists need
//                not be equal, so nobody has to converge on one set of bytes
//   stalled      named by STALL_PROOF_ROUNDS = 3 rounds whose final_afters lie at least 1 h apart in the 72 h before the census block's median
//                time, each a fresh draw and each a duty posting's round
//   census       from protocol 26 every output of a stalled node is left out, after the absent; census_root is over what is left
//   cap          nodes out by this rule hold at most 10 % of the census's weight, past absence. Past that those named longest ago are out
//                and the rest stay in. The first always goes: on a small census that is 1 node
//
// THERE IS NO TIMER. A node is out while 3 proofs lie in the window, and back by itself when they do not; nobody decides anything, so nobody
// can be asked. THE RULE MOVES THE DRAW ONLY: not pay, not absence, not the bond, not the census key.
//
// A FRAME IS BOUNDED, NOT STOPPED (#1052). 4 colluding seats can name 3 honest ones. A signed result cannot clear them, because the owner refused
// a refutation spreading from seat to seat (#727): a claim stands on what it carries. Slashing a false note is refused too: an honest seat cut
// off from a peer would sign one in good faith. What bounds it: a note needs a real failed round, which costs the signers that round's fee in the
// open; 3 rounds an hour apart, each a fresh draw and a duty posting's; the cap; and the victim loses fees for the window and nothing else.
import { Writer, Reader } from './encode.js';
import { taggedHash, toHex } from './hash.js';
import { TAG, TYPE_STALL_NOTE, PROTOCOL_VERSION, speaksVersion, networkOf, STALL_VERSION, STALL_NOTE_QUORUM, STALL_PROOF_ROUNDS, STALL_WINDOW_MS, STALL_CAP_BPS,
  STALL_SETTLEMENT_WAIT_MS, STALL_SETTLEMENT_HEIGHT, stallSettlementPoint, ABSENCE_PROOF_SPACING_MS } from './constants.js';
import { windowsOf } from './window.js';
import { tableAnchorOf } from './known-game.js';
import { spacedCloses, provenSeating, inWindow } from './presence.js';

export { STALL_VERSION, STALL_NOTE_QUORUM, STALL_PROOF_ROUNDS, STALL_WINDOW_MS, STALL_CAP_BPS, STALL_SETTLEMENT_WAIT_MS, STALL_SETTLEMENT_HEIGHT };

/**
 * WHEN THE RULE APPLIES: one height per network, named by the release after every seat of the network runs it (#1052); null is not named. Mainnet from
 * genesis. The round's census height decides, so a round below the point never leaves a stalled node out, on any seat of any release.
 */
export const STALL_HEIGHT = Object.freeze({
  mainnet: 0,
  testnet4: null,
  regtest: 0,
});
/** Is this round's census one a stalled node leaves? */
export function stallsOut(contract) {
  if (!contract || !(Number(contract.protocolVersion) >= STALL_VERSION)) return false;
  let net; try { net = networkOf(contract.networkId); } catch { return false; }
  const point = Object.prototype.hasOwnProperty.call(STALL_HEIGHT, net) ? STALL_HEIGHT[net] : null;
  return Number.isInteger(point) && Number(contract.censusHeight) >= point;
}

export const STALL_STAGE = Object.freeze({ RESULT: 1, SETTLEMENT: 2, FINAL: 3 });
const STALL_STAGE_NAMES = Object.freeze({ 1: 'RESULT', 2: 'SETTLEMENT', 3: 'FINAL' });
/** Does a SETTLEMENT note count at this round? Under the stall rule, at or above the network's STALL_SETTLEMENT_HEIGHT. The round's census height decides, as for stallsOut. `pointOf` a harness's own. */
export function settlementNotesCount(contract, pointOf = stallSettlementPoint) {
  if (!stallsOut(contract)) return false;
  const point = pointOf(networkOf(contract.networkId));
  return Number.isInteger(point) && Number(contract.censusHeight) >= point;
}
/** Does this verified note count at this round? RESULT and FINAL wherever the rule runs; SETTLEMENT as settlementNotesCount says. */
export const stallNoteCounts = (note, contract, pointOf = stallSettlementPoint) => note.stage !== STALL_STAGE.SETTLEMENT || settlementNotesCount(contract, pointOf);
/** What a census says of an output it leaves out as stalled. */
export const STALLED_WHY = `named by ${STALL_NOTE_QUORUM} seats of each of ${STALL_PROOF_ROUNDS} failed duty rounds at least 1 h apart in the 72 h before the census: left out of the census, its bond untouched`;

const hexOfStall = (k) => (typeof k === 'string' ? k.toLowerCase() : toHex(k));
const bytesOfStall = (h) => Uint8Array.from(String(h).match(/../g) || [], (x) => parseInt(x, 16));
const is32Stall = (b) => b instanceof Uint8Array && b.length === 32;
const cmpStall = (a, b) => { for (let i = 0; i < 32; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };

/**
 * A STALLED NODE IS OUT FOR A SEASON FROM ITS THIRD PROOF (§5A.3, RULED 2026-11-07 kanban #1304): 12,960 blocks from H3, the census height of the
 * round of its third proof. CARRIED FORWARD BY CENSUS (RULED 2026-11-08 kanban #1350): a later census leaves it out by naming an earlier census that
 * listed it - that census's root, a duty round naming it, and H3 - in place of the proofs; the proofs are checked once, while fresh. Each census names
 * the newest earlier one that listed the node (with proofs or itself carried), so a checker reads only a census within its own view.
 */
export const STALL_SEASON_BLOCKS = 12960;
/** H3 of a stalled entry: a carried one's own, else the highest census height of its proofs' rounds (`heightOf(ridHex)` -> height or null). */
export function stallH3Of(entry, heightOf) {
  if (entry && entry.carried) return Number(entry.carried.h3);
  const hs = (entry && Array.isArray(entry.proofs) ? entry.proofs : []).map((p) => heightOf(hexOfStall(String(p.roundId || '')))).filter(Number.isInteger);
  return hs.length ? Math.max(...hs) : null;
}

/** The window of a census whose block's median time past is `censusTimeMs`: (from, to]. */
export function stallWindow(censusTimeMs) {
  const to = BigInt(censusTimeMs);
  return { fromMs: to - STALL_WINDOW_MS, toMs: to };
}
/** The moment a proof counts at: the round's final_after, from its contract alone, the same everywhere. */
export const stallCloseMs = (contract) => windowsOf(contract).finalAfterMs;

// ---- StallNote: one seat's list of who was silent in a failed round ----
function stallNoteBody({ roundId, stage, silent }) {
  if (!is32Stall(roundId) || !STALL_STAGE_NAMES[stage]) throw new Error('a StallNote names a round and a stage');
  const list = [...new Map((silent || []).map((k) => (typeof k === 'string' ? bytesOfStall(k) : k)).map((k) => [toHex(k), k])).values()].sort(cmpStall);
  if (!list.length || !list.every(is32Stall)) throw new Error('a StallNote lists the seats that were silent, node keys of 32 bytes');
  const w = new Writer();
  w.u8(TYPE_STALL_NOTE); w.u16(PROTOCOL_VERSION); w.bytes32(roundId); w.u8(stage);
  w.vec(list, (k, ww) => ww.bytes32(k));
  return w.finish();
}
export const stallNoteId = (n) => taggedHash(TAG.stallNote, stallNoteBody(n));
/** The note as it travels: its body, the seat's node key, the seat's BIP-340 signature over `stallNoteId`. `sign(digest)` -> 64 bytes. */
export function signStallNote({ roundId, stage, silent }, nodePubkey, sign) {
  const body = stallNoteBody({ roundId, stage, silent });
  const signed = sign(taggedHash(TAG.stallNote, body));
  const out = new Uint8Array(body.length + 96);
  out.set(body, 0); out.set(nodePubkey, body.length); out.set(signed, body.length + 32);
  return out;
}
export function decodeStallNote(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== TYPE_STALL_NOTE) throw new Error('that is not a StallNote');
  if (!speaksVersion(r.u16())) throw new Error('a StallNote of another protocol version');
  const roundId = r.bytes32(); const stage = r.u8();
  const silent = r.vec((rr) => rr.bytes32());
  const nodePubkey = r.bytes32(); const signature = r.bytes(64);
  if (r.at !== bytes.length) throw new Error('trailing bytes after the StallNote');
  if (!STALL_STAGE_NAMES[stage]) throw new Error('a StallNote of no stage');
  if (!silent.length || !silent.every((k, i) => i === 0 || cmpStall(silent[i - 1], k) < 0)) throw new Error('a StallNote lists its silent seats sorted, each once');
  return { roundId, stage, silent, nodePubkey, signature };
}
/** A note that stands: decodes, is signed by the seat it names, and does not list that seat. Answers { ok, note: { roundId, stage, silent, signer } } (hex) or { ok: false, why }. */
export function verifyStallNote(bytes, { verify }) {
  let n; try { n = decodeStallNote(bytes); } catch (e) { return { ok: false, why: e.message }; }
  const signer = toHex(n.nodePubkey), silent = n.silent.map(toHex);
  if (silent.includes(signer)) return { ok: false, why: `the note of ${signer.slice(0, 16)} lists itself` };
  let good = false; try { good = verify(n.signature, stallNoteId(n), n.nodePubkey) === true; } catch { good = false; }
  return good ? { ok: true, note: { roundId: toHex(n.roundId), stage: n.stage, silent, signer } } : { ok: false, why: `that note is not signed by ${signer.slice(0, 16)}` };
}
/** The seats a note may list, as this seat holds them: the round's seats it holds no word of, never itself. */
export const silentSeats = ({ seats, answered, me }) => {
  const heard = new Set([...answered].map(hexOfStall)), self = hexOfStall(me);
  return [...seats].map(hexOfStall).filter((k) => k !== self && !heard.has(k)).sort();
};

/**
 * THE SIGNERS WHOSE NOTES NAME `node` AT ONE ROUND: distinct seats of the round, not `node`, each note a verified one of this round listing it. Works on verified notes; a
 * seat that signed two notes of one round (both stages) counts once. `seated` hex keys.
 */
export function namedBy(node, notes, seated) {
  const seats = new Set(seated.map(hexOfStall));
  if (!seats.has(node)) return [];
  const out = new Map();
  for (const n of notes) if (n.signer !== node && seats.has(n.signer) && n.silent.includes(node) && !out.has(n.signer)) out.set(n.signer, n);
  return [...out.values()];
}

/** The cap, in order: those named longest ago first (by the oldest proof, then key). `list` [{ node, sinceMs, weight }]; `baseWeight` the census's weight past absence. Answers the kept. */
export function stallCapKept(list, baseWeight) {
  const order = [...list].sort((a, b) => (a.sinceMs === b.sinceMs ? (a.node < b.node ? -1 : 1) : (a.sinceMs < b.sinceMs ? -1 : 1)));
  const kept = [];
  let out = 0n;
  for (const c of order) {
    const w = BigInt(c.weight);
    if (kept.length && (out + w) * 10000n > BigInt(baseWeight) * STALL_CAP_BPS) break;
    kept.push(c); out += w;
  }
  return kept;
}

/**
 * THE STALLED, AS A POSTING NODE FINDS THEM. `rounds` [{ roundId, closeMs, seatRound, seated, notes: [{ signer, silent, bytes }] }] the failed rounds it holds notes of, verified;
 * `census` the chain census's node keys; `weightOf(node)` its weight; `baseWeight` the census's weight past absence; `dutyOf(ridHex)` as presence.js. Answers the claims sorted by
 * node: [{ node, proofs: [{ roundId, seatRound, notes: [hex] }] }], each with the oldest 3 rounds that name it, closes at least 1 h apart, each a fresh draw, 4 notes each.
 * A node may be drawn while it is named: a claim is made of what lies in the window at this census.
 */
export function stalledFrom({ rounds, census, window, weightOf, baseWeight, dutyOf = null, carried = [] }) {
  const inCensus = [...new Set([...census].map(hexOfStall))].sort();
  const seen = new Map();
  const isDuty = (rid) => { if (!dutyOf) return true; if (!seen.has(rid)) { const d = dutyOf(rid); seen.set(rid, !!(d && d.ok)); } return seen.get(rid); };
  const inWin = (rounds || []).filter((r) => inWindow(window, r.closeMs))
    .sort((a, b) => (a.closeMs === b.closeMs ? (a.roundId < b.roundId ? -1 : 1) : (a.closeMs < b.closeMs ? -1 : 1)));
  const found = [];
  for (const node of inCensus) {
    const proofs = [];
    let last = null, sinceMs = null;
    const draws = new Set();
    for (const r of inWin) {
      if (proofs.length >= STALL_PROOF_ROUNDS) break;
      if ((last !== null && r.closeMs - last < ABSENCE_PROOF_SPACING_MS) || draws.has(r.seatRound)) continue;
      const by = namedBy(node, r.notes, r.seated);
      if (by.length < STALL_NOTE_QUORUM || !isDuty(r.roundId)) continue;
      last = r.closeMs; draws.add(r.seatRound);
      if (sinceMs === null) sinceMs = r.closeMs;
      proofs.push({ roundId: r.roundId, seatRound: r.seatRound, notes: by.sort((a, b) => (a.signer < b.signer ? -1 : 1)).slice(0, STALL_NOTE_QUORUM).map((n) => n.bytes) });
    }
    if (proofs.length >= STALL_PROOF_ROUNDS) found.push({ node, proofs, sinceMs, weight: weightOf(node) });
  }
  // AND THE ONES CARRIED FORWARD (kanban #1350): a node an earlier census listed, its season not over, not proven afresh here; in the cap's order
  // they are named before any fresh one (their H3 is a height, far below any time in ms)
  const fresh = new Set(found.map((f) => f.node));
  for (const c of carried || []) {
    const node = hexOfStall(c.node);
    if (fresh.has(node) || !inCensus.includes(node)) continue;
    found.push({ node, carried: c.carried, sinceMs: BigInt(c.carried.h3), weight: weightOf(node) });
  }
  return stallCapKept(found, baseWeight).sort((a, b) => (a.node < b.node ? -1 : 1)).map(({ node, proofs, carried: k }) => (k ? { node, carried: k } : { node, proofs }));
}

/**
 * THE CHECK OF A STALL CLAIM - the same at every seat and at the client (#1052: "a claim without valid notes makes the census invalid, as for absence"). `claims` as stalledFrom
 * answers; `census` the node keys a claimed node must be in (a seat: its chain census; the client: none); `roundOf(ridHex)` the checker's contract of a named round or null;
 * `drawOf(ridHex, role)` its own draw of a seating, as presence.js, or null; `certOf(ridHex, role)` the certificate the claim carries or the checker holds; `dutyOf(ridHex)` as
 * presence.js; `weightOf(node)` a claimed node's weight; `keptWeight` the weight of the census the root commits (null: the cap is not read here); `settlementPointOf` a harness's own. A SETTLEMENT note below its
 * height is not counted, so a claim that rests on one falls short of its 4 seats. Answers { ok: true } or { ok: false, node, why, proof } - proof
 * 'census', 'version', 'seat-round', 'not-duty', 'certificate', 'outside', 'not-seated', 'note', 'too-few', 'cap' - or { ok: false, notYet: true, node, why }.
 */
export function checkStallProof(claims, { census = null, window, roundOf, drawOf, certOf, dutyOf = null, verify, weightOf, keptWeight = null, settlementPointOf = stallSettlementPoint,
  censusHeight = null, earlierClaimOf = null }) {
  const inCensus = census ? new Set([...census].map(hexOfStall)) : null;
  const seatings = new Map();      // seat round -> who it seated
  const list = [];
  let last = '';
  for (const c of claims || []) {
    const node = hexOfStall(c.node);
    if (node <= last) return { ok: false, node, proof: 'census', why: 'that stalled list is not sorted by node key, or names a node twice' };
    last = node;
    const short = node.slice(0, 16);
    const wrong = (proof, why) => ({ ok: false, node, proof, why });
    if (inCensus && !inCensus.has(node)) return wrong('census', `that census leaves out ${short} as stalled, and it is not in the chain census`);
    // CARRIED FORWARD (kanban #1350): an earlier census that listed the node - a duty round naming its root, below this census - and its H3, the
    // season not over at this census's height. A seat that holds the earlier claim reads the node in its stalled list with the same H3.
    if (c.carried) {
      const k = c.carried, root = hexOfStall(String(k.root || '')), rid = hexOfStall(String(k.roundId || '')), h3 = Number(k.h3);
      if (!/^[0-9a-f]{64}$/.test(root) || !/^[0-9a-f]{64}$/.test(rid) || !Number.isInteger(h3) || h3 < 0) return wrong('carried', `the carried stall of ${short} names no census root, round and height`);
      if (censusHeight === null || censusHeight === undefined) return wrong('carried', `a carried stall of ${short} is read against a census height, and none was given`);
      if (!(Number(censusHeight) < h3 + STALL_SEASON_BLOCKS)) return wrong('carried', `${short}'s season out ended at block ${h3 + STALL_SEASON_BLOCKS}; this census is at ${censusHeight}`);
      const earlier = roundOf(rid);
      if (!earlier) return { ok: false, notYet: true, node, why: `the round ${rid.slice(0, 16)} naming the earlier census cannot be read here yet` };
      if (hexOfStall(earlier.censusRoot) !== root) return wrong('carried', `the round ${rid.slice(0, 16)} names another census than ${root.slice(0, 16)}`);
      if (!(Number(earlier.censusHeight) >= h3 && Number(earlier.censusHeight) < Number(censusHeight)))
        return wrong('carried', `the earlier census (block ${earlier.censusHeight}) lies not between the third proof (${h3}) and this census (${censusHeight})`);
      if (dutyOf) {
        const du = dutyOf(rid);
        if (!du) return { ok: false, notYet: true, node, why: `whether round ${rid.slice(0, 16)} is a duty posting's cannot be read here yet` };
        if (!du.ok) return wrong('not-duty', `the round ${rid.slice(0, 16)} naming the earlier census is no duty posting's: ${du.why}`);
      }
      if (earlierClaimOf) {
        const e = earlierClaimOf(root);
        if (e) {
          const x = (e.stalled || []).find((y) => hexOfStall(String(y.node || '')) === node);
          if (!x) return wrong('carried', `the earlier census ${root.slice(0, 16)} does not list ${short} as stalled`);
          const eh3 = stallH3Of(x, (r) => { const ct = roundOf(r); return ct ? Number(ct.censusHeight) : null; });
          if (eh3 !== h3) return wrong('carried', `the earlier census lists ${short} from block ${eh3}, not ${h3}`);
        }
      }
      list.push({ node, sinceMs: BigInt(h3), weight: weightOf(node) });
      continue;
    }
    const closes = new Set(), draws = new Set(), named = new Set();
    let sinceMs = null;
    for (const p of Array.isArray(c.proofs) ? c.proofs : []) {
      const rid = hexOfStall(String(p.roundId || '')), seatRound = hexOfStall(String(p.seatRound || rid));
      if (named.has(rid)) return wrong('too-few', `the proof that ${short} stalled names one round twice`);
      named.add(rid);
      const contract = roundOf(rid);
      if (!contract) return { ok: false, notYet: true, node, why: `the round ${rid.slice(0, 16)} that names ${short} cannot be read here yet` };
      if (!stallsOut(contract)) return wrong('version', `the round ${rid.slice(0, 16)} that names ${short} is not under the stall rule`);
      if (seatRound !== rid) {
        const seat = roundOf(seatRound);
        if (!seat) return { ok: false, notYet: true, node, why: `the seating ${seatRound.slice(0, 16)} that names ${short}'s seats cannot be read here yet` };
        const a = tableAnchorOf(contract), b = tableAnchorOf(seat);
        if (!a || !b || toHex(a.anchorId) !== toHex(b.anchorId) || !(seat.roundIndex <= contract.roundIndex))
          return wrong('seat-round', `the seating ${seatRound.slice(0, 16)} does not seat round ${rid.slice(0, 16)}`);
      }
      const d = drawOf(seatRound, 'settlement');
      if (!d) return { ok: false, notYet: true, node, why: `the seating ${seatRound.slice(0, 16)} cannot be drawn here yet` };
      if (dutyOf) {
        const du = dutyOf(rid);
        if (!du) return { ok: false, notYet: true, node, why: `whether round ${rid.slice(0, 16)} is a duty posting's cannot be read here yet` };
        if (!du.ok) return wrong('not-duty', `the round ${rid.slice(0, 16)} that names ${short} is no duty posting's: ${du.why}`);
      }
      let seated = seatings.get(seatRound);
      if (!seated) {
        const bytes = certOf(seatRound, 'settlement');
        if (!bytes) return wrong('certificate', `the proof that ${short} stalled carries no certificate of seating ${seatRound.slice(0, 16)}`);
        const got = provenSeating(bytes, { roundId: seatRound, role: 'settlement', drawn: d.drawn, slots: d.slots, closeMs: d.closeMs, verify });
        if (!got.ok) return wrong('certificate', `the certificate of seating ${seatRound.slice(0, 16)} does not stand: ${got.why}`);
        seated = got.seating.seated;
        seatings.set(seatRound, seated);
      }
      const closeMs = stallCloseMs(contract);
      if (!inWindow(window, closeMs)) return wrong('outside', `the round ${rid.slice(0, 16)} that names ${short} ends outside the census's 72 h`);
      if (!seated.includes(node)) return wrong('not-seated', `${short} was not seated in round ${rid.slice(0, 16)}`);
      const notes = [];
      for (const h of Array.isArray(p.notes) ? p.notes : []) {
        const v = verifyStallNote(bytesOfStall(h), { verify });
        if (!v.ok) return wrong('note', `a note that names ${short} does not stand: ${v.why}`);
        if (v.note.roundId !== rid) return wrong('note', `a note that names ${short} at ${rid.slice(0, 16)} is about another round`);
        if (stallNoteCounts(v.note, contract, settlementPointOf)) notes.push(v.note);
      }
      const by = namedBy(node, notes, seated);
      if (by.length < STALL_NOTE_QUORUM) return wrong('note', `${by.length} seats of round ${rid.slice(0, 16)} named ${short}; it takes ${STALL_NOTE_QUORUM}`);
      closes.add(closeMs); draws.add(seatRound);
      if (sinceMs === null || closeMs < sinceMs) sinceMs = closeMs;
    }
    const spaced = spacedCloses(closes);
    if (spaced < STALL_PROOF_ROUNDS || draws.size < STALL_PROOF_ROUNDS)
      return wrong('too-few', `that census leaves out ${short} on ${Math.min(spaced, draws.size)} rounds at least 1 h apart, each a fresh draw; it takes ${STALL_PROOF_ROUNDS}`);
    list.push({ node, sinceMs, weight: weightOf(node) });
  }
  if (list.length && keptWeight !== null) {
    const baseWeight = list.reduce((s, c) => s + BigInt(c.weight), BigInt(keptWeight));
    const kept = new Set(stallCapKept(list, baseWeight).map((c) => c.node));
    const over = list.find((c) => !kept.has(c.node));
    if (over) return { ok: false, node: over.node, proof: 'cap', why: `that census leaves out ${over.node.slice(0, 16)} as stalled past the 10 % cap` };
  }
  return { ok: true };
}
