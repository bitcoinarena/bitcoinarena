// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SEAT'S PRESENCE BOOK (§5A.3 "Absent from its seatings", protocol 22, kanban #727): what this seat knows of who was seen at the
// seatings of a census's 24 h, the absent claims of the censuses it holds, and its two jobs with them:
//
//   posting   the duty node, before it writes a census root into a grid, finds the absent (presence.js absentFrom): the window's
//             seatings it can draw, the nodes seen there by what it holds, and - for each node that looks absent - that node's own
//             proofs and the drawn peers' (GET /presence) asked first, so a node whose PRESENTs only its peers hold is not left out
//   checking  a seat reading a 22 census whose root is not the chain census's looks up the claim for that root (POST/GET /absent)
//             and checks it one way (presence.js checkAbsent): a node it holds a window signature of, or one that the seatings named
//             did not draw, refuses the census; a claim it cannot check (no series of the window here) is not refused
//
// Seen is a signed message only: a PRESENT this seat holds (seat_presents, the seating agent's) or took from a peer (presence_proofs),
// or a node seated by a certificate it holds (every seated node signed it).
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { decodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { seatingCloseMs, verifyPresent, decodeSeatingCertificate, SEATING_ROLES } from '../../arena-protocol/src/seating.js';
import { tableAnchorOf } from '../../arena-protocol/src/known-game.js';
import { absentFrom, checkAbsent, inWindow, CLAIM_SEATINGS } from '../../arena-protocol/src/presence.js';

/** At most this many proofs one GET /presence answers per node (one stands; three survive a round this seat does not hold). */
export const PROOFS_PER_NODE = 3;
/** How far before the window a round may have been stored (series are posted up to ~2 days ahead). */
const STORED_LEAD_MS = 4 * 86400000;

export function presenceBook({ round, roster, verify, log = () => {}, closeOfRound = null, rootOfRound = null }) {
  // `closeOfRound(rid)`: a round's seating close (bigint) or null; `rootOfRound(rid)`: its census root (hex) - read off its stored
  // contract unless handed in
  const db = round.db;
  db.exec(`
    CREATE TABLE IF NOT EXISTS presence_proofs (node TEXT NOT NULL, round_id BLOB NOT NULL, role TEXT NOT NULL, close_ms INTEGER NOT NULL,
      bytes BLOB NOT NULL, PRIMARY KEY (node, round_id, role));
    CREATE TABLE IF NOT EXISTS presence_claims (root TEXT PRIMARY KEY, claims TEXT NOT NULL, kept_ms INTEGER NOT NULL);
  `);
  // the seating agent's tables, so a seat with seating off reads empty ones
  db.exec(`
    CREATE TABLE IF NOT EXISTS seat_presents (round_id BLOB NOT NULL, role TEXT NOT NULL, node TEXT NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY (round_id, role, node));
    CREATE TABLE IF NOT EXISTS seat_certs (round_id BLOB NOT NULL, role TEXT NOT NULL, cert BLOB NOT NULL, PRIMARY KEY (round_id, role));
  `);

  // EACH STORED ROUND'S SEATING CLOSE, read once: null for a round that seats nothing of its own (a table's later rounds)
  const closes = new Map();
  const roots = new Map();
  const closeOf = (rid) => {
    const h = toHex(rid);
    if (closes.has(h)) return closes.get(h);
    if (closeOfRound) { const c = closeOfRound(rid); closes.set(h, c); roots.set(h, rootOfRound ? rootOfRound(rid) : null); return c; }
    let got = null, root = null;
    const row = round.get(rid);
    if (row) {
      try {
        const c = decodeRoundContract(new Uint8Array(row.contract));
        const anchor = tableAnchorOf(c);
        if (typeof c.startTimeMs === 'bigint' && !(anchor && !anchor.first)) got = seatingCloseMs(c);
        if (c.censusRoot instanceof Uint8Array) root = toHex(c.censusRoot);
      } catch { got = null; }
    }
    closes.set(h, got); roots.set(h, root);
    return got;
  };
  const rootOf = (rid) => { closeOf(rid); return roots.get(toHex(rid)) || null; };
  const roundsIn = (w) => db.prepare('SELECT round_id FROM rounds WHERE opened_ms > ?').all(Number(w.fromMs) - STORED_LEAD_MS)
    .map((r) => new Uint8Array(r.round_id)).filter((rid) => { const c = closeOf(rid); return c !== null && inWindow(w, c); });

  /** The drawn of a seating this seat can draw, with its close - or null (no such round here, or no draw). */
  const drawOf = (ridHex, role) => {
    let rid; try { rid = fromHex(ridHex); } catch { return null; }
    const closeMs = closeOf(rid);
    if (closeMs === null) return null;
    const c = roster.committeeFor(rid, role);
    if (!c || !c.ok || !Array.isArray(c.drawn)) return null;
    return { drawn: c.drawn.map((e) => toHex(e.pubkey)), closeMs };
  };
  const seatedOf = (rid, role) => {
    const r = db.prepare('SELECT cert FROM seat_certs WHERE round_id = ? AND role = ?').get(rid, role);
    if (!r) return null;
    try { return decodeSeatingCertificate(new Uint8Array(r.cert)).seated.map(toHex); } catch { return null; }
  };

  /**
   * THE ABSENT CARRIED INTO THE WINDOW: the nodes the claims of the window seatings' own censuses left out, by root - a node left out
   * stays out until it is seen (presence.js absentFrom `carried`).
   */
  function carriedIn(w) {
    const out = [];
    const done = new Set();
    for (const rid of roundsIn(w)) {
      const root = rootOf(rid);
      if (!root || done.has(root)) continue;
      done.add(root);
      for (const c of claimFor(root) || []) out.push({ node: c.node, root });
    }
    return out;
  }
  /** carriedOf for a check: the claim of `rootHex` when a window seating here was drawn from that census, else null. */
  const carriedOfIn = (w) => {
    let windowRoots = null;
    return (rootHex) => {
      if (!windowRoots) windowRoots = new Set(roundsIn(w).map(rootOf).filter(Boolean));
      if (!windowRoots.has(rootHex)) return null;
      const c = claimFor(rootHex);
      return c ? c.map((x) => x.node) : null;
    };
  };

  /** THE WINDOW'S SEATINGS THIS SEAT CAN DRAW: [{ roundId, role, closeMs, drawn, seated }]. */
  function seatingsIn(w) {
    const out = [];
    for (const rid of roundsIn(w)) {
      for (const role of SEATING_ROLES) {
        const d = drawOf(toHex(rid), role);
        if (d) out.push({ roundId: toHex(rid), role, closeMs: d.closeMs, drawn: d.drawn, seated: seatedOf(rid, role) });
      }
    }
    return out;
  }

  /** THE NODES SEEN IN THE WINDOW BY WHAT THIS SEAT HOLDS: a PRESENT (its own store or a peer's proof), or seated by a certificate. */
  function seenIn(w) {
    const seen = new Set();
    for (const rid of roundsIn(w)) {
      for (const r of db.prepare('SELECT node FROM seat_presents WHERE round_id = ?').all(rid)) seen.add(r.node);
      for (const role of SEATING_ROLES) for (const k of seatedOf(rid, role) || []) seen.add(k);
    }
    for (const r of db.prepare('SELECT node FROM presence_proofs WHERE close_ms > ? AND close_ms <= ?').all(Number(w.fromMs), Number(w.toMs))) seen.add(r.node);
    return seen;
  }

  /** GET /presence: the PRESENTs this seat holds of these nodes for seatings in the window, up to PROOFS_PER_NODE each, hex. */
  function proofsOf(nodes, w) {
    const out = [];
    const want = new Set(nodes.map((n) => String(n).toLowerCase()));
    const per = new Map();
    const add = (node, bytes) => { if ((per.get(node) || 0) >= PROOFS_PER_NODE) return; per.set(node, (per.get(node) || 0) + 1); out.push(toHex(new Uint8Array(bytes))); };
    for (const r of db.prepare('SELECT node, bytes FROM presence_proofs WHERE close_ms > ? AND close_ms <= ?').all(Number(w.fromMs), Number(w.toMs)))
      if (want.has(r.node)) add(r.node, r.bytes);
    for (const rid of roundsIn(w))
      for (const r of db.prepare('SELECT node, bytes FROM seat_presents WHERE round_id = ?').all(rid)) if (want.has(r.node)) add(r.node, r.bytes);
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

  /**
   * THE ABSENT, FOR A CENSUS THIS NODE POSTS: `census` the chain census's node keys, `w` its window, `ask(nodes, w)` an async that
   * answers PRESENT bytes from other seats (the candidates' own doors and their drawn peers') - each taken as a proof - before the
   * claim is made. Answers the claims (presence.js absentFrom).
   */
  async function absentForPosting({ census, w, ask = null }) {
    const seatings = seatingsIn(w);
    const carried = carriedIn(w);
    let claims = absentFrom({ seatings, seen: seenIn(w), census, window: w, carried });
    if (claims.length && ask) {
      let got = [];
      try { got = (await ask(claims.map((c) => c.node), w, claims)) || []; } catch { got = []; }
      for (const b of got) { try { takeProof(b instanceof Uint8Array ? b : fromHex(b), w); } catch { /* not one */ } }
      claims = absentFrom({ seatings, seen: seenIn(w), census, window: w, carried });
    }
    if (claims.length) log(`[presence] ${claims.length} node(s) drawn in the 24 h and seen at none of those seatings: left out of the census`);
    return claims;
  }

  /** The claim kept for a census root (hex), or null. */
  const claimFor = (rootHex) => {
    const r = db.prepare('SELECT claims FROM presence_claims WHERE root = ?').get(String(rootHex).toLowerCase());
    if (!r) return null;
    try { return JSON.parse(r.claims); } catch { return null; }
  };
  /** Keep a claim for a root: well formed, at most CLAIM_SEATINGS seatings per node (the root decides whether it is the census's). */
  function keepClaim(rootHex, claims) {
    const root = String(rootHex || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(root)) return { ok: false, why: 'a claim names its census root, 32 bytes hex' };
    if (!Array.isArray(claims) || claims.length > 4096) return { ok: false, why: 'a claim is a list of absent nodes' };
    const clean = [];
    for (const c of claims) {
      const node = String((c && c.node) || '').toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(node)) return { ok: false, why: 'an absent node is its key, 32 bytes hex' };
      const drawnIn = (Array.isArray(c.drawnIn) ? c.drawnIn : []).slice(0, CLAIM_SEATINGS).map((s) => ({ roundId: String(s.roundId || '').toLowerCase(), role: String(s.role || '') }))
        .filter((s) => /^[0-9a-f]{64}$/.test(s.roundId) && SEATING_ROLES.includes(s.role));
      const from = /^[0-9a-f]{64}$/.test(String((c && c.from) || '').toLowerCase()) ? String(c.from).toLowerCase() : null;
      clean.push({ node, drawnIn, ...(from ? { from } : {}) });
    }
    db.prepare('INSERT OR REPLACE INTO presence_claims (root, claims, kept_ms) VALUES (?, ?, ?)').run(root, JSON.stringify(clean), Date.now());
    return { ok: true, root, nodes: clean.length };
  }

  /** A SEAT'S CHECK of a claim against what it holds (presence.js checkAbsent). */
  const check = (claims, { census, w }) => checkAbsent(claims, { census, seen: seenIn(w), drawOf, window: w, carriedOf: carriedOfIn(w) });

  /**
   * A NODE LEFT OUT COMES BACK BY BEING SEEN: the rounds this seat holds whose seating closes in (now, now + ahead] and whose census
   * left `me` out as absent. The node signs a PRESENT for each - drawn or not - and hands them to the seats (POST /presence), so the
   * next census's window holds its signature and it is drawn again.
   */
  function roundsToReturn(me, nowMs, ahead = 60000n) {
    const now = BigInt(nowMs), meHex = String(me).toLowerCase();
    const out = [];
    const w = { fromMs: now, toMs: now + ahead };
    for (const rid of roundsIn(w)) {
      const root = rootOf(rid);
      const c = root ? claimFor(root) : null;
      if (c && c.some((x) => x.node === meHex)) out.push(rid);
    }
    return out;
  }

  return { seatingsIn, seenIn, carriedIn, proofsOf, takeProof, absentForPosting, claimFor, keepClaim, check, drawOf, roundsToReturn };
}
