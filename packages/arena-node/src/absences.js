// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// ABSENCE ATTESTATIONS A SEAT HOLDS (spec §23A.4): each guardian signs, once a day while it lasts, that it has not
// seen a peer in consensus since a height (absence.js). A seat takes them (POST /absence), keeps per federation, peer and
// attester the newest one, and answers whether they make an abandonment proof against a record - 2f + 1 distinct guardians,
// for at least abandon_blocks. The record's gone[] takes that peer ABANDONED with the proof's since-height and id.
//
// An attestation travels as its encoding followed by its 64-byte signature, in hex (`absenceHex`), so the second ask of a
// record gathering hands every guardian seat exactly the set the proof was made of, and each one checks it on its own.
import { encodeAbsence, decodeAbsence, absenceId, abandonmentProof, encodeDeparture, decodeDeparture, departureId, departureStands, departureAnchorOf, anchorRequired } from '../../arena-protocol/src/absence.js';
import { encodeEmergencyDeparture, decodeEmergencyDeparture, emergencyDepartureId } from '../../arena-protocol/src/emergency.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

export const absenceHex = (a) => toHex(encodeAbsence(a)) + toHex(a.signature);
export function readAbsenceHex(hex) {
  const b = fromHex(String(hex || ''));
  if (b.length < 65) throw new Error('an attestation is its encoding and a 64-byte signature');
  return { ...decodeAbsence(b.slice(0, b.length - 64)), signature: b.slice(b.length - 64) };
}

// A DEPARTURE NOTICE travels the same way (§23A.5, RULED 2026-09-21: "Leaving is legitimate"): the leaving guardian's
// own signed (federation_id, peer, leave_after_height); from leave_after on the record has it DEPARTED, its bond untouched
// AND ITS ANCHOR WITH IT (kanban #2608): from the gate a notice counts from the confirmed height of its "ARN" 'L' anchor (absence.js), so
// it travels with where that anchor is - the anchor transaction's txid and the block it confirmed in, 64 bytes after the signature. The
// receiving seat reads that one transaction from its own bitcoind (as a ballot deposit is read) and takes the height from its chain: the
// reference only says where to look, never what height. Without them the bytes are the old 172.
const NOTICE_BYTES = 1 + 2 + 32 + 33 + 4 + 4 + 32;
const anchorRef = (a) => (a && /^[0-9a-f]{64}$/.test(String(a.txid || '')) && /^[0-9a-f]{64}$/.test(String(a.blockHash || '')) ? String(a.txid) + String(a.blockHash) : '');
export const departureHex = (d) => toHex(encodeDeparture(d)) + toHex(d.signature) + anchorRef(d.anchor);
export function readDepartureHex(hex) {
  const b = fromHex(String(hex || ''));
  if (b.length !== NOTICE_BYTES + 64 && b.length !== NOTICE_BYTES + 128) throw new Error('a notice is its encoding and a 64-byte signature, and its anchor\'s txid and block hash if it names one');
  const d = { ...decodeDeparture(b.slice(0, NOTICE_BYTES)), signature: b.slice(NOTICE_BYTES, NOTICE_BYTES + 64) };
  if (b.length > NOTICE_BYTES + 64) d.anchor = { txid: toHex(b.slice(NOTICE_BYTES + 64, NOTICE_BYTES + 96)), blockHash: toHex(b.slice(NOTICE_BYTES + 96)) };
  return d;
}
/**
 * THE ANCHOR READ ON THIS SEAT'S CHAIN (kanban #2608): `confirmedTx(txidHex, blockHashHex)` -> { raw, height } or null (main.js: the
 * block on this bitcoind's main chain). Answers the notice with `anchor.height` set when that transaction carries its "ARN" 'L' anchor,
 * else the notice with no anchor height (it does not count past the gate). Any time: no freshness window.
 */
