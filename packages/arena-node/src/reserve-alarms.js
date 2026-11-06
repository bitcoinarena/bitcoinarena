// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A FEDERATION'S RESERVE ALARMS, AS ONE SEAT HOLDS THEM (kanban #1093 parts 2 and 5, ruling #1106, 2026-11-03).
//
// A theft by a threshold of guardians leaves one of two objective marks in the federation's threshold-signed history: inflation (more
// e-cash redeemed so far than issued so far) or an unbacked spend (a reserve UTXO spent on the chain, 6 deep, by no peg-out in the signed
// history). "Any seat that sees a mark stops offering deposits into that federation at once, even before anyone has acted on it." This
// book keeps the marks this seat saw, one per federation (the first), with what proves it, so GET /federations lists it beside the record
// and every client stops depositing. It judges nothing itself: the audit of the signed history raises a mark (`raise`).
//
// AN ALARM'S STATES (kanban #1176): one enum, one transition function (`alarmStep`), every write kept before it is answered.
//   RAISED     this seat saw the mark; deposits into the federation stop at once (ruling #1106)
//   CONFIRMED  `confirmSeats` distinct seated nodes (this one among them) signed the same mark (`confirm`); only then does this seat list theft
//              slashes from it (federation-records.js theftSlashes) - one seat's wrong mark no longer files slashes against every guardian
//   WITHDRAWN  the unbacked spend's block left this seat's chain (a reorg: reserve-spend-watch.js); deposits are offered again. An inflation is
//              never withdrawn: its signed sessions do not reorg. A withdrawn federation may be raised again by a new mark.
// It was one-way: the first mark stood for good, and a reorged-away spend refused deposits at that seat forever.
import { createHash } from 'node:crypto';
const isHex = (s, n) => typeof s === 'string' && new RegExp(`^[0-9a-f]{${n}}$`).test(s);
export const ALARM_KINDS = Object.freeze(['inflation', 'unbacked-spend']);
export const ALARM_STATE = Object.freeze({ RAISED: 'RAISED', CONFIRMED: 'CONFIRMED', WITHDRAWN: 'WITHDRAWN' });
/** How many distinct seated nodes must sign one mark before it is CONFIRMED (this seat counts as one). */
export const ALARM_CONFIRM_SEATS = 2;
const stateOf = (a) => (!a ? null : a.state || ALARM_STATE.RAISED);          // a row kept before kanban #1176 is RAISED
const markOf = (a) => (a.kind === 'inflation' ? `session:${a.session}` : String(a.txid).toLowerCase());
/** What a seat signs to say it saw a mark (its node key, BIP340): the federation, the kind and the mark (the spender's txid, or the session). */
export const alarmDigest = (a) => new Uint8Array(createHash('sha256').update(`ARENA/v1/ReserveAlarm:${String(a.federation).toLowerCase()}:${a.kind}:${markOf(a)}`).digest());

/**
 * THE TRANSITION FUNCTION (kanban #1176). `a` the held alarm or null; `ev` one of
 *   { kind: 'raise', alarm }               null | WITHDRAWN -> RAISED (a RAISED or CONFIRMED alarm stands: a later mark is not taken over it)
 *   { kind: 'confirm', by: [node hex], n } RAISED -> CONFIRMED when `by` holds n distinct nodes (each one's signature checked by the caller)
 *   { kind: 'withdraw', txid, why }        RAISED | CONFIRMED -> WITHDRAWN, an unbacked spend only, by its own spender's txid
 * Answers { ok: true, alarm } or { ok: false, why }.
 */
