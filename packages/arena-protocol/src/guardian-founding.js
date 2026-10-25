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
import { TAG } from './constants.js';
import { weightOf } from './sortition.js';
import { tagAt } from './tag-switch.js';

export const ALTERNATES = 3;

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
 */
export function drawGuardians({ entries, seed, height, nominal, bondMinGuardian, guardingOpen = new Set(), seatedFirst = [] }) {
  if (!(seed instanceof Uint8Array) || seed.length !== 32) return { ok: false, why: 'a founding is drawn on the beacon after its trigger height' };
  if (typeof bondMinGuardian !== 'bigint' || bondMinGuardian <= 0n) return { ok: false, why: 'bond_min_guardian is a positive floor' };
  const opOf = (e) => String((e.advert && e.advert.operatorId) || toHex(e.pubkey));
  const f = Math.floor((nominal - 1) / 3);
  const offered = seatedFirst || [];
  const first = offered.length >= f + 1 ? offered.slice(0, nominal) : [];
  const firstOps = new Set(first.map(opOf)), firstNodes = new Set(first.map((e) => toHex(e.pubkey)));
  const byOp = new Map();
  for (const e of entries || []) {
    const a = e && e.advert;
    if (!a || a.guardianCapable !== true || !a.guardianEndpoint) continue;
    const op = String(a.operatorId || toHex(e.pubkey));
    if (guardingOpen.has(op) || firstOps.has(op) || firstNodes.has(toHex(e.pubkey))) continue;
    const had = byOp.get(op);
    if (!had) { byOp.set(op, { entry: e, bondSats: BigInt(e.bondSats) }); continue; }
    had.bondSats += BigInt(e.bondSats);
    if (outpointOrder(e, had.entry) < 0) had.entry = e;
  }
  const pool = [...byOp.values()].filter((x) => x.bondSats >= bondMinGuardian);
  const missing = nominal - first.length;
  const allDrawn = offered.length && !first.length ? `, everything drawn: ${offered.length} seated first is fewer than f + 1 = ${f + 1}` : '';
  if (pool.length < missing)
    return { ok: false, eligible: pool.length, seatedFirst: first.length, why: first.length
      ? `${first.length} seated first, and ${pool.length} other guardian-capable operators hold bond_min_guardian and guard no OPEN federation: the ${missing} missing seats of ${nominal} are not filled, a federation is not founded with fewer`
      : `${pool.length} guardian-capable operators hold bond_min_guardian and none guards an OPEN federation: a federation of ${nominal} is not founded with fewer${allDrawn}` };
  const scored = pool.map((x) => ({ entry: x.entry, ticket: guardianTicket(seed, x.entry, height), weight: weightOf(x.bondSats, bondMinGuardian) }))
    .sort((a, b) => { const l = a.ticket * b.weight, r = b.ticket * a.weight; return l < r ? -1 : l > r ? 1 : outpointOrder(a.entry, b.entry); });
  return { ok: true, eligible: pool.length, seatedFirst: first.length, drawn: [...first, ...scored.slice(0, missing).map((s) => s.entry)],
    alternates: scored.slice(missing, missing + ALTERNATES).map((s) => s.entry),
    why: `${first.length ? `${first.length} seated first, ` : ''}${missing} drawn of ${pool.length} eligible operators, ${Math.min(ALTERNATES, pool.length - missing)} alternates in order${allDrawn}` };
}

/**
 * A NO-SHOW REPLACED: the drawn set after `noShows` (node keys hex that did not take part within founding_window) - each seat of a
 * no-show to the next alternate in order. Answers { ok, seated, used, why }; not ok when the alternates run out.
 */
