// RESERVE SEATS AT A SEAT (multiplayer_p2p.md §5A.7, kanban #301). For each round this node is drawn for, per role:
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
import { signPresent, verifyPresent, seatedFrom, signSeating, seatingId, encodeSeatingCertificate, verifySeating,
  seatingEquivocation, seatingCloseMs, decodeSeatingCertificate, SEATING_ROLES } from '../../arena-protocol/src/seating.js';
import { endpointsOf } from './roster.js';

/** How far ahead of its start a round is looked at: PRESENT is signed in the last minute before seating_close. */
export const PRESENT_WINDOW_MS = 60000n;

export function seatingAgent({ round, roster, sign, verify, fetcher = fetch, nowMs = () => Date.now(), log = () => {}, windowOf = () => null }) {
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
    const v = verifyPresent(bytes, { verify });
    if (!v.ok) return v;
    const { roundId, role, nodePubkey } = v.present;
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
  let busy = false;
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      index();
      const now = BigInt(nowMs());
      for (const [ridHex, t] of starts) {
        if (t.start + 600000n < now) { starts.delete(ridHex); continue; }   // long started: nothing left to seat
        if (now < t.close - PRESENT_WINDOW_MS || now > t.start) continue;
        for (const role of SEATING_ROLES) await seatRole(t, role, now);
      }
    } catch (e) { log(`[seating] ${e.message}`); }
    finally { busy = false; }
  }

  async function seatRole(t, role, now) {
    const { rid } = t;
    if (certs.has(`${toHex(rid)}:${role}`) && db.prepare('SELECT 1 FROM seat_certs WHERE round_id = ? AND role = ?').get(rid, role)) {
      // a certificate stands here: a second one reaches this node by POST /seating, and is then the proof of equivocation
      return;
    }
    const c = roster.committeeFor(rid, role);
    if (!c.ok) return;
    const drawnKeys = c.drawn.map((e) => e.pubkey);
    const amDrawn = drawnKeys.some((k) => toHex(k) === me);
    const others = endpointsOf(c.drawn, round.pubkey);
    const slots = slotsForRole(t.contract, role);
    if (now < t.close) {
      if (!amDrawn) return;
      // PRESENT: once, kept, handed to the other drawn nodes; and theirs asked for
      if (!db.prepare('SELECT 1 FROM seat_presents WHERE round_id = ? AND role = ? AND node = ?').get(rid, role, me)) {
        const p = signPresent({ roundId: rid, role, nodePubkey: round.pubkey }, sign);
        takePresent(p);
        await Promise.all(others.map((b) => post(b, '/present', p)));
        log(`[seating] ${toHex(rid).slice(0, 16)} ${role}: PRESENT signed and sent to ${others.length}`);
      }
      await Promise.all(others.map(async (b) => {
        const got = await getJson(b, `/present?round=${toHex(rid)}`);
        for (const x of (got && got.presents) || []) if (x.role === role) takePresent(fromHex(x.present));
      }));
      return;
    }
    // SEATING CLOSED. First the others' certificates: any drawn node - seated or a reserve - keeps one that stands
    await Promise.all(others.map(async (b) => {
      const got = await getJson(b, `/seating?round=${toHex(rid)}&role=${role}`);
      if (got && got.cert) keepCert(rid, role, fromHex(got.cert));
    }));
    if (db.prepare('SELECT 1 FROM seat_certs WHERE round_id = ? AND role = ?').get(rid, role)) return;
    // then the seated from the PRESENTs held; sign once, if seated
    const held = db.prepare('SELECT node FROM seat_presents WHERE round_id = ? AND role = ?').all(rid, role).map((r) => r.node);
    const seated = seatedFrom({ drawn: drawnKeys, present: held, slots });
    const mine = mySignature(rid, role);
    if (!mine) {
      if (!seated.some((k) => toHex(k) === me)) return;
      const sig = signSeating({ roundId: rid, role, seated }, sign);
      db.prepare('INSERT OR IGNORE INTO seat_signed (round_id, role, seated, signature) VALUES (?, ?, ?, ?)').run(rid, role, JSON.stringify(seated.map(toHex)), sig);
      log(`[seating] ${toHex(rid).slice(0, 16)} ${role}: signed the seating of ${seated.length} (${held.length} present of ${drawnKeys.length} drawn)`);
    }
    const signed = mySignature(rid, role);
    if (!signed) return;
    const list = signed.seated.map(fromHex);
    const id = toHex(seatingId({ roundId: rid, role, seated: list }));
    db.prepare('INSERT OR IGNORE INTO seat_sigs (round_id, role, seating, node, signature) VALUES (?, ?, ?, ?, ?)').run(rid, role, id, me, fromHex(signed.signature));
    // THE OTHER SEATED NODES' SIGNATURES over the same seating
    const seatedEntries = c.drawn.filter((e) => signed.seated.includes(toHex(e.pubkey)));
    await Promise.all(endpointsOf(seatedEntries, round.pubkey).map(async (b) => {
      const got = await getJson(b, `/seating-sig?round=${toHex(rid)}&role=${role}`);
      if (!got || !got.signature || !Array.isArray(got.seated)) return;
      if (got.seated.join(',') !== signed.seated.join(',')) return;    // another seating: no signature of this one
      let good = false; try { good = verify(fromHex(got.signature), fromHex(id), fromHex(got.node)); } catch { good = false; }
      if (good) db.prepare('INSERT OR IGNORE INTO seat_sigs (round_id, role, seating, node, signature) VALUES (?, ?, ?, ?, ?)').run(rid, role, id, got.node, fromHex(got.signature));
    }));
    const sigs = db.prepare('SELECT node, signature FROM seat_sigs WHERE round_id = ? AND role = ? AND seating = ?').all(rid, role, id);
    if (signed.seated.every((k) => sigs.some((s) => s.node === k))) {
      const cert = encodeSeatingCertificate({ roundId: rid, role, seated: list,
        signatures: sigs.filter((s) => signed.seated.includes(s.node)).map((s) => ({ nodePubkey: fromHex(s.node), signature: new Uint8Array(s.signature) })) });
      const k = keepCert(rid, role, cert);
      if (k.ok && k.kept) {
        // HANDED TO EVERY OTHER DRAWN NODE, so each holds it - the reserves too - before an entry comes
        await Promise.all(others.map((b) => post(b, '/seating', cert)));
        log(`[seating] ${toHex(rid).slice(0, 16)} ${role}: certificate of ${list.length} seated, every one signed - handed to ${others.length}`);
      }
    }
  }

  return {
    tick,
    /** For the roster: who the certificate seats (node keys hex), or null while none stands or after equivocation. */
    seatedFor: (rid, role) => { const s = certs.get(`${toHex(rid)}:${role}`); return s || null; },
    /** A round's seating, for the doors, the lobby and the entry gate. */
    stateOf: (rid) => {
      const out = {};
      for (const role of SEATING_ROLES) {
        const key = `${toHex(rid)}:${role}`;
        out[role] = certs.has(key) && certs.get(key) === null ? { equivocated: true } : certs.get(key) ? { seated: certs.get(key) } : null;
      }
      return out;
    },
    takePresent, presentsOf, mySignature, certOf, keepCert, equivocationOf,
  };
}
