// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHO THE GUARDIANS ARE: FOUNDING BY SORTITION (§23A.2). "Bond-weighted stateless sortition, §5A.6 unchanged, with the beacon
// block after trigger_height and the guardian tag (BLWP/v1/GUARDIAN, ARENA/v1/GUARDIAN from the switch: tag-switch.js), over the guardian-capable census minus operators already guarding an OPEN
// federation, one ticket per operator. federation_nominal are drawn, then three alternates in order. Nobody hand-picks." A drawn guardian
// that does not take part within founding_window is a no-show, replaced by the next alternate in order.
//
// Eligible: a bonded census node advertising guardian_capable and a guardian_endpoint, with a bond of at least bond_min_guardian, of an
// operator not guarding an OPEN federation; one ticket per operator (its lowest outpoint, its bonds summed into its weight).
import { Writer } from './encode.js';
import { taggedHash, bytesToBigInt, toHex } from './hash.js';
import { TAG, FOUNDING_PRESSURE_VERSION } from './constants.js';
import { weightOf } from './sortition.js';
import { tagAt } from './tag-switch.js';
import { exposureCap } from './federation-slash.js';
import { opensWith } from './federation-record.js';

export const ALTERNATES = 3;

/**
 * WHEN THE PRESSURE RULE APPLIES (§23A.3a, kanban #993/#1023): one point per network, named by the release after every seat of the
 * network runs it; null is not named, and the draw is plain everywhere. The trigger's own height decides: a trigger below the point draws
 * plain forever, on any seat of any release, so a founding already drawn cannot change.
 */
export const FOUNDING_PRESSURE_HEIGHT = Object.freeze({
  mainnet: 0,
  testnet4: null,
  regtest: null,
});
/** The records a founding reads are in force this many blocks behind its trigger: they step every 6 and come from a census 6 deep. */
export const FOUNDING_RECORD_LAG = 12;
export const foundingPressurePoint = (network) => (Object.prototype.hasOwnProperty.call(FOUNDING_PRESSURE_HEIGHT, network) ? FOUNDING_PRESSURE_HEIGHT[network] : null);
const reached = (height, point) => Number.isInteger(point) && Number.isInteger(height) && height >= point;
/** The height a founding at `height` reads records at, or null: before the point, or under FOUNDING_RECORD_LAG, nothing is under pressure. */
export const foundingRecordHeight = (height, point) => (reached(height, point) && height >= FOUNDING_RECORD_LAG ? height - FOUNDING_RECORD_LAG : null);
/** The version a candidate of a founding at `height` has to advertise, or null before the point. */
export const foundingCandidateVersion = (height, point) => (reached(height, point) ? FOUNDING_PRESSURE_VERSION : null);

/**
 * A GUARDIAN'S BOND FLOOR (§23A.2, kanban #1025): a genesis parameter on mainnet; testnet4's and regtest's genesis bytes do not carry it and
 * cannot without moving their network ids, so it stands here, beside genesis, as BOND_MATURITY_OFFSET does. Never a seat's setting: it
 * feeds the draw and B*_net, and a seat on another value names another founding. Regtest may keep a test's override. `genesisSats` the
 * genesis's bondMinGuardianSats, if it names one. Nothing moves it after genesis today, so the value at any height is this one.
 */
export const BOND_MIN_GUARDIAN = Object.freeze({ testnet4: 50000n, regtest: 50000n });
export function bondMinGuardianOf({ network, genesisSats = null, override = null }) {
  if (typeof genesisSats === 'bigint') return genesisSats;
  if (network === 'testnet4' || network === 'testnet') return BOND_MIN_GUARDIAN.testnet4;
  if (network === 'mainnet') throw new Error('mainnet names its guardian bond floor in its genesis');
  return override ? BigInt(override) : BOND_MIN_GUARDIAN.regtest;
}