export async function readAnchor(d, confirmedTx) {
  if (!d || !d.anchor || typeof confirmedTx !== 'function') return d;
  const { txid, blockHash } = d.anchor;
  let tx = null; try { tx = await confirmedTx(txid, blockHash); } catch { tx = null; }
  const a = tx ? departureAnchorOf({ raw: tx.raw, height: tx.height, notice: d }) : { ok: false };
  // THE NOTICE AS THE CHAIN CARRIES IT (kanban #2612): its signature is the one in the anchor, checked when the notice is taken
  return a.ok && a.txid === txid ? { ...d, signature: a.signature, anchor: { txid, blockHash, height: a.postedHeight } } : { ...d, anchor: { txid, blockHash } };
}
const anchorHeightOf = (d) => (d && d.anchor && Number.isInteger(d.anchor.height) ? d.anchor.height : null);

// AN OWNER'S EMERGENCY LEAVE REQUEST travels the same way (§23A.5a, protocol 17): (node_key, emergency_key, posted_at), signed by the
// emergency key; whether the node's advertisement names that key is the census's to say (emergency.js emergencyDepartureStands)
export const emergencyHex = (d) => toHex(encodeEmergencyDeparture(d)) + toHex(d.signature);
export function readEmergencyHex(hex) {
  const b = fromHex(String(hex || ''));
  if (b.length < 65) throw new Error('a leave request is its encoding and a 64-byte signature');
  return { ...decodeEmergencyDeparture(b.slice(0, b.length - 64)), signature: b.slice(b.length - 64) };
}

/** The notice of `notices` that stands for `peerKey` against `record` and is due at `height` (the earliest leave_after). */
// `gate`: the network's DEPARTURE_ANCHOR_HEIGHT (absence.js; null: the old rule) - at or above it each notice counts from its anchor's height
export function dueDeparture(notices, { record, peerKey, departureNotice, height, verify, gate = null }) {
  let best = null; let why = 'no notice from that guardian';
  for (const d of notices || []) {
    if (toHex(d.peerKey) !== toHex(peerKey)) continue;
    const st = departureStands(d, { record, departureNotice, verify, height, gate, anchorHeight: anchorHeightOf(d) });
    if (!st.ok) { why = st.why; continue; }
    if (d.leaveAfterHeight > height) { why = `it leaves after ${d.leaveAfterHeight}, the record is at ${height}`; continue; }
    if (!best || d.leaveAfterHeight < best.leaveAfterHeight) best = d;
  }
  return best ? { ok: true, notice: best, sinceHeight: best.leaveAfterHeight, id: departureId(best) } : { ok: false, why };
}

