// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ARBITRATION SET'S EVENTS, PUBLISHED (kanban #723, the owner 2026-10-27: "Sind die Transaktionen alle im Explorer zu sehen als liquidation
// event?" - "Ja soll es"): a liquidation and a slash lived only in the arbiter's own state file on one machine, so nobody could see what the
// set did with an escrow, and the explorer found none of its transactions. Now the set says each one as an EVENT - every step with its
// amount and its transaction - signed by k of its members, and posts it to the seats; every seat checks the signatures against its
// genesis' arbitration keys, keeps the newest version of each event across restarts, hands it on to the other seats, and lists them all
// at GET /liquidations (`events`), so the explorer reads them from any seat.
//
//   liquidation  { kind, network, federation, firstMs, atMs, status,
//                  halt: { height, proof: { session, observers, abandoned, id } | null },
//                  escrow: { outpoint, sats, txid (bitcoin: the escrow into the safe federation), address, into, claimedMsat, atMs, claimedAtMs },
//                  claims: { accepted: [{ nonce, amountMsat, height, payoutPk }], refused: [{ nonce, why, height }], msat },
//                  payouts: [{ payoutPk, msat, txid (federation), outIdx, federation, atMs }],
//                  remainder: { txid (federation), msat, federation, atMs, payees: n, payouts: [{ part: reserves, payoutPk, msat, outIdx }] } | null }
//   slash        { kind, network, proof, node, round, entry, firstMs, atMs, status, txid (bitcoin: path B), slashHeight, signers,
//                  sats: { bond, escrow }, msat: { players, reserves }, escrows: [{ txid (bitcoin), keptSats, pegIns: [{ federation, sats, claimedMsat }] }],
//                  payouts: [{ refundPk, msat, txid (federation), outIdx, round, entry, federation }],
//                  reserves: [{ federation, reserveKey, msat, txid (federation), outIdx }] }
// An event is named by its kind and its subject (the federation liquidated, the slash proof); a newer `atMs` replaces the one kept.
import { taggedHash, toHex, fromHex } from '../../arena-protocol/src/hash.js';

export const EVENT_KINDS = ['liquidation', 'slash'];
const hex64 = /^[0-9a-f]{64}$/;
const MAX_EVENT_BYTES = 512 * 1024;
const MAX_EVENTS = 2000;

/** JSON with every object's keys in order: the bytes the members sign are the same on every machine. */
export function canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : typeof v === 'bigint' ? String(v) : v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
}
export const eventMessage = (event) => taggedHash('BLWP/v1/ArbitrationEvent', new TextEncoder().encode(canonicalJson(event)));
export const subjectOf = (event) => (event && event.kind === 'slash' ? event.proof : event ? event.federation : null);
export const eventKey = (event) => `${event.kind}:${subjectOf(event)}`;

/** The event signed by k members of the set (`set` as arbiter.js arbitrationMembers answers it), each on its own. */
export function signEvent(event, set, sign) {
  const msg = eventMessage(event);
  return { event, signatures: set.members.slice(0, set.k).map((m) => ({ key: toHex(m.key), sig: toHex(sign(m, msg)) })) };
}

/** Does a published event stand: its shape, and k valid signatures of distinct members of `keys` over it? */
export function eventStands(said, { keys, k, verify }) {
  const e = said && said.event;
  if (!e || typeof e !== 'object' || !EVENT_KINDS.includes(e.kind)) return { ok: false, why: `an event is one of ${EVENT_KINDS.join(', ')}` };
  if (!hex64.test(String(subjectOf(e) || ''))) return { ok: false, why: e.kind === 'slash' ? 'a slash names its proof (64 hex)' : 'a liquidation names its federation (64 hex)' };
  if (!Number.isFinite(e.atMs) || !Number.isFinite(e.firstMs)) return { ok: false, why: 'an event says when it was first made and last changed (firstMs, atMs)' };
  if (canonicalJson(e).length > MAX_EVENT_BYTES) return { ok: false, why: 'that event is too large' };
  const members = new Set((keys || []).map((x) => (typeof x === 'string' ? x : toHex(x))));
  const msg = eventMessage(e);
  const good = new Set();
  for (const s of Array.isArray(said.signatures) ? said.signatures : []) {
    const key = String(s && s.key || '').toLowerCase();
    if (!members.has(key) || good.has(key) || !/^[0-9a-f]{128}$/.test(String(s.sig || ''))) continue;
    if (verify(fromHex(s.sig), msg, fromHex(key))) good.add(key);
  }
  if (good.size < k) return { ok: false, why: `${good.size} valid signatures of the arbitration set, and an event needs ${k}` };
  return { ok: true, signers: good.size };
}