/**
 * The founding's id: H(founding tag, seed || trigger_height), with `pressureBond` set H(tag, seed || trigger_height || pressure_bond) -
 * the tag by the trigger height (kanban #525). Seats that read another B*_net name another founding, so they cannot meet in one ceremony.
 */
export function foundingId(seed, triggerHeight, pressureBond = null) {
  const w = new Writer(); w.bytes32(seed); w.u32(triggerHeight);
  if (pressureBond !== null) w.u64(pressureBond);
  return taggedHash(tagAt('founding', { height: triggerHeight }), w.finish());
}

const outpointOrder = (a, b) => { const x = toHex(a.txid) + ':' + a.vout, y = toHex(b.txid) + ':' + b.vout; return x < y ? -1 : x > y ? 1 : 0; };

/** One operator's ticket on the founding's seed: H_tag(seed || its lowest bond outpoint) - the tag by the trigger height (kanban #525). */
export function guardianTicket(seed, entry, height) {
  const w = new Writer(); w.bytes32(seed); w.bytes32(entry.txid); w.u32(entry.vout);
  return bytesToBigInt(taggedHash(tagAt('guardianTicket', { height }), w.finish()));
}

/**
 * THE FOUNDING DRAW. `entries` census entries ({ pubkey, txid, vout, bondSats, advert: { operatorId, guardianCapable, guardianEndpoint } });
 * `seed` the beacon block hash after trigger_height (32 bytes); `nominal` federation_nominal; `bondMinGuardian`; `guardingOpen` the
 * operator ids already guarding an OPEN federation. Answers { ok, drawn: [entry], alternates: [entry], eligible, seatedFirst, why }.
 *
 * SEATED FIRST (§23A.6 step 1): `seatedFirst` - census entries, in order - are the old federation's seated, non-departing
 * guardians: "seated first in the new one - same operators, new key shares ... and only the missing seats up to federation_nominal
 * are drawn. If they are fewer than f + 1, everything is drawn." They take positions 0.. in their order (position 0 leads the
 * ceremony), as they are: no capability, bond or guardingOpen test (they guard the federation being succeeded) and no one-ticket
 * rule among them (they keep the operators they had). The missing seats are drawn from the pool minus their operators (and minus
 * their nodes), minus `guardingOpen`; then three alternates. `drawn` is the whole seated list, seated-first and drawn alike - the
 * no-show rule (replaceNoShows) applies to every position.
 *
 * UNDER CAPACITY PRESSURE (§23A.3a "The founding draw under pressure", kanban #993/#1023): `pressureBond` is the network's B*_net while
 * the network is under pressure, null otherwise. An operator whose seated node - the one its ticket names - holds a bond of at least that
 * takes a drawn place before every other operator, in ticket order among themselves; the rest follow in ticket order, so too few of
 * them leaves the other seats drawn as always, and the alternates carry on down the same list. The test reads that node's sum of
 * outputs, never the operator's: exposure_cap is (f + 1) times the smallest seated bond, so two small nodes summing to B*_net lift
 * nothing. It orders the pool and nothing else: who is eligible, the weights, and a succession's seated first (who are not candidates)
 * do not change. With null the draw is the plain one, byte for byte, and the answer gains `atPressureBond` only when it is set.
 *
 * `candidateVersion`: from the point (foundingCandidateVersion), a node whose advertisement does not list it is no candidate - it would
 * compute another draw, miss the ceremony and burn an alternate. Null leaves everyone in.
 */