export function alarmStep(a, ev, nowMs = Date.now()) {
  const s = stateOf(a);
  if (ev.kind === 'raise') {
    if (s === ALARM_STATE.RAISED || s === ALARM_STATE.CONFIRMED) return { ok: false, why: 'this federation\'s first alarm stands' };
    return { ok: true, alarm: { ...ev.alarm, state: ALARM_STATE.RAISED, ...(a ? { withdrawnBefore: [...(a.withdrawnBefore || []), markOf(a)] } : {}) } };
  }
  if (ev.kind === 'confirm') {
    if (s !== ALARM_STATE.RAISED) return { ok: false, why: s ? `the alarm is ${s}` : 'no alarm to confirm' };
    const by = [...new Set((ev.by || []).map((x) => String(x).toLowerCase()).filter((x) => isHex(x, 64)))].sort();
    if (by.length < ev.n) return { ok: false, why: `${by.length} of ${ev.n} seats signed this mark` };
    return { ok: true, alarm: { ...a, state: ALARM_STATE.CONFIRMED, confirmedBy: by, confirmedAtMs: nowMs } };
  }
  if (ev.kind === 'withdraw') {
    if (s !== ALARM_STATE.RAISED && s !== ALARM_STATE.CONFIRMED) return { ok: false, why: s ? 'withdrawn already' : 'no alarm to withdraw' };
    if (a.kind !== 'unbacked-spend') return { ok: false, why: 'an inflation is in the signed sessions, and they do not reorg' };
    if (String(ev.txid || '').toLowerCase() !== a.txid) return { ok: false, why: 'the alarm names another spend' };
    return { ok: true, alarm: { ...a, state: ALARM_STATE.WITHDRAWN, withdrawn: String(ev.why || 'its block left the chain'), withdrawnAtMs: nowMs } };
  }
  return { ok: false, why: 'no such step' };
}

/**
 * `save(all)` keeps every alarm (its state with it) and must replace a kept row; `verify(sig, digest, node32)` BIP340 and `isSeat(nodeHex)`
 * (a seated node of the network) check another seat's statement; `me` this seat's node key (hex), counted once for its own mark.
 */