/**
 * A SEAT'S BOOK OF THE SET'S EVENTS: `offer({ event, signatures })` keeps one that stands and is newer than the one held under its name;
 * `list()` answers them newest first. `load()` / `save(rows)` keep them across restarts (the seat's file beside its database).
 */
export function createArbitrationEvents({ keys, k, verify, load = () => [], save = () => {} }) {
  const held = new Map();
  try { for (const r of load() || []) if (r && r.event && EVENT_KINDS.includes(r.event.kind)) held.set(eventKey(r.event), r); } catch { /* none kept yet */ }
  function offer(said) {
    if (!keys || !keys.length) return { ok: false, status: 503, why: 'this seat knows no arbitration set for its chain' };
    const st = eventStands(said, { keys, k, verify });
    if (!st.ok) return { ok: false, status: 422, why: st.why };
    const name = eventKey(said.event);
    const had = held.get(name);
    if (had && had.event.atMs >= said.event.atMs) return { ok: true, status: 200, kept: false, why: 'that event is held here already, as new or newer' };
    held.set(name, { event: said.event, signatures: said.signatures.map((s) => ({ key: String(s.key).toLowerCase(), sig: String(s.sig).toLowerCase() })) });
    if (held.size > MAX_EVENTS) {
      const oldest = [...held.entries()].sort((a, b) => a[1].event.atMs - b[1].event.atMs)[0];
      held.delete(oldest[0]);
    }
    save([...held.values()]);
    return { ok: true, status: 201, kept: true, event: name };
  }
  const list = ({ kind = null } = {}) => [...held.values()].filter((r) => !kind || r.event.kind === kind).sort((a, b) => b.event.atMs - a.event.atMs);
  return { offer, list };
}

// ---- the arbiter's side: its state, said as events -------------------------------------------------------------------------------------

const str = (x) => (x === null || x === undefined ? null : String(x));
const n = (x) => (x === null || x === undefined || x === '' ? null : Number(x));

/**
 * A LIQUIDATION AS THE ARBITER'S STATE HOLDS IT (`v`, state.liquidations[fid]), said as an event's body (no times of its own:
 * `firstMs` / `atMs` are the arbiter's, see stampEvent). `claims` are the accepted claims of that federation (the claims book),
 * `liq` the seats' listing of it (halt, proof), `escrowAt` the escrow outpoint "txid:vout", `into` the safe federation paid in.
 */
export function liquidationEvent({ network, fid, v = {}, claims = [], liq = null, escrowAt = null, into = null }) {
  const halt = v.halt || (liq ? { height: n(liq.haltHeight), proof: liq.haltProof ? { session: liq.haltProof.session, observers: liq.haltProof.observers,
    abandoned: liq.haltProof.abandoned || [], id: liq.haltProof.id } : null } : null);
  const accepted = claims.map((c) => ({ nonce: c.nonce, amountMsat: String(c.amountMsat), height: n(c.height), payoutPk: c.payoutPk }))
    .sort((a, b) => (a.nonce < b.nonce ? -1 : 1));
  const intoFed = str(v.into || into);
  const payouts = (v.payouts || []).map((p) => ({ payoutPk: p.payoutPk, msat: String(p.msat), txid: p.txid, outIdx: n(p.outIdx), federation: intoFed, atMs: n(p.atMs) }));
  const rp = (v.remainderPayouts || []).map((p) => ({ part: p.part || null, payoutPk: p.payoutPk, msat: String(p.msat), outIdx: n(p.outIdx) }))
    .sort((a, b) => (a.outIdx ?? 1e9) - (b.outIdx ?? 1e9));
  const remainder = v.remainderTxid ? { txid: v.remainderTxid, msat: str(v.remainderMsat), federation: intoFed, atMs: n(v.remainderAtMs),
    payees: n(v.remainderPayees) ?? rp.length, payouts: rp } : null;
  const status = remainder ? 'paid out' : payouts.length ? 'claims paid, remainder waits' : v.claimedMsat ? 'escrow claimed in the safe federation'
    : v.escrowTxid ? 'escrow sent to the safe federation' : 'claims open';
  return { kind: 'liquidation', network, federation: fid, status, halt,
    escrow: { outpoint: str(escrowAt), sats: str(v.escrowSats), txid: str(v.escrowTxid), address: str(v.pegInAddress), into: intoFed,
      claimedMsat: str(v.claimedMsat), atMs: n(v.escrowAtMs), claimedAtMs: n(v.claimedAtMs) },
    claims: { accepted, refused: (v.refused || []).map((r) => ({ nonce: str(r.nonce), why: str(r.why), height: n(r.height) })),
      msat: String(accepted.reduce((t, c) => t + BigInt(c.amountMsat), 0n)) },
    payouts, remainder };
}

