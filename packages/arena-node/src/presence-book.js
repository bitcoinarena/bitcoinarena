// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SEAT'S PRESENCE BOOK (§5A.3 "Absent from its seatings", protocol 22, kanban #727): the seating certificates of a census's 24 h
// that this seat holds or gathered, the PRESENTs it holds, the absent claims of the censuses it holds, and its two jobs with them:
//
//   posting   the duty node, before it writes a census root into a grid, finds the absent (presence.js absentFrom): the window's
//             22 certificates it holds - for every node that looks absent it first asks every seat and the node's own door for that
//             node's PRESENTs and for the certificates they hold (GET /presence), so a node seen only at seatings this seat was not
//             drawn for is not left out - and attaches to its claim the 3 certificates that prove each absent node absent
//   checking  a seat reading a 22 census whose root is not the chain census's takes the claim held for that root (POST/GET /absent)
//             and checks every proof (presence.js checkAbsenceProof) against its own draw of the seatings named: a forged, short or
//             contradicted proof makes the census invalid here, as at every other seat and at the client. On top, as the owner ruled, a
//             seat refuses a census leaving out a node it holds a window PRESENT or certificate of
//
// ABSENCE ONLY WITH PROOF (the owner 2026-10-27): a node is left out only on threshold-signed certificates (seating.js SEEN), never on
// what the posting node says it collected.
//
// AND THE HEARTBEAT (kanban #727, the owner 2026-10-27): besides seatings, a round's 3 heartbeat slots are proofs too (heartbeat.js) - a
// slot's certificate (hb_certs, made by heartbeat-agent.js or gathered) names every census node it did not hear missed, and a HEARTBEAT
// this seat held as a member (hb_beats) is evidence it refuses a census with, as a PRESENT is. A proof's role is a seating's (game,
// settlement) or a slot's (heartbeat-0..2).
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { decodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { seatingCloseMs, verifyPresent, decodeSeatingCertificate, SEATING_ROLES } from '../../arena-protocol/src/seating.js';
import { slotsForRole } from '../../arena-protocol/src/sortition.js';
import { tableAnchorOf } from '../../arena-protocol/src/known-game.js';
import { absentFrom, checkAbsenceProof, provenProof, presentAt, missedAt, inWindow, ABSENCE_PROOF_SEATINGS } from '../../arena-protocol/src/presence.js';
import { heartbeatSlotOf, decodeHeartbeatCertificate, HEARTBEAT_ROLES, HEARTBEAT_SLOTS_PER_ROUND, HEARTBEAT_SPACING_MS } from '../../arena-protocol/src/heartbeat.js';
import { TYPE_HEARTBEAT_HEARD } from '../../arena-protocol/src/constants.js';

/** What a proof names: a seating's role, or a heartbeat slot's. */
export const PROOF_ROLES = Object.freeze([...SEATING_ROLES, ...HEARTBEAT_ROLES]);
/** A round's earliest heartbeat slot closes this long before its seating does. */
const SLOTS_LEAD_MS = BigInt(HEARTBEAT_SLOTS_PER_ROUND - 1) * HEARTBEAT_SPACING_MS;

/** At most this many proofs one GET /presence answers per node (one stands; three survive a round this seat does not hold). */
export const PROOFS_PER_NODE = 3;
/** At most this many certificates one GET /presence answers (each names who was present at one seating). */
export const CERTS_PER_ANSWER = 256;
/** How far before the window a round may have been stored (series are posted up to ~2 days ahead). */
const STORED_LEAD_MS = 4 * 86400000;
const HEX64 = /^[0-9a-f]{64}$/;

export function presenceBook({ round, roster, verify, log = () => {}, closeOfRound = null, rootOfRound = null, slotsOfRound = null }) {
  // `closeOfRound(rid)`: a round's seating close (bigint) or null; `rootOfRound(rid)`: its census root (hex); `slotsOfRound(rid, role)`:
  // its seats - read off its stored contract unless handed in
  const db = round.db;
  db.exec(`
    CREATE TABLE IF NOT EXISTS presence_proofs (node TEXT NOT NULL, round_id BLOB NOT NULL, role TEXT NOT NULL, close_ms INTEGER NOT NULL,
      bytes BLOB NOT NULL, PRIMARY KEY (node, round_id, role));
    CREATE TABLE IF NOT EXISTS presence_certs (round_id BLOB NOT NULL, role TEXT NOT NULL, close_ms INTEGER NOT NULL, cert BLOB NOT NULL,
      PRIMARY KEY (round_id, role));
    CREATE TABLE IF NOT EXISTS absent_claims (root TEXT PRIMARY KEY, claim TEXT NOT NULL, kept_ms INTEGER NOT NULL);
  `);
  // the seating agent's tables, so a seat with seating off reads empty ones
  db.exec(`
    CREATE TABLE IF NOT EXISTS seat_presents (round_id BLOB NOT NULL, role TEXT NOT NULL, node TEXT NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY (round_id, role, node));
    CREATE TABLE IF NOT EXISTS seat_certs (round_id BLOB NOT NULL, role TEXT NOT NULL, cert BLOB NOT NULL, PRIMARY KEY (round_id, role));
    CREATE TABLE IF NOT EXISTS hb_beats (round_id BLOB NOT NULL, slot INTEGER NOT NULL, node TEXT NOT NULL, close_ms INTEGER NOT NULL, bytes BLOB NOT NULL,
      PRIMARY KEY (round_id, slot, node));
    CREATE TABLE IF NOT EXISTS hb_certs (round_id BLOB NOT NULL, slot INTEGER NOT NULL, close_ms INTEGER NOT NULL, cert BLOB NOT NULL,
      PRIMARY KEY (round_id, slot));
  `);

  // EACH STORED ROUND'S SEATING CLOSE, read once: null for a round that seats nothing of its own (a table's later rounds)
  const closes = new Map();
  const roots = new Map();
  const contracts = new Map();
  const closeOf = (rid) => {
    const h = toHex(rid);
    if (closes.has(h)) return closes.get(h);
    if (closeOfRound) { const c = closeOfRound(rid); closes.set(h, c); roots.set(h, rootOfRound ? rootOfRound(rid) : null); return c; }
    let got = null, root = null;
    const row = round.get(rid);
    if (row) {
      try {
        const c = decodeRoundContract(new Uint8Array(row.contract));
        contracts.set(h, c);
        const anchor = tableAnchorOf(c);
        if (typeof c.startTimeMs === 'bigint' && !(anchor && !anchor.first)) got = seatingCloseMs(c);
        if (c.censusRoot instanceof Uint8Array) root = toHex(c.censusRoot);
      } catch { got = null; }
    }
    closes.set(h, got); roots.set(h, root);
    return got;
  };
  const rootOf = (rid) => { closeOf(rid); return roots.get(toHex(rid)) || null; };
  const slotsOf = (rid, role) => {
    if (slotsOfRound) return slotsOfRound(rid, role);
    closeOf(rid);
    const c = contracts.get(toHex(rid));
    return c ? slotsForRole(c, role) : null;
  };
  // a round whose seating closes in the window - or up to 10 min after it, for its heartbeat slots that close inside
  const roundsIn = (w) => db.prepare('SELECT round_id FROM rounds WHERE opened_ms > ?').all(Number(w.fromMs) - STORED_LEAD_MS)
    .map((r) => new Uint8Array(r.round_id)).filter((rid) => { const c = closeOf(rid); return c !== null && c > w.fromMs && c <= w.toMs + SLOTS_LEAD_MS; });

  /**
   * THIS SEAT'S OWN DRAW OF A SEATING, with its seats and its close - or null (no such round here, or no draw yet). Drawn on the
   * round's census as its root commits (roster `asCommitted`): the census's own absent claim is not checked again here - its seated
   * checked it before they signed - so a claim's proofs never send a seat back through every earlier day.
   */
  const drawOf = (ridHex, role) => {
    let rid; try { rid = fromHex(ridHex); } catch { return null; }
    // A HEARTBEAT SLOT: its committee and the census it expects to beat, on the round's census as its root commits
    const j = heartbeatSlotOf(role);
    if (j !== null) {
      const c = roster.heartbeatCommitteeFor ? roster.heartbeatCommitteeFor(rid, j, { asCommitted: true }) : null;
      if (c && c.none) return { heartbeat: null, drawn: [], census: null, closeMs: 0n };     // no slots there: a wrong proof, for good
      if (!c || !c.ok) return null;
      return { heartbeat: j, drawn: c.committee.map((e) => toHex(e.pubkey)), census: c.census, closeMs: c.closeMs };
    }
    const closeMs = closeOf(rid);
    if (closeMs === null) return null;
    const slots = slotsOf(rid, role);
    if (!slots) return null;
    const c = roster.committeeFor(rid, role, { asCommitted: true });
    if (!c || !c.ok || !Array.isArray(c.drawn)) return null;
    return { drawn: c.drawn.map((e) => toHex(e.pubkey)), slots, closeMs };
  };

  /** A certificate this seat holds for a seating: its own (seat_certs) or one gathered (presence_certs). */
  const heldCert = (rid, role) => {
    const j = heartbeatSlotOf(role);
    if (j !== null) { const h = db.prepare('SELECT cert FROM hb_certs WHERE round_id = ? AND slot = ?').get(rid, j); return h ? new Uint8Array(h.cert) : null; }
    const r = db.prepare('SELECT cert FROM seat_certs WHERE round_id = ? AND role = ?').get(rid, role)
      || db.prepare('SELECT cert FROM presence_certs WHERE round_id = ? AND role = ?').get(rid, role);
    return r ? new Uint8Array(r.cert) : null;
  };
  // A CERTIFICATE IS CHECKED ONCE per its bytes: its signatures do not change
  const proven = new Map();
  const provenOf = (rid, role) => {
    const bytes = heldCert(rid, role);
    if (!bytes) return null;
    const key = `${toHex(rid)}:${role}:${bytes.length}:${toHex(bytes.subarray(bytes.length - 32))}`;
    if (proven.has(key)) return proven.get(key);
    const d = drawOf(toHex(rid), role);
    if (!d) return null;          // not drawable yet: asked again next time
    const got = provenProof(bytes, { roundId: rid, role, d, verify });
    const s = got.ok ? got.seating : null;
    proven.set(key, s);
    if (proven.size > 20000) proven.delete(proven.keys().next().value);
    return s;
  };

  /** THE WINDOW'S PROVEN SEATINGS THIS SEAT HOLDS: [{ roundId, role, closeMs, drawn, seated, present, leftOut }] (presence.js). */
  function seatingsIn(w) {
    const out = [];
    for (const rid of roundsIn(w)) for (const role of PROOF_ROLES) { const s = provenOf(rid, role); if (s && inWindow(w, s.closeMs)) out.push(s); }
    return out;
  }

  /** The nodes this seat holds a window PRESENT of: its own store (the seating agent's) or a peer's proof. */
  function presentsIn(w) {
    const seen = new Set();
    for (const rid of roundsIn(w)) for (const r of db.prepare('SELECT node FROM seat_presents WHERE round_id = ?').all(rid)) seen.add(r.node);
    for (const r of db.prepare('SELECT node FROM presence_proofs WHERE close_ms > ? AND close_ms <= ?').all(Number(w.fromMs), Number(w.toMs))) seen.add(r.node);
    // a HEARTBEAT this seat held as a member, in time for its slot (heartbeat-agent.js takes none after the close)
    for (const r of db.prepare('SELECT node FROM hb_beats WHERE close_ms > ? AND close_ms <= ?').all(Number(w.fromMs), Number(w.toMs))) seen.add(r.node);
    return seen;
  }
  /** THE NODES SEEN IN THE WINDOW BY WHAT THIS SEAT HOLDS: a PRESENT, or present in a window certificate. */
  function seenIn(w) {
    const seen = presentsIn(w);
    for (const s of seatingsIn(w)) { for (const k of s.present) seen.add(k); for (const k of s.seated) seen.add(k); }
    return seen;
  }

  /**
   * GET /presence: the PRESENTs this seat holds of these nodes for seatings in the window (up to PROOFS_PER_NODE each), and the window
   * certificates it holds that name any of them present or missed (up to CERTS_PER_ANSWER), hex.
   */
  function proofsOf(nodes, w) {
    const out = [];
    const want = new Set(nodes.map((n) => String(n).toLowerCase()));
    const per = new Map();
    const add = (node, bytes) => { if ((per.get(node) || 0) >= PROOFS_PER_NODE) return; per.set(node, (per.get(node) || 0) + 1); out.push(toHex(new Uint8Array(bytes))); };
    for (const r of db.prepare('SELECT node, bytes FROM presence_proofs WHERE close_ms > ? AND close_ms <= ?').all(Number(w.fromMs), Number(w.toMs)))
      if (want.has(r.node)) add(r.node, r.bytes);
    for (const rid of roundsIn(w))
      for (const r of db.prepare('SELECT node, bytes FROM seat_presents WHERE round_id = ?').all(rid)) if (want.has(r.node)) add(r.node, r.bytes);
    for (const r of db.prepare('SELECT node, bytes FROM hb_beats WHERE close_ms > ? AND close_ms <= ?').all(Number(w.fromMs), Number(w.toMs))) if (want.has(r.node)) add(r.node, r.bytes);
    return out;
  }
  function certsOf(nodes, w) {
    const want = [...new Set(nodes.map((n) => String(n).toLowerCase()))];
    const out = [];
    for (const s of seatingsIn(w)) {
      if (out.length >= CERTS_PER_ANSWER) break;
      if (want.some((n) => presentAt(n, s) || missedAt(n, s))) out.push(toHex(heldCert(fromHex(s.roundId), s.role)));
    }
    return out;
  }

  /** A PRESENT handed over as a proof: signed by the node it names, for a round this seat holds whose seating closes in `w`. */
  function takeProof(bytes, w) {
    const v = verifyPresent(bytes, { verify });
    if (!v.ok) return v;
    const { roundId, role, nodePubkey } = v.present;
    const closeMs = closeOf(roundId);
    if (closeMs === null) return { ok: false, why: 'this seat holds no seating of that round' };
    if (w && !inWindow(w, closeMs)) return { ok: false, why: 'that PRESENT is for a seating outside the 24 h' };
    db.prepare('INSERT OR IGNORE INTO presence_proofs (node, round_id, role, close_ms, bytes) VALUES (?, ?, ?, ?, ?)')
      .run(toHex(nodePubkey), roundId, role, Number(closeMs), bytes);
    return { ok: true, node: toHex(nodePubkey) };
  }
  /** A 22 SEATING CERTIFICATE handed over (GET /presence answers, an absent claim): kept when it stands against this seat's own draw. */
  function takeCert(bytes) {
    if (bytes[0] === TYPE_HEARTBEAT_HEARD) return takeHeartbeatCert(bytes);
    let c; try { c = decodeSeatingCertificate(bytes); } catch (e) { return { ok: false, why: e.message }; }
    if (heldCert(c.roundId, c.role)) return { ok: true, held: true };
    const d = drawOf(toHex(c.roundId), c.role);
    if (!d) return { ok: false, why: 'this seat cannot draw that seating' };
    const got = provenProof(bytes, { roundId: c.roundId, role: c.role, d, verify });
    if (!got.ok) return got;
    db.prepare('INSERT OR IGNORE INTO presence_certs (round_id, role, close_ms, cert) VALUES (?, ?, ?, ?)').run(c.roundId, c.role, Number(d.closeMs), bytes);
    return { ok: true };
  }
  /** A HEARTBEAT CERTIFICATE handed over: kept when it stands against this seat's own draw of the slot, and lists more than the one held. */
  function takeHeartbeatCert(bytes) {
    let c; try { c = decodeHeartbeatCertificate(bytes); } catch (e) { return { ok: false, why: e.message }; }
    const role = HEARTBEAT_ROLES[c.slot];
    const held = heldCert(c.roundId, role);
    if (held && toHex(held) === toHex(bytes)) return { ok: true, held: true };
    const d = drawOf(toHex(c.roundId), role);
    if (!d) return { ok: false, why: 'this seat cannot draw that heartbeat slot' };
    const got = provenProof(bytes, { roundId: c.roundId, role, d, verify });
    if (!got.ok) return got;
    // TWO CERTIFICATES OF ONE SLOT: the one more members signed is kept - both stand, and presence is any listing, so the bigger one is
    // the one that lists more (a node a smaller one missed is in no danger from it: the checker of a claim reads the claim's own)
    if (held) {
      const was = provenProof(held, { roundId: c.roundId, role, d, verify });
      if (was.ok && was.seating.seated.length >= got.seating.seated.length) return { ok: true, held: true };
    }
    db.prepare('INSERT OR REPLACE INTO hb_certs (round_id, slot, close_ms, cert) VALUES (?, ?, ?, ?)').run(c.roundId, c.slot, Number(d.closeMs), bytes);
    return { ok: true };
  }

  /**
   * THE ABSENT, FOR A CENSUS THIS NODE POSTS: `census` the chain census's node keys, `w` its window, `ask(nodes, w)` an async that
   * answers { presents, certs } (hex) from other seats - each taken - before the claim is made. Answers { claims, certs }: the claims
   * (presence.js absentFrom) and, by `${roundId}:${role}`, the certificate of every seating they name, hex.
   */
  async function absentForPosting({ census, w, ask = null }) {
    let claims = absentFrom({ seatings: seatingsIn(w), census, window: w, seen: presentsIn(w) });
    // THE CANDIDATES: every node of the census this seat saw nowhere - the certificates it holds are only of seatings it was drawn for
    const seen = seenIn(w);
    const unseen = [...new Set([...census].map((k) => String(k).toLowerCase()))].filter((n) => !seen.has(n));
    if (unseen.length && ask) {
      let got = null;
      try { got = await ask(unseen, w); } catch { got = null; }
      for (const b of (got && got.presents) || []) { try { takeProof(b instanceof Uint8Array ? b : fromHex(b), w); } catch { /* not one */ } }
      for (const b of (got && got.certs) || []) { try { takeCert(b instanceof Uint8Array ? b : fromHex(b)); } catch { /* not one */ } }
      claims = absentFrom({ seatings: seatingsIn(w), census, window: w, seen: presentsIn(w) });
    }
    const certs = {};
    for (const c of claims) for (const p of c.proofs) {
      const key = `${p.roundId}:${p.role}`;
      if (!certs[key]) certs[key] = toHex(heldCert(fromHex(p.roundId), p.role));
    }
    if (claims.length) log(`[presence] ${claims.length} node(s) proven drawn and not present at ${ABSENCE_PROOF_SEATINGS} seatings of the 24 h and present at none: left out of the census, ${Object.keys(certs).length} certificate(s) attached`);
    return { claims, certs };
  }

  /** The claim kept for a census root (hex): { claims, certs } - or null. */
  const claimFor = (rootHex) => {
    const r = db.prepare('SELECT claim FROM absent_claims WHERE root = ?').get(String(rootHex).toLowerCase());
    if (!r) return null;
    try { return JSON.parse(r.claim); } catch { return null; }
  };
  /** Keep a claim for a root: well formed (the root decides whether it is the census's; the check decides whether it stands). */
  function keepClaim(rootHex, claim) {
    const root = String(rootHex || '').toLowerCase();
    if (!HEX64.test(root)) return { ok: false, why: 'a claim names its census root, 32 bytes hex' };
    const list = claim && claim.claims;
    if (!Array.isArray(list) || list.length > 4096) return { ok: false, why: 'a claim is a list of absent nodes with their proofs' };
    const clean = [];
    for (const c of list) {
      const node = String((c && c.node) || '').toLowerCase();
      if (!HEX64.test(node)) return { ok: false, why: 'an absent node is its key, 32 bytes hex' };
      const proofs = (Array.isArray(c.proofs) ? c.proofs : []).slice(0, 16).map((s) => ({ roundId: String(s.roundId || '').toLowerCase(), role: String(s.role || '') }));
      if (!proofs.every((s) => HEX64.test(s.roundId) && PROOF_ROLES.includes(s.role))) return { ok: false, why: 'a proof names a seating or a heartbeat slot: a round id, 32 bytes hex, and a role' };
      clean.push({ node, proofs });
    }
    const certs = {};
    for (const [k, v] of Object.entries((claim && claim.certs) || {}).slice(0, 4096)) {
      const [rid, role] = String(k).toLowerCase().split(':');
      if (!HEX64.test(rid || '') || !PROOF_ROLES.includes(role) || !/^([0-9a-f]{2})+$/.test(String(v)) || String(v).length > 200000) return { ok: false, why: 'certificates are by round id and role, hex' };
      certs[`${rid}:${role}`] = String(v).toLowerCase();
    }
    db.prepare('INSERT OR REPLACE INTO absent_claims (root, claim, kept_ms) VALUES (?, ?, ?)').run(root, JSON.stringify({ claims: clean, certs }), Date.now());
    return { ok: true, root, nodes: clean.length, certs: Object.keys(certs).length };
  }

  /** A SEAT'S CHECK of a claim ({ claims, certs }): every proof (presence.js checkAbsenceProof), and nothing it holds against it. */
  const check = (claim, { census, w }) => checkAbsenceProof(claim.claims, { census, window: w, verify, drawOf, seen: seenIn(w),
    certOf: (ridHex, role) => { const h = claim.certs && claim.certs[`${ridHex}:${role}`]; return h ? fromHex(h) : heldCert(fromHex(ridHex), role); } });

  /**
   * A NODE LEFT OUT COMES BACK BY BEING SEEN: the rounds this seat holds whose seating closes in (now, now + ahead] and whose census
   * left `me` out as absent. The node signs a PRESENT for each - drawn or not - and hands it to the round's drawn before the close
   * (POST /presents), so a seated node lists it and the next census keeps it.
   */
  function roundsToReturn(me, nowMs, ahead = 60000n) {
    const now = BigInt(nowMs), meHex = String(me).toLowerCase();
    const out = [];
    const w = { fromMs: now, toMs: now + ahead };
    for (const rid of roundsIn(w)) {
      const root = rootOf(rid);
      const c = root ? claimFor(root) : null;
      if (c && c.claims.some((x) => x.node === meHex)) out.push(rid);
    }
    return out;
  }

  return { seatingsIn, seenIn, presentsIn, proofsOf, certsOf, takeProof, takeCert, absentForPosting, claimFor, keepClaim, check, drawOf, roundsToReturn };
}
