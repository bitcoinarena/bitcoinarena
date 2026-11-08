// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHAT A SEAT READS BEFORE IT DRAWS A FOUNDING UNDER PRESSURE (spec §23A.3a, kanban #993/#1023): B*_net from the federation records in
// force at trigger_height - 12, or null.
//
//   BONDS      the census at trigger_height, as the draw reads it; only the federations it names are read here
//   RECORDS    not "the newest I hold": each federation's records at or below that height, from this seat and every seat it can reach,
//              each verified at threshold against the census at the record's own height. The highest verified one is used. A record
//              cannot be forged, so a seat that hides one changes nothing when another seat has it
//   ONLY A RECORD COUNTS  a federation with no verified record at that height is left out and holds nothing back (kanban #1025): a made-up
//              id in an advert never has one, and a federation younger than 12 blocks held no reserve then. No record of any is no pressure
//   NOT YET    only this seat's own unread chain: a record it was given and cannot check, for want of the census at the record's height,
//              throws, and the seat starts no founding yet. It is not left out
//   THE BAND   foundingPressureBond, on those records alone; never capacityBand's `was` or network.band
//
// What is left: a record that reaches some seats late gives them another B*_net. The founding's id covers it, so they name another founding
// and it goes void. It cannot seat anyone wrongly.
import { schnorr } from '@noble/curves/secp256k1.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { foundingPressureBond } from '../../arena-protocol/src/capacity.js';
import { foundingRecordHeight } from '../../arena-protocol/src/guardian-founding.js';
import { decodeFederationRecord, highestVerified, splitSignedRecord, verifyFederationRecord, loadReserveOf } from '../../arena-protocol/src/federation-record.js';
import { federationsOf } from './federation-records.js';

/** How many seats are asked at a time, and how long each has. */
const ASK_AT_ONCE = 8, ASK_MS = 8000;
const decodes = (hex) => { try { return decodeFederationRecord(splitSignedRecord(fromHex(String(hex))).body); } catch { return null; } };
export { highestVerified };

/**
 * `point` this network's FOUNDING_PRESSURE_HEIGHT; `held(fidHex, height)` this seat's record in force there, hex or null; `seats()` the seats'
 * base URLs; `censusAt(height)` the census entries there or null; `inviteFederationId`, `networkId`, `verify` as verifyFederationRecord takes
 * them. Answers an async ({ height, entries }) -> B*_net or null, for createFoundingSeat's pressureBondAt; it throws only while this seat's
 * chain is unread. An answer is kept per trigger height: a seat that started a founding again in the same trigger must not name another one.
 */
export function foundingPressureReader({ point, bandPoint = undefined, bondMinGuardian, held = () => null, seats = () => [], censusAt, inviteFederationId, networkId = null, fetcher = fetch,
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
        if (!entriesThere) throw new Error(`the census at ${r.height} is not read yet, so a record of federation ${fid.slice(0, 16)} cannot be checked: no draw yet`);
        const v = verifyFederationRecord(fromHex(hex), { census: entriesThere, verify, inviteFederationId, networkId, bandPoint });
        if (v.ok) good.push(v);
      }
      const best = highestVerified(good);
      if (!best) continue;
      federations.push({ federation: fid, status: best.status, nominal: best.record.nominal, reserveSats: loadReserveOf(best.record), exposureCapSats: best.record.exposureCapSats, band: best.record.capacityBand || null });
    }
    const bond = federations.length ? foundingPressureBond({ federations, bondMinSats: bondMinGuardian }) : null;
    answers.set(height, bond);
    return bond;
  };
}