/** A SLASH AS THE ARBITER'S STATE HOLDS IT (`v`, state.handled[proof]) - only one it posted. */
export function slashEvent({ network, proof, v = {} }) {
  const stages = v.stages || [];
  const status = v.settled ? 'paid out' : (stages.length && stages[stages.length - 1].kept && stages[stages.length - 1].done) ? 'part of the escrow waits for room'
    : stages.some((s) => s.pegIns.some((p) => p.claimedMsat)) ? 'escrow claimed in the federation' : stages.length ? 'escrow sent to the federation' : 'posted';
  const paidMsat = (v.reserves || []).reduce((t, r) => t + BigInt(r.msat), 0n);
  return { kind: 'slash', network, proof, ...(v.offence ? { offence: String(v.offence) } : {}), node: str(v.node), round: str(v.round), entry: str(v.entry), status, txid: v.posted, slashHeight: n(v.slashHeight),
    signers: n(v.signers), sats: { bond: str(v.bondSats), escrow: str(v.escrowSats) },
    msat: { players: str(v.playersMsat), reserves: str(stages.length ? paidMsat : v.reservesMsat) },
    escrows: stages.map((s) => ({ txid: str(s.txid), keptSats: str(s.kept && s.kept.sats), pegIns: s.pegIns.map((p) => ({ federation: p.federation, sats: str(p.sats), claimedMsat: str(p.claimedMsat) })) })),
    payouts: (v.payouts || []).map((p) => ({ refundPk: p.refundPk, msat: String(p.msat), txid: p.txid, outIdx: n(p.outIdx), round: p.round || null, entry: p.entry || null, federation: p.federation || null })),
    reserves: (v.reserves || []).map((r) => ({ federation: r.federation, reserveKey: r.reserveKey, msat: String(r.msat), txid: r.txid, outIdx: n(r.outIdx) })) };
}

/**
 * THE TIMES OF AN EVENT: `firstMs` once, `atMs` moved only when the body changed - `kept` ({ hash, firstMs, atMs }, the arbiter's state)
 * is updated in place; answers the event with its times and whether it changed.
 */
export function stampEvent(body, kept, now = Date.now()) {
  const hash = toHex(eventMessage(body));
  const changed = kept.hash !== hash;
  if (changed) { kept.hash = hash; kept.atMs = now; }
  if (!Number.isFinite(kept.firstMs)) kept.firstMs = now;
  return { event: { ...body, firstMs: kept.firstMs, atMs: kept.atMs }, changed };
}

/** Every transaction an event names, bitcoin and federation, for a search by any of them (the explorer). */
export function eventTxids(e) {
  const out = new Set();
  const add = (x) => { if (hex64.test(String(x || ''))) out.add(String(x)); };
  if (e.kind === 'slash') { add(e.txid); for (const x of e.escrows || []) add(x.txid); for (const p of [...(e.payouts || []), ...(e.reserves || [])]) add(p.txid); }
  else { add(e.escrow && e.escrow.txid); add(e.escrow && e.escrow.outpoint && e.escrow.outpoint.split(':')[0]); for (const p of e.payouts || []) add(p.txid); add(e.remainder && e.remainder.txid); }
  return [...out];
}