// `firstSeasonEnds` (#1318, RULED #1288): a height - an output that matures at or before it counts for nothing in the draw, so a federation is never
// founded on a bond that leaves inside its first season. Null: every output counts, the draw byte for byte as before.
// VETERANS FIRST (§23A.2 RULED 2026-11-07, kanban #1297/#1323): "A cohort or succession founding seats at least f + 1 guardians drawn from the
// seated guardians of existing OPEN federations (an operator may guard at most two OPEN federations), and only the rest from the free pool".
// `openGuarding` Map operator id -> how many OPEN federations it guards. A veteran guards exactly one and its node offers a free founding slot
// (advert.foundingSlot - it runs the second guardian beside the first); the f + 1 (less the seated first) come from them in ticket order, the rest
// from the free pool, and too few veterans found nothing - ten fresh bonds alone are not a federation. Null, or no OPEN federation at all (the
// network's first founding): the draw as before, byte for byte.
export const OPEN_GUARDED_MAX = 2;
export function drawGuardians({ entries, seed, height, nominal, bondMinGuardian, guardingOpen = new Set(), seatedFirst = [], pressureBond = null, candidateVersion = null, firstSeasonEnds = null, openGuarding = null, pegInMinSats = null }) {
  if (!(seed instanceof Uint8Array) || seed.length !== 32) return { ok: false, why: 'a founding is drawn on the beacon after its trigger height' };
  if (typeof bondMinGuardian !== 'bigint' || bondMinGuardian <= 0n) return { ok: false, why: 'bond_min_guardian is a positive floor' };
  if (pressureBond !== null && (typeof pressureBond !== 'bigint' || pressureBond <= 0n)) return { ok: false, why: 'B*_net under pressure is a positive amount, or null when the network is not under pressure' };
  const opOf = (e) => String((e.advert && e.advert.operatorId) || toHex(e.pubkey));
  const f = Math.floor((nominal - 1) / 3);
  const offered = seatedFirst || [];
  const first = offered.length >= f + 1 ? offered.slice(0, nominal) : [];
  const firstOps = new Set(first.map(opOf)), firstNodes = new Set(first.map((e) => toHex(e.pubkey)));
  const byOp = new Map(), nodeSats = new Map();
  const nodeKey = (op, e) => `${op}|${toHex(e.pubkey)}`;
  for (const e of entries || []) {
    const a = e && e.advert;
    if (!a || a.guardianCapable !== true || !a.guardianEndpoint) continue;
    if (candidateVersion !== null && !(a.protocolVersions || []).includes(candidateVersion)) continue;
    if (firstSeasonEnds !== null && !(Number.isInteger(a.bondMaturityHeight) && a.bondMaturityHeight > firstSeasonEnds)) continue;
    const op = String(a.operatorId || toHex(e.pubkey));
    if (guardingOpen.has(op) || firstOps.has(op) || firstNodes.has(toHex(e.pubkey))) continue;
    nodeSats.set(nodeKey(op, e), (nodeSats.get(nodeKey(op, e)) || 0n) + BigInt(e.bondSats));
    const had = byOp.get(op);
    if (!had) { byOp.set(op, { entry: e, bondSats: BigInt(e.bondSats) }); continue; }
    had.bondSats += BigInt(e.bondSats);
    if (outpointOrder(e, had.entry) < 0) had.entry = e;
  }
  const pool = [...byOp].filter(([, x]) => x.bondSats >= bondMinGuardian).map(([op, x]) => ({ ...x, op }));
  const missing = nominal - first.length;
  const veteransRule = openGuarding instanceof Map && openGuarding.size > 0;
  if (veteransRule) return opensOrNot(drawWithVeterans({ entries, seed, height, nominal, bondMinGuardian, first, firstOps, firstNodes, free: pool, missing, f, openGuarding, candidateVersion, firstSeasonEnds }), f, pegInMinSats);
  const allDrawn = offered.length && !first.length ? `, everything drawn: ${offered.length} seated first is fewer than f + 1 = ${f + 1}` : '';
  if (pool.length < missing)
    return { ok: false, eligible: pool.length, seatedFirst: first.length, why: first.length
      ? `${first.length} seated first, and ${pool.length} other guardian-capable operators hold bond_min_guardian and guard no OPEN federation: the ${missing} missing seats of ${nominal} are not filled, a federation is not founded with fewer`
      : `${pool.length} guardian-capable operators hold bond_min_guardian and none guards an OPEN federation: a federation of ${nominal} is not founded with fewer${allDrawn}` };
  const scored = pool.map((x) => ({ entry: x.entry, ticket: guardianTicket(seed, x.entry, height), weight: weightOf(x.bondSats, bondMinGuardian),
    ahead: pressureBond !== null && nodeSats.get(nodeKey(x.op, x.entry)) >= pressureBond }))
    .sort((a, b) => { if (a.ahead !== b.ahead) return a.ahead ? -1 : 1; const l = a.ticket * b.weight, r = b.ticket * a.weight; return l < r ? -1 : l > r ? 1 : outpointOrder(a.entry, b.entry); });
  const ahead = scored.filter((s) => s.ahead).length;
  // GUARDIANS SPREAD (kanban #1093 part 4: "The founding draw seats at most f guardians that share an operator, or that name the same host_group"): in ticket
  // order, a candidate whose host_group already holds f drawn seats is passed over; one ticket per operator already keeps an operator to one seat. A node
  // that names no host_group is a group of its own. The alternates are the next in order that keep the cap beside the drawn.
  const groupOf = (e) => (e.advert && e.advert.hostGroup instanceof Uint8Array ? toHex(e.advert.hostGroup) : `node:${toHex(e.pubkey)}`);
  const inGroup = new Map();
  for (const e of first) inGroup.set(groupOf(e), (inGroup.get(groupOf(e)) || 0) + 1);
  const fits = (e) => (inGroup.get(groupOf(e)) || 0) < Math.max(1, f);
  const picked = [], rest = [];
  for (const s of scored) {
    if (picked.length < missing && fits(s.entry)) { picked.push(s.entry); inGroup.set(groupOf(s.entry), (inGroup.get(groupOf(s.entry)) || 0) + 1); }
    else rest.push(s.entry);
  }
  if (picked.length < missing)
    return { ok: false, eligible: pool.length, seatedFirst: first.length, why: `the ${missing} seats to draw cannot be filled with at most ${Math.max(1, f)} guardians per host_group: ${picked.length} fit` };
  const alternates = rest.filter(fits).slice(0, ALTERNATES);
  return opensOrNot({ ok: true, eligible: pool.length, seatedFirst: first.length, ...(pressureBond !== null ? { atPressureBond: ahead } : {}), drawn: [...first, ...picked],
    alternates,
    why: `${first.length ? `${first.length} seated first, ` : ''}${missing} drawn of ${pool.length} eligible operators, ${alternates.length} alternates in order${allDrawn}${pressureBond !== null ? `, under pressure ${ahead} at or above B*_net ${pressureBond} go ahead of the rest` : ''}` }, f, pegInMinSats);
}

