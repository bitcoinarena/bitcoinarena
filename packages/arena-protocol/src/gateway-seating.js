// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE GATEWAY SEATING OF AN EPOCH, SIGNED BY THE GUARDIANS (spec §23A.9): each guardian ranks its federation's gateway
// claims (gateway-seats.js) on the epoch it measured and signs the seats it got; a seating stands when at least the federation's
// threshold of its seated guardians signed the same seats for the same epoch. Kept apart from the federation record on purpose: a
// guardian that measured differently only fails to add its signature here, and the record (status, exposure) is never held up by
// it. With no standing seating for an epoch there are no gateway seats in it, and the guardian pool stays the guardians' (fee.js).
import { Writer } from './encode.js';
import { taggedHash, fromHex, toHex } from './hash.js';
import { tagAt, tagsAccepted, TAG_PAIRS } from './tag-switch.js';
import { GATEWAY_EPOCH_BLOCKS } from './gateway-seats.js';
import { SEATING_RULES_EPOCH } from './constants.js';

/** The step a guardian floors a proved peg-in to before signing it, from SEATING_RULES_EPOCH (§23A.9 ruling 1). */
export const PEG_IN_FLOOR_SATS = 100_000n;

/**
 * WHETHER THE 2.0 SEATING RULES APPLY TO A SEATING OF `epoch` (§23A.9 rulings 1 and 2): from the activation epoch `from` (SEATING_RULES_EPOCH;
 * a test names its own) on, by the seating's own epoch - the epoch signed, or the epoch judged. `from` null: never.
 */
export const seatingRulesActive = (epoch, from = SEATING_RULES_EPOCH) =>
  from !== null && from !== undefined && epoch !== null && epoch !== undefined && Number(epoch) >= Number(from);

export const GATEWAY_SEATING_TAG = TAG_PAIRS.gatewaySeating[0];   // the tag before the switch (tag-switch.js, kanban #525)

/**
 * THE EPOCH WHOSE SEATING A HEIGHT READS (§23A.9, kanban #559 P2): the last whole epoch before the one `height` is in. A guardian at chain
 * tip `height` signs this epoch's seating (it measured all of it), and a round whose census height is `height` is paid by this epoch's
 * standing seating: a seat earns in a round only if that seating names it. One function for both, so a round never reads an epoch
 * the guardians could not yet have signed.
 */
export const seatingEpochAt = (height) => Math.floor(Number(height) / GATEWAY_EPOCH_BLOCKS) - 1;

/**
 * THE SEATS A GUARDIAN SIGNS (§23A.9: "the seating the guardians sign names only eligible seats"): its ranking's seated gateways
 * (gateway-seats.js seatGateways) but the one holding its seat below the minimums - it serves, and is not paid.
 */
export const paidSeatsOf = (ranking) => ((ranking && ranking.seated) || []).filter((n) => !((ranking && ranking.belowMinimums) || []).includes(n));

/** THE HEIGHT A SEATING OF `epoch` IS JUDGED AT, from SEATING_RULES_EPOCH (§23A.9 ruling 2): the last block of that epoch. */
export const seatingJudgeHeight = (epoch) => (Number(epoch) + 1) * GATEWAY_EPOCH_BLOCKS - 1;

/**
 * THE FEDERATION RECORD A SEATING OF `epoch` IS JUDGED AGAINST - its seated guardians who may sign, its threshold (§23A.9 ruling 2): for a
 * seating of the activation epoch (`rulesEpoch`, SEATING_RULES_EPOCH) or later, the record in force at the epoch's last block
 * (`recordAt(height)`, federation-records.js), so a guardian set that changed after the epoch neither adds signers to it nor takes them
 * away; before it, or where this seat holds no record that old, the record it holds now (`current`), as before. Answers
 * { record, at: 'epoch' | 'now' }.
 */
export function seatingRecordFor({ epoch, recordAt = null, current = null, rulesEpoch = SEATING_RULES_EPOCH }) {
  if (seatingRulesActive(epoch, rulesEpoch) && typeof recordAt === 'function') {
    let r = null; try { r = recordAt(seatingJudgeHeight(epoch)); } catch { r = null; }
    if (r) return { record: r, at: 'epoch' };
  }
  return { record: current || null, at: 'now' };
}

/**
 * THE PROVED PEG-INS A GUARDIAN SIGNS (§23A.3a part 2, kanban #559/#543): { node hex: sat string } for each paid seat whose peg-in this
 * guardian proved from the federation's coins (`gateways`: its watch's view, node hex -> { provedPegInSats }); a seat it could not check
 * (no entry, or null) is left out. In a seating of the activation epoch (`rulesEpoch`, SEATING_RULES_EPOCH) or later (`epoch`: the epoch
 * signed) each amount is floored to whole PEG_IN_FLOOR_SATS (ruling 1: guardians reading the coins minutes apart, a few sat moved, still
 * sign one body); before it, exact. Never the lowest of the signers' amounts: each seat gathers another subset of signatures, and would
 * settle on another body.
 */