// `nodeOf(fidHex, peerHex)`: the node key (hex) the federation record this seat holds names for that guardian, or null (kanban #1222)
// `guardiansOf(fidHex)`: the node keys (hex) of the guardians the federation record this seat holds names, or null when it holds none (kanban #1384)
// NOT FILLED BY ANYONE (kanban #1384, audit 2 #1204 FED-B4): 4096 self-signed attestations from random keys made every seat refuse a real guardian's
// first one ("as many as it keeps") - a dead guardian was never proven ABANDONED. Now an attestation about a federation whose record this seat holds
// is taken only from a guardian of that record about a peer of it, bounded per federation; one about a federation it holds no record of (a seat
// just restarted, a founding) goes into a small bucket of its own, so what fills that bucket never crowds out a held federation's guardians.
export const UNKNOWN_FEDERATION_MAX = 512;
// THE CHAIN READ FOR ANCHORED NOTICES (kanban #2612): a first pass starts a week below the tip; each pass reads the newest 6 again
export const SCAN_LOOKBACK = 1008;
export const SCAN_RESCAN = 6;
// `confirmedTx`, `anchorGate` (kanban #2608): the anchor read on this seat's chain (readAnchor) and the network's DEPARTURE_ANCHOR_HEIGHT
export function createAbsences({ verify, max = 4096, store = null, nodeOf = null, guardiansOf = null, unknownMax = UNKNOWN_FEDERATION_MAX, confirmedTx = null, anchorGate = null }) {
  const notices = new Map();                 // `${fid}:${peer}` -> departure notice (one per guardian: the latest posted)
  const emergencies = new Map();             // node key -> the owner's emergency leave request (one per node: the EARLIEST posted)
  const held = new Map();                    // `${fid}:${peer}:${attester}` -> attestation (the newest height)
  // KEPT ACROSS A RESTART (measured live 2026-10-15: the founding seats restarted after B7's notice held 0 departures,
  // and the founding it triggers never started): `store` { read() -> { departures: [hex], absences: [hex] }, write(that) } - every
  // kept notice and attestation is written, and read back at start through the same checks (each signature verified again)
  let loading = false;
  // each notice with its anchor reference, and the height this seat read that anchor at (its own chain's word, kanban #2608)
  const save = () => { if (!store || loading) return; try { store.write({ departures: [...notices.values()].map(departureHex), absences: [...held.values()].map(absenceHex),
    emergencies: [...emergencies.values()].map(emergencyHex),
    departureAnchors: Object.fromEntries([...notices.values()].filter((d) => anchorHeightOf(d) !== null).map((d) => [toHex(departureId(d)), d.anchor])),
    departuresScannedTo: scannedTo }); } catch { /* kept in memory */ } };
  let scannedTo = null;                      // the highest block whose anchored notices this seat has read (kanban #2612)

  // the guardians a held record names for `fidHex` (a Set of node key hex), or null: no record held (or no way to ask)
  const membersOf = (fidHex) => { if (typeof guardiansOf !== 'function') return null; let g = null; try { g = guardiansOf(fidHex); } catch { g = null; } return Array.isArray(g) ? new Set(g.map((x) => String(x).toLowerCase())) : null; };
  const countOf = (map, fidHex) => { let n = 0; for (const k of map.keys()) if (k.startsWith(`${fidHex}:`)) n++; return n; };
  const unknownCount = (map) => { let n = 0; for (const k of map.keys()) if (membersOf(k.split(':')[0]) === null) n++; return n; };
  /** Takes one attestation, signed by its attester - from a guardian of the federation's held record about a peer of it (kanban #1384). */
  function offer(a) {
    if (!verify(a.signature, absenceId(a), a.attester)) return { ok: false, why: 'the attestation is not signed by its attester' };
    const fid = toHex(a.federationId);
    const members = membersOf(fid);
    if (members) {
      if (!members.has(toHex(a.attester))) return { ok: false, why: 'the attester is no guardian of the federation record this seat holds' };
      let peerNode = null; try { peerNode = typeof nodeOf === 'function' ? nodeOf(fid, toHex(a.peerKey)) : null; } catch { peerNode = null; }
      if (typeof nodeOf === 'function' && !peerNode) return { ok: false, why: 'the attestation is about a peer the federation record this seat holds does not name' };
    }
    const k = `${fid}:${toHex(a.peerKey)}:${toHex(a.attester)}`;
    const had = held.get(k);
    if (had && had.height >= a.height) return { ok: true, kept: false };
    if (!had && members && countOf(held, fid) >= max) return { ok: false, why: 'this seat holds as many attestations of that federation as it keeps' };
    if (!had && !members && (loading ? countOf(held, fid) >= max : (typeof guardiansOf === 'function' ? unknownCount(held) >= unknownMax : held.size >= max))) return { ok: false, why: 'this seat holds as many attestations as it keeps' };
    held.set(k, a);
    save();
    return { ok: true, kept: true };
  }
  const about = (fidHex, peerHex) => [...held.entries()].filter(([k]) => k.startsWith(`${fidHex}:${peerHex}:`)).map(([, a]) => a);
  /** The proof the held attestations make about `peerKey` against `record`, or why not. */
  const proofFor = (record, peerKey, abandonBlocks) => abandonmentProof(about(toHex(record.federationId), toHex(peerKey)), { record, peerKey, abandonBlocks, verify });
  /** Takes a guardian's departure notice, signed by the node key it names (whether that is the peer's is the record's to say). */
  function offerDeparture(d) {
    if (!verify(d.signature, departureId(d), d.nodePubkey)) return { ok: false, why: 'the notice is not signed by the node key it names' };
    // ONE NOTICE PER GUARDIAN'S NODE KEY (kanban #1222, audit 2 #1204 FED-B1): keyed by (federation, peer) alone and the newest winning, a
    // notice anyone signed with a key of their own and a later posted_at displaced the guardian's real one - and the leaver was recorded
    // ABANDONED. Now a notice from another node key than the record names for that guardian is refused, and each node key keeps its own.
    let named = null; try { named = typeof nodeOf === 'function' ? nodeOf(toHex(d.federationId), toHex(d.peerKey)) : null; } catch { named = null; }
    if (named && String(named).toLowerCase() !== toHex(d.nodePubkey)) return { ok: false, why: 'the notice is signed by another node key than the federation record names for that guardian' };
    // ABOUT A HELD RECORD, ONLY ITS OWN GUARDIANS (kanban #1384): a record this seat holds that does not name that peer refuses the notice
    const fid = toHex(d.federationId), members = membersOf(fid);
    if (members && !named) return { ok: false, why: 'the notice is about a peer the federation record this seat holds does not name' };
    const k = `${fid}:${toHex(d.peerKey)}:${toHex(d.nodePubkey)}`;
    const had = notices.get(k);
    // THE SAME NOTICE, ANCHORED NOW (kanban #2608): a copy whose anchor this seat read on its chain replaces one with none, or a later one
    const sameId = had && toHex(departureId(had)) === toHex(departureId(d));
    const anchoredBetter = sameId && anchorHeightOf(d) !== null && (anchorHeightOf(had) === null || anchorHeightOf(d) < anchorHeightOf(had));
    if (had && had.postedAt >= d.postedAt && !anchoredBetter) return { ok: true, kept: false };
    if (!had && members && countOf(notices, fid) >= max) return { ok: false, why: 'this seat holds as many notices of that federation as it keeps' };
    if (!had && !members && (loading ? countOf(notices, fid) >= max : (typeof guardiansOf === 'function' ? unknownCount(notices) >= unknownMax : notices.size >= max))) return { ok: false, why: 'this seat holds as many notices as it keeps' };
    notices.set(k, d);
    save();
    return { ok: true, kept: true };
  }
  /**
   * Takes an owner's emergency leave request, signed by the emergency key it names (§23A.5a). The earliest one is kept: it is the one
   * that decides whether a guardian left in time, and a later copy cannot move it. Answers { ok, kept } or why not.
   */
  function offerEmergency(d) {
    if (!verify(d.signature, emergencyDepartureId(d), d.emergencyPubkey)) return { ok: false, why: 'the request is not signed by the emergency key it names' };
    const k = toHex(d.nodePubkey);
    const had = emergencies.get(k);
    if (had && had.postedAt <= d.postedAt) return { ok: true, kept: false };
    if (!had && emergencies.size >= max) return { ok: false, why: 'this seat holds as many leave requests as it keeps' };
    emergencies.set(k, d);
    save();
    return { ok: true, kept: true };
  }
  const emergencyFor = (nodeKey) => emergencies.get(typeof nodeKey === 'string' ? nodeKey.toLowerCase() : toHex(nodeKey)) || null;
  const listEmergencies = () => [...emergencies.values()].map(emergencyHex);
  const departureFor = (record, peerKey, departureNotice, height) => dueDeparture([...notices.entries()].filter(([k]) => k.startsWith(`${toHex(record.federationId)}:${toHex(peerKey)}:`)).map(([, d]) => d),
    { record, peerKey, departureNotice, height, verify, gate: anchorGate });
  /** A notice with its anchor read on this seat's chain (readAnchor), then taken: POST /departure and a peer's pull (kanban #2608). */
  const anchorDeparture = (d) => readAnchor(d, confirmedTx);
  async function offerAnchored(d) { return offerDeparture(await anchorDeparture(d)); }
  /**
   * THE NOTICES ON THIS SEAT'S CHAIN (kanban #2612, feedback #041): an anchor carries the whole notice, so each seat reads every block
   * from the gate on and takes each anchored notice at its block's height - a guardian cannot anchor in secret and show the notice when
   * its period is over: the federation sees it from the anchor's block. `chain` { tipHeight(), blockHashAt(h) -> hash | null,
   * departuresAt(h, hash) -> [{ notice, txid, height }] } (main.js: the raw block from bitcoind). At most `max` blocks a pass; the newest
   * RESCAN blocks are read again (a reorg near the tip puts a notice in another block); a first pass starts LOOKBACK below the tip.
   * An RPC that does not answer stops the pass, nothing skipped. Answers { from, to, found, took }.
   */
  async function scanDepartures(chain, { max: most = 64 } = {}) {
    const out = { from: null, to: null, found: 0, took: 0 };
    if (!chain || !Number.isInteger(anchorGate)) return out;
    const tip = Number(await chain.tipHeight());
    if (!Number.isInteger(tip) || !anchorRequired(anchorGate, tip)) return out;
    const start = Math.max(anchorGate, Number.isInteger(scannedTo) ? Math.min(scannedTo + 1, tip - SCAN_RESCAN + 1) : tip - SCAN_LOOKBACK);
    out.from = start;
    for (let h = start; h <= tip && h < start + most; h++) {
      const hash = await chain.blockHashAt(h);
      if (!hash) break;
      for (const f of (await chain.departuresAt(h, String(hash))) || []) {
        out.found++;
        const r = offerDeparture({ ...f.notice, anchor: { txid: String(f.txid), blockHash: String(hash), height: h } });
        if (r.ok && r.kept) out.took++;
      }
      out.to = h;
      if (!Number.isInteger(scannedTo) || h > scannedTo) scannedTo = h;
    }
    save();
    return out;
  }
  /** The held notices as objects, each with the anchor height this seat read (the wire form never carries one) - the founding's triggers (kanban #2612). */
  const departureNotices = (fidHex) => [...notices.entries()].filter(([k]) => !fidHex || k.startsWith(`${fidHex}:`)).map(([, d]) => ({ ...d, anchor: d.anchor ? { ...d.anchor } : undefined }));
  const listDepartures = (fidHex) => [...notices.entries()].filter(([k]) => !fidHex || k.startsWith(`${fidHex}:`)).map(([, d]) => departureHex(d));
  const list = (fidHex) => [...held.entries()].filter(([k]) => !fidHex || k.startsWith(`${fidHex}:`)).map(([, a]) => absenceHex(a));
  // READ BACK WHOLE AT A RESTART (kanban #1404, audit 5 #1399): the store is read while the seat holds no federation record yet (server.js restores
  // them later), so guardiansOf answered null for every kept entry and all of them went into the 512 bucket for unknown federations - the rest were
  // dropped, and the next save wrote the cut set: ABANDONED proofs and departure notices lost at each restart. What this seat wrote was taken
  // through every check when it came; read back, each signature is verified again and each federation is bounded by `max` as a held one is.
  if (store) {
    let had = null; try { had = store.read(); } catch { had = null; }
    loading = true;
    const anchors = (had && had.departureAnchors) || {};
    if (had && Number.isInteger(had.departuresScannedTo)) scannedTo = had.departuresScannedTo;
    for (const h of (had && had.departures) || []) {
      try {
        const d = readDepartureHex(h);
        const a = anchors[toHex(departureId(d))];
        if (d.anchor && a && a.txid === d.anchor.txid && a.blockHash === d.anchor.blockHash && Number.isInteger(a.height)) d.anchor.height = a.height;
        offerDeparture(d);
      } catch { /* not one */ }
    }
    for (const h of (had && had.absences) || []) { try { offer(readAbsenceHex(h)); } catch { /* not one */ } }
    for (const h of (had && had.emergencies) || []) { try { offerEmergency(readEmergencyHex(h)); } catch { /* not one */ } }
    loading = false;
  }
  /** Whether this seat keeps a notice of node `nodeHex` for (federation, peer) - the leaver's own check that its notice is made (kanban #1379). */
  const heldDeparture = (fidHex, peerHex, nodeHex) => notices.has(`${String(fidHex).toLowerCase()}:${String(peerHex).toLowerCase()}:${String(nodeHex).toLowerCase()}`);
  return { offer, proofFor, list, offerDeparture, offerAnchored, anchorDeparture, anchorGate, scanDepartures, scannedTo: () => scannedTo, departureNotices, departureFor, listDepartures, heldDeparture, offerEmergency, emergencyFor, listEmergencies };
}
