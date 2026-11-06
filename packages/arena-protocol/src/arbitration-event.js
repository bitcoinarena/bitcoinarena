// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AN EVENT OF THE ARBITRATION SET, CHECKED (kanban #723; kanban #1148): the bytes the set's members sign and the check that k of them did -
// shared by the seats (arena-node arbitration-events.js keeps and hands them on) and the page (arena-client liquidation-claim.js acts on a
// liquidation only when its event stands). One copy, so a seat and a browser can never read the same event differently.
import { taggedHash, fromHex } from './hash.js';
import { liquidationSchedule, clocksFor } from './federation-slash.js';

export const EVENT_KINDS = ['liquidation', 'slash'];
const EVENT_SUBJECT_HEX = /^[0-9a-f]{64}$/;
export const MAX_EVENT_BYTES = 512 * 1024;

/** JSON with every object's keys in order: the bytes the members sign are the same on every machine. */
export function canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : typeof v === 'bigint' ? String(v) : v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
}
export const eventMessage = (event) => taggedHash('BLWP/v1/ArbitrationEvent', new TextEncoder().encode(canonicalJson(event)));
export const subjectOf = (event) => (event && event.kind === 'slash' ? event.proof : event ? event.federation : null);
export const eventKey = (event) => `${event.kind}:${subjectOf(event)}`;

const arbitrationKeyHex = (x) => (typeof x === 'string' ? x.toLowerCase() : Array.from(x, (b) => b.toString(16).padStart(2, '0')).join(''));

/** Does a published event stand: its shape, and k valid signatures of distinct members of `keys` over it? */
export function eventStands(said, { keys, k, verify }) {
  const e = said && said.event;
  if (!e || typeof e !== 'object' || !EVENT_KINDS.includes(e.kind)) return { ok: false, why: `an event is one of ${EVENT_KINDS.join(', ')}` };
  if (!EVENT_SUBJECT_HEX.test(String(subjectOf(e) || ''))) return { ok: false, why: e.kind === 'slash' ? 'a slash names its proof (64 hex)' : 'a liquidation names its federation (64 hex)' };
  if (!Number.isFinite(e.atMs) || !Number.isFinite(e.firstMs)) return { ok: false, why: 'an event says when it was first made and last changed (firstMs, atMs)' };
  if (canonicalJson(e).length > MAX_EVENT_BYTES) return { ok: false, why: 'that event is too large' };
  if (!Number.isInteger(k) || k < 1) return { ok: false, why: 'no arbitration threshold is known for this chain' };
  const members = new Set((keys || []).map(arbitrationKeyHex));
  const msg = eventMessage(e);
  const good = new Set();
  for (const s of Array.isArray(said.signatures) ? said.signatures : []) {
    const key = String((s && s.key) || '').toLowerCase();
    if (!members.has(key) || good.has(key) || !/^[0-9a-f]{128}$/.test(String(s.sig || ''))) continue;
    let ok = false;
    try { ok = verify(fromHex(s.sig), msg, fromHex(key)); } catch { ok = false; }
    if (ok) good.add(key);
  }
  if (good.size < k) return { ok: false, why: `${good.size} valid signatures of the arbitration set, and an event needs ${k}` };
  return { ok: true, signers: good.size };
}

/** A claims door the set may name: an https URL (http only on regtest, whose set runs on a private machine). */
export function doorOk(door, network) {
  let u;
  try { u = new URL(String(door)); } catch { return false; }
  return u.protocol === 'https:' || (network === 'regtest' && u.protocol === 'http:');
}

/**
 * THE LIQUIDATION A BROWSER MAY ACT ON (kanban #1148): of `events` (the { event, signatures } rows any seat lists at GET /liquidations), the
 * newest liquidation of `federation` on `network` that k of the arbitration set's `keys` signed, that names the set's claims door (`door`)
 * and its halt height. Its claim window comes from that signed halt height and the network's pinned clocks - never from a seat's word.
 * Answers { ok, event, door, window: { opens, closes } } or { ok: false, why }. A seat can withhold an event; it cannot make one.
 */
export function standingLiquidation({ events, federation, network, keys, k, verify }) {
  const fid = String(federation || '').toLowerCase();
  const mine = (Array.isArray(events) ? events : []).filter((r) => r && r.event && r.event.kind === 'liquidation' && String(r.event.federation || '').toLowerCase() === fid)
    .sort((a, b) => Number(b.event.atMs) - Number(a.event.atMs));
  if (!mine.length) return { ok: false, why: 'the arbitration set has published no liquidation of that federation' };
  let why = null;
  for (const r of mine) {
    const st = eventStands(r, { keys, k, verify });
    if (!st.ok) { why = why || st.why; continue; }
    const e = r.event;
    if (e.network !== network) { why = why || `that liquidation is of ${e.network}, and this page runs on ${network}`; continue; }
    if (!doorOk(e.door, network)) { why = why || 'the signed liquidation names no claims door of the arbitration set'; continue; }
    const h = e.halt && e.halt.height;
    const c = clocksFor(network);
    if (!c.ok) return { ok: false, why: c.why };
    const when = liquidationSchedule({ haltHeight: h, clocks: c.clocks });
    if (!when.ok) { why = why || `the signed liquidation names no halt height: ${when.why}`; continue; }
    return { ok: true, event: e, signers: st.signers, door: String(e.door).replace(/\/+$/, '').replace(/\/liquidation-claims$/, ''),
      // the last height a claim is still paid at: the late-claim tail where a line has one (1.9: halt + drain_blocks), else the close
      window: { opens: when.claimWindowOpens, closes: Number.isInteger(when.lateClaimsUntil) ? when.lateClaimsUntil : when.claimWindowCloses } };
  }
  return { ok: false, why };
}

/** The claims the set's signed event lists as accepted for `payoutPk` (64 hex): what makes a kept claim taken. */
export const acceptedFor = (event, payoutPk) => ((event && event.claims && Array.isArray(event.claims.accepted)) ? event.claims.accepted : [])
  .filter((c) => String(c && c.payoutPk || '').toLowerCase() === String(payoutPk || '').toLowerCase());
