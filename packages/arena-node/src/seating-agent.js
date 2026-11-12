// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// RESERVE SEATS AT A SEAT (multiplayer_p2p.md §5A.7). For each round this node is drawn for, per role:
//
//   before seating_close (start - 120 s)  it signs PRESENT once it can serve the round, keeps it, and hands it to every
//                                         other drawn node (POST /present); it also asks them for theirs (GET /present)
//   at seating_close                      it computes the seated from the PRESENTs it holds (seating.js seatedFrom) and,
//                                         if it is seated, signs that SEATING - once per round and role, kept before it is
//                                         served - and gathers the other seated nodes' signatures over the same seating
//                                         (GET /seating-sig); with every one, the certificate (GET /seating)
//   after seating_close, before start     a seated node whose seating can never stand - a member of it signed a seating that does
//                                         not come before it (kanban #738) - takes the PRESENTs it lacked from the others and signs
//                                         once more: the seating of what it holds now, and only one another node has signed
//   any time                              a second valid certificate for one round and role is equivocation: both are
//                                         kept as the proof (GET /seating-equivocation), and the round takes no entries - except a
//                                         seating less a withholding member, reserves in, and the one it replaced: the replacement
//                                         stands (kanban #1681, #1741) while no round the held one seats took entries, and is refused
//                                         after (#2083); a seating that seats a withholder this node left is refused (#2083)
//
// The roster asks `seatedFor` and seats the certificate's nodes; before one stands, the draw's first slots (Roster).
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { decodeRoundContract, seriesRoundIdOf } from '../../arena-protocol/src/contracts.js';
import { slotsForRole } from '../../arena-protocol/src/sortition.js';
import { signPresent, verifyPresent, decodePresent, seatedFrom, signSeating, seatingId, encodeSeatingCertificate, verifySeating,
  seatingEquivocation, seatingCloseMs, decodeSeatingCertificate, SEATING_ROLES, seatingBefore as seatingOrderBefore } from '../../arena-protocol/src/seating.js';
import { endpointsOf } from './roster.js';
import { receiptsNeeded } from '../../arena-protocol/src/threshold.js';
import { tableAnchorOf } from '../../arena-protocol/src/known-game.js';

/** How far ahead of its start a round is looked at: PRESENT is signed in the last minute before seating_close. */
/** The most PRESENTs one POST /presents batch is read for (kanban #1271): as POST /presence's 4096 lines. */
/**
 * ARE THESE SEATED NODES THE DRAW'S, IN ITS SCORE ORDER (kanban #2564)? `seated` and `drawn` as hex keys (or bytes); each seated node drawn, ranks rising -
 * the order verifySeating checks a certificate in. A check-in seating signed on another draw fails it.
 */
export function seatedInDrawOrder(seated, drawn) {
  const hx = (k) => (typeof k === 'string' ? k.toLowerCase() : Buffer.from(k).toString('hex'));
  const rank = new Map((drawn || []).map((k, i) => [hx(k), i]));
  let last = -1;
  for (const k of seated || []) { const r = rank.get(hx(k)); if (r === undefined || r <= last) return false; last = r; }
  return true;
}

export const MAX_PRESENTS_PER_BATCH = 4096;

export const PRESENT_WINDOW_MS = 60000n;
/** A PRESENT's length: type, version, round id, role, node key, signature (seating.js presentBody + 64). */
export const PRESENT_BYTES = 1 + 2 + 32 + 1 + 32 + 64;
/** At most this many rounds in one GET /seating-batch. */
export const BATCH_ROUNDS = 64;
/** How long a node that runs no seating (its seating door: 404 "no such door") is left out of the exchange (kanban #791). */
export const NO_SEATING_REST_MS = Number(process.env.ARENA_NO_SEATING_REST_MS || 600000);
/** A node that did not answer at all rests this long, doubled on each failure after, up to NO_SEATING_REST_MS (kanban #791). */
export const UNREACHABLE_REST_MS = Number(process.env.ARENA_UNREACHABLE_REST_MS || 30000);
/** Failed requests in a row after which a drawn node counts as not answering (kanban #979): one lost request says nothing, two with a 30 s rest between them do. */
export const UNANSWERED_TRIES = 2;
/** How long a seated member may hold back its seating signature (kanban #1509): one that signed no seating at all this long after this node signed its own is
 * left out like a silent node (#979), and the next present reserve takes its place. Well inside the 120 s from seating_close to the start. */
export const WITHHELD_SIG_MS = Number(process.env.ARENA_WITHHELD_SIG_MS || 30000);
/** The most rounds of a table one replacement is checked for entries (kanban #2083): a table of 15 s rounds plays 5,760 a day. */
const TABLE_ENTRY_SCAN = 20000;
/** How long after its start a table's first round without a certificate is still read, and joined late (kanban #803): its table plays all day. */
export const TABLE_LATE_MS = BigInt(process.env.ARENA_TABLE_LATE_MS || 24 * 3600000);
/** A table's check-in (kanban #1020): the first round of the table in each of these periods of UTC time exchanges PRESENTs. */
export const TABLE_CHECK_IN_MS = 900000n;
/** How often a seat asks the seats of its tables for a newer seating it missed (kanban #1020). */
const TABLE_RESEAT_ASK_MS = 300000;
/** How often a seat reads the drawn seats' certificates of a round it holds one of, until most of them name the same seating (kanban #2245). */
const CONFIRM_ASK_MS = Number(process.env.ARENA_SEATING_CONFIRM_ASK_MS || 10000);
/** The confirm pass for rounds out of the tick's index (kanban #2360, #2363): at most this many certificates read in one pass, and one not yet confirmed
 * is read again after CONFIRM_ASK_MS, doubled on each read that saw no majority, up to CONFIRM_REST_MAX_MS - until it is confirmed or the round is pruned. */
const CONFIRM_PASS_ROUNDS = 256;
const CONFIRM_REST_MAX_MS = 600000;
/** Does seating `q` leave members of seating `p` out and take in only nodes ranked below every member of `p` - the pair an honest #1509 move signs (kanban #1707, #2501)? */
function leavesFor(rank, p, q) {
  const inQ = new Set(q), inP = new Set(p);
  const gone = p.filter((k) => !inQ.has(k)), added = q.filter((k) => !inP.has(k));
  const low = Math.max(...p.map((k) => (rank.has(k) ? rank.get(k) : Infinity)));
  return gone.length > 0 && added.every((k) => rank.has(k) && rank.get(k) > low);
}
const joinBytes = (list) => { const out = new Uint8Array(list.reduce((n, x) => n + x.length, 0)); let at = 0; for (const x of list) { out.set(x, at); at += x.length; } return out; };