/**
 * A FEDERATION OPENS ONLY IF 2 x peg_in_min <= exposure_cap / 4 (§23A.3a RULED 2026-11-07, kanban #1296/#1322): the drawn set's cap - halts at f
 * times its smallest bond - is read before anyone is asked to take part; a set whose two gateways' mandatory peg-ins would be more than a
 * quarter of it founds nothing. `pegInMinSats` null: not checked (the draw as before).
 */
function opensOrNot(draw, f, pegInMinSats) {
  if (!draw.ok || pegInMinSats === null || pegInMinSats === undefined) return draw;
  const cap = exposureCap({ bonds: draw.drawn.map((e) => BigInt(e.bondSats)), f });
  if (!cap.ok) return { ok: false, eligible: draw.eligible, seatedFirst: draw.seatedFirst, why: cap.why };
  const o = opensWith({ exposureCapSats: cap.cap, pegInMinSats });
  return o.ok ? draw : { ok: false, eligible: draw.eligible, seatedFirst: draw.seatedFirst, capSats: cap.cap, why: `the drawn set's exposure cap is ${cap.cap} sat: ${o.why}` };
}

function drawWithVeterans({ entries, seed, height, nominal, bondMinGuardian, first, firstOps, firstNodes, free, missing, f, openGuarding, candidateVersion, firstSeasonEnds }) {
  const vByOp = new Map();
  for (const e of entries || []) {
    const a = e && e.advert;
    if (!a || a.guardianCapable !== true || !a.guardianEndpoint || a.foundingSlot !== true) continue;
    if (candidateVersion !== null && !(a.protocolVersions || []).includes(candidateVersion)) continue;
    if (firstSeasonEnds !== null && !(Number.isInteger(a.bondMaturityHeight) && a.bondMaturityHeight > firstSeasonEnds)) continue;
    const op = String(a.operatorId || toHex(e.pubkey));
    const n = openGuarding.get(op) || 0;
    if (n < 1 || n >= OPEN_GUARDED_MAX || firstOps.has(op) || firstNodes.has(toHex(e.pubkey))) continue;
    const had = vByOp.get(op);
    if (!had) { vByOp.set(op, { entry: e, bondSats: BigInt(e.bondSats) }); continue; }
    had.bondSats += BigInt(e.bondSats);
    if (outpointOrder(e, had.entry) < 0) had.entry = e;
  }
  const order = (xs) => xs.map((x) => ({ entry: x.entry, ticket: guardianTicket(seed, x.entry, height), weight: weightOf(x.bondSats, bondMinGuardian) }))
    .sort((a, b) => { const l = a.ticket * b.weight, r = b.ticket * a.weight; return l < r ? -1 : l > r ? 1 : outpointOrder(a.entry, b.entry); }).map((s) => s.entry);
  const veterans = order([...vByOp.values()].filter((x) => x.bondSats >= bondMinGuardian));
  const freeOrdered = order(free.filter((x) => !vByOp.has(x.op)));
  const needVets = Math.max(0, f + 1 - first.length);
  const groupOf = (e) => (e.advert && e.advert.hostGroup instanceof Uint8Array ? toHex(e.advert.hostGroup) : `node:${toHex(e.pubkey)}`);
  const inGroup = new Map();
  for (const e of first) inGroup.set(groupOf(e), (inGroup.get(groupOf(e)) || 0) + 1);
  const fits = (e) => (inGroup.get(groupOf(e)) || 0) < Math.max(1, f);
  const take = (e) => inGroup.set(groupOf(e), (inGroup.get(groupOf(e)) || 0) + 1);
  const vets = [];
  for (const e of veterans) if (vets.length < needVets && fits(e)) { vets.push(e); take(e); }
  if (vets.length < needVets)
    return { ok: false, eligible: free.length, veterans: veterans.length, seatedFirst: first.length,
      why: `a founding seats at least f + 1 = ${f + 1} guardians of OPEN federations (§23A.2): ${first.length} seated first and ${vets.length} of ${needVets} more from the ${veterans.length} with a free founding slot - ${free.length} fresh operators do not found alone` };
  const picked = [...vets], rest = [];
  for (const e of freeOrdered) { if (picked.length < missing && fits(e)) { picked.push(e); take(e); } else rest.push(e); }
  if (picked.length < missing)
    return { ok: false, eligible: free.length, veterans: veterans.length, seatedFirst: first.length,
      why: `${vets.length} veterans and ${picked.length - vets.length} of the free pool: the ${missing} seats of ${nominal} are not filled, a federation is not founded with fewer` };
  const alternates = rest.filter(fits).slice(0, ALTERNATES);
  return { ok: true, eligible: free.length, veterans: vets.length, seatedFirst: first.length, drawn: [...first, ...picked], alternates,
    why: `${first.length ? `${first.length} seated first, ` : ''}${vets.length} of OPEN federations and ${picked.length - vets.length} from the free pool, ${alternates.length} alternates in order` };
}

