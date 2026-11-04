// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A FEDERATION'S RESERVE ALARMS, AS ONE SEAT HOLDS THEM (kanban #1093 parts 2 and 5, ruling #1106, 2026-11-03).
//
// A theft by a threshold of guardians leaves one of two objective marks in the federation's threshold-signed history: inflation (more
// e-cash redeemed so far than issued so far) or an unbacked spend (a reserve UTXO spent on the chain, 6 deep, by no peg-out in the signed
// history). "Any seat that sees a mark stops offering deposits into that federation at once, even before anyone has acted on it." This
// book keeps the marks this seat saw, one per federation (the first), with what proves it, so GET /federations lists it beside the record
// and every client stops depositing. It judges nothing itself: the audit of the signed history raises a mark (`raise`).
const isHex = (s, n) => typeof s === 'string' && new RegExp(`^[0-9a-f]{${n}}$`).test(s);
export const ALARM_KINDS = Object.freeze(['inflation', 'unbacked-spend']);

export function createReserveAlarms({ load = () => [], save = () => {}, nowMs = () => Date.now() } = {}) {
  const held = new Map();                  // federation hex -> alarm
  for (const a of load() || []) if (a && isHex(a.federation, 64)) held.set(a.federation, a);
  /**
   * A mark seen: { federation (64 hex), kind, height, session? (the signed session where redeemed passed issued), txid? (the unbacked spend),
   * issuedMsat?, redeemedMsat? }. The first mark of a federation stands; a later one is not taken over it. Answers { ok, kept, why }.
   */
  function raise(m) {
    const federation = String(m && m.federation || '').toLowerCase();
    if (!isHex(federation, 64)) return { ok: false, why: 'an alarm names its federation (64 hex)' };
    if (!ALARM_KINDS.includes(m.kind)) return { ok: false, why: `an alarm is one of ${ALARM_KINDS.join(', ')}` };
    if (!Number.isInteger(m.height) || m.height < 0) return { ok: false, why: 'an alarm names the height of its mark' };
    if (m.kind === 'inflation' && !Number.isInteger(m.session)) return { ok: false, why: 'an inflation names the signed session it shows in' };
    if (m.kind === 'unbacked-spend' && !isHex(String(m.txid || '').toLowerCase(), 64)) return { ok: false, why: 'an unbacked spend names its transaction' };
    if (held.has(federation)) return { ok: true, kept: false, why: 'this federation\'s first alarm stands' };
    const a = { federation, kind: m.kind, height: m.height, ...(m.kind === 'inflation' ? { session: m.session } : { txid: String(m.txid).toLowerCase() }),
      ...(m.issuedMsat !== undefined ? { issuedMsat: String(m.issuedMsat) } : {}), ...(m.redeemedMsat !== undefined ? { redeemedMsat: String(m.redeemedMsat) } : {}), seenAtMs: nowMs() };
    held.set(federation, a); save([...held.values()]);
    return { ok: true, kept: true, alarm: a };
  }
  return { raise, of: (fid) => held.get(String(fid || '').toLowerCase()) || null, list: () => [...held.values()] };
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
