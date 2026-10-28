// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE HEARTBEAT AT A SEAT (multiplayer_p2p.md §5A.3 "The heartbeat", protocol 22, kanban #727, the owner 2026-10-27). For every 22 round
// this seat holds that seats itself, and its heartbeat slot (heartbeat.js: one per round, the owner 2026-10-27, closing with its seating):
//
//   in the minute before the slot closes   if this node is in the round's census (or left out by it, coming back), it signs its HEARTBEAT
//                                          and hands it to the slot's 9 committee members (POST /heartbeats, one body per member)
//   as a member, until the close           it keeps every HEARTBEAT of a census node handed to it; none after the close
//   as a member, after the close           it signs its HEARD once - every node it held a HEARTBEAT of, and the census's left out - and
//                                          hands it to the other 8 (POST /heard); with 5 or more members' HEARDs it keeps the slot's
//                                          certificate, and a bigger one as more arrive
//
// Why: on 10-27 almost no round reached 5 present, so almost no seating certificate existed and the stopped nodes took 3 days to be
// proven out. A heartbeat certificate proves every census node it does not list missed at its slot, one every 15 min on a 15-min grid, so a day of them
// proves a stopped node out. The presence book reads the certificates (hb_certs) and the HEARTBEATs held (hb_beats): a seat holding one
// of a node in the 24 h refuses a census that leaves it out.
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { decodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { signHeartbeat, verifyHeartbeat, decodeHeartbeat, signHeard, heardId, encodeHeartbeatCertificate, decodeHeartbeatCertificate, hasHeartbeats, heartbeatCloseMs,
  HEARTBEAT_BYTES, HEARTBEAT_SLOTS_PER_ROUND, HEARTBEAT_THRESHOLD } from '../../arena-protocol/src/heartbeat.js';
import { endpointsOf } from './roster.js';

/** A HEARTBEAT is signed and handed out in the last minute before its slot closes. */
export const BEAT_LEAD_MS = 60000n;
/** After its close a slot's HEARDs are exchanged for this long; then the slot is done here. */
export const HEARD_FOR_MS = 300000n;
/** A member hands its HEARD out again this long after it first did, for a member that was not listening yet. */
const HEARD_AGAIN_MS = 60000n;
const HEX64 = /^[0-9a-f]{64}$/;
const joinBytes = (list) => { const out = new Uint8Array(list.reduce((n, x) => n + x.length, 0)); let at = 0; for (const x of list) { out.set(x, at); at += x.length; } return out; };

export function heartbeatAgent({ round, roster, sign, verify, fetcher = fetch, nowMs = () => Date.now(), log = () => {}, leftNode = () => false, endpointOf = null }) {
  const db = round.db;
  db.exec(`
    CREATE TABLE IF NOT EXISTS hb_beats (round_id BLOB NOT NULL, slot INTEGER NOT NULL, node TEXT NOT NULL, close_ms INTEGER NOT NULL, bytes BLOB NOT NULL,
      PRIMARY KEY (round_id, slot, node));
    CREATE TABLE IF NOT EXISTS hb_heard (round_id BLOB NOT NULL, slot INTEGER NOT NULL, node TEXT NOT NULL, heard TEXT NOT NULL, left_out TEXT NOT NULL,
      signature BLOB NOT NULL, PRIMARY KEY (round_id, slot, node));
    CREATE TABLE IF NOT EXISTS hb_certs (round_id BLOB NOT NULL, slot INTEGER NOT NULL, close_ms INTEGER NOT NULL, cert BLOB NOT NULL,
      PRIMARY KEY (round_id, slot));
  `);
  const me = toHex(round.pubkey);
  // ROUNDS WITH HEARTBEAT SLOTS, read once each: rid hex -> { rid, closes: [bigint x 3] }
  const slots = new Map();
  let lastRow = 0;
  const index = () => {
    const now = BigInt(nowMs());
    for (const r of db.prepare('SELECT rowid, round_id, contract FROM rounds WHERE rowid > ? ORDER BY rowid').all(lastRow)) {
      lastRow = r.rowid;
      let c; try { c = decodeRoundContract(new Uint8Array(r.contract)); } catch { continue; }
      if (!hasHeartbeats(c)) continue;
      const closes = Array.from({ length: HEARTBEAT_SLOTS_PER_ROUND }, (_, j) => heartbeatCloseMs(c, j));
      if (closes[0] + HEARD_FOR_MS < now) continue;            // done long ago
      slots.set(toHex(new Uint8Array(r.round_id)), { rid: new Uint8Array(r.round_id), closes });
    }
  };
  const closeOf = (rid, slot) => { const s = slots.get(toHex(rid)); return s ? s.closes[slot] : null; };

  const post = async (base, path, body) => {
    try { const r = await fetcher(`${base}${path}`, { method: 'POST', body, signal: AbortSignal.timeout(5000) }); return r.ok; } catch { return false; }
  };

  // ---- the doors ----
  /** A HEARTBEAT handed to this node as a member: kept until the slot's close, when it is signed by a node the round's census expects. */
  function takeHeartbeat(bytes) {
    let h; try { h = decodeHeartbeat(bytes); } catch (e) { return { ok: false, why: e.message }; }
    const node = toHex(h.nodePubkey);
    const had = db.prepare('SELECT bytes FROM hb_beats WHERE round_id = ? AND slot = ? AND node = ?').get(h.roundId, h.slot, node);
    if (had && Buffer.compare(Buffer.from(had.bytes), Buffer.from(bytes)) === 0) return { ok: true, held: true };
    const closeMs = closeOf(h.roundId, h.slot);
    if (closeMs === null) return { ok: false, why: 'this node holds no heartbeat slot of that round' };
    // NONE AFTER THE CLOSE: a HEARD names who beat in time, and a late beat would make it a list of who beat at all
    if (BigInt(nowMs()) >= closeMs) return { ok: false, why: 'that heartbeat slot has closed' };
    const v = verifyHeartbeat(bytes, { verify });
    if (!v.ok) return v;
    if (leftNode(node)) return { ok: false, why: 'that node\'s owner took it out of the seating (emergency departure, §23A.5a)' };
    const c = roster.heartbeatCommitteeFor(h.roundId, h.slot);
    if (!c.ok) return { ok: false, why: c.why };
    if (!c.committee.some((e) => toHex(e.pubkey) === me)) return { ok: false, why: 'this node is not on that slot\'s heartbeat committee' };
    if (!c.census.includes(node) && !c.leftOut.includes(node)) return { ok: false, why: 'that node is not in the round\'s census, nor left out by it' };
    db.prepare('INSERT OR IGNORE INTO hb_beats (round_id, slot, node, close_ms, bytes) VALUES (?, ?, ?, ?, ?)').run(h.roundId, h.slot, node, Number(closeMs), bytes);
    return { ok: true };
  }
  /** POST /heartbeats: a body of whole HEARTBEATs, each taken as above. */
  function takeHeartbeats(bytes) {
    if (!bytes.length || bytes.length % HEARTBEAT_BYTES !== 0) return { ok: false, why: `a batch of HEARTBEATs is a whole number of ${HEARTBEAT_BYTES}-byte HEARTBEATs` };
    let taken = 0; const refused = [];
    for (let i = 0; i < bytes.length; i += HEARTBEAT_BYTES) { const r = takeHeartbeat(bytes.subarray(i, i + HEARTBEAT_BYTES)); if (r.ok) taken++; else refused.push(r.why); }
    return { ok: true, taken, refused: refused.slice(0, 8) };
  }
  /**
   * POST /heard: other members' HEARDs, [{ round, slot, node, heard, leftOut, signature }] (hex) - each kept when its signer is on the
   * slot's committee and the signature verifies. A member's second, different HEARD for one slot is not kept (the first one stands here).
   */
  function takeHeard(list) {
    if (!Array.isArray(list) || list.length > 1024) return { ok: false, why: 'HEARDs are a list' };
    let taken = 0; const refused = [];
    for (const x of list) {
      const r = takeOneHeard(x);
      if (r.ok) taken++; else refused.push(r.why);
    }
    return { ok: true, taken, refused: refused.slice(0, 8) };
  }
  function takeOneHeard(x) {
    const node = String((x && x.node) || '').toLowerCase(), ridHex = String((x && x.round) || '').toLowerCase(), slot = Number(x && x.slot);
    if (!HEX64.test(node) || !HEX64.test(ridHex) || !Number.isInteger(slot) || slot < 0 || slot >= HEARTBEAT_SLOTS_PER_ROUND) return { ok: false, why: 'a HEARD names a round, a slot and its member' };
    let heard, leftOut;
    try { heard = [...new Set(x.heard.map((k) => String(k).toLowerCase()))].sort(); leftOut = [...new Set(x.leftOut.map((k) => String(k).toLowerCase()))].sort(); } catch { return { ok: false, why: 'a HEARD lists node keys' }; }
    if (heard.length > 4096 || leftOut.length > 4096 || ![...heard, ...leftOut].every((k) => HEX64.test(k))) return { ok: false, why: 'a HEARD lists node keys, 32 bytes hex' };
    const rid = fromHex(ridHex);
    const had = db.prepare('SELECT heard, left_out FROM hb_heard WHERE round_id = ? AND slot = ? AND node = ?').get(rid, slot, node);
    if (had) return had.heard === JSON.stringify(heard) && had.left_out === JSON.stringify(leftOut) ? { ok: true, held: true } : { ok: false, why: 'that member\'s HEARD for that slot is held already, and it is another' };
    const c = roster.heartbeatCommitteeFor(rid, slot);
    if (!c.ok) return { ok: false, why: c.why };
    if (!c.committee.some((e) => toHex(e.pubkey) === node)) return { ok: false, why: 'that node is not on the slot\'s heartbeat committee' };
    let good = false;
    try { good = verify(fromHex(String(x.signature)), heardId({ roundId: rid, slot, heard, leftOut }), fromHex(node)); } catch { good = false; }
    if (!good) return { ok: false, why: 'that HEARD is not signed by the member it names' };
    db.prepare('INSERT OR IGNORE INTO hb_heard (round_id, slot, node, heard, left_out, signature) VALUES (?, ?, ?, ?, ?, ?)')
      .run(rid, slot, node, JSON.stringify(heard), JSON.stringify(leftOut), fromHex(String(x.signature)));
    return { ok: true };
  }
  const heardOf = (rid, slot, node) => {
    const r = db.prepare('SELECT heard, left_out, signature FROM hb_heard WHERE round_id = ? AND slot = ? AND node = ?').get(rid, slot, node);
    return r ? { round: toHex(rid), slot, node, heard: JSON.parse(r.heard), leftOut: JSON.parse(r.left_out), signature: toHex(new Uint8Array(r.signature)) } : null;
  };
  /** This slot's certificate, kept: hex, or null. */
  const certOf = (rid, slot) => { const r = db.prepare('SELECT cert FROM hb_certs WHERE round_id = ? AND slot = ?').get(rid, slot); return r ? toHex(new Uint8Array(r.cert)) : null; };

  /** With HEARTBEAT_THRESHOLD or more members' HEARDs held: the certificate, kept when it has more signers than the one held. */
  function certify(rid, slot, closeMs) {
    const rows = db.prepare('SELECT node, heard, left_out, signature FROM hb_heard WHERE round_id = ? AND slot = ?').all(rid, slot);
    if (rows.length < HEARTBEAT_THRESHOLD) return false;
    const held = db.prepare('SELECT cert FROM hb_certs WHERE round_id = ? AND slot = ?').get(rid, slot);
    if (held && signersIn(new Uint8Array(held.cert)) >= rows.length) return false;
    const groups = new Map();
    for (const x of rows) {
      const k = `${x.heard}|${x.left_out}`;
      if (!groups.has(k)) groups.set(k, { heard: JSON.parse(x.heard).map(fromHex), leftOut: JSON.parse(x.left_out).map(fromHex), signatures: [] });
      groups.get(k).signatures.push({ nodePubkey: fromHex(x.node), signature: new Uint8Array(x.signature) });
    }
    const cert = encodeHeartbeatCertificate({ roundId: rid, slot, groups: [...groups.values()] });
    db.prepare('INSERT OR REPLACE INTO hb_certs (round_id, slot, close_ms, cert) VALUES (?, ?, ?, ?)').run(rid, slot, Number(closeMs), cert);
    return true;
  }
  const signersIn = (bytes) => { try { return decodeHeartbeatCertificate(bytes).groups.reduce((n, g) => n + g.signatures.length, 0); } catch { return 0; } };

  // ---- the work, every tick ----
  const sent = new Set();           // `${rid}:${slot}` this node beat for
  const heardOut = new Map();       // `${rid}:${slot}` -> when this node first handed its HEARD out (bigint), or 'again' once repeated
  let busy = false;
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      index();
      const now = BigInt(nowMs());
      const beats = new Map(), heards = new Map();
      for (const [ridHex, s] of slots) {
        if (s.closes[0] + HEARD_FOR_MS < now) { slots.delete(ridHex); continue; }
        for (let j = 0; j < HEARTBEAT_SLOTS_PER_ROUND; j++) {
          const close = s.closes[j], key = `${ridHex}:${j}`;
          if (now < close - BEAT_LEAD_MS || now > close + HEARD_FOR_MS) continue;
          const c = roster.heartbeatCommitteeFor(s.rid, j);
          if (!c.ok) continue;
          const member = c.committee.some((e) => toHex(e.pubkey) === me);
          const others = endpointsOf(c.committee, round.pubkey, endpointOf);
          // 1. BEFORE THE CLOSE: this node's HEARTBEAT, once, to every member (itself kept when it is one)
          if (now < close && !sent.has(key) && !leftNode(me) && (c.census.includes(me) || c.leftOut.includes(me))) {
            sent.add(key);
            const hb = signHeartbeat({ roundId: s.rid, slot: j, nodePubkey: round.pubkey }, sign);
            if (member) takeHeartbeat(hb);
            for (const b of others) (beats.get(b) || beats.set(b, []).get(b)).push(hb);
          }
          if (!member || now < close) continue;
          // 2. AFTER THE CLOSE, AS A MEMBER: its HEARD, signed once over the HEARTBEATs held at the close, handed to the other members
          let mine = heardOf(s.rid, j, me);
          if (!mine) {
            const heard = db.prepare('SELECT node FROM hb_beats WHERE round_id = ? AND slot = ?').all(s.rid, j).map((r) => r.node).sort();
            const leftOut = [...new Set(c.leftOut)].sort();
            const signature = signHeard({ roundId: s.rid, slot: j, heard, leftOut }, sign);
            db.prepare('INSERT OR IGNORE INTO hb_heard (round_id, slot, node, heard, left_out, signature) VALUES (?, ?, ?, ?, ?, ?)')
              .run(s.rid, j, me, JSON.stringify(heard), JSON.stringify(leftOut), signature);
            mine = heardOf(s.rid, j, me);
            log(`[heartbeat] ${ridHex.slice(0, 16)} slot ${j}: heard ${heard.length} of ${c.census.length + c.leftOut.length}, HEARD signed`);
          }
          const first = heardOut.get(key);
          if (first === undefined || (first !== 'again' && now - first >= HEARD_AGAIN_MS)) {
            heardOut.set(key, first === undefined ? now : 'again');
            for (const b of others) (heards.get(b) || heards.set(b, []).get(b)).push(mine);
          }
          if (certify(s.rid, j, close)) log(`[heartbeat] ${ridHex.slice(0, 16)} slot ${j}: certificate of ${db.prepare('SELECT COUNT(*) AS n FROM hb_heard WHERE round_id = ? AND slot = ?').get(s.rid, j).n} members`);
        }
      }
      await Promise.all([
        ...[...beats].map(([b, list]) => post(b, '/heartbeats', joinBytes(list))),
        ...[...heards].map(([b, list]) => post(b, '/heard', JSON.stringify(list))),
      ]);
      if (sent.size > 20000) sent.clear();
      if (heardOut.size > 20000) heardOut.clear();
    } catch (e) { log(`[heartbeat] ${e.message}`); }
    finally { busy = false; }
  }

  return { tick, takeHeartbeat, takeHeartbeats, takeHeard, heardOf, certOf };
}