export function createReserveAlarms({ load = () => [], save = () => {}, nowMs = () => Date.now(), me = null, verify = null, isSeat = null, confirmSeats = ALARM_CONFIRM_SEATS } = {}) {
  const held = new Map();                  // federation hex -> alarm, in every state
  for (const a of load() || []) if (a && isHex(a.federation, 64)) held.set(a.federation, a);
  // every write is one alarmStep, kept before it is answered
  const step = (federation, ev) => {
    const s = alarmStep(held.get(federation) || null, ev, nowMs());
    if (!s.ok) return s;
    held.set(federation, s.alarm); save([...held.values()]);
    return s;
  };
  /**
   * A mark seen: { federation (64 hex), kind, height, session? (the signed session where redeemed passed issued), txid? (the unbacked spend),
   * issuedMsat?, redeemedMsat? }. The first standing mark of a federation stands; a later one is not taken over it. Answers { ok, kept, why }.
   */
  function raise(m) {
    const federation = String(m && m.federation || '').toLowerCase();
    if (!isHex(federation, 64)) return { ok: false, why: 'an alarm names its federation (64 hex)' };
    if (!ALARM_KINDS.includes(m.kind)) return { ok: false, why: `an alarm is one of ${ALARM_KINDS.join(', ')}` };
    if (!Number.isInteger(m.height) || m.height < 0) return { ok: false, why: 'an alarm names the height of its mark' };
    if (m.kind === 'inflation' && !Number.isInteger(m.session)) return { ok: false, why: 'an inflation names the signed session it shows in' };
    if (m.kind === 'unbacked-spend' && !isHex(String(m.txid || '').toLowerCase(), 64)) return { ok: false, why: 'an unbacked spend names its transaction' };
    const a = { federation, kind: m.kind, height: m.height, ...(m.kind === 'inflation' ? { session: m.session } : { txid: String(m.txid).toLowerCase() }),
      ...(m.issuedMsat !== undefined ? { issuedMsat: String(m.issuedMsat) } : {}), ...(m.redeemedMsat !== undefined ? { redeemedMsat: String(m.redeemedMsat) } : {}), seenAtMs: nowMs() };
    const s = step(federation, { kind: 'raise', alarm: a });
    return s.ok ? { ok: true, kept: true, alarm: s.alarm } : { ok: true, kept: false, why: s.why };
  }
  /** The unbacked spend's block left this seat's chain: its alarm is WITHDRAWN. Answers { ok, alarm } or { ok: false, why }. */
  const withdraw = ({ federation, txid, why }) => step(String(federation || '').toLowerCase(), { kind: 'withdraw', txid, why });
  /**
   * OTHER SEATS' SIGNED STATEMENTS OF A MARK (their GET /reserve-alarms): [{ node, alarm: { federation, kind, txid | session, sig } }]. Each one
   * counts only when its signature verifies over alarmDigest of THIS seat's mark and its node is seated; `confirmSeats` distinct nodes, this
   * one among them, make it CONFIRMED. Answers { ok, alarm } or { ok: false, why }.
   */
  function confirm(fid, statements = []) {
    const federation = String(fid || '').toLowerCase(), a = held.get(federation);
    if (!a || stateOf(a) !== ALARM_STATE.RAISED) return { ok: false, why: a ? `the alarm is ${stateOf(a)}` : 'no alarm to confirm' };
    if (typeof verify !== 'function' || typeof isSeat !== 'function') return { ok: false, why: 'this seat checks no other seat\'s statement' };
    const digest = alarmDigest(a), by = new Set(me ? [String(me).toLowerCase()] : []);
    for (const st of statements || []) {
      const node = String(st && st.node || '').toLowerCase(), x = st && st.alarm;
      if (!isHex(node, 64) || !x || !isHex(String(x.sig || ''), 128)) continue;
      if (String(x.federation).toLowerCase() !== federation || x.kind !== a.kind || markOf(x) !== markOf(a)) continue;
      let ok = false; try { ok = verify(Buffer.from(x.sig, 'hex'), digest, Buffer.from(node, 'hex')) === true; } catch { ok = false; }
      let seated = false; try { seated = isSeat(node) === true; } catch { seated = false; }
      if (ok && seated) by.add(node);
    }
    return step(federation, { kind: 'confirm', by: [...by], n: confirmSeats });
  }
  /** This seat's statements of its standing marks, signed with its node key: what GET /reserve-alarms hands other seats to confirm. */
  const signed = (sign) => [...held.values()].map((a) => (stateOf(a) === ALARM_STATE.WITHDRAWN || typeof sign !== 'function' ? a : { ...a, sig: Buffer.from(sign(alarmDigest(a))).toString('hex') }));
  // `of`: the STANDING alarm (RAISED or CONFIRMED) - what stops deposits and halts; a withdrawn one stops nothing. `held`: in any state.
  const of = (fid) => { const a = held.get(String(fid || '').toLowerCase()); const s = stateOf(a); return s === ALARM_STATE.RAISED || s === ALARM_STATE.CONFIRMED ? { ...a, state: s } : null; };
  return { raise, withdraw, confirm, signed, of, held: (fid) => held.get(String(fid || '').toLowerCase()) || null, stateOf: (fid) => stateOf(held.get(String(fid || '').toLowerCase())), list: () => [...held.values()] };
}

/**
 * THE SEAT'S OWN REFUSAL (kanban #1108): a round that takes a stake into a federation this seat holds an alarm for is refused at every door
 * that takes money into it - handout, entry, lock - not only skipped by the client's pickFederation. A free round (no stake) moves no money
 * and is not refused. `contract`: a decoded round contract ({ stakeMsat, federationId }). Answers the reason, or null.
 */
export function alarmRefusal(alarms, contract) {
  if (!alarms || !contract || !(contract.stakeMsat > 0n) || !(contract.federationId instanceof Uint8Array)) return null;
  const fid = Array.from(contract.federationId, (b) => b.toString(16).padStart(2, '0')).join('');
  const a = alarms.of(fid);
  if (!a) return null;
  const what = a.kind === 'inflation' ? `inflation at signed session ${a.session}` : `an unbacked spend of its reserve by ${a.txid}`;
  return `this seat saw a mark of theft in federation ${fid.slice(0, 16)} (${what}, height ${a.height}): no deposit, entry or lock into it`;
}