export function seatingAgent({ round, roster, sign, verify, fetcher = fetch, nowMs = () => Date.now(), log = () => {}, windowOf = () => null,
  onSeated = () => {}, leftNode = () => false, contractOf = () => null, endpointOf = null }) {
  // `leftNode(nodeHex)`: the node's owner took it out of every seating with the emergency key (§23A.5a, protocol 17) - its PRESENT is
  // not counted, and this node signs none once it holds its own request
  const db = round.db;
  db.exec(`
    CREATE TABLE IF NOT EXISTS seat_presents (round_id BLOB NOT NULL, role TEXT NOT NULL, node TEXT NOT NULL, bytes BLOB NOT NULL,
      PRIMARY KEY (round_id, role, node));
    CREATE TABLE IF NOT EXISTS seat_signed (round_id BLOB NOT NULL, role TEXT NOT NULL, seated TEXT NOT NULL, signature BLOB NOT NULL,
      PRIMARY KEY (round_id, role));
    CREATE TABLE IF NOT EXISTS seat_sigs (round_id BLOB NOT NULL, role TEXT NOT NULL, seating TEXT NOT NULL, node TEXT NOT NULL, signature BLOB NOT NULL,
      PRIMARY KEY (round_id, role, seating, node));
    CREATE TABLE IF NOT EXISTS seat_certs (round_id BLOB NOT NULL, role TEXT NOT NULL, cert BLOB NOT NULL, PRIMARY KEY (round_id, role));
    CREATE TABLE IF NOT EXISTS seat_reseats (round_id BLOB NOT NULL, role TEXT NOT NULL, anchor TEXT NOT NULL, idx INTEGER NOT NULL, PRIMARY KEY (round_id, role));
    CREATE TABLE IF NOT EXISTS seat_equivocations (round_id BLOB NOT NULL, role TEXT NOT NULL, a BLOB NOT NULL, b BLOB NOT NULL,
      PRIMARY KEY (round_id, role));
    CREATE TABLE IF NOT EXISTS seat_withheld (round_id BLOB NOT NULL, role TEXT NOT NULL, node TEXT NOT NULL, PRIMARY KEY (round_id, role, node));
    CREATE TABLE IF NOT EXISTS seat_seatings (round_id BLOB NOT NULL, role TEXT NOT NULL, seating TEXT NOT NULL, seated TEXT NOT NULL,
      PRIMARY KEY (round_id, role, seating));
    CREATE TABLE IF NOT EXISTS seat_signed_at (round_id BLOB NOT NULL, role TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (round_id, role));
  `);
  // WHETHER A HELD CERTIFICATE WAS CONFIRMED BY MOST OF THE DRAWN SEATS (kanban #2360, #2363): 0 from its first keep until a confirm read sees more than half
  // of the drawn hold its seating, then 1. A column of seat_certs, so it goes with the certificate when the round is pruned (transcript-prune.js) and is no
  // round-marking table of its own. Certificates kept before this column existed read NULL and count as confirmed: they were read while their round was indexed.
  try { db.exec('ALTER TABLE seat_certs ADD COLUMN confirmed INTEGER'); } catch { /* there already */ }
  const me = toHex(round.pubkey);
  // THE SEATED LISTS OF THE SEATINGS SIGNED (kanban #738): `${rid}:${role}:${seating id}` -> node keys hex, for every seating a
  // signature over it was kept of - a seating this node did not sign is known by its id only in seat_sigs.
  // KEPT IN THE STORE BESIDE seat_sigs (kanban #2140, #2208, #2298, wf1489 a44 refute-3): the map alone was lost at a restart, so a kept signature over a
  // seating before ours - the #1609 withholder's - counted as signing again ("not remembered here") and the restarted seat never moved while the others
  // did. The map is a cache of seat_seatings; seatingOf reads the store on a miss.
  const seatings = new Map();
  const rememberSeating = (rid, role, id, list) => {
    const key = `${toHex(rid)}:${role}:${id}`;
    if (seatings.has(key)) return;
    seatings.set(key, list);
    if (seatings.size > 20000) seatings.delete(seatings.keys().next().value);
    db.prepare('INSERT OR IGNORE INTO seat_seatings (round_id, role, seating, seated) VALUES (?, ?, ?, ?)').run(rid, role, id, JSON.stringify(list));
  };
  const seatingOf = (w, id) => {
    const key = `${w.ridHex}:${w.role}:${id}`;
    if (seatings.has(key)) return seatings.get(key);
    const r = db.prepare('SELECT seated FROM seat_seatings WHERE round_id = ? AND role = ? AND seating = ?').get(w.t.rid, w.role, id);
    let list = null; try { list = r ? JSON.parse(r.seated) : null; } catch { list = null; }
    if (Array.isArray(list)) { seatings.set(key, list); if (seatings.size > 20000) seatings.delete(seatings.keys().next().value); }
    return Array.isArray(list) ? list : null;
  };
  /** The members this node left a seating for, as withholders (kanban #1509, kept in seat_withheld): a seating that seats one is never gone back to (#2208). */
  const leftFor = (w) => new Set(db.prepare('SELECT node FROM seat_withheld WHERE round_id = ? AND role = ?').all(w.t.rid, w.role).map((r) => r.node));
  const certs = new Map();       // `${rid}:${role}` -> seated hex list (null: equivocated)
  for (const r of db.prepare('SELECT round_id, role, cert FROM seat_certs').all()) {
    try { certs.set(`${toHex(new Uint8Array(r.round_id))}:${r.role}`, decodeSeated(new Uint8Array(r.cert))); } catch { /* unread */ }
  }
  for (const r of db.prepare('SELECT round_id, role FROM seat_equivocations').all()) certs.set(`${toHex(new Uint8Array(r.round_id))}:${r.role}`, null);
  // a kept certificate was checked before it was kept (keepCert): read back, it names its seated
  function decodeSeated(cert) { return decodeSeatingCertificate(cert).seated.map(toHex); }
  function seatingIdOfCert(cert) { try { const d = decodeSeatingCertificate(cert); return seatingId({ roundId: d.roundId, role: d.role, seated: d.seated }); } catch { return new Uint8Array(0); } }

  // A TABLE'S LATER SEATINGS (kanban #1020, the owner 2026-11-02: "Die tote node muss doch 120s vor Runden Beginn einchecken, das kann sie doch nicht"; measured 10:45Z: a node
  // gone since 04:00Z sat in two RPS tables, because a table was seated once, by its first round). `${anchor hex}:${role}` -> [{ index, rid, seated }], lowest index first: a
  // certificate on a later round of the table seats that round and the ones after it. Empty for every table that lost nobody.
  const reseats = new Map();
  // CHECK-IN SEATINGS THAT DO NOT STAND ON THIS SEAT'S DRAW (kanban #2564, feedback #019, measured 2026-11-12 on an RPS table of federation 337ae01a: check-ins
  // 264 and 297 were signed at 00:35Z / 00:39Z on a draw that is not the round's - verifySeating against every seat's draw of today: "not in score order" -
  // and the seats kept seating every later round by them; a client checks them, refuses them and refuses the round). `${rid hex}:${role}`; a stale one is
  // skipped where a round's seating is looked up, so the table falls back to the newest seating that stands; a round with entries keeps its seats (#1020)
  const staleReseats = new Set();
  let reseatsCheckedMs = 0;
  const tableStarts = new Map();   // anchor hex -> round 0's start
  const noteReseat = (rid, role, seated, posted = null) => {
    let c; try { const row = round.get(rid); c = row ? decodeRoundContract(new Uint8Array(row.contract)) : posted; } catch { c = posted; }
    const a = c ? tableAnchorOf(c) : null;
    if (!a || a.first) return;
    // kept beside the certificate: a seat may hold no row of the check-in, and must still know it after a restart
    db.prepare('INSERT OR IGNORE INTO seat_reseats (round_id, role, anchor, idx) VALUES (?, ?, ?, ?)').run(rid, role, toHex(a.anchorId), c.roundIndex);
    listReseat(toHex(a.anchorId), role, c.roundIndex, rid, seated);
  };
  const listReseat = (anchorHex, role, index, rid, seated) => {
    const key = `${anchorHex}:${role}`;
    const list = reseats.get(key) || reseats.set(key, []).get(key);
    // a seating this seat took instead of the one it held (kanban #2245, keepCert `supersede`) replaces it at its index
    const at = list.find((x) => x.index === index);
    if (at) { at.rid = rid; at.seated = seated; return; }
    list.push({ index, rid, seated });
    list.sort((x, y) => x.index - y.index);
  };
  for (const r of db.prepare('SELECT round_id, role, cert FROM seat_certs').all()) {
    try { noteReseat(new Uint8Array(r.round_id), r.role, decodeSeated(new Uint8Array(r.cert))); } catch { /* unread */ }
  }
  for (const r of db.prepare('SELECT s.round_id, s.role, s.anchor, s.idx, c.cert FROM seat_reseats s JOIN seat_certs c ON c.round_id = s.round_id AND c.role = s.role').all()) {
    try { listReseat(r.anchor, r.role, Number(r.idx), new Uint8Array(r.round_id), decodeSeated(new Uint8Array(r.cert))); } catch { /* unread */ }
  }
  /** The seating that seats round `index` of the table: the newest certificate at or before it, and the table's first otherwise. Null while none stands. */
  const tableSeatingAt = (anchorHex, role, index, { keepStale = false } = {}) => {
    const later = reseats.get(`${anchorHex}:${role}`);
    if (later) for (let i = later.length - 1; i >= 0; i--) if (later[i].index <= index && (keepStale || !staleReseats.has(`${toHex(later[i].rid)}:${role}`))) return later[i].seated;
    return certs.get(`${anchorHex}:${role}`) || null;
  };
  /** Is this round of a table one of its check-ins? The table's rounds are evenly spaced, so round 0's start gives the spacing. */
  const checkInOf = (c, anchor) => {
    if (!anchor || anchor.first || c.roundIndex < 1) return false;
    const a = toHex(anchor.anchorId);
    let t0 = tableStarts.get(a);
    if (t0 === undefined) {
      const row = round.get(anchor.anchorId);
      let c0 = null; try { c0 = row ? decodeRoundContract(new Uint8Array(row.contract)) : contractOf(anchor.anchorId); } catch { c0 = null; }
      if (!c0) return false;
      t0 = c0.startTimeMs; tableStarts.set(a, t0);
    }
    const period = (c.startTimeMs - t0) / BigInt(c.roundIndex);
    return period > 0n && c.startTimeMs / TABLE_CHECK_IN_MS !== (c.startTimeMs - period) / TABLE_CHECK_IN_MS;
  };

  /** Do seatings `xs` and `ys` (keys hex) differ only by members one left out and reserves ranked below all of its members (kanban #1707)? */
  const leftOutPair = (drawn, xs, ys) => {
    const rank = new Map(drawn.map((k, i) => [toHex(k), i]));
    const leftOut = (p, q) => { const inQ = new Set(q), inP = new Set(p);
      const gone = p.filter((k) => !inQ.has(k)), added = q.filter((k) => !inP.has(k));
      const low = Math.max(...p.map((k) => (rank.has(k) ? rank.get(k) : Infinity)));
      return gone.length > 0 && added.every((k) => rank.has(k) && rank.get(k) > low); };
    return leftOut(xs, ys) || leftOut(ys, xs);
  };
  // A CERTIFICATE HELD HERE THAT MOST DRAWN SEATS HAVE NOT SHOWN YET (kanban #2245): `${rid}:${role}` -> last read (ms); confirmed ones are read no more
  const confirmAsked = new Map();
  const confirmed = new Set();
  // EVERY HELD CERTIFICATE NOT CONFIRMED YET, WHATEVER ITS ROUND'S AGE (kanban #2360, #2363, wf1489 a45 refute 5 s3): the tick's confirm read (#2245, #2321)
  // runs only while the round is in its index - 10 min after the start - so a seat that took its first certificate after that (down for longer, newly joined,
  // a drawn seat back late; a long round is played and settled long after) kept whatever POST /seating handed it first (a stranger can relay M's superseded
  // S), refused the honest T by #1707 and seated S for good; and askUnwritten's table round 0 and #1020 check-in keeps took the first valid answer of any
  // drawn seat and were never confirmed at all. Each first keep is listed here (and kept 0 in seat_certs.confirmed, so a restart lists it again), and the
  // confirm pass beside the tick (confirmHeld) reads the drawn seats for it until more than half hold its seating or another one replaces it (`supersede`).
  // `${rid}:${role}` -> { rid, ridHex, role, index, askedMs, tries }
  const pending = new Map();
  const confirm = (key) => {
    confirmed.add(key); confirmAsked.delete(key); if (confirmed.size > 20000) confirmed.delete(confirmed.values().next().value);
    const p = pending.get(key);
    if (p) { pending.delete(key); try { db.prepare('UPDATE seat_certs SET confirmed = 1 WHERE round_id = ? AND role = ?').run(p.rid, p.role); } catch { /* read again after a restart */ } }
  };
  const listPending = (rid, role, index = null) => {
    const key = `${toHex(rid)}:${role}`;
    if (confirmed.has(key) || pending.has(key)) return;
    pending.set(key, { rid: new Uint8Array(rid), ridHex: toHex(rid), role, index, askedMs: -Infinity, tries: 0 });
  };
  for (const r of db.prepare('SELECT c.round_id, c.role, s.idx FROM seat_certs c LEFT JOIN seat_reseats s ON s.round_id = c.round_id AND s.role = c.role WHERE c.confirmed = 0').all()) {
    listPending(new Uint8Array(r.round_id), r.role, r.idx === null || r.idx === undefined ? null : Number(r.idx));
  }

  // THE CHECK OF A CERTIFICATE, against this node's own draw for the round
  const checkFor = (rid, role, index = null) => {
    // A TABLE'S FIRST ROUND THIS SEAT NEVER WROTE (kanban #604: the 10-24 series reached the test host seats at 00:12Z, after their
    // tables' round 0 had started, so no certificate could be checked and they answered the unseated draw): `contractOf` builds it
    // from a series this seat holds, and it is drawn as a posted contract
    const row = round.get(rid);
    const posted = row ? null : contractOf(rid, index);
    if (!row && !posted) return null;
    const c = roster.committeeFor(rid, role, posted ? { posted } : {});
    if (!c.ok) return { refused: c.why };
    const contract = row ? decodeRoundContract(new Uint8Array(row.contract)) : posted;
    return { roundId: rid, role, drawn: c.drawn.map((e) => e.pubkey), slots: slotsForRole(contract, role), verify, contract };
  };
  /**
   * DOES SEATING `a` REPLACE SEATING `b` (kanban #1681, #1741)? Node keys hex, `drawn` the round's draw in score order: `a` leaves out at least one member of `b`,
   * and each node it seats that `b` did not ranks after every member of `b` - `b` less the members that withheld, the next reserves in (resign, #1509). Never
   * both ways round: a node of `a` not in `b` ranks after one of `b` not in `a`, so the reverse cannot hold too.
   */
  const replaces = (a, b, drawn) => {
    const rank = new Map(drawn.map((k, i) => [k, i]));
    const inA = new Set(a), inB = new Set(b);
    if (!b.some((k) => !inA.has(k)) || !a.every((k) => rank.has(k)) || !b.every((k) => rank.has(k))) return false;
    const last = Math.max(...b.map((k) => rank.get(k)));
    return a.filter((k) => !inB.has(k)).every((k) => rank.get(k) > last);
  };
  /**
   * DID ANY ROUND THE CERTIFICATE HELD ON `rid` SEATS TAKE ENTRIES (kanban #2083, wf1489 v1 refute-17-s3-2 of #1509)? The round itself, and on a table every
   * round from it up to the table's next seating held (a table is seated by its first round and its check-ins, #1020): those rounds took their entries under
   * the held seating, and a replacement must not move the money already on the table to another committee. Rows are walked by their series ids, past the
   * leading ones a prune took, until the table's rows end.
   */
  const seatsEntries = (rid, role, contract) => {
    const has = (r) => { try { return !!(round.entriesOf && round.entriesOf(r).length); } catch { return false; } };
    if (has(rid)) return true;
    let a = null; try { a = tableAnchorOf(contract); } catch { a = null; }
    if (!a) return false;
    const from = contract.roundIndex;
    const next = (reseats.get(`${toHex(a.anchorId)}:${role}`) || []).find((x) => x.index > from);
    const upto = Math.min(next ? next.index : Infinity, from + TABLE_ENTRY_SCAN);
    let seen = false, misses = 0;
    for (let j = from + 1; j < upto; j++) {
      const r = seriesRoundIdOf(contract.seriesId, j);
      if (!round.get(r)) { if (seen && ++misses >= 64) return false; continue; }
      seen = true; misses = 0;
      if (has(r)) return true;
    }
    return false;
  };
  // REPLACEMENTS REFUSED FOR GOOD (kanban #2083): entries never leave a round, so a replacement refused for them is refused again without its signatures checked
  const refusedLate = new Set();
  const keepCert = (rid, role, bytes, { index = null, supersede = false } = {}) => {
    // ONE HELD ALREADY, byte for byte, is not checked again (2026-10-12 "figure out why CPU usage so high and
    // optimise it": every batch answer repeats a round's certificate, and each was verified - all its signatures - before the
    // seat looked whether it held exactly these bytes)
    const held = db.prepare('SELECT cert FROM seat_certs WHERE round_id = ? AND role = ?').get(rid, role);
    if (held && Buffer.compare(Buffer.from(held.cert), Buffer.from(bytes)) === 0) {
      // held from before a restart, on a round this seat has no row of: read back here (kanban #1020)
      if (index !== null) { const posted = contractOf(rid, index); if (posted) noteReseat(rid, role, decodeSeated(bytes), posted); }
      return { ok: true, kept: false };
    }
    const lateKey = `${toHex(rid)}:${role}:${toHex(seatingIdOfCert(bytes))}`;
    if (refusedLate.has(lateKey)) return { ok: false, superseded: true, why: 'the seating held seats rounds that took entries: a replacement does not move them' };
    const check = checkFor(rid, role, index);
    if (!check || check.refused) return { ok: false, why: `this node cannot draw that round yet${check ? `: ${check.refused}` : ''}` };
    const v = verifySeating(bytes, check);
    if (!v.ok) return v;
    // A SEATING THIS NODE LEFT FOR A WITHHOLDER (kanban #1707, wf1489 r5 census-2): the honest members' signatures over the first seating were handed out
    // before they re-signed without the withholder (#1509), so the withholder can sign that seating late and complete it with them. A certificate that
    // seats a member this node named a withholder is never kept nor counted as equivocation: this node left that seating, and the one it moved to stands.
    const named = v.seating.seated.map(toHex).find((k) => db.prepare('SELECT 1 FROM seat_withheld WHERE round_id = ? AND role = ? AND node = ?').get(rid, role, k));
    if (named) return { ok: false, superseded: true, why: `that seating seats ${named.slice(0, 8)}, which withheld its seating signature here (kanban #1509): this node left it` };
    // KEPT ONLY IN ITS CANONICAL FORM (kanban #1711): verifySeating checks the seated members' signatures and nothing else, so a
    // stranger who read them off GET /seating-batch could pad a standing certificate with 65,000 junk (nodePubkey, signature)
    // pairs (6.2 MB), post it first, and every seat kept and served those bytes - the honest certificate after it then differed
    // and was refused as "one seating twice". The seat keeps exactly the seated members' signatures, the bytes certify() makes.
    { const by = new Map(v.seating.signatures.map((x) => [toHex(x.nodePubkey), x.signature]));
      const canonical = encodeSeatingCertificate({ roundId: v.seating.roundId, role: v.seating.role, seated: v.seating.seated,
        signatures: v.seating.seated.map((k) => ({ nodePubkey: k, signature: by.get(toHex(k)) })) });
      if (Buffer.compare(Buffer.from(canonical), Buffer.from(bytes)) !== 0) {
        bytes = canonical;
        if (held && Buffer.compare(Buffer.from(held.cert), Buffer.from(bytes)) === 0) return { ok: true, kept: false };
      } }
    // on a table only the first round and its check-ins hold a seating (kanban #1020)
    try { const a = tableAnchorOf(check.contract);
      if (a && !a.first && !checkInOf(check.contract, a)) return { ok: false, why: 'that round of its table is no check-in' }; } catch { /* the draw above read it */ }
    const key = `${toHex(rid)}:${role}`;
    const had = db.prepare('SELECT cert FROM seat_certs WHERE round_id = ? AND role = ?').get(rid, role);
    if (had) {
      const old = new Uint8Array(had.cert);
      if (toHex(old) === toHex(bytes)) return { ok: true, kept: false };
      // THE SEATING MOST OF THE DRAWN SEATS HOLD REPLACES AN ORDERED ONE HELD HERE (kanban #2245, wf1489 a45 refute 5 of #1812 and #1707): the two
      // seatings of an honest move - forward in #738's order (#1812) or a withholder left out for the next reserve (#1509, #1707) - carry the same
      // members' signatures, so their certificates alone never say which one the honest seats moved to: a seat that held none (not drawn, or drawn and
      // down at the close) kept whichever came first, and one member that posted the seating left behind split the network's committee for good. The
      // drawn seats' own certificates say it (tick's confirm read): `supersede` is set only when more than half of them hold this seating, and it then
      // replaces the held one - no equivocation, since an ordered pair proves none. A pair that is not ordered still is (below).
      if (supersede && certs.get(key) !== null) {
        const xs = decodeSeated(old), ys = v.seating.seated.map(toHex), w = { drawnKeys: check.drawn };
        if (seatingBefore(w, xs, ys) || seatingBefore(w, ys, xs) || leftOutPair(check.drawn, xs, ys)) {
          db.prepare('UPDATE seat_certs SET cert = ? WHERE round_id = ? AND role = ?').run(bytes, rid, role);
          certs.set(key, ys);
          noteReseat(rid, role, ys, check.contract);
          log(`[seating] ${toHex(rid).slice(0, 16)} ${role}: the seating most drawn seats hold replaces the one held here (kanban #2245)`);
          try { onSeated(rid, role, v.seating.seated, check.contract, { replaced: true }); } catch (e) { log(`[seating] ${toHex(rid).slice(0, 16)} ${role}: ${e.message}`); }
          return { ok: true, kept: true, replaced: true };
        }
      }
      const e = seatingEquivocation(old, bytes, check);
      if (!e.ok) return { ok: false, why: e.why };
      // A SEATING THAT LEFT OUT A WITHHOLDING MEMBER IS NO EQUIVOCATION WITH THE ONE IT REPLACED (kanban #1681, #1741, wf1489 v1 refute-17): the honest seats
      // signed S, a member of it never signed (#1509), and they moved to S' - S less that member, the next reserves in. The withholder can still sign S at any
      // time and build its certificate from the honest signatures over S it read; that made every honest member of both an equivocator and voided the round.
      // Of two such certificates the replacement stands at every seat: kept when it comes second, and taking the place of the other when that came first,
      // while the round has no entries. One certificate per round and role still seats it; a pair of any other shape is equivocation as before.
      if (certs.get(key) !== null) {
        const heldSeated = decodeSeated(old), newSeated = v.seating.seated.map(toHex), drawnHex = check.drawn.map(toHex);
        if (replaces(heldSeated, newSeated, drawnHex)) return { ok: false, superseded: true, why: 'a certificate that replaced this seating (a member of it withheld its signature) seats that round here' };
        if (replaces(newSeated, heldSeated, drawnHex)) {
          // A REPLACEMENT AFTER ENTRIES CAME (kanban #2083, wf1489 v1 refute-17-s3): the held seating stands, the newcomer is refused as superseded - and no
          // equivocation is kept. The pair is replace-shaped because the honest members signed both (the #1509 move): no proof of anything against them, and
          // a withholder plus a reserve that hid its signature over S' (handing out S first, S' after the entries) voided every round they were drawn into.
          // Entries on any round the held seating seats count, a later round of its table too (#1020: the money on the table keeps its committee).
          if (seatsEntries(rid, role, check.contract)) {
            refusedLate.add(lateKey);
            if (refusedLate.size > 20000) refusedLate.delete(refusedLate.values().next().value);
            log(`[seating] ${toHex(rid).slice(0, 16)} ${role}: a certificate that would replace the one held came after entries - the one held stands`);
            return { ok: false, superseded: true, why: 'the seating held seats rounds that took entries: a replacement does not move them' };
          }
          db.prepare('UPDATE seat_certs SET cert = ? WHERE round_id = ? AND role = ?').run(bytes, rid, role);
          certs.set(key, newSeated);
          for (const list of reseats.values()) for (const x of list) if (toHex(x.rid) === toHex(rid)) x.seated = newSeated;
          noteReseat(rid, role, newSeated, check.contract);
          try { onSeated(rid, role, v.seating.seated, check.contract, { replaced: true }); } catch (err) { log(`[seating] ${toHex(rid).slice(0, 16)} ${role}: ${err.message}`); }
          log(`[seating] ${toHex(rid).slice(0, 16)} ${role}: the certificate of ${newSeated.length} replaced the one held - it leaves out ${heldSeated.filter((k) => !newSeated.includes(k)).map((k) => k.slice(0, 8)).join(', ')}`);
          return { ok: true, kept: true, replaced: true };
        }
      }
      // A SEATING ITS SIGNERS LEFT IS NO EQUIVOCATION - asked after the #1509 replacement above, which comes before the held seating in #738's
      // order and still takes its place (kanban #1681) (kanban #1812, wf1489 r6 census-1): honest seats re-sign only forward in #738's order
      // (seatingBefore), so a certificate for a seating that comes before the one held is made of signatures they gave up - one member that
      // read them (GET /seating-batch), drove the others on and then signed the old seating as well would otherwise void the round and name
      // the honest seats as equivocators. It is refused as superseded; only seatings that are not ordered prove equivocation.
      if (seatingBefore({ drawnKeys: check.drawn }, v.seating.seated.map(toHex), decodeSeated(old))) {
        log(`[seating] ${toHex(rid).slice(0, 16)} ${role}: a certificate for a seating before the one held refused (superseded)`);
        return { ok: false, why: 'superseded: that seating comes before the one certified here' };
      }
      // AND ANY OTHER PAIR AN HONEST #1509 MOVE MAKES (kanban #1707): one leaves members of the other out and takes in only nodes that rank below every member of
      // it (the next reserves). The honest seats sign exactly that pair when they leave a withholder, which can still sign the first seating late and complete
      // it with the signatures it read - so the pair is no proof against anyone. The certificate held stands and the other is refused; the round goes on.
      if (leftOutPair(check.drawn, decodeSeated(old), v.seating.seated.map(toHex))) return { ok: false, why: 'that seating differs from the one held only by members left out for withholding and the reserves after them (kanban #1509): the seating held stands' };
      db.prepare('INSERT OR IGNORE INTO seat_equivocations (round_id, role, a, b) VALUES (?, ?, ?, ?)').run(rid, role, old, bytes);
      certs.set(key, null);
      log(`[seating] ${toHex(rid).slice(0, 16)} ${role}: two seatings - equivocation by ${e.signers.map((k) => toHex(k).slice(0, 8)).join(', ')}; the round takes no entries`);
      return { ok: true, equivocation: true, signers: e.signers.map(toHex) };
    }
    db.prepare('INSERT OR IGNORE INTO seat_certs (round_id, role, cert, confirmed) VALUES (?, ?, ?, 0)').run(rid, role, bytes);
    if (!certs.has(key) || certs.get(key) !== null) certs.set(key, v.seating.seated.map(toHex));
    // read against the drawn seats until most of them are seen holding it, whenever and however it came (kanban #2360, #2363)
    if (certs.get(key) !== null) listPending(rid, role, index);
    noteReseat(rid, role, v.seating.seated.map(toHex), check.contract);
    // the seats a v2 round counts are these (2026.0.2): the server writes them into the stored contract
    try { onSeated(rid, role, v.seating.seated, check.contract); } catch (e) { log(`[seating] ${toHex(rid).slice(0, 16)} ${role}: ${e.message}`); }
    return { ok: true, kept: true };
  };

  // ROUNDS BY START TIME, read once each (the seats hold thousands)
  const starts = new Map();      // rid hex -> { rid, start: bigint, close: bigint }
  const unwritten = new Map();   // anchor hex -> { rid, askedMs }: tables whose round 0 this seat does not hold (or holds uncertified)
  const heldChecked = new Set(); // anchor hex: a held round 0 already looked at for its certificates
  const tables = new Map();      // anchor hex -> { rid, start, askedMs }: the table's latest round held (kanban #1020)
  let lastRow = 0;
  const index = () => {
    for (const r of db.prepare('SELECT rowid, round_id, contract FROM rounds WHERE rowid > ? ORDER BY rowid').all(lastRow)) {
      lastRow = r.rowid;
      let c; try { c = decodeRoundContract(new Uint8Array(r.contract)); } catch { continue; }
      if (typeof c.startTimeMs !== 'bigint') continue;
      // A TABLE IS SEATED ONCE, BY ITS FIRST ROUND (pick (c), known-game.js tableAnchorOf): its later rounds exchange no
      // PRESENT and sign no seating - the roster seats them with the first round's certificate
      const anchor = tableAnchorOf(c);
      // long started: nothing left to seat, never held (at a start that was every round in the store, 53,658
      // contracts on seat 1, of which 5,950 had not started 10 min ago) - but a table's first round is read all day while no certificate
      // of it stands (kanban #803, below)
      if (c.startTimeMs + (anchor && anchor.first ? TABLE_LATE_MS : 600000n) < BigInt(nowMs())) continue;
      if (anchor && !anchor.first) {
        const known = tables.get(toHex(anchor.anchorId));
        // first asked a minute from now; `from`: the table's earliest round held, so a table of a later day is not asked
        if (!known || known.start < c.startTimeMs) tables.set(toHex(anchor.anchorId), { rid: new Uint8Array(r.round_id), start: c.startTimeMs, from: known ? known.from : c.startTimeMs, askedMs: known ? known.askedMs : nowMs() - TABLE_RESEAT_ASK_MS + 60000 });
        else if (c.startTimeMs < known.from) known.from = c.startTimeMs;
        if (checkInOf(c, anchor)) starts.set(toHex(new Uint8Array(r.round_id)), { rid: new Uint8Array(r.round_id), start: c.startTimeMs, close: seatingCloseMs(c, windowOf(c)), contract: c,
          tableFirst: false, checkIn: { anchorHex: toHex(anchor.anchorId), index: c.roundIndex }, askedMs: -Infinity });
      }
      if (anchor && anchor.first && c.startTimeMs + 600000n < BigInt(nowMs()) && SEATING_ROLES.every((role) => db.prepare('SELECT 1 FROM seat_certs WHERE round_id = ? AND role = ?').get(new Uint8Array(r.round_id), role))) continue;
      if (anchor && !anchor.first) {
        // A TABLE WHOSE FIRST ROUND THIS SEAT NEVER WROTE (kanban #604): its certificate is asked of the table's seats
        const a = toHex(anchor.anchorId);
        if (!unwritten.has(a)) {
          const held = round.get(anchor.anchorId);
          if (!held) unwritten.set(a, { rid: anchor.anchorId, askedMs: -Infinity, sinceMs: nowMs() });
          // A TABLE WHOSE FIRST ROUND THIS SEAT HOLDS BUT WAS DOWN AT ITS SEATING (measured 2026-10-29 10:5xZ: test host seat 5 held round 0
          // of RPS table 9ea77b85 and no certificate of it; round 0 had started hours before the restart, so it was never asked, and all day
          // the seat named the drawn 7 against the seated 5 - a client checking the seats refused the table): asked as above once its
          // seating has closed, and for 3 h from then
          else if (!heldChecked.has(a)) {
            heldChecked.add(a);
            if (SEATING_ROLES.some((role) => !db.prepare('SELECT 1 FROM seat_certs WHERE round_id = ? AND role = ?').get(anchor.anchorId, role))) {
              let closeMs = 0; try { const c0 = decodeRoundContract(new Uint8Array(held.contract)); closeMs = Number(seatingCloseMs(c0, windowOf(c0))); } catch { /* asked now */ }
              unwritten.set(a, { rid: anchor.anchorId, askedMs: -Infinity, sinceMs: Math.max(nowMs(), closeMs), held: true, closeMs });
            }
          }
        }
        continue;
      }
      starts.set(toHex(new Uint8Array(r.round_id)), { rid: new Uint8Array(r.round_id), start: c.startTimeMs, close: seatingCloseMs(c, windowOf(c)), contract: c,
        tableFirst: !!(anchor && anchor.first), askedMs: -Infinity });
    }
  };

  // A NODE THAT RUNS NO SEATING IS NOT ASKED EVERY TICK (kanban #791, measured 2026-10-30 01:1xZ on second-host seat 3: 1,150 GET /seating and
  // /seating-sig a minute to each of two installed nodes drawn into its rounds, every answer 404 "no such door" - they run without
  // ARENA_SEATING, have no batch door, and so were asked the old way for every round and role on every 2 s tick): a node whose
  // seating door says it has none rests NO_SEATING_REST_MS - no PRESENT handed to it, no batch, no single read - then is asked again
  //
  // AND A NODE THAT DOES NOT ANSWER AT ALL (kanban #791, measured 2026-10-30 01:2xZ on the test host seats: seating ticks of 85-141 s, "5 of
  // 18 node(s) answered no batch" - five drawn nodes whose quick tunnels are gone, each request waiting out its 5 s timeout, and every
  // PRESENT posted to them one after another): a timeout, a refusal or a name that no longer resolves rests the node
  // UNREACHABLE_REST_MS, doubled on each failure after, up to NO_SEATING_REST_MS; its first answer ends it
  const resting = new Map();             // base -> until (ms)
  const failing = new Map();             // base -> requests that failed in a row
  const rests = (base) => { const u = resting.get(base); if (u === undefined) return false; if (nowMs() < u) return true; resting.delete(base); return false; };
  const failingSince = new Map();        // base -> when its failures in a row began (kanban #984: said at GET /node-facts)
  const unreachable = (base) => { const n = (failing.get(base) || 0) + 1; failing.set(base, n); if (n === 1) failingSince.set(base, nowMs());
    resting.set(base, nowMs() + Math.min(UNREACHABLE_REST_MS * 2 ** Math.min(n - 1, 10), NO_SEATING_REST_MS)); };
  const reached = (base) => { if (failing.delete(base)) { resting.delete(base); failingSince.delete(base); } };
  // a tunnel whose node behind it is gone answers for it: 502-504, or Cloudflare's 530
  const gone = (r) => (r.status >= 502 && r.status <= 504) || r.status === 530;
  const noDoor = async (base, path, r) => {
    if (r.status !== 404 || !/^\/(present|seating)/.test(path)) return;
    try { if ((await r.text()).trim() === 'no such door' && !path.startsWith('/seating-batch') && !path.startsWith('/presents')) resting.set(base, nowMs() + NO_SEATING_REST_MS); } catch { /* not read: asked again */ }
  };
  const post = async (base, path, body) => {
    let r;
    try { r = await fetcher(`${base}${path}`, { method: 'POST', body, signal: AbortSignal.timeout(5000) }); } catch { unreachable(base); return false; }
    if (gone(r)) { unreachable(base); return false; }
    reached(base);
    try { if (!r.ok) await noDoor(base, path, r); } catch { /* the answer's body is not needed */ }
    return r.ok;
  };
  const getJson = async (base, path) => {
    let r;
    try { r = await fetcher(`${base}${path}`, { signal: AbortSignal.timeout(5000) }); } catch { unreachable(base); return null; }
    if (gone(r)) { unreachable(base); return null; }
    reached(base);
    try { if (r.ok) return await r.json(); await noDoor(base, path, r); } catch { /* an answer that is not JSON says nothing */ }
    return null;
  };

  // ---- the doors ----
  // PRESENT BYTES WHOSE SIGNATURE FAILED are remembered and never checked again (kanban #1565, #1489 r3 census-2): a refused PRESENT was
  // not kept, so the same junk naming a drawn node was verified again at every tick. Bounded: the oldest is forgotten first
  const badPresents = new Set();
  const BAD_PRESENTS_KEPT = 8192;
  function takePresent(bytes, { afterClose = false, once = null } = {}) {
    // ONE HELD ALREADY, byte for byte, is not checked again (every batch answer repeats a round's PRESENTs,
    // and verifying each at each tick was thousands of signature checks per tick at grid density)
    try {
      const d = decodePresent(bytes);
      const had = db.prepare('SELECT bytes FROM seat_presents WHERE round_id = ? AND role = ? AND node = ?').get(d.roundId, d.role, toHex(d.nodePubkey));
      if (had && Buffer.compare(Buffer.from(had.bytes), Buffer.from(bytes)) === 0) return { ok: true, held: true };
      // AND A NODE WHOSE PRESENT IS HELD ALREADY in other bytes is not checked either (kanban #1565): the first valid one stands
      // (INSERT OR IGNORE below), so a second could change nothing - only cost a signature check
      if (had) return { ok: true, held: true };
      // ONE PRESENT PER (round, role, node) IN ONE ANSWER OR ONE POST /presents BODY (kanban #1565): a seat's answer or a stranger's body
      // carried thousands of PRESENTs naming one drawn key with junk signatures, each a BIP-340 check; now one each at most
      if (once) { const k = `${toHex(d.roundId)}|${d.role}|${toHex(d.nodePubkey)}`; if (once.has(k)) return { ok: false, why: 'one PRESENT per node and role in one batch' }; once.add(k); }
      if (badPresents.has(toHex(bytes))) return { ok: false, why: 'that PRESENT\'s signature was refused already' };
      // A ROUND WHOSE SEATING HAS CLOSED takes no PRESENT, and is refused before the signature is checked (kanban #587, measured
      // 2026-10-23 13:2xZ: seat 7 spent 41 % of a core on verifyPresent while idle - PRESENTs of closed rounds, refused after the
      // check and so never kept, checked again on every tick from every peer that sent them)
      const t = starts.get(toHex(d.roundId));
      if (t && !afterClose && BigInt(nowMs()) >= t.close) return { ok: false, why: 'that round\'s seating has closed' };
      // AND A ROUND OR A NODE THIS SEAT HAS NOTHING FOR is refused before the signature is checked (kanban #1271, audit 4 #1257 outsider-3): an unknown
      // round's PRESENT was verified first, so one POST /presents of random PRESENTs ran a signature check per 132 bytes on the event loop. The same
      // checks run after the verify below; here they only save it
      if (leftNode(toHex(d.nodePubkey))) return { ok: false, why: 'that node\'s owner took it out of the seating (emergency departure, §23A.5a)' };
      const c0 = roster.committeeFor(d.roundId, d.role);
      if (!c0.ok) return { ok: false, why: c0.why };
      if (!c0.drawn.some((e) => toHex(e.pubkey) === toHex(d.nodePubkey))) return { ok: false, why: 'that node is not drawn for that round and role' };
    } catch { /* not decodable: verifyPresent says why */ }
    const v = verifyPresent(bytes, { verify });
    if (!v.ok) {
      badPresents.add(toHex(bytes));
      if (badPresents.size > BAD_PRESENTS_KEPT) badPresents.delete(badPresents.values().next().value);
      return v;
    }
    const { roundId, role, nodePubkey } = v.present;
    if (leftNode(toHex(nodePubkey))) return { ok: false, why: 'that node\'s owner took it out of the seating (emergency departure, §23A.5a)' };
    const c = roster.committeeFor(roundId, role);
    if (!c.ok) return { ok: false, why: c.why };
    if (!c.drawn.some((e) => toHex(e.pubkey) === toHex(nodePubkey))) return { ok: false, why: 'that node is not drawn for that round and role' };
    const t = starts.get(toHex(roundId));
    if (t && !afterClose && BigInt(nowMs()) >= t.close) return { ok: false, why: 'that round\'s seating has closed' };
    db.prepare('INSERT OR IGNORE INTO seat_presents (round_id, role, node, bytes) VALUES (?, ?, ?, ?)').run(roundId, role, toHex(nodePubkey), bytes);
    return { ok: true };
  }
  const presentsOf = (rid) => db.prepare('SELECT role, node, bytes FROM seat_presents WHERE round_id = ?').all(rid)
    .map((r) => ({ role: r.role, node: r.node, present: toHex(new Uint8Array(r.bytes)) }));
  const mySignature = (rid, role) => {
    const r = db.prepare('SELECT seated, signature FROM seat_signed WHERE round_id = ? AND role = ?').get(rid, role);
    return r ? { node: me, seated: JSON.parse(r.seated), signature: toHex(new Uint8Array(r.signature)) } : null;
  };
  const certOf = (rid, role) => {
    const r = db.prepare('SELECT cert FROM seat_certs WHERE round_id = ? AND role = ?').get(rid, role);
    return r ? toHex(new Uint8Array(r.cert)) : null;
  };
  const equivocationOf = (rid) => db.prepare('SELECT role, a, b FROM seat_equivocations WHERE round_id = ?').all(rid)
    .map((r) => ({ role: r.role, a: toHex(new Uint8Array(r.a)), b: toHex(new Uint8Array(r.b)) }));

  // ---- the work, every tick ----
  // ONE EXCHANGE PER NODE PER TICK (measured on testnet4 2026-10-11: an RPS grid of 2 tables per 8 s slot kept
  // ~15 rounds in the PRESENT window at once, and each round asked each of the 8 other drawn nodes on its own - for 2 roles,
  // every 2 s - so a tick ran past its rounds' closes: seat 3 signed 349 game seatings and built 35 certificates). Now one
  // POST /presents carries every PRESENT a tick hands a node, and one GET /seating-batch reads, for every round of the tick
  // that node is drawn for, its PRESENTs, its seating signature and the certificates it holds. The PRESENTs, seatings and
  // certificates are the same signed messages as before; a node without the batch doors is asked the old way.
  let busy = false;
  // THE TABLES' CERTIFICATES ARE ASKED BESIDE THE TICK, NOT IN IT (kanban #803, measured 2026-10-30 07:5xZ on test host seat 7: a tick of
  // 35,197 ms of which askUnwritten 35,014 and the reads 85 - each table lacking a certificate asked of its drawn seats one after another,
  // up to 5 s each, every minute, before the tick signed a PRESENT. Each table no one certified made the next tick long, a long tick
  // missed the next rounds' close, and that left more tables uncertified). One pass at a time, its own; the tick does not wait for it.
  let asking = null;
  let confirming = null;     // the confirm pass for rounds out of the index (kanban #2360, #2363), beside the tick as askUnwritten
  // EVERY CHECK-IN SEATING HELD, AGAINST THIS SEAT'S DRAW OF ITS TABLE (kanban #2564): a table's rounds all draw on the table's first round's seed, census and
  // beacon (known-game tableAnchorOf; measured 2026-11-12: one table's round 0, check-in 264 and check-in 297 drew the same at every seat), so one draw per
  // table and role - computed once, at most RESEAT_DRAWS new ones a pass - checks all its seatings, each verdict kept. Once a minute. (A first version drew
  // every seating each minute: fed2-1 holds 46,728 of them and its loop was held past 20 s.)
  const RESEAT_CHECK_MS = 60000, RESEAT_DRAWS = 8;
  const tableDraws = new Map();       // `${anchor hex}:${role}` -> drawn keys hex, score order
  const reseatVerdicts = new Map();   // `${rid hex}:${role}` -> true (stands) / false (stale)
  const checkReseats = () => {
    if (nowMs() - reseatsCheckedMs < RESEAT_CHECK_MS) return;
    reseatsCheckedMs = nowMs();
    let draws = RESEAT_DRAWS;
    const pass = { tables: 0, drawn: 0, noDraw: 0, checked: 0, stale: 0 };
    for (const [key, list] of reseats) {
      pass.tables++;
      if (!list.length) continue;
      const role = key.slice(key.lastIndexOf(':') + 1);
      let drawn = tableDraws.get(key);
      if (!drawn) {
        if (draws-- <= 0) continue;
        let c = null; try { c = roster.committeeFor(list[list.length - 1].rid, role); } catch { c = null; }
        if (!c || !c.ok || !Array.isArray(c.drawn)) { pass.noDraw++; if (pass.noDraw === 1) pass.why = c ? c.why : 'no answer'; continue; }
        drawn = c.drawn.map((e) => toHex(e.pubkey));
        pass.drawn++;
        tableDraws.set(key, drawn);
        if (tableDraws.size > 2000) tableDraws.delete(tableDraws.keys().next().value);
      }
      let named = 0;
      for (const x of list) {
        const k = `${toHex(x.rid)}:${role}`;
        if (reseatVerdicts.has(k)) continue;
        // AND AT A ROUND THAT IS A CHECK-IN BY TODAY'S RULE (measured 2026-11-12 16:4xZ: the fed2 seats held a correctly drawn seating at round 283 of table
        // a46fcbb3, signed under an older check-in rule; the guardian seats refused it - "that round of its table is no check-in" - and stayed on round 0)
        let isCheckIn = true;
        try { const row = round.get(x.rid); const c = row ? decodeRoundContract(new Uint8Array(row.contract)) : contractOf(x.rid, x.index);
          if (c) isCheckIn = checkInOf(c, tableAnchorOf(c)); } catch { isCheckIn = true; }
        const stands = isCheckIn && seatedInDrawOrder(x.seated, drawn);
        reseatVerdicts.set(k, stands);
        if (reseatVerdicts.size > 200000) reseatVerdicts.delete(reseatVerdicts.keys().next().value);
        pass.checked++;
        if (stands) staleReseats.delete(k); else { staleReseats.add(k); named++; pass.stale++; }
      }
      if (named) log(`[seating] table ${key.slice(0, 16)} ${role}: ${named} check-in seating(s) held are not this seat's draw in score order - not used (kanban #2564)`);
    }
    if (pass.drawn || pass.noDraw || pass.checked) log(`[seating] check-in pass (kanban #2564): ${pass.tables} table role(s), ${pass.drawn} drawn, ${pass.noDraw} not drawable${pass.why ? ` (${pass.why})` : ''}, ${pass.checked} seating(s) checked, ${pass.stale} stale, ${staleReseats.size} stale held`);
  };
  async function tick() {
    if (busy) return;
    busy = true;
    const t0 = Date.now(); let fellBack = 0, peers = 0, rounds = 0;
    // WHERE A LONG TICK WENT (kanban #803: test host seat 7 ran ticks of 60-99 s with every node answering): each phase's time, logged with it
    const took = { unwritten: 0, presents: 0, reads: 0, single: 0, 'take+certify': 0 };
    let mark = Date.now(); const lap = (k) => { const n = Date.now(); took[k] += n - mark; mark = n; };
    try {
      index();
      // OFF UNTIL THE CHECK-INS ARE DRAWN RIGHT (kanban #2564, measured 2026-11-12 on fed2-1: 46,626 of 46,728 held check-in seatings fail verifySeating
      // against the table's draw - check-ins are signed out of draw order on every table; skipping them all moved every table back to its first seating,
      // replaced nodes and all). ARENA_CHECKIN_DRAW_CHECK=1 turns it on for a measurement
      if (process.env.ARENA_CHECKIN_DRAW_CHECK === '1') { try { checkReseats(); } catch (e) { log(`[seating] check-in check: ${e.message}`); } }   // kanban #2564
      if (!asking) asking = askUnwritten().catch((e) => log(`[seating] ${e.message}`)).finally(() => { asking = null; });
      if (!confirming && pending.size) confirming = confirmHeld().catch((e) => log(`[seating] ${e.message}`)).finally(() => { confirming = null; });
      lap('unwritten');
      const now = BigInt(nowMs());
      const work = [];
      for (const [ridHex, t] of starts) {
        const long = t.start + 600000n < now;
        // long started: nothing left to seat - but a table's first round is kept while it lacks a certificate (kanban #803)
        if (long && (!t.tableFirst || t.start + TABLE_LATE_MS < now || SEATING_ROLES.every((role) => db.prepare('SELECT 1 FROM seat_certs WHERE round_id = ? AND role = ?').get(t.rid, role)))) { starts.delete(ridHex); continue; }
        if (now < t.close - PRESENT_WINDOW_MS) continue;
        // and read once a minute from then on, not every tick
        if (long) { if (nowMs() - t.askedMs < 60000) continue; t.askedMs = nowMs(); }
        // A ROUND ALREADY STARTED IS ONLY READ, for the certificate this node lacks (kanban #576, measured 2026-10-23 12:0xZ: seats
        // restarted after the 12:00 window started never asked for its certificates - a started round was skipped - so each
        // counted itself unseated and refused the claim key, "this node is not assigned to that round", and no order of that
        // window went in). It sends no PRESENT and signs no seating late: it keeps what the seated already certified (keepCert
        // checks it), until the round leaves the index 10 min after its start.
        const late = now > t.start;
        // A TABLE'S FIRST ROUND THAT STARTED WITHOUT ITS CERTIFICATE (kanban #803, measured 2026-10-30 07:5xZ on RPS table 24d4c900 of
        // 00:00Z, federation B): 5 present of the drawn, and four of the five seated - second-host seats 2, 3, 5, 7 - signed the seating of
        // those 5; the fifth, test host seat 7 (fefa1945), held all five PRESENTs but was inside one seating tick of 364 s ("5 of 18
        // node(s) answered no batch") from before the close until after the start. A started round is only read for its certificate,
        // so it never signed, the four kept waiting for it, and the table - every round of the day - stayed unseated. Such a table is
        // joined late: this node signs, once, a seating another seated member signed (joinLate below), and the certificate is built
        const joins = late && t.tableFirst;
        for (const role of SEATING_ROLES) {
          // a certificate stands here: a second one reaches this node by POST /seating, and is then the proof of equivocation - but until most of the
          // drawn seats are seen holding the same seating, it is read again every CONFIRM_ASK_MS (kanban #2245, keepCert `supersede`)
          // AFTER THE START TOO (kanban #2321, wf1489 a45 refute 5 s2): a seat that held no certificate at the start - restarted, newly joined, drawn and down
          // across the close, or S posted in the last tick gap before the start - took the first one POST /seating handed it after the start (a stranger can
          // relay M's superseded S), and with `late` in this skip it was never read again: it seated S for good while every honest seat seated T. A held
          // certificate stays unconfirmed until a confirm read sees more than half of the drawn hold it, whenever it was taken (the `confirmed` set is lost
          // at a restart, which is fine: the read runs again). It ends with the round's index, 10 min after the start (a long round once a minute, above).
          const key = `${ridHex}:${role}`;
          const certified = certs.has(key) && !!db.prepare('SELECT 1 FROM seat_certs WHERE round_id = ? AND role = ?').get(t.rid, role);
          if (certified && (certs.get(key) === null || confirmed.has(key) || nowMs() - (confirmAsked.has(key) ? confirmAsked.get(key) : -Infinity) < CONFIRM_ASK_MS)) continue;
          const c = roster.committeeFor(t.rid, role);
          if (!c.ok) continue;
          if (certified) {
            confirmAsked.set(key, nowMs());
            if (confirmAsked.size > 20000) confirmAsked.delete(confirmAsked.keys().next().value);
            work.push({ t, ridHex, role, c, drawnKeys: c.drawn.map((e) => e.pubkey), amDrawn: c.drawn.some((e) => toHex(e.pubkey) === me),
              others: endpointsOf(c.drawn, round.pubkey, endpointOf), slots: slotsForRole(t.contract, role), closed: true, late: false, joins: false, confirm: true });
            continue;
          }
          const drawnKeys = c.drawn.map((e) => e.pubkey);
          const w = { t, ridHex, role, c, drawnKeys, amDrawn: drawnKeys.some((k) => toHex(k) === me), others: endpointsOf(c.drawn, round.pubkey, endpointOf),
            slots: slotsForRole(t.contract, role), closed: now >= t.close, late, joins };
          // A CHECK-IN NOBODY MISSED ends at its close: no seating is signed, so none is waited for (kanban #1020)
          if (t.checkIn && (late || (w.closed && !mySignature(t.rid, role) && !reseatingOf(w)))) continue;
          work.push(w);
        }
      }
      if (!work.length) return;
      // 1. THIS NODE'S PRESENTs, once each, kept, and handed to every other drawn node: one POST per node
      const outbox = new Map();
      for (const w of work) {
        if (w.closed || !w.amDrawn || leftNode(me)) continue;
        if (db.prepare('SELECT 1 FROM seat_presents WHERE round_id = ? AND role = ? AND node = ?').get(w.t.rid, w.role, me)) continue;
        const p = signPresent({ roundId: w.t.rid, role: w.role, nodePubkey: round.pubkey }, sign);
        takePresent(p);
        for (const b of w.others) if (!rests(b)) (outbox.get(b) || outbox.set(b, []).get(b)).push(p);
        log(`[seating] ${w.ridHex.slice(0, 16)} ${w.role}: PRESENT signed, handed to ${w.others.length}`);
      }
      await Promise.all([...outbox].map(async ([b, list]) => {
        if (await post(b, '/presents', joinBytes(list))) return;
        for (const p of list) if (!rests(b)) await post(b, '/present', p);   // a node without the batch door
      }));
      lap('presents');
      // 2. THIS NODE'S SEATING SIGNATURE for each closed round it is seated in, before the reads
      for (const w of work) if (w.closed && !w.late && !w.confirm) signMine(w);
      // 3. ONE READ PER NODE, for every round of this tick it is drawn for
      // ONLY WHAT THIS NODE STILL LACKS (measured 2026-10-12 21:3x local on seat 3: GET /seating-batch 88 times in 30 s,
      // 14.3 MB of JSON out - every round of the window asked of every node each tick, its PRESENTs sent back though held - the
      // seat's largest cost with the garbage it made): a round before its close whose PRESENTs from every drawn node are held
      // has nothing more to learn until then; after the close it is asked until its certificate stands (the work above)
      const holds = (w) => !w.closed && db.prepare('SELECT COUNT(*) AS n FROM seat_presents WHERE round_id = ? AND role = ?').get(w.t.rid, w.role).n >= w.drawnKeys.length;
      // BUT A DRAWN NODE WHOSE LAST REQUEST FAILED IS ASKED AGAIN BEFORE THE CLOSE once its rest is over (kanban #1119): a node whose address died this window
      // pushed its PRESENT out, and with every PRESENT held nothing else was asked of it - its one failure, the PRESENT post, is not the two that leave it out
      // of the seating (#979, silentOf). The second try, 30 s later, comes before the close (the window opens 60 s before it): it is left out, the next reserve in
      const asks = new Map();
      for (const w of work) { const all = holds(w); for (const b of w.others) if (!rests(b) && (!all || failing.has(b))) (asks.get(b) || asks.set(b, new Set()).get(b)).add(w.ridHex); }
      const answers = new Map();
      await Promise.all([...asks].map(async ([b, set]) => {
        const ids = [...set]; const got = {};
        for (let i = 0; i < ids.length; i += BATCH_ROUNDS) {
          const j = await getJson(b, `/seating-batch?rounds=${ids.slice(i, i + BATCH_ROUNDS).join(',')}`);
          if (!j || !j.rounds) { answers.set(b, null); return; }
          Object.assign(got, j.rounds);
        }
        answers.set(b, got);
      }));
      lap('reads');
      peers = answers.size; fellBack = [...answers.values()].filter((a) => a === null).length; rounds = new Set(work.map((w) => w.ridHex)).size;
      // 4. WHAT EACH SAID: their PRESENTs, certificates and seating signatures; then this node's certificate where it can
      // a node that answered no batch is asked the old way - every round of it at once, not one after another
      const single = new Map();
      await Promise.all(work.flatMap((w) => (holds(w) || w.confirm ? [] : w.others.filter((b) => answers.get(b) === null && !rests(b)))
        .map(async (b) => { single.set(`${b}|${w.ridHex}|${w.role}`, await askOne(b, w)); })));
      lap('single');
      for (const w of work) {
        if (w.confirm) { confirmRead(w, answers); continue; }
        const said = []; const sigs = [];
        for (const b of w.others) {
          const batch = answers.get(b);
          const a = batch ? batch[w.ridHex] : single.get(`${b}|${w.ridHex}|${w.role}`);
          if (!a) continue;
          said.push(a);
          // a round already started is read for its certificate only: its PRESENTs are not taken (b5e8b412's late read)
          if (!w.late) { const once = new Set(); for (const x of a.presents || []) if (x.role === w.role) takePresent(fromHex(x.present), { once }); }
          const cert = a.cert && a.cert[w.role];
          if (cert) keepCert(w.t.rid, w.role, fromHex(cert));
          const sig = a.sig && a.sig[w.role];
          if (sig && w.closed && !w.late) keepSig(w, sig);
          if (sig && (w.joins || (w.closed && !w.late && !mySignature(w.t.rid, w.role)))) sigs.push(sig);
        }
        if (w.joins && w.closed) { joinLate(w, sigs); for (const s of sigs) keepSig(w, s); await certify(w); }
        // A RESERVE TAKEN IN FOR A WITHHOLDING MEMBER (kanban #1509): not seated by its own seating, it signs the one every other member of it signed already
        if (w.closed && !w.late && !w.joins && !mySignature(w.t.rid, w.role)) { joinLate(w, sigs, { everyOther: true }); for (const s of sigs) keepSig(w, s); }
        if (w.closed && !w.late) {
          // A SEATING THAT CAN NEVER STAND (kanban #738): the PRESENTs the others held at the close are taken late, here only
          if (canNeverStand(w)) for (const a of said) { const once = new Set(); for (const x of a.presents || []) if (x.role === w.role) takePresent(fromHex(x.present), { afterClose: true, once }); }
          signMine(w); resign(w); await certify(w);
        }
        // THE SAME READ CONFIRMS WHAT IT LEFT HELD (kanban #2321, wf1489 a45 refute 5 s2): the drawn seats' certificates are in these answers already, so
        // the one more than half of them hold is kept now - confirmed, or put in place of the one taken first (keepCert `supersede`) - and the round is not
        // read again for it; short of a majority, the confirm read above asks again in CONFIRM_ASK_MS
        const key = `${w.ridHex}:${w.role}`;
        if (certs.get(key) && !confirmed.has(key) && db.prepare('SELECT 1 FROM seat_certs WHERE round_id = ? AND role = ?').get(w.t.rid, w.role)) {
          confirmRead(w, answers);
          if (!confirmed.has(key)) confirmAsked.set(key, nowMs());
        }
      }
      lap('take+certify');
    } catch (e) { log(`[seating] ${e.message}`); }
    finally {
      busy = false;
      const all = Date.now() - t0;
      if (all > 5000) log(`[seating] a tick of ${rounds} round(s) took ${all} ms; ${fellBack} of ${peers} node(s) answered no batch; ${Object.entries(took).map(([k, v]) => `${k} ${v}`).join(', ')} ms`);
    }
  }

  /** A held certificate against the drawn seats' (kanban #2245): confirmed when more than half of the drawn hold its seating (this seat counted when drawn);
   * another seating more than half of them hold replaces it when the two are ordered (keepCert `supersede`). */
  function confirmRead(w, answers) {
    const key = `${w.ridHex}:${w.role}`, mine = (certs.get(key) || []).join(',');
    const by = new Map();   // seated list -> { n, cert }
    for (const b of w.others) {
      const a = answers.get(b); const cert = a && a[w.ridHex] && a[w.ridHex].cert && a[w.ridHex].cert[w.role];
      if (!cert) continue;
      let s; try { s = decodeSeated(fromHex(cert)).join(','); } catch { continue; }
      const e = by.get(s) || by.set(s, { n: 0, cert }).get(s); e.n++;
    }
    const half = w.drawnKeys.length / 2;
    if (((by.get(mine) || { n: 0 }).n + (w.amDrawn ? 1 : 0)) > half) { confirm(key); return; }
    for (const [s, e] of by) {
      if (s === mine || e.n <= half) continue;
      const k = keepCert(w.t.rid, w.role, fromHex(e.cert), { supersede: true, index: w.index ?? null });
      if (k.replaced) confirm(key);
      else if (!k.ok) log(`[seating] ${w.ridHex.slice(0, 16)} ${w.role}: the seating most drawn seats hold refused here: ${k.why}`);
      return;
    }
  }

  /**
   * THE CONFIRM PASS FOR EVERY HELD CERTIFICATE THE TICK NO LONGER READS (kanban #2360, #2363, wf1489 a45 refute 5 s3): a round out of the index (10 min
   * after its start), a table's round 0 or check-in taken by askUnwritten. One GET /seating-batch per drawn seat for at most CONFIRM_PASS_ROUNDS of them,
   * each read again after CONFIRM_ASK_MS doubled per read short of a majority (up to CONFIRM_REST_MAX_MS), until confirmed or replaced (confirmRead), or
   * until the round is pruned (its seat_certs row gone, `forget`). A seat without the batch door is not asked here, as in the tick's confirm read.
   */
  async function confirmHeld() {
    const t = nowMs();
    const due = [];
    for (const [key, p] of pending) {
      if (starts.has(p.ridHex)) continue;          // the tick reads it (#2245, #2321)
      if (certs.get(key) === null || confirmed.has(key)) { pending.delete(key); continue; }
      if (!db.prepare('SELECT 1 FROM seat_certs WHERE round_id = ? AND role = ?').get(p.rid, p.role)) { pending.delete(key); continue; }
      if (t - p.askedMs < Math.min(CONFIRM_ASK_MS * 2 ** Math.min(p.tries, 16), CONFIRM_REST_MAX_MS)) continue;
      due.push(p);
      if (due.length >= CONFIRM_PASS_ROUNDS) break;
    }
    const ws = [];
    for (const p of due) {
      p.askedMs = t; p.tries++;
      let c;
      try {
        const row = round.get(p.rid);
        const posted = row ? null : contractOf(p.rid, p.index);
        if (!row && !posted) continue;
        c = roster.committeeFor(p.rid, p.role, posted ? { posted } : {});
      } catch { continue; }
      if (!c || !c.ok) continue;
      const drawnKeys = c.drawn.map((e) => e.pubkey);
      ws.push({ t: { rid: p.rid }, ridHex: p.ridHex, role: p.role, index: p.index, drawnKeys, amDrawn: drawnKeys.some((k) => toHex(k) === me),
        others: endpointsOf(c.drawn, round.pubkey, endpointOf) });
    }
    if (!ws.length) return;
    const asks = new Map();
    for (const w of ws) for (const b of w.others) if (!rests(b)) (asks.get(b) || asks.set(b, new Set()).get(b)).add(w.ridHex);
    const answers = new Map();
    await Promise.all([...asks].map(async ([b, set]) => {
      const ids = [...set]; const got = {};
      for (let i = 0; i < ids.length; i += BATCH_ROUNDS) {
        const j = await getJson(b, `/seating-batch?rounds=${ids.slice(i, i + BATCH_ROUNDS).join(',')}`);
        if (!j || !j.rounds) { answers.set(b, null); return; }
        Object.assign(got, j.rounds);
      }
      answers.set(b, got);
    }));
    for (const w of ws) { try { confirmRead(w, answers); } catch (e) { log(`[seating] ${w.ridHex.slice(0, 16)} ${w.role}: ${e.message}`); } }
  }

  /** The old doors, one round at a time: for a node that has no GET /seating-batch. */
  // A TABLE'S CERTIFICATES THIS SEAT CANNOT EXCHANGE FOR (kanban #604: the 10-24 series reached the test host seats at 00:12Z, after their
  // tables' round 0 had started; they held no row of it, never asked for its certificate and answered the unseated draw): read from the
  // table's drawn seats once a minute until both stand, each checked by keepCert on round 0 built from the series (`contractOf`)
  async function askUnwritten() {
    const t = nowMs();
    // A SEATING OF A TABLE THIS SEAT MISSED (kanban #1020): it was down at the check-in, or the hand-out left it out. The newest is asked of the table's drawn seats.
    for (const [a, table] of tables) {
      // a table whose first certificate is still lacking is asked below; one this seat holds it for may still have no row of round 0, and is asked here
      if (table.from > BigInt(t) || SEATING_ROLES.some((role) => !certs.get(`${a}:${role}`)) || t - table.askedMs < TABLE_RESEAT_ASK_MS) continue;
      table.askedMs = t;
      await Promise.all(SEATING_ROLES.map(async (role) => {
        const c = roster.committeeFor(table.rid, role);
        if (!c.ok) return;
        // three of the drawn seats, others on the next pass
        const seats = endpointsOf(c.drawn, round.pubkey, endpointOf).filter((b) => !rests(b));
        const turn = Math.floor(t / TABLE_RESEAT_ASK_MS);
        await Promise.all(seats.filter((_, i) => (i + turn) % Math.max(1, Math.ceil(seats.length / 3)) === 0).map(async (b) => {
          const j = await getJson(b, `/seating?round=${a}&role=${role}&at=${toHex(table.rid)}`);
          if (!j || !j.cert) return;
          // a check-in this seat never wrote is built from the series it holds, by the index the door names
          try { const d = decodeSeatingCertificate(fromHex(j.cert)); if (toHex(d.roundId) !== a && d.role === role) { const k = keepCert(d.roundId, role, fromHex(j.cert), { index: j.index }); if (!k.ok) log(`[seating] table ${a.slice(0, 16)} ${role}: its seating at round ${j.index} refused here: ${k.why}`); } } catch { /* says nothing */ }
        }));
      }));
    }
    for (const [a, u] of unwritten) {
      const lacking = SEATING_ROLES.filter((role) => !db.prepare('SELECT 1 FROM seat_certs WHERE round_id = ? AND role = ?').get(u.rid, role));
      // asked for at most 3 h: a table nobody certified is not asked for all day
      if (!lacking.length || (!u.held && round.get(u.rid)) || t - u.sinceMs > 3 * 3600000) { unwritten.delete(a); continue; }
      if (u.held && t < u.closeMs) continue;     // its seating still open: the exchange above seats it
      if (t - u.askedMs < 60000) continue;
      u.askedMs = t;
      const posted = u.held ? null : contractOf(u.rid);
      if (!u.held && !posted) continue;
      // every lacking role and every drawn seat at once, a resting one left out (#791): the first certificate that checks is kept
      await Promise.all(lacking.map(async (role) => {
        const c = roster.committeeFor(u.rid, role, posted ? { posted } : {});
        if (!c.ok) return;
        await Promise.all(endpointsOf(c.drawn, round.pubkey, endpointOf).filter((b) => !rests(b)).map(async (b) => {
          const j = await getJson(b, `/seating?round=${a}&role=${role}`);
          if (j && j.cert && !db.prepare('SELECT 1 FROM seat_certs WHERE round_id = ? AND role = ?').get(u.rid, role)) keepCert(u.rid, role, fromHex(j.cert));
        }));
      }));
    }
  }

  async function askOne(b, w) {
    const rid = w.ridHex;
    if (!w.closed) { const got = await getJson(b, `/present?round=${rid}`); return got ? { presents: got.presents || [] } : null; }
    const c = await getJson(b, `/seating?round=${rid}&role=${w.role}`);
    const s = await getJson(b, `/seating-sig?round=${rid}&role=${w.role}`);
    return { cert: { [w.role]: c && c.cert ? c.cert : null }, sig: { [w.role]: s && s.signature ? s : null } };
  }

  /**
   * WHO ANSWERS, AMONG THE PRESENTS HELD (kanban #979, the owner 2026-11-02: "Wenn er nicht reagiert sollte er nicht als anwesend gezogen"; measured: an outside node sat in
   * 24 of 60 seated rounds with an advertised address nobody reaches, its PRESENT pushed out from behind it, so no reserve took its seat). A drawn node this seat failed to
   * reach UNANSWERED_TRIES times in a row, with no answer since, is not seated by this seat's first signature, and the next drawn node is. Never below the threshold: with
   * fewer than that left, the PRESENTs held stand as before. The PRESENT stays held, so if a member signs the seating with that node in it, the ordered rule above (#738)
   * brings this seat to it: one seat's bad line can cost a reserve, not a round.
   */
  const silentOf = (w) => new Set(w.c.drawn.filter((e) => toHex(e.pubkey) !== me && (failing.get(endpointsOf([e], null, endpointOf)[0]) || 0) >= UNANSWERED_TRIES).map((e) => toHex(e.pubkey)));
  function answeringOf(w, held) {
    const silent = silentOf(w);
    const left = held.filter((k) => !silent.has(k));
    return left.length >= receiptsNeeded(w.slots) ? left : held;
  }
  /**
   * THE SEATING A CHECK-IN ASKS FOR (kanban #1020), or null when the table stays as it is. A seated node leaves only if this seat holds no PRESENT of it AND failed to reach it
   * (#979), so a node that lives keeps its seat even on a build that sends no PRESENT for a later round. The rest keep theirs, the next drawn node that checked in and answers
   * takes the place, and the seats never shrink: with no reserve for a place, nothing changes, so the claim key is made again only for a real replacement.
   */
  function reseatingOf(w) {
    const prior = tableSeatingAt(w.t.checkIn.anchorHex, w.role, w.t.checkIn.index - 1);
    if (!prior) return null;
    const held = new Set(db.prepare('SELECT node FROM seat_presents WHERE round_id = ? AND role = ?').all(w.t.rid, w.role).map((r) => r.node));
    const silent = silentOf(w);
    const gone = prior.filter((k) => !held.has(k) && silent.has(k));
    if (!gone.length) return null;
    const stay = prior.filter((k) => !gone.includes(k));
    const reserves = w.drawnKeys.map(toHex).filter((k) => !prior.includes(k) && held.has(k) && !silent.has(k)).slice(0, gone.length);
    if (reserves.length < gone.length) return null;
    const list = new Set([...stay, ...reserves]);
    return w.drawnKeys.filter((k) => list.has(toHex(k)));
  }
  /** At seating_close: the seated from the PRESENTs held, and this node's signature over that seating - once, if seated. */
  function signMine(w) {
    if (db.prepare('SELECT 1 FROM seat_certs WHERE round_id = ? AND role = ?').get(w.t.rid, w.role)) return;
    if (mySignature(w.t.rid, w.role)) return;
    const held = db.prepare('SELECT node FROM seat_presents WHERE round_id = ? AND role = ?').all(w.t.rid, w.role).map((r) => r.node);
    const seated = w.t.checkIn ? reseatingOf(w) : seatedFrom({ drawn: w.drawnKeys, present: answeringOf(w, held), slots: w.slots });
    if (!seated) return;
    if (!seated.some((k) => toHex(k) === me)) return;
    signSeatingOf(w, seated, held);
    log(`[seating] ${w.ridHex.slice(0, 16)} ${w.role}: signed the seating of ${seated.length} (${held.length} present of ${w.drawnKeys.length} drawn)`);
  }
  /** This node's signature over `seated` (and, for a 22 round, its SEEN of `held`): the one seat_signed names, kept with the others'. */
  function signSeatingOf(w, seated, held) {
    const sig = signSeating({ roundId: w.t.rid, role: w.role, seated }, sign);
    const list = seated.map(toHex);
    db.prepare('INSERT INTO seat_signed (round_id, role, seated, signature) VALUES (?, ?, ?, ?) ON CONFLICT (round_id, role) DO UPDATE SET seated = excluded.seated, signature = excluded.signature')
      .run(w.t.rid, w.role, JSON.stringify(list), sig);
    const id = toHex(seatingId({ roundId: w.t.rid, role: w.role, seated }));
    rememberSeating(w.t.rid, w.role, id, list);
    db.prepare('INSERT OR IGNORE INTO seat_sigs (round_id, role, seating, node, signature) VALUES (?, ?, ?, ?, ?)').run(w.t.rid, w.role, id, me, sig);
    signedAt.set(`${w.ridHex}:${w.role}`, nowMs());   // a withholder of this seating is counted from now (kanban #1509)
    // kept in the store (kanban #2501): a restart no longer starts WITHHELD_SIG_MS again, so a restarted seat does not move 30 s after the others
    db.prepare('INSERT INTO seat_signed_at (round_id, role, at) VALUES (?, ?, ?) ON CONFLICT (round_id, role) DO UPDATE SET at = excluded.at').run(w.t.rid, w.role, nowMs());
  }

  // ONE OVERLOADED SEAT SIGNED A SMALLER SEATING AND NO CERTIFICATE FORMED (kanban #738, measured 2026-10-27 23:30Z, Up/Down round
  // d77b3d03, 9 drawn for 7 seats): six seats signed the seating of 7 (8 present of 9 drawn), the overloaded one the seating of 5 (5
  // present) - it held only 5 PRESENTs at its close and signed once, for good. The seating of 7 needs its signature and never got it;
  // no certificate, GET /seating 404 everywhere, the round unseated and without entries.
  //
  // A SEAT SIGNS A SECOND SEATING ONLY WHEN ITS FIRST CAN NEVER STAND. Seatings are ordered: S comes before T (seatingBefore) when T
  // seats at least as many and its i-th seated ranks no lower in the draw than S's i-th, for every i of S - the seating of a superset
  // of the PRESENTs comes after the seating of the subset. A seat signs again only (1) when a member of its seating S other than
  // itself signed a seating T that does not come before S, (2) the seating S' of the PRESENTs it holds now, which comes after S, (3)
  // when it is in S', (4) when another node signed S' already, and (5) while no certificate stands here. Every honest seat's
  // signatures then come one after another in that order; the first seat to leave S saw a member that had never signed S and from
  // T can only go on to seatings after T - never to S. So S never completes, at most one certificate stands, and no two can prove
  // equivocation against an honest seat.
  const rankOf = (w) => w.rank || (w.rank = new Map(w.drawnKeys.map((k, i) => [toHex(k), i])));
  /** Does seating `a` come before seating `b` (node keys hex, both in score order) in this round's draw? (one rule with the page, kanban #2537) */
  function seatingBefore(w, a, b) { return seatingOrderBefore(w.drawnKeys, a, b); }
  // A MEMBER THAT ANSWERS BUT NEVER SIGNS (kanban #1509, wf1489 r1 census-1): a drawn seat that hands out its PRESENT and answers every read, with its seating
  // signature always null, is never silent (#979) and signs no other seating (#738), so every honest seat waited for it until the start - no certificate, no
  // entries, one free seat voiding every round it was drawn into. A member of this node's seating of whom no signature over any seating is held
  // WITHHELD_SIG_MS after this node signed it withholds: the seating can never stand without it, and the seats move on to the seating of the PRESENTs held
  // less the withholders (resign), never below the threshold; the reserve it takes in signs once every other member did (joinLate everyOther).
  const signedAt = new Map();     // `${ridHex}:${role}` -> when this node signed its present seating (ms; first seen after a restart)
  function withholdersOf(w) {
    const signed = mySignature(w.t.rid, w.role);
    if (!signed) return [];
    const key = `${w.ridHex}:${w.role}`;
    if (!signedAt.has(key)) {
      const r = db.prepare('SELECT at FROM seat_signed_at WHERE round_id = ? AND role = ?').get(w.t.rid, w.role);
      const at = r ? Number(r.at) : nowMs();
      signedAt.set(key, at);
      if (!r) db.prepare('INSERT OR IGNORE INTO seat_signed_at (round_id, role, at) VALUES (?, ?, ?)').run(w.t.rid, w.role, at);
    }
    if (nowMs() < signedAt.get(key) + WITHHELD_SIG_MS) return [];
    // ONLY A SIGNATURE OVER THIS NODE'S PRESENT SEATING EXCUSES A MEMBER (kanban #1681, #1741, wf1489 v1 refute-17): one over any other seating did before, so a
    // withholder that signed a seating of itself alone - one that comes before ours in #738's order, so that branch skips it too - was never left out, and
    // still voided every round it was drawn into. A member that signed another seating which can stand moves to ours, or #738 moves us; either way its
    // signature over this seating is what the certificate needs.
    const id = toHex(seatingId({ roundId: w.t.rid, role: w.role, seated: signed.seated.map(fromHex) }));
    const held = new Set(db.prepare('SELECT node FROM seat_presents WHERE round_id = ? AND role = ?').all(w.t.rid, w.role).map((r) => r.node));
    const left = withheldOf(w);
    const signs = (k) => !!db.prepare('SELECT 1 FROM seat_sigs WHERE round_id = ? AND role = ? AND seating = ? AND node = ?').get(w.t.rid, w.role, id, k);
    // A MEMBER THE OTHERS LEFT FOR WITHHOLDING, THOUGH IT SIGNED THIS SEATING LATE (kanban #2501, wf1489 a44 refute-3 s2, after #1609/#1707): the #1609 withholder
    // signs the seating before ours until a few honest members have left it (#1509) and re-signed without it, then signs ours. A seat whose timer ran a tick
    // later held every member's signature over ours - the movers' first ones are kept - and certified it; the movers refuse that certificate (#1707) and theirs
    // never completed: 3 of 8 honest seats held the standing seating's certificate, below receiptsNeeded(7). Such a member is a withholder here too: it signed a
    // seating before ours (the #1609 signal), and at least two other members of ours signed the seating that leaves it out and takes in only reserves ranked
    // below every member (the pair an honest #1509 move makes, #1707) - so this seat moves with them instead of completing the seating they left. Two, not one:
    // a single member cannot drop another this way; and a member that signed nothing before ours is never dropped by others' signatures.
    const mine = signed.seated;
    const before = (k) => db.prepare('SELECT seating FROM seat_sigs WHERE round_id = ? AND role = ? AND node = ?').all(w.t.rid, w.role, k)
      .some((r) => { const o = r.seating === id ? null : seatingOf(w, r.seating); return !!o && seatingBefore(w, o, mine); });
    const droppedBy = new Map();     // member -> the other members that signed a seating leaving it out
    for (const r of db.prepare('SELECT node, seating FROM seat_sigs WHERE round_id = ? AND role = ? AND seating != ? AND node != ?').all(w.t.rid, w.role, id, me)) {
      if (!mine.includes(r.node)) continue;
      const other = seatingOf(w, r.seating);
      if (!other || !other.includes(me) || !other.includes(r.node) || !other.every((x) => held.has(x) && !left.has(x)) || !leavesFor(rankOf(w), mine, other)) continue;
      for (const g of mine) if (!other.includes(g)) (droppedBy.get(g) || droppedBy.set(g, new Set()).get(g)).add(r.node);
    }
    const dropped = (k) => (droppedBy.get(k) || new Set()).size >= 2 && before(k);
    return mine.filter((k) => k !== me && (!signs(k) || dropped(k)));
  }
  // THE WITHHOLDERS THIS NODE LEFT A SEATING FOR, kept for the round and role (kanban #1887, #1921, #1965, wf1489 v1 refute-17-s2 of #1509). Only the members of the
  // present seating counted as withholders before: after the move to S' (S less the withholder, the reserve in) the honest members' own older signatures over S - S
  // does not come before S' - made S' 'never stand' in #738's check, and resign() took them back to S, which seats the withholder again. A second withholder (a
  // colluding first reserve), a reserve that crashed after the close, or an honest reserve on a slow tick swung the seats S <-> S' every 30 s and voided the round.
  // Now every withholder this node moved away from is written here, survives a restart, and is left out for good: no candidate of resign() seats one, and a
  // signature over a seating that seats one is no reason in #738's check to move - such a seating can never stand.
  const withheldOf = (w) => new Set(db.prepare('SELECT node FROM seat_withheld WHERE round_id = ? AND role = ?').all(w.t.rid, w.role).map((r) => r.node));
  const seatsWithheld = (list, withheld) => list.some((k) => withheld.has(k));
  /** The member of this node's seating that signed a seating not before it (kanban #738), or one that withholds its signature (#1509), or null while the seating may still stand. */
  function canNeverStand(w) {
    if (db.prepare('SELECT 1 FROM seat_certs WHERE round_id = ? AND role = ?').get(w.t.rid, w.role)) return null;
    const signed = mySignature(w.t.rid, w.role);
    if (!signed) return null;
    const known = withheldOf(w);
    const id = toHex(seatingId({ roundId: w.t.rid, role: w.role, seated: signed.seated.map(fromHex) }));
    // A SEATING THIS NODE LEFT FOR A WITHHOLDER is no reason to move (kanban #2208, wf1489 a44 refute-3): one honest seat ticking 10-20 s behind the others
    // (#803's long ticks) still signed the seating with the withholder in it after the others had left it; that seating does not come before theirs, so
    // #738 sent them back to it, and the two halves swapped seatings until the start. A seat never goes back to a seating that seats a member it left.
    for (const r of db.prepare('SELECT node, seating FROM seat_sigs WHERE round_id = ? AND role = ? AND seating != ? AND node != ?').all(w.t.rid, w.role, id, me)) {
      if (!signed.seated.includes(r.node)) continue;
      const other = seatingOf(w, r.seating);   // from the store after a restart too (kanban #2140)
      // a seating that seats a withholder this node left (kanban #1887, #1921, #1965): never a reason to move, it can never stand
      if (other && !seatsWithheld(other, known) && !seatingBefore(w, other, signed.seated)) return r.node;
    }
    return withholdersOf(w)[0] || null;
  }
  /** This node's second seating, when its first can never stand (kanban #738): the rule above. */
  function resign(w) {
    if (w.t.checkIn) return;      // a check-in that does not meet leaves the table as it is, and the next one tries again (kanban #1020)
    const member = canNeverStand(w);
    if (!member) return;
    const signed = mySignature(w.t.rid, w.role);
    const held = db.prepare('SELECT node FROM seat_presents WHERE round_id = ? AND role = ?').all(w.t.rid, w.role).map((r) => r.node);
    // THE SEATING TO GO TO (kanban #1119, measured on the live seats' stores for Up/Down b3f22953, 2026-11-04 10:28Z): six seats signed the seating of the
    // PRESENTs held less the dead node b36828 (#979); seat 438af56f had also failed to reach c6d5d34b and signed without both. Its re-sign took the seating of
    // all the PRESENTs it held - the dead node in again - which nobody signed, so it never moved and no certificate formed. Now the seating of the PRESENTs
    // held is one candidate, and every seating another node signed whose seated this node holds PRESENTs of is another; each must meet the rule as before
    // (it comes after this node's seating, seats this node, another node signed it), and of those the one most nodes signed is taken, by id on a tie.
    const heldSet = new Set(held);
    const candidates = new Map();      // seating id -> seated (hex, score order)
    // MEMBERS THAT WITHHOLD THEIR SIGNATURE (kanban #1509) are left out of every candidate: the seating of the PRESENTs held less them, never below the threshold.
    // Leaving a member out does not come after this node's seating in #738's order and nobody may have signed it yet, so the two checks below are not asked of it -
    // the withholder signed nothing, so no seating of it can stand that an honest member left; it is this node's own seating and another node's alike.
    // EVERY WITHHOLDER SEEN SO FAR, not only those of the present seating (kanban #1887, #1921, #1965): the seating less the new ones would seat the old ones again
    const now = withholdersOf(w);
    const known = withheldOf(w);
    if (now.length) {
      const withheld = new Set([...known, ...now]);
      const less = held.filter((k) => !withheld.has(k));
      if (less.length < receiptsNeeded(w.slots)) return;
      let best = null;
      // and only the nodes that answer (kanban #979; #1921: the withheld branch took a reserve that died after the close, and 30 s later went back for it)
      const own = seatedFrom({ drawn: w.drawnKeys, present: answeringOf(w, less), slots: w.slots }).map(toHex);
      const pick = new Map([[toHex(seatingId({ roundId: w.t.rid, role: w.role, seated: own.map(fromHex) })), own]]);
      for (const r of db.prepare('SELECT DISTINCT seating FROM seat_sigs WHERE round_id = ? AND role = ? AND node != ?').all(w.t.rid, w.role, me)) {
        const other = seatingOf(w, r.seating);
        if (other && other.every((k) => heldSet.has(k))) pick.set(r.seating, other);
      }
      for (const [id, list] of pick) {
        if (!list.includes(me) || list.some((k) => withheld.has(k)) || list.length < receiptsNeeded(w.slots) || list.join(',') === signed.seated.join(',')) continue;
        const n = db.prepare('SELECT COUNT(*) AS n FROM seat_sigs WHERE round_id = ? AND role = ? AND seating = ? AND node != ?').get(w.t.rid, w.role, id, me).n;
        if (!best || n > best.n || (n === best.n && id < best.id)) best = { id, list, n };
      }
      if (!best) return;
      // kept before the signature: after a restart the round still leaves them out
      for (const k of now) db.prepare('INSERT OR IGNORE INTO seat_withheld (round_id, role, node) VALUES (?, ?, ?)').run(w.t.rid, w.role, k);
      signSeatingOf(w, best.list.map(fromHex), held);
      log(`[seating] ${w.ridHex.slice(0, 16)} ${w.role}: re-signed the seating of ${best.list.length} (member(s) ${now.map((k) => k.slice(0, 8)).join(', ')} signed nothing in ${WITHHELD_SIG_MS / 1000} s; ${withheld.size} left out in all)`);
      return;
    }
    const own = seatedFrom({ drawn: w.drawnKeys, present: known.size && held.filter((k) => !known.has(k)).length >= receiptsNeeded(w.slots) ? held.filter((k) => !known.has(k)) : held, slots: w.slots }).map(toHex);
    candidates.set(toHex(seatingId({ roundId: w.t.rid, role: w.role, seated: own.map(fromHex) })), own);
    for (const r of db.prepare('SELECT DISTINCT seating FROM seat_sigs WHERE round_id = ? AND role = ? AND node != ?').all(w.t.rid, w.role, me)) {
      const other = seatingOf(w, r.seating);
      if (other && other.every((k) => heldSet.has(k))) candidates.set(r.seating, other);
    }
    let best = null;
    for (const [id, list] of candidates) {
      // never back to a seating that seats a withholder this node left (kanban #1887, #1921, #1965)
      if (!list.includes(me) || seatsWithheld(list, known) || !seatingBefore(w, signed.seated, list)) continue;
      const n = db.prepare('SELECT COUNT(*) AS n FROM seat_sigs WHERE round_id = ? AND role = ? AND seating = ? AND node != ?').get(w.t.rid, w.role, id, me).n;
      if (!n) continue;
      if (!best || n > best.n || (n === best.n && id < best.id)) best = { id, list, n };
    }
    if (!best) return;
    const list = best.list;
    const seated = list.map(fromHex);
    signSeatingOf(w, seated, held);
    log(`[seating] ${w.ridHex.slice(0, 16)} ${w.role}: re-signed the seating of ${list.length} (member ${member.slice(0, 8)} signed another; the seating of ${signed.seated.length} can never stand)`);
  }

  /**
   * A TABLE'S FIRST ROUND JOINED LATE (kanban #803): this node, not yet signed and with no certificate here, signs the seating another
   * seated member signed - one that seats this node, all of whose members' PRESENTs this node holds - and no other. It adds no seating
   * of its own, and it is this node's one signature, so the rule of the ordered seatings (#738) holds as before.
   */
  // everyOther (kanban #1509): a reserve taken in for a withholding member, on a round not yet started, joins only a seating every other member of it signed -
  // its signature completes the certificate, and no single node can spend it on a seating the others did not move to
  function joinLate(w, got, { everyOther = false } = {}) {
    if (leftNode(me) || certOf(w.t.rid, w.role) || mySignature(w.t.rid, w.role)) return;
    const held = new Set(db.prepare('SELECT node FROM seat_presents WHERE round_id = ? AND role = ?').all(w.t.rid, w.role).map((r) => r.node));
    const r = rankOf(w);
    const by = new Map();     // seating id -> { list, n }
    for (const g of got) {
      if (!g || !g.signature || !Array.isArray(g.seated) || !g.node) continue;
      const node = String(g.node).toLowerCase();
      let list; try { list = g.seated.map((k) => String(k).toLowerCase()); } catch { continue; }
      if (node === me || !list.includes(node) || !list.includes(me) || list.length > w.slots) continue;
      if (!list.every((k, i) => held.has(k) && r.has(k) && (i === 0 || r.get(list[i - 1]) < r.get(k)))) continue;
      const id = toHex(seatingId({ roundId: w.t.rid, role: w.role, seated: list.map(fromHex) }));
      let good = false; try { good = verify(fromHex(g.signature), fromHex(id), fromHex(node)); } catch { good = false; }
      if (!good) continue;
      const e = by.get(id) || by.set(id, { list, n: 0, by: new Set() }).get(id); if (!e.by.has(node)) { e.by.add(node); e.n++; }   // each signer once (kanban #1509)
    }
    const best = [...by.values()].filter((e) => !everyOther || e.n >= e.list.length - 1).sort((a, b) => b.n - a.n)[0];
    if (!best) return;
    signSeatingOf(w, best.list.map(fromHex), [...held]);
    log(`[seating] ${w.ridHex.slice(0, 16)} ${w.role}: joined late - signed the seating of ${best.list.length} that ${best.n} seated member(s) signed (table's first round, started without its certificate)`);
  }

  /** Another seated node's signature, kept when it verifies: over the seating this node signed, or (kanban #738) over another one. */
  function keepSig(w, got) {
    const signed = mySignature(w.t.rid, w.role);
    if (!signed || !got.signature || !Array.isArray(got.seated) || !got.node) return;
    const node = String(got.node).toLowerCase();
    if (node === me || !/^[0-9a-f]{64}$/.test(node)) return;
    let list; try { list = got.seated.map((k) => String(k).toLowerCase()); } catch { return; }
    const mine = list.join(',') === signed.seated.join(',');
    // ANOTHER SEATING is kept only as a seating looks: drawn nodes in score order, no more than the seats, its signer among them
    if (!mine) {
      const r = rankOf(w);
      if (!list.length || list.length > w.slots || !list.includes(node) || !list.every((k, i) => r.has(k) && (i === 0 || r.get(list[i - 1]) < r.get(k)))) return;
    }
    const id = toHex(seatingId({ roundId: w.t.rid, role: w.role, seated: list.map(fromHex) }));
    rememberSeating(w.t.rid, w.role, id, list);
    if (db.prepare('SELECT 1 FROM seat_sigs WHERE round_id = ? AND role = ? AND seating = ? AND node = ?').get(w.t.rid, w.role, id, node)) return;   // held already
    // a node's signatures over other seatings, a few at most: an honest one signs one, or two (kanban #738)
    if (!mine && db.prepare('SELECT COUNT(*) AS n FROM seat_sigs WHERE round_id = ? AND role = ? AND node = ?').get(w.t.rid, w.role, node).n >= 3) return;
    let good = false; try { good = verify(fromHex(got.signature), fromHex(id), fromHex(node)); } catch { good = false; }
    if (good) db.prepare('INSERT OR IGNORE INTO seat_sigs (round_id, role, seating, node, signature) VALUES (?, ?, ?, ?, ?)').run(w.t.rid, w.role, id, node, fromHex(got.signature));
  }

  /** With every seated node's signature: the certificate, kept and handed to every other drawn node. */
  async function certify(w) {
    if (db.prepare('SELECT 1 FROM seat_certs WHERE round_id = ? AND role = ?').get(w.t.rid, w.role)) return;
    const signed = mySignature(w.t.rid, w.role);
    if (!signed) return;
    const list = signed.seated.map(fromHex);
    const id = toHex(seatingId({ roundId: w.t.rid, role: w.role, seated: list }));
    const sigs = db.prepare('SELECT node, signature FROM seat_sigs WHERE round_id = ? AND role = ? AND seating = ?').all(w.t.rid, w.role, id);
    if (!signed.seated.every((k) => sigs.some((x) => x.node === k))) return;
    const cert = encodeSeatingCertificate({ roundId: w.t.rid, role: w.role, seated: list,
      signatures: sigs.filter((x) => signed.seated.includes(x.node)).map((x) => ({ nodePubkey: fromHex(x.node), signature: new Uint8Array(x.signature) })) });
    const k = keepCert(w.t.rid, w.role, cert);
    if (k.ok && k.kept) {
      // HANDED TO EVERY OTHER DRAWN NODE, so each holds it - the reserves too - before an entry comes; a resting node (#791) is left
      // out, and the tick does not wait for the hand-out (kanban #803, measured 08:0xZ 10-30 on test host seat 2: take+certify 10,581 ms of
      // a 12,189 ms tick, two certificates each waiting out a drawn node that never answers; a node left out reads it by its batch)
      const to = w.others.filter((b) => !rests(b));
      Promise.all(to.map((b) => post(b, '/seating', cert))).catch(() => {});
      log(`[seating] ${w.ridHex.slice(0, 16)} ${w.role}: certificate of ${list.length} seated, every one signed - handed to ${to.length}`);
    }
  }

  /** THE BATCH DOORS' SIDE. POST /presents: the PRESENTs of one body, each taken as POST /present takes it. */
  function takePresents(bytes) {
    if (!bytes.length || bytes.length % PRESENT_BYTES !== 0) return { ok: false, why: `a batch of PRESENTs is a whole number of ${PRESENT_BYTES}-byte PRESENTs` };
    // AT MOST AS MANY AS POST /presence takes (kanban #1271): a batch is a round's seating, never more than a few hundred
    if (bytes.length / PRESENT_BYTES > MAX_PRESENTS_PER_BATCH) return { ok: false, status: 413, why: `a batch holds at most ${MAX_PRESENTS_PER_BATCH} PRESENTs` };
    let taken = 0; const refused = []; const once = new Set();   // one PRESENT per (round, role, node) in one body (kanban #1565)
    for (let i = 0; i < bytes.length; i += PRESENT_BYTES) { const r = takePresent(bytes.subarray(i, i + PRESENT_BYTES), { once }); if (r.ok) taken++; else refused.push(r.why); }
    return { ok: true, taken, refused: refused.slice(0, 8) };
  }
  /** GET /seating-batch: for each named round, the PRESENTs held, this node's seating signatures and the certificates. */
  function batchOf(ridHexes) {
    const rounds = {};
    for (const h of ridHexes) {
      const rid = fromHex(h);
      rounds[h] = { presents: presentsOf(rid), sig: Object.fromEntries(SEATING_ROLES.map((r) => [r, mySignature(rid, r)])),
        cert: Object.fromEntries(SEATING_ROLES.map((r) => [r, certOf(rid, r)])) };
    }
    return { rounds };
  }

  // A TABLE'S ROUND IS SEATED BY ITS TABLE'S FIRST ROUND (pick (c)): every lookup by round maps it there
  const anchors = new Map();
  const seatOf = (rid) => {
    const h = toHex(rid);
    if (anchors.has(h)) return anchors.get(h);
    let to = rid;
    // A ROUND THIS SEAT HOLDS NO ROW OF YET IS NOT REMEMBERED AS ITS OWN TABLE (kanban #1046, measured 2026-11-02 in running seats: asked before its row was written, a round stayed "no
    // table" here, seatedFor answered with the table's first seating, and that list, absent node and all, went into the round's row when it was assigned)
    let row = null;
    try { row = round.get(rid); const a = row ? tableAnchorOf(decodeRoundContract(new Uint8Array(row.contract))) : null; if (a) to = a.anchorId; } catch { /* itself */ }
    if (!row) return to;
    anchors.set(h, to);
    if (anchors.size > 20000) anchors.delete(anchors.keys().next().value);
    return to;
  };
  /** The round of a table's seating that seats `rid`, for the doors: its table's first, or the check-in that seated it last (kanban #1020). */
  const seatRoundOf = (rid, role) => {
    const anchor = seatOf(rid);
    const later = reseats.get(`${toHex(anchor)}:${role}`);
    if (!later) return anchor;
    let index = null; try { index = decodeRoundContract(new Uint8Array(round.get(rid).contract)).roundIndex; } catch { index = null; }
    if (index === null) return anchor;
    for (let i = later.length - 1; i >= 0; i--) if (later[i].index <= index && !staleReseats.has(`${toHex(later[i].rid)}:${role}`)) return later[i].rid;
    return anchor;
  };
  /** Who seats round `rid`. A round with entries keeps the seats it had when they came (kanban #1020): a later seating does not move money already on the table. */
  const seatedAt = (rid, role) => {
    const anchor = seatOf(rid), a = toHex(anchor);
    if (!reseats.size || !(reseats.has(`${a}:${role}`) || reseats.has(`${a}:settlement`))) return certs.get(`${a}:${role}`) || null;
    let c; try { c = decodeRoundContract(new Uint8Array(round.get(rid).contract)); } catch { return certs.get(`${a}:${role}`) || null; }
    let index = c.roundIndex;
    // A ROUND WITH ENTRIES KEEPS ITS SEATS, a stale check-in seating too (kanban #2564 beside #1020 / #2083): the money on it is not moved to another committee
    const withEntries = !!(round.entriesOf && round.entriesOf(rid).length);
    if (round.entriesOf && round.entriesOf(rid).length && c.nodes && c.nodes.length) {
      const names = c.nodes.map(toHex).sort().join();
      const fits = (s) => s && [...s].sort().join() === names;
      const later = reseats.get(`${a}:settlement`) || [];
      if (!fits(tableSeatingAt(a, 'settlement', index, { keepStale: true }))) {
        const kept = [...later].reverse().find((x) => x.index <= index && fits(x.seated));
        index = kept ? kept.index : (later[0] ? later[0].index - 1 : index);
      }
    }
    return tableSeatingAt(a, role, index, { keepStale: withEntries });
  };
  return {
    tick,
    /** WHO THIS SEAT COUNTS AS NOT ANSWERING (kanban #984): each address, its failed requests in a row and since when, so another node can compare and ask it itself. */
    unanswered: () => [...failing].filter(([, n]) => n >= UNANSWERED_TRIES).map(([base, tries]) => ({ base, tries, sinceMs: failingSince.get(base) ?? null })),
    /** The certificate pass running beside the tick, if one is (kanban #803): for a caller that needs it finished. */
    settled: () => Promise.all([asking, confirming]).then(() => {}),
    /** For the roster: who the certificate seats (node keys hex), or null while none stands or after equivocation. */
    seatedFor: (rid, role, at = rid) => (toHex(seatOf(at)) === toHex(seatOf(rid)) ? seatedAt(at, role) : seatedAt(rid, role)),
    /** A round's seating, for the doors, the lobby and the entry gate. */
    stateOf: (rid) => {
      const out = {};
      for (const role of SEATING_ROLES) {
        const key = `${toHex(seatOf(rid))}:${role}`;
        const seated = certs.has(key) && certs.get(key) === null ? null : seatedAt(rid, role);
        out[role] = certs.has(key) && certs.get(key) === null ? { equivocated: true } : seated ? { seated } : null;
      }
      return out;
    },
    // WHETHER THIS NODE'S OWN PRESENT IS HELD FOR A ROUND'S SEATING: a reserve that was present has not missed it
    presentHere: (rid, role = 'settlement') => !!db.prepare('SELECT 1 FROM seat_presents WHERE round_id = ? AND role = ? AND node = ?').get(seatOf(rid), role, me),
    takePresent, presentsOf, mySignature, certOf: (rid, role, at = rid) => certOf(seatRoundOf(at, role), role), keepCert, equivocationOf, takePresents, batchOf,
    /** The table round a door's certificate is on, and its index (kanban #1020): 0 for the table's first. */
    certRoundOf: (at, role) => { const r = toHex(seatRoundOf(at, role)); const e = (reseats.get(`${toHex(seatOf(at))}:${role}`) || []).find((x) => toHex(x.rid) === r); return e ? e.index : 0; },
    /** A round deleted from the store (transcript-prune.js, unused and past its windows): its certificates leave memory too. */
    forget: (ridHex) => { for (const role of SEATING_ROLES) { certs.delete(`${ridHex}:${role}`); pending.delete(`${ridHex}:${role}`); } },
  };
}
