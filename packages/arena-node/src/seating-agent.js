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
//                                         kept as the proof (GET /seating-equivocation), and the round takes no entries
//
// The roster asks `seatedFor` and seats the certificate's nodes; before one stands, the draw's first slots (Roster).
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { decodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { slotsForRole } from '../../arena-protocol/src/sortition.js';
import { signPresent, verifyPresent, decodePresent, seatedFrom, signSeating, seatingId, encodeSeatingCertificate, verifySeating,
  seatingEquivocation, seatingCloseMs, decodeSeatingCertificate, SEATING_ROLES } from '../../arena-protocol/src/seating.js';
import { endpointsOf } from './roster.js';
import { tableAnchorOf } from '../../arena-protocol/src/known-game.js';

/** How far ahead of its start a round is looked at: PRESENT is signed in the last minute before seating_close. */
export const PRESENT_WINDOW_MS = 60000n;
/** A PRESENT's length: type, version, round id, role, node key, signature (seating.js presentBody + 64). */
export const PRESENT_BYTES = 1 + 2 + 32 + 1 + 32 + 64;
/** At most this many rounds in one GET /seating-batch. */
export const BATCH_ROUNDS = 64;
/** How long a node that runs no seating (its seating door: 404 "no such door") is left out of the exchange (kanban #791). */
export const NO_SEATING_REST_MS = Number(process.env.ARENA_NO_SEATING_REST_MS || 600000);
/** A node that did not answer at all rests this long, doubled on each failure after, up to NO_SEATING_REST_MS (kanban #791). */
export const UNREACHABLE_REST_MS = Number(process.env.ARENA_UNREACHABLE_REST_MS || 30000);
/** How long after its start a table's first round without a certificate is still read, and joined late (kanban #803): its table plays all day. */
export const TABLE_LATE_MS = BigInt(process.env.ARENA_TABLE_LATE_MS || 24 * 3600000);
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
    CREATE TABLE IF NOT EXISTS seat_equivocations (round_id BLOB NOT NULL, role TEXT NOT NULL, a BLOB NOT NULL, b BLOB NOT NULL,
      PRIMARY KEY (round_id, role));
  `);
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

  // THE CHECK OF A CERTIFICATE, against this node's own draw for the round
  const checkFor = (rid, role) => {
    // A TABLE'S FIRST ROUND THIS SEAT NEVER WROTE (kanban #604: the 10-24 series reached the test host seats at 00:12Z, after their
    // tables' round 0 had started, so no certificate could be checked and they answered the unseated draw): `contractOf` builds it
    // from a series this seat holds, and it is drawn as a posted contract
    const row = round.get(rid);
    const posted = row ? null : contractOf(rid);
    if (!row && !posted) return null;
    const c = roster.committeeFor(rid, role, posted ? { posted } : {});
    if (!c.ok) return { refused: c.why };
    const contract = row ? decodeRoundContract(new Uint8Array(row.contract)) : posted;
    return { roundId: rid, role, drawn: c.drawn.map((e) => e.pubkey), slots: slotsForRole(contract, role), verify };
  };
  const keepCert = (rid, role, bytes) => {
    // ONE HELD ALREADY, byte for byte, is not checked again (2026-10-12 "figure out why CPU usage so high and
    // optimise it": every batch answer repeats a round's certificate, and each was verified - all its signatures - before the
    // seat looked whether it held exactly these bytes)
    const held = db.prepare('SELECT cert FROM seat_certs WHERE round_id = ? AND role = ?').get(rid, role);
    if (held && Buffer.compare(Buffer.from(held.cert), Buffer.from(bytes)) === 0) return { ok: true, kept: false };
    const check = checkFor(rid, role);
    if (!check || check.refused) return { ok: false, why: `this node cannot draw that round yet${check ? `: ${check.refused}` : ''}` };
    const v = verifySeating(bytes, check);
    if (!v.ok) return v;
    const key = `${toHex(rid)}:${role}`;
    const had = db.prepare('SELECT cert FROM seat_certs WHERE round_id = ? AND role = ?').get(rid, role);
    if (had) {
      const old = new Uint8Array(had.cert);
      if (toHex(old) === toHex(bytes)) return { ok: true, kept: false };
      const e = seatingEquivocation(old, bytes, check);
      if (!e.ok) return { ok: false, why: e.why };
      db.prepare('INSERT OR IGNORE INTO seat_equivocations (round_id, role, a, b) VALUES (?, ?, ?, ?)').run(rid, role, old, bytes);
      certs.set(key, null);
      log(`[seating] ${toHex(rid).slice(0, 16)} ${role}: two seatings - equivocation by ${e.signers.map((k) => toHex(k).slice(0, 8)).join(', ')}; the round takes no entries`);
      return { ok: true, equivocation: true, signers: e.signers.map(toHex) };
    }
    db.prepare('INSERT OR IGNORE INTO seat_certs (round_id, role, cert) VALUES (?, ?, ?)').run(rid, role, bytes);
    if (!certs.has(key) || certs.get(key) !== null) certs.set(key, v.seating.seated.map(toHex));
    // the seats a v2 round counts are these (2026.0.2): the server writes them into the stored contract
    try { onSeated(rid, role, v.seating.seated); } catch (e) { log(`[seating] ${toHex(rid).slice(0, 16)} ${role}: ${e.message}`); }
    return { ok: true, kept: true };
  };

  // ROUNDS BY START TIME, read once each (the seats hold thousands)
  const starts = new Map();      // rid hex -> { rid, start: bigint, close: bigint }
  const unwritten = new Map();   // anchor hex -> { rid, askedMs }: tables whose round 0 this seat does not hold (or holds uncertified)
  const heldChecked = new Set(); // anchor hex: a held round 0 already looked at for its certificates
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
  const unreachable = (base) => { const n = (failing.get(base) || 0) + 1; failing.set(base, n);
    resting.set(base, nowMs() + Math.min(UNREACHABLE_REST_MS * 2 ** Math.min(n - 1, 10), NO_SEATING_REST_MS)); };
  const reached = (base) => { if (failing.delete(base)) resting.delete(base); };
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
  function takePresent(bytes, { afterClose = false } = {}) {
    // ONE HELD ALREADY, byte for byte, is not checked again (every batch answer repeats a round's PRESENTs,
    // and verifying each at each tick was thousands of signature checks per tick at grid density)
    try {
      const d = decodePresent(bytes);
      const had = db.prepare('SELECT bytes FROM seat_presents WHERE round_id = ? AND role = ? AND node = ?').get(d.roundId, d.role, toHex(d.nodePubkey));
      if (had && Buffer.compare(Buffer.from(had.bytes), Buffer.from(bytes)) === 0) return { ok: true, held: true };
      // A ROUND WHOSE SEATING HAS CLOSED takes no PRESENT, and is refused before the signature is checked (kanban #587, measured
      // 2026-10-23 13:2xZ: seat 7 spent 41 % of a core on verifyPresent while idle - PRESENTs of closed rounds, refused after the
      // check and so never kept, checked again on every tick from every peer that sent them)
      const t = starts.get(toHex(d.roundId));
      if (t && !afterClose && BigInt(nowMs()) >= t.close) return { ok: false, why: 'that round\'s seating has closed' };
    } catch { /* not decodable: verifyPresent says why */ }
    const v = verifyPresent(bytes, { verify });
    if (!v.ok) return v;
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
  async function tick() {
    if (busy) return;
    busy = true;
    const t0 = Date.now(); let fellBack = 0, peers = 0, rounds = 0;
    // WHERE A LONG TICK WENT (kanban #803: test host seat 7 ran ticks of 60-99 s with every node answering): each phase's time, logged with it
    const took = { unwritten: 0, presents: 0, reads: 0, single: 0, 'take+certify': 0 };
    let mark = Date.now(); const lap = (k) => { const n = Date.now(); took[k] += n - mark; mark = n; };
    try {
      index();
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
          work.push({ t, ridHex, role, c, drawnKeys, amDrawn: drawnKeys.some((k) => toHex(k) === me), others: endpointsOf(c.drawn, round.pubkey, endpointOf),
            slots: slotsForRole(t.contract, role), closed: now >= t.close, late, joins });
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
      const asks = new Map();
      for (const w of work) { if (holds(w)) continue; for (const b of w.others) if (!rests(b)) (asks.get(b) || asks.set(b, new Set()).get(b)).add(w.ridHex); }
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
          if (!w.late) for (const x of a.presents || []) if (x.role === w.role) takePresent(fromHex(x.present));
          const cert = a.cert && a.cert[w.role];
          if (cert) keepCert(w.t.rid, w.role, fromHex(cert));
          const sig = a.sig && a.sig[w.role];
          if (sig && w.closed && !w.late) keepSig(w, sig);
          else if (sig && w.joins) sigs.push(sig);
        }
        if (w.joins && w.closed) { joinLate(w, sigs); for (const s of sigs) keepSig(w, s); await certify(w); }
        if (w.closed && !w.late) {
          // A SEATING THAT CAN NEVER STAND (kanban #738): the PRESENTs the others held at the close are taken late, here only
          if (canNeverStand(w)) for (const a of said) for (const x of a.presents || []) if (x.role === w.role) takePresent(fromHex(x.present), { afterClose: true });
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

  /** At seating_close: the seated from the PRESENTs held, and this node's signature over that seating - once, if seated. */
  function signMine(w) {
    if (db.prepare('SELECT 1 FROM seat_certs WHERE round_id = ? AND role = ?').get(w.t.rid, w.role)) return;
    if (mySignature(w.t.rid, w.role)) return;
    const held = db.prepare('SELECT node FROM seat_presents WHERE round_id = ? AND role = ?').all(w.t.rid, w.role).map((r) => r.node);
    const seated = seatedFrom({ drawn: w.drawnKeys, present: held, slots: w.slots });
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
  /** Does seating `a` come before seating `b` (node keys hex, both in score order) in this round's draw? */
  function seatingBefore(w, a, b) {
    if (a.join(',') === b.join(',') || b.length < a.length) return false;
    const r = rankOf(w);
    return a.every((k, i) => r.has(k) && r.has(b[i]) && r.get(b[i]) <= r.get(k));
  }
  /** The member of this node's seating that signed a seating not before it (kanban #738), or null while the seating may still stand. */
  function canNeverStand(w) {
    if (db.prepare('SELECT 1 FROM seat_certs WHERE round_id = ? AND role = ?').get(w.t.rid, w.role)) return null;
    const signed = mySignature(w.t.rid, w.role);
    if (!signed) return null;
    const id = toHex(seatingId({ roundId: w.t.rid, role: w.role, seated: signed.seated.map(fromHex) }));
    for (const r of db.prepare('SELECT node, seating FROM seat_sigs WHERE round_id = ? AND role = ? AND seating != ? AND node != ?').all(w.t.rid, w.role, id, me)) {
      if (!signed.seated.includes(r.node)) continue;
      const other = seatings.get(`${w.ridHex}:${w.role}:${r.seating}`);
      if (other && !seatingBefore(w, other, signed.seated)) return r.node;
    }
    return null;
  }
  /** This node's second seating, when its first can never stand (kanban #738): the rule above. */
  function resign(w) {
    const member = canNeverStand(w);
    if (!member) return;
    const signed = mySignature(w.t.rid, w.role);
    const held = db.prepare('SELECT node FROM seat_presents WHERE round_id = ? AND role = ?').all(w.t.rid, w.role).map((r) => r.node);
    const seated = seatedFrom({ drawn: w.drawnKeys, present: held, slots: w.slots });
    const list = seated.map(toHex);
    if (!list.includes(me) || !seatingBefore(w, signed.seated, list)) return;
    const id = toHex(seatingId({ roundId: w.t.rid, role: w.role, seated }));
    if (!db.prepare('SELECT 1 FROM seat_sigs WHERE round_id = ? AND role = ? AND seating = ? AND node != ?').get(w.t.rid, w.role, id, me)) return;
    signSeatingOf(w, seated, held);
    log(`[seating] ${w.ridHex.slice(0, 16)} ${w.role}: re-signed the seating of ${list.length} (member ${member.slice(0, 8)} signed another; the seating of ${signed.seated.length} can never stand)`);
  }

  /**
   * A TABLE'S FIRST ROUND JOINED LATE (kanban #803): this node, not yet signed and with no certificate here, signs the seating another
   * seated member signed - one that seats this node, all of whose members' PRESENTs this node holds - and no other. It adds no seating
   * of its own, and it is this node's one signature, so the rule of the ordered seatings (#738) holds as before.
   */
  function joinLate(w, got) {
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
      const e = by.get(id) || by.set(id, { list, n: 0 }).get(id); e.n++;
    }
    const best = [...by.values()].sort((a, b) => b.n - a.n)[0];
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
      // HANDED TO EVERY OTHER DRAWN NODE, so each holds it - the reserves too - before an entry comes
      await Promise.all(w.others.map((b) => post(b, '/seating', cert)));
      log(`[seating] ${w.ridHex.slice(0, 16)} ${w.role}: certificate of ${list.length} seated, every one signed - handed to ${w.others.length}`);
    }
  }

  /** THE BATCH DOORS' SIDE. POST /presents: the PRESENTs of one body, each taken as POST /present takes it. */
  function takePresents(bytes) {
    if (!bytes.length || bytes.length % PRESENT_BYTES !== 0) return { ok: false, why: `a batch of PRESENTs is a whole number of ${PRESENT_BYTES}-byte PRESENTs` };
    let taken = 0; const refused = [];
    for (let i = 0; i < bytes.length; i += PRESENT_BYTES) { const r = takePresent(bytes.subarray(i, i + PRESENT_BYTES)); if (r.ok) taken++; else refused.push(r.why); }
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
    try { const row = round.get(rid); const a = row ? tableAnchorOf(decodeRoundContract(new Uint8Array(row.contract))) : null; if (a) to = a.anchorId; } catch { /* itself */ }
    anchors.set(h, to);
    if (anchors.size > 20000) anchors.delete(anchors.keys().next().value);
    return to;
  };
  return {
    tick,
    /** The certificate pass running beside the tick, if one is (kanban #803): for a caller that needs it finished. */
    settled: () => asking || Promise.resolve(),
    /** For the roster: who the certificate seats (node keys hex), or null while none stands or after equivocation. */
    seatedFor: (rid, role) => { const s = certs.get(`${toHex(seatOf(rid))}:${role}`); return s || null; },
    /** A round's seating, for the doors, the lobby and the entry gate. */
    stateOf: (rid) => {
      const out = {};
      for (const role of SEATING_ROLES) {
        const key = `${toHex(seatOf(rid))}:${role}`;
        out[role] = certs.has(key) && certs.get(key) === null ? { equivocated: true } : certs.get(key) ? { seated: certs.get(key) } : null;
      }
      return out;
    },
    // WHETHER THIS NODE'S OWN PRESENT IS HELD FOR A ROUND'S SEATING: a reserve that was present has not missed it
    presentHere: (rid, role = 'settlement') => !!db.prepare('SELECT 1 FROM seat_presents WHERE round_id = ? AND role = ? AND node = ?').get(seatOf(rid), role, me),
    takePresent, presentsOf, mySignature, certOf: (rid, role) => certOf(seatOf(rid), role), keepCert, equivocationOf, takePresents, batchOf,
    /** A round deleted from the store (transcript-prune.js, unused and past its windows): its certificates leave memory too. */
    forget: (ridHex) => { for (const role of SEATING_ROLES) certs.delete(`${ridHex}:${role}`); },
  };
}