/**
 * A NO-SHOW REPLACED: the drawn set after `noShows` (node keys hex that did not take part within founding_window) - each seat of a
 * no-show to the next alternate in order. Answers { ok, seated, used, why }; not ok when the alternates run out.
 */
export function replaceNoShows({ drawn, alternates, noShows }) {
  const out = new Set((noShows || []).map((k) => String(k).toLowerCase()));
  const queue = (alternates || []).filter((e) => !out.has(toHex(e.pubkey)));
  // AT MOST f OF ONE host_group STILL (kanban #1093 part 4): an alternate whose group would go past f is passed over for the next
  const f = Math.max(1, Math.floor(((drawn || []).length - 1) / 3));
  const groupOf = (e) => (e.advert && e.advert.hostGroup instanceof Uint8Array ? toHex(e.advert.hostGroup) : `node:${toHex(e.pubkey)}`);
  const inGroup = new Map();
  for (const e of drawn || []) if (!out.has(toHex(e.pubkey))) inGroup.set(groupOf(e), (inGroup.get(groupOf(e)) || 0) + 1);
  const seated = [];
  let used = 0;
  for (const e of drawn) {
    if (!out.has(toHex(e.pubkey))) { seated.push(e); continue; }
    const at = queue.findIndex((x) => (inGroup.get(groupOf(x)) || 0) < f);
    const next = at < 0 ? null : queue.splice(at, 1)[0];
    if (!next) return { ok: false, seated, used, why: 'more no-shows than alternates that keep at most f guardians per host_group: the founding is drawn again at the next trigger' };
    inGroup.set(groupOf(next), (inGroup.get(groupOf(next)) || 0) + 1);
    seated.push(next); used++;
  }
  return { ok: true, seated, used, why: used ? `${used} no-show${used === 1 ? '' : 's'} replaced by the alternates in order` : 'every drawn guardian took part' };
}

