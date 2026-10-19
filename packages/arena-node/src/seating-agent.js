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
const joinBytes = (list) => { const out = new Uint8Array(list.reduce((n, x) => n + x.length, 0)); let at = 0; for (const x of list) { out.set(x, at); at += x.length; } return out; };

export function seatingAgent({ round, roster, sign, verify, fetcher = fetch, nowMs = () => Date.now(), log = () => {}, windowOf = () => null,
  onSeated = () => {}, leftNode = () => false }) {
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
  const certs = new Map();       // `${rid}:${role}` -> seated hex list (null: equivocated)
  for (const r of db.prepare('SELECT round_id, role, cert FROM seat_certs').all()) {
    try { certs.set(`${toHex(new Uint8Array(r.round_id))}:${r.role}`, decodeSeated(new Uint8Array(r.cert))); } catch { /* unread */ }
  }
  for (const r of db.prepare('SELECT round_id, role FROM seat_equivocations').all()) certs.set(`${toHex(new Uint8Array(r.round_id))}:${r.role}`, null);
  // a kept certificate was checked before it was kept (keepCert): read back, it names its seated
  function decodeSeated(cert) { return decodeSeatingCertificate(cert).seated.map(toHex); }

  // THE CHECK OF A CERTIFICATE, against this node's own draw for the round
  const checkFor = (rid, role) => {
    const c = roster.committeeFor(rid, role);
    if (!c.ok) return null;
    const row = round.get(rid);
    const contract = decodeRoundContract(new Uint8Array(row.contract));
    return { roundId: rid, role, drawn: c.drawn.map((e) => e.pubkey), slots: slotsForRole(contract, role), verify };
  };
  const keepCert = (rid, role, bytes) => {
    // ONE HELD ALREADY, byte for byte, is not checked again (2026-10-12 "figure out why CPU usage so high and
    // optimise it": every batch answer repeats a round's certificate, and each was verified - all its signatures - before the
    // seat looked whether it held exactly these bytes)
    const held = db.prepare('SELECT cert FROM seat_certs WHERE round_id = ? AND role = ?').get(rid, role);
    if (held && Buffer.compare(Buffer.from(held.cert), Buffer.from(bytes)) === 0) return { ok: true, kept: false };
    const check = checkFor(rid, role);
    if (!check) return { ok: false, why: 'this node cannot draw that round yet' };
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
      if (anchor && !anchor.first) continue;
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
  function takePresent(bytes) {
    // ONE HELD ALREADY, byte for byte, is not checked again (every batch answer repeats a round's PRESENTs,
    // and verifying each at each tick was thousands of signature checks per tick at grid density)
    try {
      const d = decodePresent(bytes);
      const had = db.prepare('SELECT bytes FROM seat_presents WHERE round_id = ? AND role = ? AND node = ?').get(d.roundId, d.role, toHex(d.nodePubkey));
      if (had && Buffer.compare(Buffer.from(had.bytes), Buffer.from(bytes)) === 0) return { ok: true, held: true };
    } catch { /* not decodable: verifyPresent says why */ }
    const v = verifyPresent(bytes, { verify });
    if (!v.ok) return v;
    const { roundId, role, nodePubkey } = v.present;
    if (leftNode(toHex(nodePubkey))) return { ok: false, why: 'that node\'s owner took it out of the seating (emergency departure, §23A.5a)' };
    const c = roster.committeeFor(roundId, role);
    if (!c.ok) return { ok: false, why: c.why };
    if (!c.drawn.some((e) => toHex(e.pubkey) === toHex(nodePubkey))) return { ok: false, why: 'that node is not drawn for that round and role' };
    const t = starts.get(toHex(roundId));
    if (t && BigInt(nowMs()) >= t.close) return { ok: false, why: 'that round\'s seating has closed' };
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
  async function tick() {
    if (busy) return;
    busy = true;
    const t0 = Date.now(); let fellBack = 0, peers = 0, rounds = 0;
    try {
      index();
      const now = BigInt(nowMs());
      const work = [];
      for (const [ridHex, t] of starts) {
        if (t.start + 600000n < now) { starts.delete(ridHex); continue; }   // long started: nothing left to seat
        if (now < t.close - PRESENT_WINDOW_MS || now > t.start) continue;
        for (const role of SEATING_ROLES) {
          // a certificate stands here: a second one reaches this node by POST /seating, and is then the proof of equivocation
          if (certs.has(`${ridHex}:${role}`) && db.prepare('SELECT 1 FROM seat_certs WHERE round_id = ? AND role = ?').get(t.rid, role)) continue;
          const c = roster.committeeFor(t.rid, role);
          if (!c.ok) continue;
          const drawnKeys = c.drawn.map((e) => e.pubkey);
          work.push({ t, ridHex, role, c, drawnKeys, amDrawn: drawnKeys.some((k) => toHex(k) === me), others: endpointsOf(c.drawn, round.pubkey),
            slots: slotsForRole(t.contract, role), closed: now >= t.close });
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
      for (const w of work) if (w.closed) signMine(w);
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
        for (const b of w.others) {
          const batch = answers.get(b);
          const a = batch ? batch[w.ridHex] : single.get(`${b}|${w.ridHex}|${w.role}`);
          if (!a) continue;
          for (const x of a.presents || []) if (x.role === w.role) takePresent(fromHex(x.present));
          const cert = a.cert && a.cert[w.role];
          if (cert) keepCert(w.t.rid, w.role, fromHex(cert));
          const sig = a.sig && a.sig[w.role];
          if (sig && w.closed) keepSig(w, sig);
        }
        if (w.closed) { signMine(w); await certify(w); }
      }
    } catch (e) { log(`[seating] ${e.message}`); }
    finally {
      busy = false;
      const took = Date.now() - t0;
      if (took > 5000) log(`[seating] a tick of ${rounds} round(s) took ${took} ms; ${fellBack} of ${peers} node(s) answered no batch`);
    }
  }

  /** The old doors, one round at a time: for a node that has no GET /seating-batch. */
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
    const sig = signSeating({ roundId: w.t.rid, role: w.role, seated }, sign);
    db.prepare('INSERT OR IGNORE INTO seat_signed (round_id, role, seated, signature) VALUES (?, ?, ?, ?)').run(w.t.rid, w.role, JSON.stringify(seated.map(toHex)), sig);
    const list = seated.map(toHex);
    const id = toHex(seatingId({ roundId: w.t.rid, role: w.role, seated }));
    db.prepare('INSERT OR IGNORE INTO seat_sigs (round_id, role, seating, node, signature) VALUES (?, ?, ?, ?, ?)').run(w.t.rid, w.role, id, me, sig);
    log(`[seating] ${w.ridHex.slice(0, 16)} ${w.role}: signed the seating of ${list.length} (${held.length} present of ${w.drawnKeys.length} drawn)`);
  }

  /** Another seated node's signature, kept when it is over the same seating this node signed. */
  function keepSig(w, got) {
    const signed = mySignature(w.t.rid, w.role);
    if (!signed || !got.signature || !Array.isArray(got.seated) || !got.node) return;
    if (got.seated.join(',') !== signed.seated.join(',')) return;    // another seating: no signature of this one
    const id = toHex(seatingId({ roundId: w.t.rid, role: w.role, seated: signed.seated.map(fromHex) }));
    if (db.prepare('SELECT 1 FROM seat_sigs WHERE round_id = ? AND role = ? AND seating = ? AND node = ?').get(w.t.rid, w.role, id, got.node)) return;   // held already
    let good = false; try { good = verify(fromHex(got.signature), fromHex(id), fromHex(got.node)); } catch { good = false; }
    if (good) db.prepare('INSERT OR IGNORE INTO seat_sigs (round_id, role, seating, node, signature) VALUES (?, ?, ?, ?, ?)').run(w.t.rid, w.role, id, got.node, fromHex(got.signature));
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
