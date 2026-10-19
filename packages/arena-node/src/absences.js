// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// ABSENCE ATTESTATIONS A SEAT HOLDS (spec §23A.4): each guardian signs, once a day while it lasts, that it has not
// seen a peer in consensus since a height (absence.js). A seat takes them (POST /absence), keeps per federation, peer and
// attester the newest one, and answers whether they make an abandonment proof against a record - 2f + 1 distinct guardians,
// for at least abandon_blocks. The record's gone[] takes that peer ABANDONED with the proof's since-height and id.
//
// An attestation travels as its encoding followed by its 64-byte signature, in hex (`absenceHex`), so the second ask of a
// record gathering hands every guardian seat exactly the set the proof was made of, and each one checks it on its own.
import { encodeAbsence, decodeAbsence, absenceId, abandonmentProof, encodeDeparture, decodeDeparture, departureId, departureStands } from '../../arena-protocol/src/absence.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

export const absenceHex = (a) => toHex(encodeAbsence(a)) + toHex(a.signature);
export function readAbsenceHex(hex) {
  const b = fromHex(String(hex || ''));
  if (b.length < 65) throw new Error('an attestation is its encoding and a 64-byte signature');
  return { ...decodeAbsence(b.slice(0, b.length - 64)), signature: b.slice(b.length - 64) };
}

// A DEPARTURE NOTICE travels the same way (§23A.5, RULED 2026-09-21: "Leaving is legitimate"): the leaving guardian's
// own signed (federation_id, peer, leave_after_height); from leave_after on the record has it DEPARTED, its bond untouched
export const departureHex = (d) => toHex(encodeDeparture(d)) + toHex(d.signature);
export function readDepartureHex(hex) {
  const b = fromHex(String(hex || ''));
  if (b.length < 65) throw new Error('a notice is its encoding and a 64-byte signature');
  return { ...decodeDeparture(b.slice(0, b.length - 64)), signature: b.slice(b.length - 64) };
}

/** The notice of `notices` that stands for `peerKey` against `record` and is due at `height` (the earliest leave_after). */
export function dueDeparture(notices, { record, peerKey, departureNotice, height, verify }) {
  let best = null; let why = 'no notice from that guardian';
  for (const d of notices || []) {
    if (toHex(d.peerKey) !== toHex(peerKey)) continue;
    const st = departureStands(d, { record, departureNotice, verify });
    if (!st.ok) { why = st.why; continue; }
    if (d.leaveAfterHeight > height) { why = `it leaves after ${d.leaveAfterHeight}, the record is at ${height}`; continue; }
    if (!best || d.leaveAfterHeight < best.leaveAfterHeight) best = d;
  }
  return best ? { ok: true, notice: best, sinceHeight: best.leaveAfterHeight, id: departureId(best) } : { ok: false, why };
}

export function createAbsences({ verify, max = 4096, store = null }) {
  const notices = new Map();                 // `${fid}:${peer}` -> departure notice (one per guardian: the latest posted)
  const held = new Map();                    // `${fid}:${peer}:${attester}` -> attestation (the newest height)
  // KEPT ACROSS A RESTART (measured live 2026-10-15: the founding seats restarted after B7's notice held 0 departures,
  // and the founding it triggers never started): `store` { read() -> { departures: [hex], absences: [hex] }, write(that) } - every
  // kept notice and attestation is written, and read back at start through the same checks (each signature verified again)
  let loading = false;
  const save = () => { if (!store || loading) return; try { store.write({ departures: [...notices.values()].map(departureHex), absences: [...held.values()].map(absenceHex) }); } catch { /* kept in memory */ } };

  /** Takes one attestation; it must be signed by its attester (whether that is a guardian is the record's to say). */
  function offer(a) {
    if (!verify(a.signature, absenceId(a), a.attester)) return { ok: false, why: 'the attestation is not signed by its attester' };
    const k = `${toHex(a.federationId)}:${toHex(a.peerKey)}:${toHex(a.attester)}`;
    const had = held.get(k);
    if (had && had.height >= a.height) return { ok: true, kept: false };
    if (!had && held.size >= max) return { ok: false, why: 'this seat holds as many attestations as it keeps' };
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
    const k = `${toHex(d.federationId)}:${toHex(d.peerKey)}`;
    const had = notices.get(k);
    if (had && had.postedAt >= d.postedAt) return { ok: true, kept: false };
    if (!had && notices.size >= max) return { ok: false, why: 'this seat holds as many notices as it keeps' };
    notices.set(k, d);
    save();
    return { ok: true, kept: true };
  }
  const departureFor = (record, peerKey, departureNotice, height) => dueDeparture([notices.get(`${toHex(record.federationId)}:${toHex(peerKey)}`)].filter(Boolean),
    { record, peerKey, departureNotice, height, verify });
  const listDepartures = (fidHex) => [...notices.entries()].filter(([k]) => !fidHex || k.startsWith(`${fidHex}:`)).map(([, d]) => departureHex(d));
  const list = (fidHex) => [...held.entries()].filter(([k]) => !fidHex || k.startsWith(`${fidHex}:`)).map(([, a]) => absenceHex(a));
  if (store) {
    let had = null; try { had = store.read(); } catch { had = null; }
    loading = true;
    for (const h of (had && had.departures) || []) { try { offerDeparture(readDepartureHex(h)); } catch { /* not one */ } }
    for (const h of (had && had.absences) || []) { try { offer(readAbsenceHex(h)); } catch { /* not one */ } }
    loading = false;
  }
  return { offer, proofFor, list, offerDeparture, departureFor, listDepartures };
}