/**
 * WHAT STARTS A FOUNDING (§23A.2): one of three events, each at a Bitcoin height that becomes the founding's
 * `trigger_height`; the earliest that has happened wins. Pure: the caller reads the facts off the chain and the records.
 *
 *   genesis     `capable`: [{ height, operators }] - guardian-capable census nodes of distinct operators at each height, ascending;
 *               the network's first federation at the first height with at least `nominal` of them, only while no federation exists
 *               ("a network with six willing operators has no mainnet federation ... and says so rather than opening with six")
 *   succession  `records`: [{ federation, status, height, replace }] - a federation that entered DRAINING, or whose guardians decided
 *               by threshold signature to be replaced (`replace: true`), at that record's height; `notices`: [{ federation, height,
 *               wouldBe }] - a standing departure notice of a guardian of an OPEN federation that would make it DRAINING (or CRITICAL,
 *               at four: §23A.1), at the height it was posted (§23A.6 "or a departure notice that would make it DRAINING").
 *               A row's `federation`, `nominal`, `seatedFirst` (node keys hex, in order) and `departing` (node keys hex) are passed through
 *   load        `loads`: [{ height, federations: [{ federation, status, load }] }], ascending - every OPEN federation at or above 80 %
 *               of its exposure cap (load >= 0.8) at every height for `abandonBlocks`; the trigger is the height that completes it
 * Answers { ok, kind, height, why } for the earliest, or { ok: false, why } naming what is missing.
 */
export const LOAD_TRIGGER = 0.8;
/**
 * THE COHORT (ruling 3, 2026-10-18: "10 new nodes find each other on the network automatically and create a new
 * federation"; protocol 2026.0.14): `capable` rows may carry `free` - the guardian-capable operators with an endpoint and at least
 * bond_min_guardian that guard no OPEN federation. While a federation exists, COHORT_NOMINAL of them found one of their own, of that
 * size: the trigger is the first height of the current run at or above it (after a founding their adverts name it in guardian_of[],
 * the run ends, and the next cohort is a later height). Before any federation exists the genesis trigger stands as it was.
 */
export const COHORT_NOMINAL = 10;
/**
 * A FOUNDING EVERY 6 BLOCKS (2026-10-22: "do the re foundation every 6 blocks on all instead of 19"): the window a drawn set
 * has for its codes and DKG, on every network - a void cohort is drawn again founding_window + 1 = 6 blocks later. The genesis
 * founding_window stays as it is: it is hashed into each network's id (testnet4 1060078b would become another network).
 */