export function provedPegInsOf(paid, gateways, { epoch = null, rulesEpoch = SEATING_RULES_EPOCH } = {}) {
  const floor = seatingRulesActive(epoch, rulesEpoch);
  return Object.fromEntries((paid || []).filter((n) => gateways && gateways[n] && gateways[n].provedPegInSats != null)
    .map((n) => [n, floor ? String((BigInt(gateways[n].provedPegInSats) / PEG_IN_FLOOR_SATS) * PEG_IN_FLOOR_SATS) : String(gateways[n].provedPegInSats)]));
}

/**
 * THE PROVED PEG-INS A SEATING NAMES (kanban #559/#543, §23A.3a part 2): { node hex: sat string } for its seats whose peg-in the
 * guardian proved from the federation's own coins, sorted by node; [] when it names none.
 */
export function seatingPegInsOf(seating) {
  const p = (seating && seating.pegIns) || {};
  const seats = new Set(((seating && seating.seats) || []).map((x) => String(x).toLowerCase()));
  return Object.entries(p).map(([n, v]) => [String(n).toLowerCase(), BigInt(v)]).filter(([n]) => seats.has(n)).sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

/**
 * The 32 bytes a seating's signatures cover: the federation, the epoch, the seats (node keys, sorted) - and, only when it names
 * them, its seats' proved peg-ins (count, then node and sats each), so a seating that names none hashes as before.
 */
export function gatewaySeatingHash(seating, tag = tagAt('gatewaySeating', { epoch: seating.epoch })) {
  const { federationId, epoch, seats } = seating;
  const w = new Writer();
  w.bytes32(fromHex(federationId)); w.u32(epoch);
  w.vec([...seats].map((s) => String(s).toLowerCase()).sort(), (s, ww) => ww.bytes32(fromHex(s)));
  const pegs = seatingPegInsOf(seating);
  if (pegs.length) { w.u32(pegs.length); for (const [n, v] of pegs) { w.bytes32(fromHex(n)); w.u64(v); } }
  return taggedHash(tag, w.finish());
}

function pegInsBody(seating) {
  const pegs = seatingPegInsOf(seating);
  return pegs.length ? { pegIns: Object.fromEntries(pegs.map(([n, v]) => [n, String(v)])) } : {};
}

/** One guardian's signature on a seating. */
export function signGatewaySeating(seating, guardianNode, sign) {
  return { federationId: seating.federationId.toLowerCase(), epoch: seating.epoch, seats: [...seating.seats].map((s) => s.toLowerCase()).sort(), ...pegInsBody(seating),
    guardian: String(guardianNode).toLowerCase(), signature: toHex(sign(gatewaySeatingHash(seating))) };
}

/**
 * Whether signed seatings make one that stands: `signed` [{ federationId, epoch, seats, guardian, signature }], `seated` the
 * federation's seated guardians (node keys hex), `threshold`. Answers { ok, seating: { federationId, epoch, seats }, signers, why } -
 * the seats signed by the most guardians, if they are at least the threshold.
 */
export function standingSeating({ signed = [], federationId, epoch, seated, threshold, verify }) {
  const allowed = new Set((seated || []).map((k) => String(k).toLowerCase()));
  const byBody = new Map();
  for (const s of signed) {
    if (!s || String(s.federationId).toLowerCase() !== String(federationId).toLowerCase() || s.epoch !== epoch || !allowed.has(String(s.guardian).toLowerCase())) continue;
    let good = false;
    try { good = tagsAccepted('gatewaySeating', { epoch: s.epoch }).some((t) => verify(fromHex(s.signature), gatewaySeatingHash(s, t), fromHex(s.guardian))); } catch { good = false; }
    if (!good) continue;
    // the same seats with the same proved peg-ins are one body: a guardian that proved another amount signs a different one
    const seatsKey = [...s.seats].map((x) => String(x).toLowerCase()).sort().join(',');
    const key = seatsKey + '|' + seatingPegInsOf(s).map(([n, v]) => n + '=' + v).join(',');
    const row = byBody.get(key) || { seats: seatsKey ? seatsKey.split(',') : [], ...pegInsBody(s), signers: new Set() };
    row.signers.add(String(s.guardian).toLowerCase());
    byBody.set(key, row);
  }
  const best = [...byBody.values()].sort((a, b) => b.signers.size - a.signers.size)[0];
  if (!best || best.signers.size < threshold)
    return { ok: false, signers: best ? best.signers.size : 0, why: `no seating for epoch ${epoch} is signed by ${threshold} of the federation's seated guardians (at most ${best ? best.signers.size : 0}): no gateway seats in it` };
  return { ok: true, seating: { federationId: String(federationId).toLowerCase(), epoch, seats: best.seats, ...(best.pegIns ? { pegIns: best.pegIns } : {}) }, signers: best.signers.size,
    why: `${best.signers.size} of the seated guardians signed ${best.seats.length} gateway seat${best.seats.length === 1 ? '' : 's'} for epoch ${epoch}` };
}
