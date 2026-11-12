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
//                                         once more: the seating of what it holds now, and only one another node has signed -
//                                         in a 22 round with its justification, the member's signed seating (RULED 2026-10-28),
//                                         bound in the signature (kanban #746)
//   any time                              a second valid certificate for one round and role is equivocation: both are
//                                         kept as the proof (GET /seating-equivocation), and the round takes no entries - except a
//                                         seating less a withholding member, reserves in, and the one it replaced: the replacement
//                                         stands (kanban #1681, #1741)
//
// FROM PROTOCOL 22 THE SEATED ALSO SIGN WHO WAS PRESENT (§5A.3, kanban #727, the owner 2026-10-27): with its SEATING signature a seated
// node signs a SEEN - every node it held a PRESENT of at the close, and the nodes the round's census left out as absent - and the
// certificate is made only with every seated node's SEEN in it. Those certificates are the only proof that leaves a node out of a
// census. A node the round's census left out may hand in a PRESENT though it is not drawn: that is how it comes back.
//
// The roster asks `seatedFor` and seats the certificate's nodes; before one stands, the draw's first slots (Roster).
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { decodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { slotsForRole } from '../../arena-protocol/src/sortition.js';
import { signPresent, verifyPresent, decodePresent, seatedFrom, signSeating, seatingId, encodeSeatingCertificate, verifySeating,
  seatingEquivocation, seatingCloseMs, decodeSeatingCertificate, SEATING_ROLES, signSeen, seenId, seatingListsPresent, seatingBefore as comesBefore,
  encodeJustification, decodeJustification, verifyJustification, justificationChain, justificationSteps, JUSTIFICATION_DEPTH, SILENT_AFTER_MS,
  signSeatingBound, seatingSignedId, justificationHash, checkSeatingPresigs } from '../../arena-protocol/src/seating.js';
import { signSlashPresig, slashPresigVerifies } from '../../arena-protocol/src/slash-presig.js';
import { endpointsOf } from './roster.js';
import { receiptsNeeded } from '../../arena-protocol/src/threshold.js';
import { tableAnchorOf } from '../../arena-protocol/src/known-game.js';

/** How far ahead of its start a round is looked at: PRESENT is signed in the last minute before seating_close. */
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
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
 * left out like a silent node (#979), and the next present reserve takes its place. Well inside the 120 s from seating_close to the start. Below protocol 22
 * only: from 22 the justified silent step (§5A.7, kanban #1314/#1332) leaves such a member out. */
export const WITHHELD_SIG_MS = Number(process.env.ARENA_WITHHELD_SIG_MS || 30000);
/** How long after its start a table's first round without a certificate is still read, and joined late (kanban #803): its table plays all day. */
export const TABLE_LATE_MS = BigInt(process.env.ARENA_TABLE_LATE_MS || 24 * 3600000);
/** A table's check-in (kanban #1020): the first round of the table in each of these periods of UTC time exchanges PRESENTs. */
export const TABLE_CHECK_IN_MS = 900000n;
/** How often a seat asks the seats of its tables for a newer seating it missed (kanban #1020). */
const TABLE_RESEAT_ASK_MS = 300000;
const joinBytes = (list) => { const out = new Uint8Array(list.reduce((n, x) => n + x.length, 0)); let at = 0; for (const x of list) { out.set(x, at); at += x.length; } return out; };

export function seatingAgent({ round, roster, sign, verify, fetcher = fetch, nowMs = () => Date.now(), log = () => {}, windowOf = () => null,
  onSeated = () => {}, leftNode = () => false, contractOf = () => null, leftOutOf = () => [], testHoldPresents = null, endpointOf = null, holdsOf = null }) {
  // `holdsOf(rid, contract)`: what the round asks of its seated nodes' template-3 bonds, { ok, plan } as slash-presig.js roundPresigPlan answers (kanban #972). None given asks nothing
  // `leftOutOf(rid)`: the node keys (hex) the round's census left out as absent (protocol 22, kanban #727) - they may say PRESENT
  // undrawn, and every seated node names them in its SEEN
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
    CREATE TABLE IF NOT EXISTS seat_seen (round_id BLOB NOT NULL, role TEXT NOT NULL, seating TEXT NOT NULL, node TEXT NOT NULL, present TEXT NOT NULL,
      left_out TEXT NOT NULL, signature BLOB NOT NULL, PRIMARY KEY (round_id, role, seating, node));
    CREATE TABLE IF NOT EXISTS seat_presigs (round_id BLOB NOT NULL, node TEXT NOT NULL, txid TEXT NOT NULL, vout INTEGER NOT NULL, signature BLOB NOT NULL, kept_ms INTEGER NOT NULL,
      PRIMARY KEY (round_id, node, txid, vout));
    CREATE INDEX IF NOT EXISTS seat_presigs_bond ON seat_presigs (txid, vout, kept_ms);
    CREATE TABLE IF NOT EXISTS own_hold_panels (txid TEXT NOT NULL, vout INTEGER NOT NULL, script TEXT NOT NULL, panel_a TEXT NOT NULL, panel_b TEXT NOT NULL, PRIMARY KEY (txid, vout, script));
    CREATE TABLE IF NOT EXISTS seat_withheld (round_id BLOB NOT NULL, role TEXT NOT NULL, node TEXT NOT NULL, PRIMARY KEY (round_id, role, node));
  `);
  // when each PRESENT arrived (kanban #1248)
  if (!db.prepare('PRAGMA table_info(seat_presents)').all().some((c) => c.name === 'received_ms')) db.exec('ALTER TABLE seat_presents ADD COLUMN received_ms INTEGER');
  // A SECOND SIGNATURE'S JUSTIFICATION (protocol 22, kanban #738): kept with it, here and at the peers that hold it
  for (const t of ['seat_signed', 'seat_sigs']) {
    if (!db.prepare(`PRAGMA table_info(${t})`).all().some((c) => c.name === 'justification')) db.exec(`ALTER TABLE ${t} ADD COLUMN justification BLOB`);
  }
  // AND THE SEATED LIST OF EACH SIGNATURE HELD (kanban #746): a signature this node holds is presented to the judge with its seating
  if (!db.prepare('PRAGMA table_info(seat_sigs)').all().some((c) => c.name === 'seated')) db.exec('ALTER TABLE seat_sigs ADD COLUMN seated TEXT');
  const me = toHex(round.pubkey);
  // THE SEATED LISTS OF THE SEATINGS SIGNED (kanban #738): `${rid}:${role}:${seating id}` -> node keys hex, for every seating a
  // signature over it was kept of - a seating this node did not sign is known by its id only in seat_sigs. Lost at a restart: the
  // peers hand their signatures with their lists again on every tick until a certificate stands, and none known is no re-sign.
  const seatings = new Map();
  const rememberSeating = (rid, role, id, list) => {
    seatings.set(`${toHex(rid)}:${role}:${id}`, list);
    if (seatings.size > 20000) seatings.delete(seatings.keys().next().value);
  };
  const certs = new Map();       // `${rid}:${role}` -> seated hex list (null: equivocated)
  for (const r of db.prepare('SELECT round_id, role, cert FROM seat_certs').all()) {
    try { certs.set(`${toHex(new Uint8Array(r.round_id))}:${r.role}`, decodeSeated(new Uint8Array(r.cert))); } catch { /* unread */ }
  }
  for (const r of db.prepare('SELECT round_id, role FROM seat_equivocations').all()) certs.set(`${toHex(new Uint8Array(r.round_id))}:${r.role}`, null);
  // a kept certificate was checked before it was kept (keepCert): read back, it names its seated
  function decodeSeated(cert) { return decodeSeatingCertificate(cert).seated.map(toHex); }

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
    if (list.some((x) => x.index === index)) return;
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
    return { roundId: rid, role, drawn: c.drawn.map((e) => e.pubkey), slots: slotsForRole(contract, role), verify, listsPresent: seatingListsPresent(contract), contract, posted };
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
  const keepCert = (rid, role, bytes, { index = null } = {}) => {
    // ONE HELD ALREADY, byte for byte, is not checked again (2026-10-12 "figure out why CPU usage so high and
    // optimise it": every batch answer repeats a round's certificate, and each was verified - all its signatures - before the
    // seat looked whether it held exactly these bytes)
    const held = db.prepare('SELECT cert FROM seat_certs WHERE round_id = ? AND role = ?').get(rid, role);
    if (held && Buffer.compare(Buffer.from(held.cert), Buffer.from(bytes)) === 0) {
      // held from before a restart, on a round this seat has no row of: read back here (kanban #1020)
      if (index !== null) { const posted = contractOf(rid, index); if (posted) noteReseat(rid, role, decodeSeated(bytes), posted); }
      return { ok: true, kept: false };
    }
    const check = checkFor(rid, role, index);
    if (!check || check.refused) return { ok: false, why: `this node cannot draw that round yet${check ? `: ${check.refused}` : ''}` };
    const v = verifySeating(bytes, check);
    if (!v.ok) return v;
    // KEPT ONLY IN ITS CANONICAL FORM (kanban #1711): verifySeating checks the seated members' signatures and nothing else, so a
    // stranger who read them off GET /seating-batch could pad a standing certificate with 65,000 junk (nodePubkey, signature)
    // pairs (6.2 MB), post it first, and every seat kept and served those bytes - the honest certificate after it then differed
    // and was refused as "one seating twice". The seat keeps exactly the seated members' signatures, the bytes certify() makes;
    // in 2.0 with the SEEN groups and justifications verifySeating held to the seated, and only the seated members' presigs.
    { const by = new Map(v.seating.signatures.map((x) => [toHex(x.nodePubkey), x.signature]));
      const seatedHex = new Set(v.seating.seated.map(toHex));
      const presigs = v.seating.presigs ? v.seating.presigs.filter((x) => seatedHex.has(toHex(x.nodePubkey))) : null;
      const canonical = encodeSeatingCertificate({ roundId: v.seating.roundId, role: v.seating.role, seated: v.seating.seated,
        signatures: v.seating.seated.map((k) => ({ nodePubkey: k, signature: by.get(toHex(k)) })),
        seen: v.seating.seen, justifications: v.seating.justifications, presigs });
      if (Buffer.compare(Buffer.from(canonical), Buffer.from(bytes)) !== 0) {
        bytes = canonical;
        if (held && Buffer.compare(Buffer.from(held.cert), Buffer.from(bytes)) === 0) return { ok: true, kept: false };
        v.seating.signatures = v.seating.seated.map((k) => ({ nodePubkey: k, signature: by.get(toHex(k)) }));
        if (presigs) v.seating.presigs = presigs;
      } }
    // A SEATING THIS NODE LEFT FOR A WITHHOLDER (kanban #1707, wf1489 r5 census-2): the honest members' signatures over the first seating were handed out
    // before they re-signed without the withholder (#1509), so the withholder can sign that seating late and complete it with them. A certificate that
    // seats a member this node named a withholder is never kept nor counted as equivocation: this node left that seating, and the one it moved to stands.
    const named = v.seating.seated.map(toHex).find((k) => db.prepare('SELECT 1 FROM seat_withheld WHERE round_id = ? AND role = ? AND node = ?').get(rid, role, k));
    if (named) return { ok: false, why: `that seating seats ${named.slice(0, 8)}, which withheld its seating signature here (kanban #1509): this node left it` };
    // A SEAT REFUSES A SEATING WHOSE MEMBER'S slash_presig DOES NOT VERIFY (5A.3B, kanban #972), and from here it holds them for a slash
    if (holdsOf) {
      let asked; try { asked = holdsOf(rid, check.contract); } catch (e) { asked = { ok: false, why: e.message }; }
      if (!asked || !asked.ok) return { ok: false, why: `this node cannot read that round's holds yet${asked ? `: ${asked.why}` : ''}` };
      const p = checkSeatingPresigs(v.seating, asked.plan, (sig, digest, key) => slashPresigVerifies(sig, digest, key, verify));
      if (!p.ok) return p;
      for (const x of v.seating.presigs || []) keepPresig(rid, toHex(x.nodePubkey), toHex(x.txid), x.vout, x.signature);
    }
    // on a table only the first round and its check-ins hold a seating (kanban #1020)
    try { const a = tableAnchorOf(check.contract);
      if (a && !a.first && !checkInOf(check.contract, a)) return { ok: false, why: 'that round of its table is no check-in' }; } catch { /* the draw above read it */ }
    const key = `${toHex(rid)}:${role}`;
    const had = db.prepare('SELECT cert FROM seat_certs WHERE round_id = ? AND role = ?').get(rid, role);
    if (had) {
      const old = new Uint8Array(had.cert);
      if (toHex(old) === toHex(bytes)) return { ok: true, kept: false };
      const e = seatingEquivocation(old, bytes, check, presentedOf(rid, role));
      if (!e.ok) return { ok: false, why: e.why };
      // A SEATING THAT LEFT OUT A WITHHOLDING MEMBER IS NO EQUIVOCATION WITH THE ONE IT REPLACED (kanban #1681, #1741, wf1489 v1 refute-17): the honest seats
      // signed S, a member of it never signed (#1509), and they moved to S' - S less that member, the next reserves in. The withholder can still sign S at any
      // time and build its certificate from the honest signatures over S it read; that made every honest member of both an equivocator and voided the round.
      // Of two such certificates the replacement stands at every seat: kept when it comes second, and taking the place of the other when that came first,
      // while the round has no entries. One certificate per round and role still seats it; a pair of any other shape is equivocation as before.
      if (certs.get(key) !== null) {
        const heldSeated = decodeSeated(old), newSeated = v.seating.seated.map(toHex), drawnHex = check.drawn.map(toHex);
        if (replaces(heldSeated, newSeated, drawnHex)) return { ok: false, superseded: true, why: 'a certificate that replaced this seating (a member of it withheld its signature) seats that round here' };
        const entries = (() => { try { return round.entriesOf ? round.entriesOf(rid).length : 0; } catch { return 0; } })();
        if (replaces(newSeated, heldSeated, drawnHex) && !entries) {
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
      if (comesBefore(new Map(check.drawn.map((k, i) => [toHex(k), i])), v.seating.seated.map(toHex), decodeSeated(old))) {   // 2.0: #738's order (seatingBefore)
        log(`[seating] ${toHex(rid).slice(0, 16)} ${role}: a certificate for a seating before the one held refused (superseded)`);
        return { ok: false, why: 'superseded: that seating comes before the one certified here' };
      }
      // 2.0 (kanban #1489 port of #1681): a pair the block above did not settle - the replacement came second while the round already
      // holds entries - keeps #1707's rule: the certificate held stands, the other is refused, no equivocation.
      // TWO SEATINGS AN HONEST #1509 MOVE MAKES (kanban #1707): one leaves members of the other out and takes in only nodes that rank below every member of
      // it (the next reserves). The honest seats sign exactly that pair when they leave a withholder, which can still sign the first seating late and complete
      // it with the signatures it read - so the pair is no proof against anyone. The certificate held stands and the other is refused; the round goes on.
      const rank = new Map(check.drawn.map((k, i) => [toHex(k), i]));
      const xs = decodeSeated(old), ys = v.seating.seated.map(toHex);
      const leftOut = (p, q) => { const inQ = new Set(q), inP = new Set(p);
        const gone = p.filter((k) => !inQ.has(k)), added = q.filter((k) => !inP.has(k));
        const low = Math.max(...p.map((k) => (rank.has(k) ? rank.get(k) : Infinity)));
        return gone.length > 0 && added.every((k) => rank.has(k) && rank.get(k) > low); };
      if (leftOut(xs, ys) || leftOut(ys, xs)) return { ok: false, why: 'that seating differs from the one held only by members left out for withholding and the reserves after them (kanban #1509): the seating held stands' };
      db.prepare('INSERT OR IGNORE INTO seat_equivocations (round_id, role, a, b) VALUES (?, ?, ?, ?)').run(rid, role, old, bytes);
      certs.set(key, null);
      // A PROOF THAT NAMES NOBODY (kanban #744): every signer of both presents its chain - the round is void all the same, and the
      // pair is kept as a fault record that names no one (GET /seating-equivocation `unnamed`), for no slash, exclusion or reputation
      const excusedTxt = e.excused.length ? ` (justified, excused: ${e.excused.map((k) => toHex(k).slice(0, 8)).join(', ')})` : '';
      log(`[seating] ${toHex(rid).slice(0, 16)} ${role}: two seatings - ${e.unnamed ? 'a fault that names nobody' : `equivocation by ${e.signers.map((k) => toHex(k).slice(0, 8)).join(', ')}`}${excusedTxt}; the round takes no entries`);
      return { ok: true, equivocation: true, signers: e.signers.map(toHex), unnamed: e.unnamed };
    }
    db.prepare('INSERT OR IGNORE INTO seat_certs (round_id, role, cert) VALUES (?, ?, ?)').run(rid, role, bytes);
    if (!certs.has(key) || certs.get(key) !== null) certs.set(key, v.seating.seated.map(toHex));
    keepPeers(rid, role, v.seating.seated);
    noteReseat(rid, role, v.seating.seated.map(toHex), check.contract);
    // the seats a v2 round counts are these (2026.0.2): the server writes them into the stored contract
    try { onSeated(rid, role, v.seating.seated, check.contract); } catch (e) { log(`[seating] ${toHex(rid).slice(0, 16)} ${role}: ${e.message}`); }
    return { ok: true, kept: true };
  };

  // THE SEATED NODES' ADDRESSES, KEPT WITH THE ROUND (kanban #735, measured 2026-10-27: seat 1, restarted inside round 2927d830's
  // objection window, read no chain view for the round for ~15 min and so gathered no FINAL from its peers - it held the certificate
  // naming them, but a key is not an address). The certificate stood against this node's draw, so the census it was drawn from is
  // readable now: each seated node's endpoint off its advert there is written to the store (round.keepRoundPeers), and every
  // "where are the round's signer nodes" lookup reads it when the roster cannot answer. A node advertising no endpoint is not written.
  const keepPeers = (rid, role, seated) => {
    try {
      const row = round.get(rid);
      const posted = row ? null : contractOf(rid);
      const c = roster.committeeFor(rid, role, posted ? { posted } : {});
      if (!c.ok) return;
      const entries = new Map();
      for (const e of [...(c.drawn || []), ...(c.committee || [])]) if (e && e.pubkey) entries.set(toHex(e.pubkey), e);
      // a node the census left out as absent and seated by being present (kanban #727) is in the census's entries, not the draw
      if (row) { try { const census = roster.censusFor(rid); if (census.ok) for (const e of census.entries || []) if (e && e.pubkey && !entries.has(toHex(e.pubkey))) entries.set(toHex(e.pubkey), e); } catch { /* the draw's entries */ } }
      const peers = [];
      for (const k of seated) {
        const e = entries.get(toHex(k));
        if (e && e.advert && e.advert.endpoint) peers.push({ node: toHex(k), endpoint: String(e.advert.endpoint) });
      }
      const n = round.keepRoundPeers(rid, role, peers);
      if (n < seated.length) log(`[seating] ${toHex(rid).slice(0, 16)} ${role}: ${n} of ${seated.length} seated nodes' addresses kept with the round (the rest advertise none)`);
    } catch (e) { log(`[seating] ${toHex(rid).slice(0, 16)} ${role}: the seated nodes' addresses were not kept: ${e.message}`); }
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
      if (!c0.drawn.some((e) => toHex(e.pubkey) === toHex(d.nodePubkey)) && !leftOutHex(d.roundId).includes(toHex(d.nodePubkey))) return { ok: false, why: 'that node is not drawn for that round and role' };
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
    // A NODE THE ROUND'S CENSUS LEFT OUT AS ABSENT may say PRESENT undrawn (kanban #727): listed in the SEEN, it is back next census
    if (!c.drawn.some((e) => toHex(e.pubkey) === toHex(nodePubkey)) && !leftOutHex(roundId).includes(toHex(nodePubkey)))
      return { ok: false, why: 'that node is not drawn for that round and role' };
    const t = starts.get(toHex(roundId));
    if (t && !afterClose && BigInt(nowMs()) >= t.close) return { ok: false, why: 'that round\'s seating has closed' };
    // THE OVERLOADED SEAT, FORCED (kanban #738, a test switch, regtest rounds only - ARENA_TEST_SEATING_HOLD=n): before its seating closes
    // this seat holds at most n PRESENTs per round and role, its own among them, and drops the rest - as the seat of 2026-10-27 that held 5
    // of 9 at the close. After the close it takes them as any seat does (the late path, afterClose), so what it does then is measured.
    if (Number.isInteger(testHoldPresents) && testHoldPresents > 0 && !afterClose && t && t.contract && toHex(t.contract.networkId || new Uint8Array(0)) === toHex(NETWORK_ID_REGTEST)
      && db.prepare('SELECT COUNT(*) AS n FROM seat_presents WHERE round_id = ? AND role = ?').get(roundId, role).n >= testHoldPresents
      && !db.prepare('SELECT 1 FROM seat_presents WHERE round_id = ? AND role = ? AND node = ?').get(roundId, role, toHex(nodePubkey)))
      return { ok: false, why: `test switch: this seat holds ${testHoldPresents} PRESENTs before the close (ARENA_TEST_SEATING_HOLD)` };
    // with when it arrived (kanban #1248): a late one is kept for the record, and presence-book counts it as seen only before the close
    db.prepare('INSERT OR IGNORE INTO seat_presents (round_id, role, node, bytes, received_ms) VALUES (?, ?, ?, ?, ?)').run(roundId, role, toHex(nodePubkey), bytes, Number(nowMs()));
    return { ok: true };
  }
  const presentsOf = (rid) => db.prepare('SELECT role, node, bytes FROM seat_presents WHERE round_id = ?').all(rid)
    .map((r) => ({ role: r.role, node: r.node, present: toHex(new Uint8Array(r.bytes)) }));
  const leftOutHex = (rid) => { try { return (leftOutOf(rid) || []).map((k) => String(k).toLowerCase()); } catch { return []; } };
  const mySignature = (rid, role) => {
    const r = db.prepare('SELECT seated, signature, justification FROM seat_signed WHERE round_id = ? AND role = ?').get(rid, role);
    if (!r) return null;
    const seated = JSON.parse(r.seated);
    // AND, FOR A 22 ROUND, WHO IT HELD A PRESENT OF (kanban #727)
    const id = toHex(seatingId({ roundId: rid, role, seated: seated.map(fromHex) }));
    const seen = db.prepare('SELECT present, left_out, signature FROM seat_seen WHERE round_id = ? AND role = ? AND seating = ? AND node = ?').get(rid, role, id, me);
    return { node: me, seated, signature: toHex(new Uint8Array(r.signature)),
      ...(seen ? { seen: { present: JSON.parse(seen.present), leftOut: JSON.parse(seen.left_out), signature: toHex(new Uint8Array(seen.signature)) } } : {}),
      // A SECOND SIGNATURE (a 22 round, kanban #738) carries why: an older seat reads past it
      ...(r.justification ? { justification: toHex(new Uint8Array(r.justification)) } : {}),
      // AND THE SLASH_PRESIGS OF ITS TEMPLATE-3 BONDS (5A.3B, kanban #972): one each, for this round whichever role asks
      ...presigsField(rid) };
  };
  // ---- THE SLASH_PRESIGS (5A.3B, kanban #972) ----
  const presigRows = (rid, node) => db.prepare('SELECT txid, vout, signature FROM seat_presigs WHERE round_id = ? AND node = ?').all(rid, node);
  const presigsField = (rid) => { const rows = presigRows(rid, me); return rows.length ? { presigs: rows.map((r) => ({ txid: r.txid, vout: Number(r.vout), signature: toHex(new Uint8Array(r.signature)) })) } : {}; };
  const keepPresig = (rid, node, txid, vout, signature) => db.prepare('INSERT OR IGNORE INTO seat_presigs (round_id, node, txid, vout, signature, kept_ms) VALUES (?, ?, ?, ?, ?, ?)').run(rid, node, txid, vout, signature, nowMs());
  /** What the round asks of `node`, [] for nothing; null when this seat cannot say yet. */
  const askedOf = (rid, contract, node) => {
    if (!holdsOf) return [];
    let got; try { got = holdsOf(rid, contract); } catch (e) { log(`[seating] ${toHex(rid).slice(0, 16)}: the round's holds cannot be read: ${e.message}`); return null; }
    return got && got.ok ? (got.plan.get(node) || []).map((b) => ({ ...b, panels: got.panels })) : null;
  };
  /** This node's own, signed once and kept before any door can hand them out. False when this seat cannot say what the round asks: then it signs no seating either. */
  function presignMine(rid, contract) {
    const asked = askedOf(rid, contract, me);
    if (!asked) return false;
    for (const b of asked) {
      if (presigRows(rid, me).some((r) => r.txid === b.txid && Number(r.vout) === b.vout)) continue;
      keepPresig(rid, me, b.txid, b.vout, signSlashPresig(b.digest, sign));
      // THE PANELS THIS NODE SIGNED A HOLD TO (5A.3B): only they rebuild it, and a start does not show them. Kept past the round's prune: this is how a node finds its way out of that hold
      if (b.panels && b.panels.n) db.prepare('INSERT OR IGNORE INTO own_hold_panels (txid, vout, script, panel_a, panel_b) VALUES (?, ?, ?, ?, ?)').run(b.txid, b.vout, toHex(b.hold.script),
        JSON.stringify(b.panels.panelA.map((e) => toHex(e.pubkey))), JSON.stringify(b.panels.panelB.map((e) => toHex(e.pubkey))));
    }
    return true;
  }
  /** A peer's, off the signature it came with: all of them verify or nothing of it is kept, and the signature with it is not counted. */
  function takePresigs(rid, contract, node, given) {
    const asked = askedOf(rid, contract, node);
    if (!asked) return false;
    const list = Array.isArray(given) ? given : [];
    const ok = asked.every((b) => {
      const p = list.find((x) => x && x.txid === b.txid && Number(x.vout) === b.vout);
      if (!p || typeof p.signature !== 'string') return false;
      let sig; try { sig = fromHex(p.signature); } catch { return false; }
      if (!slashPresigVerifies(sig, b.digest, fromHex(node), verify)) return false;
      p.bytes = sig;
      return true;
    });
    if (!ok) { log(`[seating] ${toHex(rid).slice(0, 16)}: ${node.slice(0, 8)}'s signature came without a good slash_presig for each of its ${asked.length} template-3 bond(s): not counted`); return false; }
    for (const b of asked) keepPresig(rid, node, b.txid, b.vout, list.find((x) => x.txid === b.txid && Number(x.vout) === b.vout).bytes);
    return true;
  }
  const certOf = (rid, role) => {
    const r = db.prepare('SELECT cert FROM seat_certs WHERE round_id = ? AND role = ?').get(rid, role);
    return r ? toHex(new Uint8Array(r.cert)) : null;
  };
  // WHAT A NODE CAN PRESENT TO THIS JUDGE (kanban #744): besides what the certificates carry, every signature kept here with the
  // justification it binds (kanban #746) - each one this node counted, and its own - so a chain that reached this node excuses its
  // signer, and a node's second signature over one seating, binding another hash, names it
  function presentedOf(rid, role) {
    const out = [];
    for (const r of db.prepare('SELECT node, seated, signature, justification FROM seat_sigs WHERE round_id = ? AND role = ? AND seated IS NOT NULL').all(rid, role)) {
      try {
        out.push({ nodePubkey: fromHex(r.node), seated: JSON.parse(r.seated).map(fromHex), signature: new Uint8Array(r.signature),
          justification: r.justification ? decodeJustification(new Uint8Array(r.justification)) : null });
      } catch { /* unread */ }
    }
    return out;
  }
  // WHO THE PROOF STANDS AGAINST (kanban #738, #744): judged again on the draw - a node that presents a chain of justified departures
  // between the two is excused, and the member each step names is proved against by its signature over that seating and the
  // certificate, unless it presents its own; a proof that names nobody is `unnamed`, a fault record only
  const equivocationOf = (rid) => db.prepare('SELECT role, a, b FROM seat_equivocations WHERE round_id = ?').all(rid).map((r) => {
    const out = { role: r.role, a: toHex(new Uint8Array(r.a)), b: toHex(new Uint8Array(r.b)) };
    try {
      const check = checkFor(rid, r.role);
      const e = check && !check.refused ? seatingEquivocation(new Uint8Array(r.a), new Uint8Array(r.b), check, presentedOf(rid, r.role)) : null;
      if (e && e.ok) Object.assign(out, { signers: e.signers.map(toHex), excused: e.excused.map(toHex), unnamed: e.unnamed,
        signedTwice: e.signedTwice.map((x) => ({ node: toHex(x.node), certificate: x.certificate, seated: x.seated.map(toHex), signature: toHex(x.signature),
          justificationHash: toHex(x.justificationHash) })),
        // ONE SEATING SIGNED TWICE, binding two hashes (kanban #746): named with no excuse
        doubleSigned: e.doubleSigned.map((d) => ({ node: toHex(d.node), seated: d.seated.map(toHex),
          signatures: d.signatures.map((x) => ({ signature: toHex(x.signature), justificationHash: toHex(x.justificationHash) })) })) });
    } catch { /* the pair alone */ }
    return out;
  });

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
          // a certificate stands here: a second one reaches this node by POST /seating, and is then the proof of equivocation
          if (certs.has(`${ridHex}:${role}`) && db.prepare('SELECT 1 FROM seat_certs WHERE round_id = ? AND role = ?').get(t.rid, role)) continue;
          const c = roster.committeeFor(t.rid, role);
          if (!c.ok) continue;
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
      for (const w of work) if (w.closed && !w.late) signMine(w);
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
      await Promise.all(work.flatMap((w) => (holds(w) ? [] : w.others.filter((b) => answers.get(b) === null && !rests(b)))
        .map(async (b) => { single.set(`${b}|${w.ridHex}|${w.role}`, await askOne(b, w)); })));
      lap('single');
      for (const w of work) {
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
        // A RESERVE TAKEN IN FOR A WITHHOLDING (OR SILENT) MEMBER (kanban #1509): not seated by its own seating, it signs the one every other member of it signed already
        if (w.closed && !w.late && !w.joins && !mySignature(w.t.rid, w.role)) { joinLate(w, sigs, { everyOther: true }); for (const s of sigs) keepSig(w, s); }
        if (w.closed && !w.late) {
          // A SEATING THAT CAN NEVER STAND (kanban #738): the PRESENTs the others held at the close are taken late, here only
          if (canNeverStand(w)) for (const a of said) { const once = new Set(); for (const x of a.presents || []) if (x.role === w.role) takePresent(fromHex(x.present), { afterClose: true, once }); }
          signMine(w); resign(w); await certify(w);
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
    if (!signSeatingOf(w, seated, held)) return;
    log(`[seating] ${w.ridHex.slice(0, 16)} ${w.role}: signed the seating of ${seated.length} (${held.length} present of ${w.drawnKeys.length} drawn)`);
  }
  /** This node's signature over `seated` (and, for a 22 round, its SEEN of `held`): the one seat_signed names, kept with the others'. */
  // A 22 SIGNATURE BINDS ITS JUSTIFICATION (kanban #746, RULED 2026-10-28): over the seating and the hash of `justification` (of the
  // empty string for a first signature). It is written here before any door can hand it out, and a seat restarted mid-draw hands
  // out the one written - signMine and resign never sign a seating this node signed already, so no seating gets a second one.
  function signSeatingOf(w, seated, held, justification = null) {
    const id = toHex(seatingId({ roundId: w.t.rid, role: w.role, seated }));
    if (db.prepare('SELECT 1 FROM seat_sigs WHERE round_id = ? AND role = ? AND seating = ? AND node = ?').get(w.t.rid, w.role, id, me)) {
      log(`[seating] ${w.ridHex.slice(0, 16)} ${w.role}: that seating is signed already - a member signs each seating of a draw once`);
      return false;
    }
    // WITH ITS SEATING SIGNATURE, ITS slash_presig (5A.3B, kanban #972), or neither
    if (!presignMine(w.t.rid, w.t.contract)) { log(`[seating] ${w.ridHex.slice(0, 16)} ${w.role}: not signed: the round's holds cannot be read yet`); return false; }
    const sig = seatingListsPresent(w.t.contract) ? signSeatingBound({ roundId: w.t.rid, role: w.role, seated }, sign, justification) : signSeating({ roundId: w.t.rid, role: w.role, seated }, sign);
    const list = seated.map(toHex);
    db.prepare('INSERT INTO seat_signed (round_id, role, seated, signature, justification) VALUES (?, ?, ?, ?, ?) ON CONFLICT (round_id, role) DO UPDATE SET seated = excluded.seated, signature = excluded.signature, justification = excluded.justification')
      .run(w.t.rid, w.role, JSON.stringify(list), sig, justification);
    rememberSeating(w.t.rid, w.role, id, list);
    signedAt.set(`${w.ridHex}:${w.role}`, nowMs());   // a withholder of this seating is counted from now (kanban #1509)
    db.prepare('INSERT OR IGNORE INTO seat_sigs (round_id, role, seating, node, signature, justification, seated) VALUES (?, ?, ?, ?, ?, ?, ?)').run(w.t.rid, w.role, id, me, sig, justification, JSON.stringify(list));
    // A 22 ROUND: WHO WAS PRESENT, signed with it (kanban #727) - every PRESENT held at the close (the table takes none after it, but
    // at a seat whose first seating can never stand, kanban #738), and the round's census's absent
    if (seatingListsPresent(w.t.contract)) {
      const present = [...new Set(held)].sort(), leftOut = [...new Set(leftOutHex(w.t.rid))].sort();
      const seenSig = signSeen({ roundId: w.t.rid, role: w.role, seating: fromHex(id), present, leftOut }, sign);
      db.prepare('INSERT OR IGNORE INTO seat_seen (round_id, role, seating, node, present, left_out, signature) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(w.t.rid, w.role, id, me, JSON.stringify(present), JSON.stringify(leftOut), seenSig);
    }
    return true;
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
  //
  // BUT A BYZANTINE MEMBER CAN COMPLETE S (kanban #738, RULED 2026-10-28: no rule may ever slash an honest seat): it signs T, the
  // honest seats leave S, then it signs S as well, and S and S' both complete with the honest seats in both. So in a 22 round the
  // second signature carries its justification - the member's signed T and the hash that signature binds - bound in the signature
  // itself (kanban #746), kept with every copy of it and carried in the certificate; a peer counts no second signature without one;
  // and a proof by two certificates does not stand against a node whose signatures bind a chain between them (seating.js
  // seatingEquivocation). The member is proved against by its two signatures, over T and over S.
  const rankOf = (w) => w.rank || (w.rank = new Map(w.drawnKeys.map((k, i) => [toHex(k), i])));
  /** Does seating `a` come before seating `b` (node keys hex, both in score order) in this round's draw? */
  const seatingBefore = (w, a, b) => comesBefore(rankOf(w), a, b);
  // A MEMBER THAT ANSWERS BUT NEVER SIGNS (kanban #1509, wf1489 r1 census-1): a drawn seat that hands out its PRESENT and answers every read, with its seating
  // signature always null, is never silent (#979) and signs no other seating (#738), so every honest seat waited for it until the start - no certificate, no
  // entries, one free seat voiding every round it was drawn into. Below protocol 22, a member of this node's seating of whom no signature over any seating is
  // held WITHHELD_SIG_MS after this node signed it withholds: the seating can never stand without it, and the seats move on to the seating of the PRESENTs held
  // less the withholders (resign), never below the threshold; the reserve it takes in signs once every other member did (joinLate everyOther). From protocol 22
  // a second signature must carry its justification, and the silent step (#1332) is that rule: nothing here.
  const signedAt = new Map();     // `${ridHex}:${role}` -> when this node signed its present seating (ms; first seen after a restart)
  function withholdersOf(w) {
    if (seatingListsPresent(w.t.contract)) return [];
    const signed = mySignature(w.t.rid, w.role);
    if (!signed) return [];
    const key = `${w.ridHex}:${w.role}`;
    if (!signedAt.has(key)) signedAt.set(key, nowMs());
    if (nowMs() < signedAt.get(key) + WITHHELD_SIG_MS) return [];
    // ONLY A SEATING BEFORE THIS ONE IS NO SIGNATURE (kanban #1609, wf1489 r4 gossip-1): a member that hands out a valid signature over a smaller seating
    // that comes before this node's in #738's order - the first 5 drawn, itself among them - was not a withholder here and set off no re-sign either (a
    // seating before ours is the one #738 expects it to leave), so it never moved and the round stood uncertified to its start, the #1509 effect again. A
    // member counts as signing only by a signature over this node's seating or over one not before it; one known to come before it, WITHHELD_SIG_MS on,
    // withholds. A seating not remembered here (after a restart) still counts, as before.
    const id = toHex(seatingId({ roundId: w.t.rid, role: w.role, seated: signed.seated.map(fromHex) }));
    const signs = (k) => db.prepare('SELECT seating FROM seat_sigs WHERE round_id = ? AND role = ? AND node = ?').all(w.t.rid, w.role, k).some((r) => {
      if (r.seating === id) return true;
      const other = seatings.get(`${w.ridHex}:${w.role}:${r.seating}`);
      return !other || !seatingBefore(w, other, signed.seated);
    });
    return signed.seated.filter((k) => k !== me && !signs(k));
  }
  /** The member of this node's seating that signed a seating not before it, and that seating's id (kanban #738), or null while it may still stand. */
  function canNeverStand(w) {
    if (db.prepare('SELECT 1 FROM seat_certs WHERE round_id = ? AND role = ?').get(w.t.rid, w.role)) return null;
    const signed = mySignature(w.t.rid, w.role);
    if (!signed) return null;
    const id = toHex(seatingId({ roundId: w.t.rid, role: w.role, seated: signed.seated.map(fromHex) }));
    for (const r of db.prepare('SELECT node, seating FROM seat_sigs WHERE round_id = ? AND role = ? AND seating != ? AND node != ?').all(w.t.rid, w.role, id, me)) {
      if (!signed.seated.includes(r.node)) continue;
      const other = seatings.get(`${w.ridHex}:${w.role}:${r.seating}`);
      if (other && !seatingBefore(w, other, signed.seated)) return { node: r.node, seating: r.seating, seated: other };
    }
    // A SILENT MEMBER (§5A.7 RULED 2026-11-07, kanban #1314/#1332): a member of this node's seating that signed nothing for it by seating_close + Δ
    // (20 s) does not hold the round - in a 22 round, where this node's own signed SEEN of that seating attests the member was present
    let close = null; try { close = Number(seatingCloseMs(w.t.contract)); } catch { close = null; }
    if (seatingListsPresent(w.t.contract) && signed.seen && Number.isFinite(close) && nowMs() >= close + SILENT_AFTER_MS) {
      const silent = signed.seated.filter((k) => k !== me && !db.prepare('SELECT 1 FROM seat_sigs WHERE round_id = ? AND role = ? AND seating = ? AND node = ?').get(w.t.rid, w.role, id, k)
        && (signed.seen.present || []).includes(k));
      if (silent.length) return { node: silent[0], silent, seating: id, seated: signed.seated };
    }
    // A MEMBER THAT WITHHOLDS ITS SIGNATURE (kanban #1509), below protocol 22
    const withheld = withholdersOf(w);
    return withheld.length ? { node: withheld[0], withheld, seating: id, seated: signed.seated } : null;
  }
  /** This node's second seating, when its first can never stand (kanban #738): the rule above. */
  function resign(w) {
    if (w.t.checkIn) return;      // a check-in that does not meet leaves the table as it is, and the next one tries again (kanban #1020)
    const never = canNeverStand(w);
    if (!never) return;
    const member = never.node;
    const signed = mySignature(w.t.rid, w.role);
    const held = db.prepare('SELECT node FROM seat_presents WHERE round_id = ? AND role = ?').all(w.t.rid, w.role).map((r) => r.node);
    if (never.silent) return resignPastSilent(w, signed, held, never);
    if (never.withheld) return resignPastWithheld(w, signed, held, never);
    // THE SEATING TO GO TO (kanban #1119, measured on the live seats' stores for Up/Down b3f22953, 2026-11-04 10:28Z): six seats signed the seating of the
    // PRESENTs held less the dead node b36828 (#979); seat 438af56f had also failed to reach c6d5d34b and signed without both. Its re-sign took the seating of
    // all the PRESENTs it held - the dead node in again - which nobody signed, so it never moved and no certificate formed. Now the seating of the PRESENTs
    // held is one candidate, and every seating another node signed whose seated this node holds PRESENTs of is another; each must meet the rule as before
    // (it comes after this node's seating, seats this node, another node signed it), and of those the one most nodes signed is taken, by id on a tie.
    const heldSet = new Set(held);
    const candidates = new Map();      // seating id -> seated (hex, score order)
    const own = seatedFrom({ drawn: w.drawnKeys, present: held, slots: w.slots }).map(toHex);
    candidates.set(toHex(seatingId({ roundId: w.t.rid, role: w.role, seated: own.map(fromHex) })), own);
    for (const r of db.prepare('SELECT DISTINCT seating FROM seat_sigs WHERE round_id = ? AND role = ? AND node != ?').all(w.t.rid, w.role, me)) {
      const other = seatings.get(`${w.ridHex}:${w.role}:${r.seating}`);
      if (other && other.every((k) => heldSet.has(k))) candidates.set(r.seating, other);
    }
    let best = null;
    for (const [id, list] of candidates) {
      if (!list.includes(me) || !seatingBefore(w, signed.seated, list)) continue;
      const n = db.prepare('SELECT COUNT(*) AS n FROM seat_sigs WHERE round_id = ? AND role = ? AND seating = ? AND node != ?').get(w.t.rid, w.role, id, me).n;
      if (!n) continue;
      if (!best || n > best.n || (n === best.n && id < best.id)) best = { id, list, n };
    }
    if (!best) return;
    const list = best.list;
    const seated = list.map(fromHex);
    // A 22 ROUND: THE SECOND SIGNATURE CARRIES WHY (kanban #738, RULED 2026-10-28) - the member's signed seating that does not come
    // before the first, and the hash the member's signature binds (kanban #746: the member's own reasons are its own to present);
    // no justification, no second signature. AND THE STEPS BEFORE (kanban #744): when its signature over the seating it leaves was
    // itself a second one, that signature and the justification it binds ride along, so this node's whole chain of departures is
    // in its last signature, and the signature binds it. More than JUSTIFICATION_DEPTH steps in all: it signs nothing.
    let justification = null;
    if (seatingListsPresent(w.t.contract)) {
      const row = db.prepare('SELECT signature, justification FROM seat_sigs WHERE round_id = ? AND role = ? AND seating = ? AND node = ?').get(w.t.rid, w.role, never.seating, member);
      if (!row) return;
      const of = signed.seated.map(fromHex);
      let before = null;
      try { before = signed.justification ? decodeJustification(fromHex(signed.justification)) : null; } catch { return; }
      const j = { of, seated: never.seated.map(fromHex), member: fromHex(member), signature: new Uint8Array(row.signature),
        bound: justificationHash(row.justification ? new Uint8Array(row.justification) : null),
        ...(before ? { prior: { signature: fromHex(signed.signature), justification: before } } : {}) };
      if (justificationSteps(j) > JUSTIFICATION_DEPTH) {
        log(`[seating] ${w.ridHex.slice(0, 16)} ${w.role}: no second signature - its justification would carry ${justificationSteps(j)} steps, more than ${JUSTIFICATION_DEPTH}`);
        return;
      }
      justification = encodeJustification(j);
    }
    if (!signSeatingOf(w, seated, held, justification)) return;
    log(`[seating] ${w.ridHex.slice(0, 16)} ${w.role}: re-signed the seating of ${list.length} (member ${member.slice(0, 8)} signed another; the seating of ${signed.seated.length} can never stand)`);
  }

  /**
   * PAST A SILENT MEMBER (kanban #1332): the seating of the PRESENTs this node holds, less the members that signed nothing for its seating by
   * seating_close + Δ - it counts as coming after the seating left (§5A.7), so no other node need have signed it first: every honest signer
   * computes the same one. Its justification is the silent step: this node's own signed SEEN of the seating left, which holds the member present.
   */
  function resignPastSilent(w, signed, held, never) {
    const gone = new Set(never.silent);
    const list = seatedFrom({ drawn: w.drawnKeys, present: held.filter((k) => !gone.has(k)), slots: w.slots }).map(toHex);
    if (!list.includes(me) || list.some((k) => gone.has(k)) || list.join(',') === signed.seated.join(',')) return;
    let before = null;
    try { before = signed.justification ? decodeJustification(fromHex(signed.justification)) : null; } catch { return; }
    const j = { silent: true, of: signed.seated.map(fromHex), present: signed.seen.present.map(fromHex), leftOut: (signed.seen.leftOut || []).map(fromHex),
      member: fromHex(never.node), signature: fromHex(signed.seen.signature),
      ...(before ? { prior: { signature: fromHex(signed.signature), justification: before } } : {}) };
    if (justificationSteps(j) > JUSTIFICATION_DEPTH) { log(`[seating] ${w.ridHex.slice(0, 16)} ${w.role}: no second signature - its justification would carry ${justificationSteps(j)} steps`); return; }
    if (!signSeatingOf(w, list.map(fromHex), held, encodeJustification(j))) return;
    log(`[seating] ${w.ridHex.slice(0, 16)} ${w.role}: re-signed the seating of ${list.length} past ${never.silent.length} silent member(s) ${never.silent.map((k) => k.slice(0, 8)).join(', ')} (nothing signed by close + ${SILENT_AFTER_MS / 1000} s)`);
  }

  /**
   * PAST A WITHHOLDING MEMBER (kanban #1509, below protocol 22): members that withhold their signature are left out of every candidate - the seating of the
   * PRESENTs held less them, or one another node signed that leaves them out - never below the threshold. Leaving a member out does not come after this
   * node's seating in #738's order and nobody may have signed it yet, so #738's two checks are not asked of it: the withholder signed nothing, so no seating
   * of it can stand that an honest member left.
   */
  function resignPastWithheld(w, signed, held, never) {
    const withheld = new Set(never.withheld);
    const heldSet = new Set(held);
    const less = held.filter((k) => !withheld.has(k));
    if (less.length < receiptsNeeded(w.slots)) return;
    let best = null;
    const own = seatedFrom({ drawn: w.drawnKeys, present: less, slots: w.slots }).map(toHex);
    const pick = new Map([[toHex(seatingId({ roundId: w.t.rid, role: w.role, seated: own.map(fromHex) })), own]]);
    for (const r of db.prepare('SELECT DISTINCT seating FROM seat_sigs WHERE round_id = ? AND role = ? AND node != ?').all(w.t.rid, w.role, me)) {
      const other = seatings.get(`${w.ridHex}:${w.role}:${r.seating}`);
      if (other && other.every((k) => heldSet.has(k))) pick.set(r.seating, other);
    }
    for (const [id, list] of pick) {
      if (!list.includes(me) || list.some((k) => withheld.has(k)) || list.length < receiptsNeeded(w.slots) || list.join(',') === signed.seated.join(',')) continue;
      const n = db.prepare('SELECT COUNT(*) AS n FROM seat_sigs WHERE round_id = ? AND role = ? AND seating = ? AND node != ?').get(w.t.rid, w.role, id, me).n;
      if (!best || n > best.n || (n === best.n && id < best.id)) best = { id, list, n };
    }
    if (!best) return;
    // the members left out are kept by name: a certificate seating any of them is refused here from now on (kanban #1707)
    for (const k of withheld) db.prepare('INSERT OR IGNORE INTO seat_withheld (round_id, role, node) VALUES (?, ?, ?)').run(w.t.rid, w.role, k);
    if (!signSeatingOf(w, best.list.map(fromHex), held)) return;
    log(`[seating] ${w.ridHex.slice(0, 16)} ${w.role}: re-signed the seating of ${best.list.length} (member(s) ${[...withheld].map((k) => k.slice(0, 8)).join(', ')} signed nothing in ${WITHHELD_SIG_MS / 1000} s)`);
  }

  /**
   * A TABLE'S FIRST ROUND JOINED LATE (kanban #803): this node, not yet signed and with no certificate here, signs the seating another
   * seated member signed - one that seats this node, all of whose members' PRESENTs this node holds - and no other. It adds no seating
   * of its own, and it is this node's one signature, so the rule of the ordered seatings (#738) holds as before.
   */
  // everyOther (kanban #1509): a reserve taken in for a withholding or silent member, on a round not yet started, joins only a seating every other member of it
  // signed - its signature completes the certificate, and no single node can spend it on a seating the others did not move to
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
      // A 22 SIGNATURE BINDS ITS JUSTIFICATION (kanban #746): read over the seating and the hash of the one it carries (keepSig checks the justification itself)
      let good = false;
      try {
        const signedId = seatingListsPresent(w.t.contract) ? seatingSignedId({ roundId: w.t.rid, role: w.role, seated: list.map(fromHex) }, justificationHash(g.justification ? fromHex(String(g.justification)) : null)) : fromHex(id);
        good = verify(fromHex(g.signature), signedId, fromHex(node));
      } catch { good = false; }
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
    // A 22 ROUND: A SECOND SIGNATURE'S JUSTIFICATION (kanban #738, RULED 2026-10-28) is checked before anything of it is kept - a
    // forged one (not signed by a member of the seating left, or a seating that comes before it) refuses the signature with it, and
    // the signature must bind it (kanban #746: one attached after the signing is refused with it). Below 22 a signature carries
    // none, and one carried is not read.
    const listsPresent = seatingListsPresent(w.t.contract);
    let justification = null, leftIds = [];
    if (listsPresent && got.justification) {
      let j; try { j = decodeJustification(fromHex(String(got.justification))); } catch { return; }
      if (!verifyJustification(j, { roundId: w.t.rid, role: w.role, drawn: w.drawnKeys, slots: w.slots, verify, signer: fromHex(node), onto: list.map(fromHex) }).ok) return;
      justification = fromHex(String(got.justification));
      leftIds = leftOf(w, j);
    }
    rememberSeating(w.t.rid, w.role, id, list);
    // its SEEN is kept once it is over this node's seating: a seat that signs that one too reads it on the next tick
    if (mine) keepSeen(w, id, { ...got, node });
    if (db.prepare('SELECT 1 FROM seat_sigs WHERE round_id = ? AND role = ? AND seating = ? AND node = ?').get(w.t.rid, w.role, id, node)) return;   // held already
    // a node's signatures over other seatings, a few at most: an honest one signs one, or two (kanban #738)
    // (kanban #744: one for each step of its chain, at most JUSTIFICATION_DEPTH + 1)
    if (!mine && db.prepare('SELECT COUNT(*) AS n FROM seat_sigs WHERE round_id = ? AND role = ? AND node = ?').get(w.t.rid, w.role, node).n > JUSTIFICATION_DEPTH) return;
    // A 22 ROUND: A SIGNATURE OVER ANOTHER SEATING THAN ONE OF THE NODE'S HELD HERE counts only justified - it left one held for
    // this, or one held left this for it (signatures arrive in any order); an unjustified second signature is not counted
    if (listsPresent) {
      const others = db.prepare('SELECT seating, justification FROM seat_sigs WHERE round_id = ? AND role = ? AND node = ? AND seating != ?').all(w.t.rid, w.role, node, id);
      // (kanban #744: anywhere on its chain - a node that signed S, S2 and T may reach this one with T before S2)
      const left = (o) => { try { return o.justification ? leftOf(w, decodeJustification(new Uint8Array(o.justification))) : []; } catch { return []; } };
      if (others.length && !others.some((o) => leftIds.includes(o.seating) || left(o).includes(id))) return;
    }
    const signedId = listsPresent ? seatingSignedId({ roundId: w.t.rid, role: w.role, seated: list.map(fromHex) }, justificationHash(justification)) : fromHex(id);
    let good = false; try { good = verify(fromHex(got.signature), signedId, fromHex(node)); } catch { good = false; }
    if (good) good = takePresigs(w.t.rid, w.t.contract, node, got.presigs);
    if (good) db.prepare('INSERT OR IGNORE INTO seat_sigs (round_id, role, seating, node, signature, justification, seated) VALUES (?, ?, ?, ?, ?, ?, ?)').run(w.t.rid, w.role, id, node, fromHex(got.signature), justification, JSON.stringify(list));
  }
  /** The ids of the seatings a justification's chain leaves (kanban #744): its own, then the signer's steps before. */
  function leftOf(w, j) { return justificationChain(j).map((s) => toHex(seatingId({ roundId: w.t.rid, role: w.role, seated: s.of }))); }
  /** A seated node's SEEN over the seating this node signed (a 22 round), kept when it verifies. */
  function keepSeen(w, id, got) {
    if (!seatingListsPresent(w.t.contract) || !got.seen || !Array.isArray(got.seen.present) || !Array.isArray(got.seen.leftOut) || !got.seen.signature) return;
    if (db.prepare('SELECT 1 FROM seat_seen WHERE round_id = ? AND role = ? AND seating = ? AND node = ?').get(w.t.rid, w.role, id, got.node)) return;
    let present, leftOut;
    try { present = [...new Set(got.seen.present.map((k) => String(k).toLowerCase()))].sort(); leftOut = [...new Set(got.seen.leftOut.map((k) => String(k).toLowerCase()))].sort(); } catch { return; }
    if (present.length > 4096 || leftOut.length > 4096 || ![...present, ...leftOut].every((k) => /^[0-9a-f]{64}$/.test(k))) return;
    let good = false;
    try { good = verify(fromHex(got.seen.signature), seenId({ roundId: w.t.rid, role: w.role, seating: fromHex(id), present, leftOut }), fromHex(got.node)); } catch { good = false; }
    if (good) db.prepare('INSERT OR IGNORE INTO seat_seen (round_id, role, seating, node, present, left_out, signature) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(w.t.rid, w.role, id, got.node, JSON.stringify(present), JSON.stringify(leftOut), fromHex(got.seen.signature));
  }

  /** With every seated node's signature: the certificate, kept and handed to every other drawn node. */
  async function certify(w) {
    if (db.prepare('SELECT 1 FROM seat_certs WHERE round_id = ? AND role = ?').get(w.t.rid, w.role)) return;
    const signed = mySignature(w.t.rid, w.role);
    if (!signed) return;
    const list = signed.seated.map(fromHex);
    const id = toHex(seatingId({ roundId: w.t.rid, role: w.role, seated: list }));
    const sigs = db.prepare('SELECT node, signature, justification FROM seat_sigs WHERE round_id = ? AND role = ? AND seating = ?').all(w.t.rid, w.role, id);
    if (!signed.seated.every((k) => sigs.some((x) => x.node === k))) return;
    // A 22 ROUND'S CERTIFICATE CARRIES EVERY SEATED NODE'S SEEN (kanban #727): not made before each is held
    let seen = null;
    if (seatingListsPresent(w.t.contract)) {
      const rows = db.prepare('SELECT node, present, left_out, signature FROM seat_seen WHERE round_id = ? AND role = ? AND seating = ?').all(w.t.rid, w.role, id)
        .filter((x) => signed.seated.includes(x.node));
      if (!signed.seated.every((k) => rows.some((x) => x.node === k))) return;
      const groups = new Map();
      for (const x of rows) {
        const key = `${x.present}|${x.left_out}`;
        if (!groups.has(key)) groups.set(key, { present: JSON.parse(x.present).map(fromHex), leftOut: JSON.parse(x.left_out).map(fromHex), signatures: [] });
        groups.get(key).signatures.push({ nodePubkey: fromHex(x.node), signature: new Uint8Array(x.signature) });
      }
      seen = [...groups.values()];
    }
    // AND, A 22 ROUND, THE JUSTIFICATION OF EVERY SECOND SIGNATURE IN IT (kanban #738): what clears its signer of a proof by two seatings
    const justifications = seen ? sigs.filter((x) => x.justification && signed.seated.includes(x.node))
      .map((x) => ({ nodePubkey: fromHex(x.node), justification: decodeJustification(new Uint8Array(x.justification)) })) : null;
    // AND THE slash_presig OF EVERY TEMPLATE-3 BOND IT SEATS (kanban #972): the signatures above were counted only with theirs
    const presigs = [];
    for (const k of signed.seated) {
      const asked = askedOf(w.t.rid, w.t.contract, k);
      if (!asked) return;
      const rows = asked.length ? presigRows(w.t.rid, k) : [];
      for (const b of asked) {
        const r = rows.find((x) => x.txid === b.txid && Number(x.vout) === b.vout);
        if (!r) return;
        presigs.push({ nodePubkey: fromHex(k), txid: fromHex(r.txid), vout: Number(r.vout), signature: new Uint8Array(r.signature) });
      }
    }
    const cert = encodeSeatingCertificate({ roundId: w.t.rid, role: w.role, seated: list, seen, justifications, presigs,
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
    settled: () => asking || Promise.resolve(),
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
    /** A bond's slash_presig (5A.3B, kanban #972): the round's, or with no round its newest held here, for "an offence with no round". */
    presigOf: ({ rid = null, txid, vout }) => {
      const r = rid ? db.prepare('SELECT round_id, node, signature, kept_ms FROM seat_presigs WHERE round_id = ? AND txid = ? AND vout = ?').get(seatOf(rid), txid, vout)
        ?? db.prepare('SELECT round_id, node, signature, kept_ms FROM seat_presigs WHERE round_id = ? AND txid = ? AND vout = ?').get(rid, txid, vout)
        : db.prepare('SELECT round_id, node, signature, kept_ms FROM seat_presigs WHERE txid = ? AND vout = ? ORDER BY kept_ms DESC LIMIT 1').get(txid, vout);
      return r ? { round: toHex(new Uint8Array(r.round_id)), node: r.node, txid, vout, signature: toHex(new Uint8Array(r.signature)) } : null;
    },
    /** The panels of every hold this node signed for one bond: [{ a, b }] of key bytes. `txid` as the census' bytes, hex. */
    ownHoldPanels: ({ txid, vout }) => db.prepare('SELECT panel_a, panel_b FROM own_hold_panels WHERE txid = ? AND vout = ?').all(txid, vout)
      .map((r) => ({ a: JSON.parse(r.panel_a).map(fromHex), b: JSON.parse(r.panel_b).map(fromHex) })),
    takePresent, presentsOf, mySignature, certOf: (rid, role, at = rid) => certOf(seatRoundOf(at, role), role), keepCert, equivocationOf, takePresents, batchOf,
    /** The round whose certificate seats `rid`: itself, its table's first, or a later check-in (kanban #1020). */
    seatRoundOf: (rid, role = 'settlement') => seatRoundOf(rid, role),
    /** The table round a door's certificate is on, and its index (kanban #1020): 0 for the table's first. */
    certRoundOf: (at, role) => { const r = toHex(seatRoundOf(at, role)); const e = (reseats.get(`${toHex(seatOf(at))}:${role}`) || []).find((x) => toHex(x.rid) === r); return e ? e.index : 0; },
    /** A round deleted from the store (transcript-prune.js, unused and past its windows): its certificates leave memory too. */
    forget: (ridHex) => { for (const role of SEATING_ROLES) certs.delete(`${ridHex}:${role}`); },
  };
}