export const FOUNDING_WINDOW = 5;
/** A trigger's identity: what a seat remembers of a founding that went void. */
export const triggerKey = (t) => `${t.kind}:${t.federation || ''}:${t.height}`;
/**
 * `voided`: keys (triggerKey) of foundings whose window passed without a federation. §23A.2: "the founding is void and the next
 * trigger draws again" - so a voided event is passed over, and a voided cohort draws again from a later height of its run (measured
 * 2026-10-18 on the test host seats: federation B's departure notice at 156647 went void at 156666 and stayed the trigger, the earliest,
 * so no later event - a cohort of ten new nodes among them - could ever start a founding).
 */
/**
 * EVERY KIND REDRAWS AS A COHORT DOES (§23A.2, kanban #1025), from `redrawFrom` (the network's FOUNDING_PRESSURE_HEIGHT; null: not on this
 * network yet, and everything below is as it was). A succession or load trigger has one height, and a void one had no next trigger, so a
 * draining federation could never get a successor. While its condition holds, a trigger T draws at T + n x (founding_window + 1), the newest
 * such height below the tip, each with its own beacon and the rules of its own height; every seat at a tip names the same one. A row whose
 * `successor` is set has its founding: its condition is over. Answers `base` (T) and `origin` (the trigger, whichever draw this is).
 *
 * NOTHING VOID HOLDS ANYTHING BACK: a trigger still on its first draw wins, the earliest of those, and only then the lowest draw height.
 */