export function replaceNoShows({ drawn, alternates, noShows }) {
  const out = new Set((noShows || []).map((k) => String(k).toLowerCase()));
  const queue = (alternates || []).filter((e) => !out.has(toHex(e.pubkey)));
  const seated = [];
  let used = 0;
  for (const e of drawn) {
    if (!out.has(toHex(e.pubkey))) { seated.push(e); continue; }
    const next = queue.shift();
    if (!next) return { ok: false, seated, used, why: 'more no-shows than alternates: the founding is drawn again at the next trigger' };
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
export function foundingTrigger({ capable = [], records = [], notices = [], loads = [], nominal, abandonBlocks, federationExists = false, cohort = COHORT_NOMINAL, voided = [],
  tip = null, foundingWindow = null }) {
  const skip = new Set(voided);
  // A COHORT REDRAWS ON THE CHAIN'S CLOCK when the tip and founding_window are known (kanban #495, measured 2026-10-21 at 157,179:
  // the seven second-host seats, restarted at 157,178, drew 218dd6c7 at 157,178; the three installer nodes, whose first readable census was
  // 157,179, drew at 157,179 - each seat's run began where its memory began, and a void moved it to the next height it had seen).
  // The draws are the run's first height, then one founding_window + 1 later each - every seat names the same one from the chain.
  const scheduled = Number.isInteger(tip) && Number.isInteger(foundingWindow) && foundingWindow > 0;
  const cohortAfter = scheduled ? -1 : Math.max(-1, ...[...skip].filter((k) => k.startsWith('cohort:')).map((k) => Number(k.split(':').pop())));
  const found = [];
  if (!federationExists && Number.isInteger(nominal)) {
    const g = capable.find((x) => x.operators >= nominal);
    if (g) found.push({ kind: 'genesis', height: g.height, why: `${g.operators} guardian-capable operators at ${g.height}, at least federation_nominal ${nominal}: the first federation is drawn` });
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
    if (start && at !== null) found.push({ kind: 'cohort', height: at, nominal: cohort,
      why: `${start.free} guardian-capable operators guarding no OPEN federation from ${start.height}, at least ${cohort}: they found a federation of their own`
        + (at !== start.height ? ` (drawn again at ${at}, every founding_window + 1)` : '') });
  }
  const carried = (r) => ({ ...(r.federation !== undefined ? { federation: r.federation } : {}), ...(Number.isInteger(r.nominal) ? { nominal: r.nominal } : {}),
    ...(Array.isArray(r.seatedFirst) ? { seatedFirst: r.seatedFirst } : {}),
    ...(Array.isArray(r.departing) ? { departing: r.departing } : {}) });
  for (const r of records) {
    if (r.status === 'DRAINING' || r.replace === true)
      found.push({ kind: 'succession', height: r.height, ...carried(r), why: `federation ${String(r.federation).slice(0, 16)} ${r.replace ? 'decided by threshold signature to be replaced' : 'entered DRAINING'} at ${r.height}: its successor is drawn` });
  }
  for (const n of notices) {
    if (!Number.isInteger(n.height)) continue;
    found.push({ kind: 'succession', notice: true, height: n.height, ...carried(n),
      why: `a departure notice posted at ${n.height} would make federation ${String(n.federation).slice(0, 16)} ${n.wouldBe || 'DRAINING'}: its successor is drawn now` });
  }
  if (Number.isInteger(abandonBlocks) && abandonBlocks > 0) {
    let since = null;
    for (const at of [...loads].sort((a, b) => a.height - b.height)) {
      const open = (at.federations || []).filter((f) => f.status === 'OPEN');
      const full = open.length > 0 && open.every((f) => typeof f.load === 'number' && f.load >= LOAD_TRIGGER);
      if (!full) { since = null; continue; }
      if (since === null) since = at.height;
      if (at.height - since >= abandonBlocks) {
        found.push({ kind: 'load', height: at.height, why: `every OPEN federation at or above ${LOAD_TRIGGER * 100} % of its cap from ${since} to ${at.height} (abandon_blocks ${abandonBlocks}): a new federation is drawn` });
        break;
      }
    }
  }
  if (!found.length) return { ok: false, why: federationExists ? 'no federation is draining or replaced, and the OPEN ones are not all at 80 % for abandon_blocks' : `fewer than federation_nominal ${nominal} guardian-capable operators so far: no federation, and no paying round` };
  found.sort((a, b) => a.height - b.height);
  const live = found.filter((t) => !skip.has(triggerKey(t)));
  if (!live.length) return { ok: false, why: `every trigger so far went void (${found.length}); the next one draws again` };
  return { ok: true, ...live[0] };
}
