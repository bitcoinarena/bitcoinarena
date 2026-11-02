// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHAT A SEAT READS BEFORE IT DRAWS A FOUNDING UNDER PRESSURE (spec §23A.3a, kanban #993/#1023): B*_net from the federation records in
// force at trigger_height - 12, or null.
//
//   BONDS      the census at trigger_height, as the draw reads it; only the federations it names are read here
//   RECORDS    not "the newest I hold": each federation's records at or below that height, from this seat and every seat it can reach,
//              each verified at threshold against the census at the record's own height. The highest verified one is used. A record
//              cannot be forged, so a seat that hides one changes nothing when another seat has it
//   NONE THERE a federation the census names with no record at that height throws, and the seat starts no founding yet
//   THE BAND   foundingPressureBond, on those records alone; never capacityBand's `was` or network.band
//
// What is left: a record that reaches some seats late gives them another B*_net. The founding's id covers it, so they name another founding
// and it goes void. It cannot seat anyone wrongly.
import { schnorr } from '@noble/curves/secp256k1.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { foundingPressureBond } from '../../arena-protocol/src/capacity.js';
import { foundingRecordHeight } from '../../arena-protocol/src/guardian-founding.js';
import { decodeFederationRecord, federationRecordId, splitSignedRecord, verifyFederationRecord } from '../../arena-protocol/src/federation-record.js';
import { federationsOf } from './federation-records.js';

/** How many seats are asked at a time, and how long each has. */
const ASK_AT_ONCE = 8, ASK_MS = 8000;
const decodes = (hex) => { try { return decodeFederationRecord(splitSignedRecord(fromHex(String(hex))).body); } catch { return null; } };
const idOf = (record) => toHex(federationRecordId(record));

/**
 * Of a federation's verified records, the one a draw uses: the highest height. Two can stand at one height, since a record's reserve is
 * read when it is gathered: a CLOSED one first, as federation-records.js keeps it, then the lowest record id, so the seats that hold both
 * pick the same one.
 */
export function highestVerified(rows) {
  let best = null;
  for (const x of rows) {
    if (!best || x.record.height > best.record.height) { best = x; continue; }
    if (x.record.height !== best.record.height) continue;
    const closed = (y) => y.status === 'CLOSED';
    if (closed(x) !== closed(best)) { if (closed(x)) best = x; continue; }
    if (idOf(x.record) < idOf(best.record)) best = x;
  }
  return best;
}

/**
 * `point` this network's FOUNDING_PRESSURE_HEIGHT; `held(fidHex, height)` this seat's record in force there, hex or null; `seats()` the seats'
 * base URLs; `censusAt(height)` the census entries there or null; `inviteFederationId`, `networkId`, `verify` as verifyFederationRecord takes
 * them. Answers an async ({ height, entries }) -> B*_net or null, for createFoundingSeat's pressureBondAt. An answer is kept per trigger
 * height: a seat that started a founding again in the same trigger must not name another one.
 */
export function foundingPressureReader({ point, bondMinGuardian, held = () => null, seats = () => [], censusAt, inviteFederationId, networkId = null, fetcher = fetch,
  verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } } }) {
  const answers = new Map();
  async function asked(height, fids) {
    const list = [...new Set((seats() || []).map((u) => String(u).replace(/\/+$/, '')))];
    const found = new Map(fids.map((f) => [f, new Set()]));
    for (const f of fids) { const own = held(f, height); if (own) found.get(f).add(String(own).toLowerCase()); }
    const one = async (base) => {
      try {
        const r = await fetcher(`${base}/federation-records-at?height=${height}&federations=${fids.join(',')}`, { signal: AbortSignal.timeout(ASK_MS) });
        if (!r.ok) return;
        const j = await r.json();
        for (const x of (j && j.records) || []) { const had = found.get(String(x && x.federation).toLowerCase()); if (had && x.record) had.add(String(x.record).toLowerCase()); }
      } catch { /* a seat out of reach: the others */ }
    };
    for (let i = 0; i < list.length; i += ASK_AT_ONCE) await Promise.all(list.slice(i, i + ASK_AT_ONCE).map(one));
    return found;
  }
  return async function pressureBondAt({ height, entries }) {
    const at = foundingRecordHeight(height, point);
    if (at === null) return null;
    if (answers.has(height)) return answers.get(height);
    const fids = federationsOf({ entries }).map(toHex).sort();
    if (!fids.length) { answers.set(height, null); return null; }
    const found = await asked(at, fids);
    const census = new Map();
    const censusOf = (h) => { if (!census.has(h)) census.set(h, Promise.resolve().then(() => censusAt(h)).catch(() => null)); return census.get(h); };
    const federations = [];
    for (const fid of fids) {
      const good = [];
      for (const hex of found.get(fid)) {
        const r = decodes(hex);
        if (!r || toHex(r.federationId) !== fid || r.height > at) continue;   // only what the height allows, whoever sent it
        const entriesThere = await censusOf(r.height);
        if (!entriesThere) continue;
        const v = verifyFederationRecord(fromHex(hex), { census: entriesThere, verify, inviteFederationId, networkId });
        if (v.ok) good.push(v);
      }
      const best = highestVerified(good);
      if (!best) throw new Error(`federation ${fid.slice(0, 16)}, named in the census at ${height}, has no record at or below ${at}: no draw yet`);
      federations.push({ federation: fid, status: best.status, nominal: best.record.nominal, reserveSats: best.record.reserveSats, exposureCapSats: best.record.exposureCapSats });
    }
    const bond = foundingPressureBond({ federations, bondMinSats: bondMinGuardian });
    answers.set(height, bond);
    return bond;
  };
}