export function foundingTrigger({ capable = [], records = [], notices = [], loads = [], nominal, abandonBlocks, federationExists = false, cohort = COHORT_NOMINAL, voided = [],
  tip = null, foundingWindow = null, redrawFrom = null }) {
  const skip = new Set(voided);
  // A COHORT REDRAWS ON THE CHAIN'S CLOCK when the tip and founding_window are known (kanban #495, measured 2026-10-21 at 157,179:
  // the seven second-host seats, restarted at 157,178, drew 218dd6c7 at 157,178; the three installer nodes, whose first readable census was
  // 157,179, drew at 157,179 - each seat's run began where its memory began, and a void moved it to the next height it had seen).
  // The draws are the run's first height, then one founding_window + 1 later each - every seat names the same one from the chain.
  const scheduled = Number.isInteger(tip) && Number.isInteger(foundingWindow) && foundingWindow > 0;
  const redraws = scheduled && Number.isInteger(redrawFrom) && tip >= redrawFrom;
  const over = (r) => redraws && r.successor === true;
  const cohortAfter = scheduled ? -1 : Math.max(-1, ...[...skip].filter((k) => k.startsWith('cohort:')).map((k) => Number(k.split(':').pop())));
  const found = [];
  if (!federationExists && Number.isInteger(nominal)) {
    const g = capable.find((x) => x.operators >= nominal);
    if (g && !(redraws && capable[capable.length - 1].operators < nominal)) found.push({ kind: 'genesis', height: g.height, why: `${g.operators} guardian-capable operators at ${g.height}, at least federation_nominal ${nominal}: the first federation is drawn` });
  }
  if (federationExists && Number.isInteger(cohort) && cohort > 0) {
    let start = null;
    for (const x of capable) { if (typeof x.free !== 'number' || x.height <= cohortAfter) continue; if (x.free >= cohort) { if (start === null) start = x; } else start = null; }
    const step = foundingWindow + 1;
    // ON THE MULTIPLES OF founding_window + 1 (kanban #495, measured 2026-10-22 after the 6-block roll: installer a's memory of the run
    // began at 157,236, the other nodes' at 157,173, so they drew at 157,254 and 157,251 - two foundings): a draw is the newest
    // multiple of the step below the tip, at or after the run's start - every seat names the same height from the chain alone
    const first = start ? Math.ceil(start.height / step) * step : null;
    const at = start && scheduled ? (tip - 1 >= first ? Math.floor((tip - 1) / step) * step : (tip >= first ? first : null)) : start && start.height;
    if (start && at !== null) found.push({ kind: 'cohort', height: at, nominal: cohort, ...(redraws ? { base: start.height, firstDraw: at === first } : {}),
      why: `${start.free} guardian-capable operators guarding no OPEN federation from ${start.height}, at least ${cohort}: they found a federation of their own`
        + (at !== start.height ? ` (drawn again at ${at}, every founding_window + 1)` : '') });
  }
  const carried = (r) => ({ ...(r.federation !== undefined ? { federation: r.federation } : {}), ...(Number.isInteger(r.nominal) ? { nominal: r.nominal } : {}),
    ...(Array.isArray(r.seatedFirst) ? { seatedFirst: r.seatedFirst } : {}),
    ...(Array.isArray(r.departing) ? { departing: r.departing } : {}) });
  for (const r of records) {
    if ((r.status === 'DRAINING' || r.replace === true) && !over(r))
      found.push({ kind: 'succession', height: r.height, ...carried(r), why: `federation ${String(r.federation).slice(0, 16)} ${r.replace ? 'decided by threshold signature to be replaced' : 'entered DRAINING'} at ${r.height}: its successor is drawn` });
  }
  for (const n of notices) {
    if (!Number.isInteger(n.height) || over(n)) continue;
    found.push({ kind: 'succession', notice: true, height: n.height, ...carried(n),
      why: `a departure notice posted at ${n.height} would make federation ${String(n.federation).slice(0, 16)} ${n.wouldBe || 'DRAINING'}: its successor is drawn now` });
  }
  if (Number.isInteger(abandonBlocks) && abandonBlocks > 0) {
    let since = null, hit = null;
    for (const at of [...loads].sort((a, b) => a.height - b.height)) {
      const open = (at.federations || []).filter((f) => f.status === 'OPEN');
      const full = open.length > 0 && open.every((f) => typeof f.load === 'number' && f.load >= LOAD_TRIGGER);
      if (!full) { since = null; hit = null; continue; }
      if (since === null) since = at.height;
      if (hit === null && at.height - since >= abandonBlocks) { hit = at.height; if (!redraws) break; }
    }
    if (hit !== null) found.push({ kind: 'load', height: hit, why: `every OPEN federation at or above ${LOAD_TRIGGER * 100} % of its cap from ${since} to ${hit} (abandon_blocks ${abandonBlocks}): a new federation is drawn` });
  }
  if (!found.length) return { ok: false, why: federationExists ? 'no federation is draining or replaced, and the OPEN ones are not all at 80 % for abandon_blocks' : `fewer than federation_nominal ${nominal} guardian-capable operators so far: no federation, and no paying round` };
  if (redraws) {
    const step = foundingWindow + 1;
    for (const t of found) {
      const base = t.base ?? t.height;
      t.origin = `${t.kind}:${t.federation || ''}:${base}`;
      if (t.kind === 'cohort') continue;
      const first = t.height;
      t.base = first; t.height = tip - 1 >= first ? first + Math.floor((tip - 1 - first) / step) * step : first; t.firstDraw = t.height === first;
      if (!t.firstDraw) t.why += ` (drawn again at ${t.height}, every founding_window + 1)`;
    }
    const order = (a, b) => a.height - b.height || (triggerKey(a) < triggerKey(b) ? -1 : 1);
    const live = found.filter((t) => !skip.has(triggerKey(t)));
    if (!live.length) return { ok: false, why: `every trigger so far went void (${found.length}); the next one draws again` };
    const firsts = live.filter((t) => t.firstDraw);
    return { ok: true, ...(firsts.length ? firsts : live).sort(order)[0] };
  }
  found.sort((a, b) => a.height - b.height);
  const live = found.filter((t) => !skip.has(triggerKey(t)));
  if (!live.length) return { ok: false, why: `every trigger so far went void (${found.length}); the next one draws again` };
  return { ok: true, ...live[0] };
}
