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
//                                         kept as the proof (GET /seating-equivocation), and the round takes no entries
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
  encodeJustification, decodeJustification, verifyJustification, justificationChain, justificationSteps, JUSTIFICATION_DEPTH,
  signSeatingBound, seatingSignedId, justificationHash } from '../../arena-protocol/src/seating.js';
import { endpointsOf } from './roster.js';
import { tableAnchorOf } from '../../arena-protocol/src/known-game.js';

/** How far ahead of its start a round is looked at: PRESENT is signed in the last minute before seating_close. */
export const PRESENT_WINDOW_MS = 60000n;
/** A PRESENT's length: type, version, round id, role, node key, signature (seating.js presentBody + 64). */
export const PRESENT_BYTES = 1 + 2 + 32 + 1 + 32 + 64;
/** At most this many rounds in one GET /seating-batch. */
export const BATCH_ROUNDS = 64;
const joinBytes = (list) => { const out = new Uint8Array(list.reduce((n, x) => n + x.length, 0)); let at = 0; for (const x of list) { out.set(x, at); at += x.length; } return out; };

export function seatingAgent({ round, roster, sign, verify, fetcher = fetch, nowMs = () => Date.now(), log = () => {}, windowOf = () => null,
  onSeated = () => {}, leftNode = () => false, contractOf = () => null, leftOutOf = () => [], endpointOf = null }) {
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
    CREATE TABLE IF NOT EXISTS seat_equivocations (round_id BLOB NOT NULL, role TEXT NOT NULL, a BLOB NOT NULL, b BLOB NOT NULL,
      PRIMARY KEY (round_id, role));
    CREATE TABLE IF NOT EXISTS seat_seen (round_id BLOB NOT NULL, role TEXT NOT NULL, seating TEXT NOT NULL, node TEXT NOT NULL, present TEXT NOT NULL,
      left_out TEXT NOT NULL, signature BLOB NOT NULL, PRIMARY KEY (round_id, role, seating, node));
  `);
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
    return { roundId: rid, role, drawn: c.drawn.map((e) => e.pubkey), slots: slotsForRole(contract, role), verify, listsPresent: seatingListsPresent(contract) };
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
      const e = seatingEquivocation(old, bytes, check, presentedOf(rid, role));
      if (!e.ok) return { ok: false, why: e.why };
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
    // the seats a v2 round counts are these (2026.0.2): the server writes them into the stored contract
    try { onSeated(rid, role, v.seating.seated); } catch (e) { log(`[seating] ${toHex(rid).slice(0, 16)} ${role}: ${e.message}`); }
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
  const unwritten = new Map();   // anchor hex -> { rid, askedMs }: tables whose round 0 this seat does not hold
  let lastRow = 0;
  const index = () => {
    for (const r of db.prepare('SELECT rowid, round_id, contract FROM rounds WHERE rowid > ? ORDER BY rowid').all(lastRow)) {
      lastRow = r.rowid;
      let c; try { c = decodeRoundContract(new Uint8Array(r.contract)); } catch { continue; }
      if (typeof c.startTimeMs !== 'bigint') continue;
      // long started: nothing left to seat, never held (at a start that was every round in the store, 53,658
      // contracts on seat 1, of which 5,950 had not started 10 min ago)
      if (c.startTimeMs + 600000n < BigInt(nowMs())) continue;
      // A TABLE IS SEATED ONCE, BY ITS FIRST ROUND (pick (c), known-game.js tableAnchorOf): its later rounds exchange no
      // PRESENT and sign no seating - the roster seats them with the first round's certificate
      const anchor = tableAnchorOf(c);
      if (anchor && !anchor.first) {
        // A TABLE WHOSE FIRST ROUND THIS SEAT NEVER WROTE (kanban #604): its certificate is asked of the table's seats
        const a = toHex(anchor.anchorId);
        if (!unwritten.has(a) && !round.get(anchor.anchorId)) unwritten.set(a, { rid: anchor.anchorId, askedMs: -Infinity, sinceMs: nowMs() });
        continue;
      }
      starts.set(toHex(new Uint8Array(r.round_id)), { rid: new Uint8Array(r.round_id), start: c.startTimeMs, close: seatingCloseMs(c, windowOf(c)), contract: c });
    }
  };

  const post = async (base, path, body) => {
    try { const r = await fetcher(`${base}${path}`, { method: 'POST', body, signal: AbortSignal.timeout(5000) }); return r.ok; } catch { return false; }
  };
  const getJson = async (base, path) => {
    try { const r = await fetcher(`${base}${path}`, { signal: AbortSignal.timeout(5000) }); return r.ok ? await r.json() : null; } catch { return null; }
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
    // A NODE THE ROUND'S CENSUS LEFT OUT AS ABSENT may say PRESENT undrawn (kanban #727): listed in the SEEN, it is back next census
    if (!c.drawn.some((e) => toHex(e.pubkey) === toHex(nodePubkey)) && !leftOutHex(roundId).includes(toHex(nodePubkey)))
      return { ok: false, why: 'that node is not drawn for that round and role' };
    const t = starts.get(toHex(roundId));
    if (t && !afterClose && BigInt(nowMs()) >= t.close) return { ok: false, why: 'that round\'s seating has closed' };
    db.prepare('INSERT OR IGNORE INTO seat_presents (round_id, role, node, bytes) VALUES (?, ?, ?, ?)').run(roundId, role, toHex(nodePubkey), bytes);
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
      ...(r.justification ? { justification: toHex(new Uint8Array(r.justification)) } : {}) };
  };
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
  async function tick() {
    if (busy) return;
    busy = true;
    const t0 = Date.now(); let fellBack = 0, peers = 0, rounds = 0;
    try {
      index();
      await askUnwritten();
      const now = BigInt(nowMs());
      const work = [];
      for (const [ridHex, t] of starts) {
        if (t.start + 600000n < now) { starts.delete(ridHex); continue; }   // long started: nothing left to seat
        if (now < t.close - PRESENT_WINDOW_MS) continue;
        // A ROUND ALREADY STARTED IS ONLY READ, for the certificate this node lacks (kanban #576, measured 2026-10-23 12:0xZ: seats
        // restarted after the 12:00 window started never asked for its certificates - a started round was skipped - so each
        // counted itself unseated and refused the claim key, "this node is not assigned to that round", and no order of that
        // window went in). It sends no PRESENT and signs no seating late: it keeps what the seated already certified (keepCert
        // checks it), until the round leaves the index 10 min after its start.
        const late = now > t.start;
        for (const role of SEATING_ROLES) {
          // a certificate stands here: a second one reaches this node by POST /seating, and is then the proof of equivocation
          if (certs.has(`${ridHex}:${role}`) && db.prepare('SELECT 1 FROM seat_certs WHERE round_id = ? AND role = ?').get(t.rid, role)) continue;
          const c = roster.committeeFor(t.rid, role);
          if (!c.ok) continue;
          const drawnKeys = c.drawn.map((e) => e.pubkey);
          work.push({ t, ridHex, role, c, drawnKeys, amDrawn: drawnKeys.some((k) => toHex(k) === me), others: endpointsOf(c.drawn, round.pubkey, endpointOf),
            slots: slotsForRole(t.contract, role), closed: now >= t.close, late });
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
        for (const b of w.others) (outbox.get(b) || outbox.set(b, []).get(b)).push(p);
        log(`[seating] ${w.ridHex.slice(0, 16)} ${w.role}: PRESENT signed, handed to ${w.others.length}`);
      }
      await Promise.all([...outbox].map(async ([b, list]) => {
        if (await post(b, '/presents', joinBytes(list))) return;
        for (const p of list) await post(b, '/present', p);             // a node without the batch door
      }));
      // 2. THIS NODE'S SEATING SIGNATURE for each closed round it is seated in, before the reads
      for (const w of work) if (w.closed && !w.late) signMine(w);
      // 3. ONE READ PER NODE, for every round of this tick it is drawn for
      // ONLY WHAT THIS NODE STILL LACKS (measured 2026-10-12 21:3x local on seat 3: GET /seating-batch 88 times in 30 s,
      // 14.3 MB of JSON out - every round of the window asked of every node each tick, its PRESENTs sent back though held - the
      // seat's largest cost with the garbage it made): a round before its close whose PRESENTs from every drawn node are held
      // has nothing more to learn until then; after the close it is asked until its certificate stands (the work above)
      const holds = (w) => !w.closed && db.prepare('SELECT COUNT(*) AS n FROM seat_presents WHERE round_id = ? AND role = ?').get(w.t.rid, w.role).n >= w.drawnKeys.length;
      const asks = new Map();
      for (const w of work) { if (holds(w)) continue; for (const b of w.others) (asks.get(b) || asks.set(b, new Set()).get(b)).add(w.ridHex); }
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
      peers = answers.size; fellBack = [...answers.values()].filter((a) => a === null).length; rounds = new Set(work.map((w) => w.ridHex)).size;
      // 4. WHAT EACH SAID: their PRESENTs, certificates and seating signatures; then this node's certificate where it can
      // a node that answered no batch is asked the old way - every round of it at once, not one after another
      const single = new Map();
      await Promise.all(work.flatMap((w) => w.others.filter((b) => answers.get(b) === null)
        .map(async (b) => { single.set(`${b}|${w.ridHex}|${w.role}`, await askOne(b, w)); })));
      for (const w of work) {
        const said = [];
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
        }
        if (w.closed && !w.late) {
          // A SEATING THAT CAN NEVER STAND (kanban #738): the PRESENTs the others held at the close are taken late, here only
          if (canNeverStand(w)) for (const a of said) for (const x of a.presents || []) if (x.role === w.role) takePresent(fromHex(x.present), { afterClose: true });
          signMine(w); resign(w); await certify(w);
        }
      }
    } catch (e) { log(`[seating] ${e.message}`); }
    finally {
      busy = false;
      const took = Date.now() - t0;
      if (took > 5000) log(`[seating] a tick of ${rounds} round(s) took ${took} ms; ${fellBack} of ${peers} node(s) answered no batch`);
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
      if (!lacking.length || round.get(u.rid) || t - u.sinceMs > 3 * 3600000) { unwritten.delete(a); continue; }
      if (t - u.askedMs < 60000) continue;
      u.askedMs = t;
      const posted = contractOf(u.rid);
      if (!posted) continue;
      for (const role of lacking) {
        const c = roster.committeeFor(u.rid, role, { posted });
        if (!c.ok) continue;
        for (const b of endpointsOf(c.drawn, round.pubkey, endpointOf)) {
          const j = await getJson(b, `/seating?round=${a}&role=${role}`);
          if (j && j.cert && keepCert(u.rid, role, fromHex(j.cert)).ok) break;
        }
      }
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
    const sig = seatingListsPresent(w.t.contract) ? signSeatingBound({ roundId: w.t.rid, role: w.role, seated }, sign, justification) : signSeating({ roundId: w.t.rid, role: w.role, seated }, sign);
    const list = seated.map(toHex);
    db.prepare('INSERT INTO seat_signed (round_id, role, seated, signature, justification) VALUES (?, ?, ?, ?, ?) ON CONFLICT (round_id, role) DO UPDATE SET seated = excluded.seated, signature = excluded.signature, justification = excluded.justification')
      .run(w.t.rid, w.role, JSON.stringify(list), sig, justification);
    rememberSeating(w.t.rid, w.role, id, list);
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
    return null;
  }
  /** This node's second seating, when its first can never stand (kanban #738): the rule above. */
  function resign(w) {
    const never = canNeverStand(w);
    if (!never) return;
    const member = never.node;
    const signed = mySignature(w.t.rid, w.role);
    const held = db.prepare('SELECT node FROM seat_presents WHERE round_id = ? AND role = ?').all(w.t.rid, w.role).map((r) => r.node);
    const seated = seatedFrom({ drawn: w.drawnKeys, present: held, slots: w.slots });
    const list = seated.map(toHex);
    if (!list.includes(me) || !seatingBefore(w, signed.seated, list)) return;
    const id = toHex(seatingId({ roundId: w.t.rid, role: w.role, seated }));
    if (!db.prepare('SELECT 1 FROM seat_sigs WHERE round_id = ? AND role = ? AND seating = ? AND node != ?').get(w.t.rid, w.role, id, me)) return;
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
    const cert = encodeSeatingCertificate({ roundId: w.t.rid, role: w.role, seated: list, seen, justifications,
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
