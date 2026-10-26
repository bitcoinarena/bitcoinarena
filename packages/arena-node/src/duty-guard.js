// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
/**
 * THE DAILY DUTY, HARDENED (kanban #689, 2026-10-26: "Make sure that we always post rounds properly for the next day. Harden it. Always
 * the newest app version. We had too many failures."). What the duty runner (tools/run-testnet4-paid.mjs, PAID_DUTY_DAILY and the grid
 * keepers) decides before and after a day's posting, as plain functions over what it read - so each rule is tested on its own:
 *
 *   - THE VERSION: the newest version of the app whose census game nodes are enough to draw a committee (pickNewestVersion), never a
 *     hand-set plugin file that went stale with the next release (10-26: an Up/Down grid posted v13 where v24 was out); a pinned
 *     version older than that is refused, loudly (pinVerdict)
 *   - BEFORE PUBLISHING: the census height's block is the one the seats' chain holds there (chainAgreement - 10-26: one copy named a
 *     census root of a branch the chain left at 157510), and enough of that census hosts the version (hostsOf - the other copy named a
 *     census with 0 game nodes hosting it)
 *   - AFTER PUBLISHING: the publication confirms below its beacon (10-25 #633: it confirmed after, the day died), the beacon goes 6 deep,
 *     and the seats draw the first round's committee (postingVerdict); a day that is dead, or not drawable DUTY_DRAWABLE_BY_MS before it
 *     starts, gets an emergency grid for what is left of it (emergencyDue / emergencyPlan - the owner's standing rule of 10-25), and a
 *     dead posting is never posted to the seats again (10-26: slots 20750-20752 re-posted every ~3.5 min for hours)
 *   - THE TIMELINE: the committee time of a day's posting DUTY_DAY_COMMITTEE_LEAD_MS (12 h) before the day - its beacon is deep by the
 *     afternoon before, so a failure is seen with time left for an emergency grid that covers the whole day; and the post comes from at
 *     most rank DUTY_DAY_RANK_CAP of the duty order, so census nodes that run no duty runner cannot push it towards the evening
 */
import { meetsCensusMinimum } from '../../arena-protocol/src/census.js';
import { dayPostDue, dayStartMs, targetDay, DUTY_DAY_MS } from '../../arena-protocol/src/duty.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const HOUR = 3600000;
// THE DUTY'S APPS BY THE NAME THEIR MANIFESTS CARRY (GET /games `name`): a version is the same app only under the same developer key
export const DUTY_APP_NAMES = Object.freeze({ updown: 'btc-updown-15m', rps: 'rock-paper-scissors', nextblock: 'nextblock' });
// THE DAY'S TIMELINE, EXPLICIT (kanban #689 d): the committee 12 h before the day (was 6 h: its beacon came ~19:00Z, 6 deep ~21:00Z, and a
// failure seen then left an emergency grid ~4.5 h short of the day's start); a day drawable on the seats 4 h before it starts, else an
// emergency grid; an emergency grid's committee 2 h past the tip's median and its first round 140 min (7 blocks) after that, once its beacon
// is 6 deep; a publication still unconfirmed 3 h before its committee time has its fee raised
export const DUTY_DAY_COMMITTEE_LEAD_MS = 12 * HOUR;
export const DUTY_DAY_RANK_CAP = 2;
export const DUTY_DRAWABLE_BY_MS = 4 * HOUR;
export const DUTY_EMERGENCY_COMMITTEE_LEAD_MS = 2 * HOUR;
export const DUTY_SEED_WAIT_MS = 140 * 60000;
export const DUTY_BEACON_DEPTH = 6;
export const DUTY_EMERGENCY_MAX = 3;
export const DUTY_REPOST_EVERY_MS = 10 * 60000;
export const DUTY_BUMP_WITHIN_MS = 3 * HOUR;
// HOW LONG THE SEATS MAY TAKE TO DRAW once the beacon is deep and the series posted, before an undrawn posting counts as dead
export const DUTY_DRAW_GRACE_MS = 45 * 60000;
// AND HOW LONG AFTER ITS COMMITTEE TIME A POSTING ON ITS WAY IS GIVEN TO BE DRAWN: the beacon ~1 h past it (the median lags the clock), 6 deep
// ~2 h later, posted and drawn within the next hour
export const DUTY_DRAW_ALLOW_MS = 4 * HOUR;

/** Each game's round shape for a day: its period and how long after a round's start its entries close. */
export function dayShape(game, periodMs) {
  if (game === 'nextblock') return { periodMs: 90000, entryAfterStartMs: 45000 };
  if (game === 'rps') return { periodMs: 8000, entryAfterStartMs: 80000 };
  if (game === 'updown') { const p = Number(periodMs); if (!(p > 0)) throw new Error('an Up/Down day needs its manifest\'s round period'); return { periodMs: p, entryAfterStartMs: 0 }; }
  throw new Error(`no day shape for ${game}`);
}

/**
 * THE APPS THE SEATS HOLD, one entry per game id: GET /games of each seat asked (`listings`, each `{ games: [...] }`), every manifest
 * decoded (`decode(hex)`) and its id worked out again (`idOf(manifest)`) - an entry whose manifest is not its id is left out.
 */
export function catalogOf(listings, { decode, idOf }) {
  const out = new Map();
  for (const l of listings || []) for (const g of (l && l.games) || []) {
    const id = String(g.id || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(id) || out.has(id) || !g.manifest) continue;
    let m; try { m = decode(Uint8Array.from(Buffer.from(String(g.manifest), 'hex'))); } catch { continue; }
    if (toHex(idOf(m)) !== id) continue;
    out.set(id, { id, name: m.gameName, version: Number(m.version), dev: toHex(m.gameDevPubkey), requiredProtocolVersion: Number(m.requiredProtocolVersion || 1), manifest: m });
  }
  return out;
}

/**
 * MAY A COMMITTEE OF THIS GAME BE DRAWN FROM THIS CENSUS (§0A.4, census.js): enough entries declaring the game role that host the game,
 * and enough settlement entries. `entries` the census (with roles and hostedGames), `contract` the round's (networkId), `gameId` bytes.
 */
export function hostsOf(entries, contract, gameId) {
  const c = { ...contract, gameId };
  const game = meetsCensusMinimum(entries, c, 'game');
  if (!game.ok) return { ok: false, have: game.have, need: game.need, why: game.why };
  const settlement = meetsCensusMinimum(entries, c, 'settlement');
  if (!settlement.ok) return { ok: false, have: game.have, need: game.need, why: settlement.why };
  return { ok: true, have: game.have, need: game.need };
}

/**
 * THE NEWEST VERSION (2026-10-26, the owner: "Always the newest app version"): of the catalog's entries named `name` and signed by `dev`,
 * the highest version this runner's protocol speaks whose census game nodes can draw a committee (`hosts(idHex)` -> { ok, have, need,
 * why }). `tried` says, version by version from the newest, why a newer one was passed over.
 */
export function pickNewestVersion({ name, dev, catalog, hosts, protocol }) {
  const of = [...(catalog || new Map()).values()].filter((g) => g.name === name && (!dev || g.dev === dev)).sort((a, b) => b.version - a.version);
  if (!of.length) return { ok: false, tried: [], why: `the seats list no version of ${name}${dev ? ` by ${dev.slice(0, 8)}` : ''}` };
  const tried = [];
  for (const g of of) {
    if (Number.isFinite(Number(protocol)) && g.requiredProtocolVersion > Number(protocol)) {
      tried.push({ version: g.version, id: g.id.slice(0, 16), why: `needs protocol ${g.requiredProtocolVersion}, this runner posts ${protocol}` });
      continue;
    }
    const h = hosts(g.id);
    if (h.ok) return { ok: true, pick: g, have: h.have, need: h.need, tried };
    tried.push({ version: g.version, id: g.id.slice(0, 16), have: h.have, need: h.need, why: h.why });
  }
  return { ok: false, tried, why: `no version of ${name} has a drawable committee in this census (newest ${of[0].version}: ${tried[0] && tried[0].why})` };
}

/**
 * A PINNED VERSION (DUTY_*_PLUGIN / _NEXT_PLUGIN, an override now): kept only when it IS the newest drawable one. Older - or newer than
 * any the census can draw - it is refused and the newest posted instead, `loud` so the journal says so. With no newest known (the seats
 * or the census unread) the pin stands, also loudly.
 */
export function pinVerdict({ pinId, picked, catalog }) {
  const pin = pinId ? String(pinId).toLowerCase() : null;
  if (!picked || !picked.ok) return pin ? { use: 'pin', loud: true, why: `no newest version known (${picked ? picked.why : 'unread'}): the pinned ${pin.slice(0, 16)} is posted` }
    : { use: 'none', loud: true, why: `no newest version known (${picked ? picked.why : 'unread'}) and no pin` };
  if (!pin || pin === picked.pick.id) return { use: 'pick', loud: false };
  const p = catalog && catalog.get(pin);
  const v = p ? `version ${p.version}` : 'a version the seats do not list';
  return { use: 'pick', loud: true, why: `the pinned ${pin.slice(0, 16)} (${v}) is not the newest drawable version ${picked.pick.version} (${picked.pick.id.slice(0, 16)}): refused, the newest is posted` };
}

/** One core of a manifest's: the one `want` names (hash or prefix), else the one `prefer` names, else the only one. */
export function pickCore(cores, want = '', prefer = '') {
  const hashes = (cores || []).map((c) => (typeof c.hash === 'string' ? c.hash : toHex(c.hash)).toLowerCase());
  for (const w of [want, prefer].map((x) => String(x || '').toLowerCase()).filter(Boolean)) {
    const got = hashes.filter((h) => h.startsWith(w));
    if (got.length === 1) return { ok: true, hash: got[0], index: hashes.indexOf(got[0]) };
  }
  if (hashes.length === 1) return { ok: true, hash: hashes[0], index: 0 };
  return { ok: false, why: `the manifest names ${hashes.length} cores (${hashes.map((h) => h.slice(0, 8)).join(', ')}) and none chosen${want ? ` - ${String(want).slice(0, 8)} is not one` : ''}` };
}

/**
 * A VERSION'S ROUND FIELDS FROM ITS MANIFEST AS THE SEATS HOLD IT, so no plugin file has to be placed for a new version: Up/Down (a
 * market) its game and zero core/config, its period and market terms; Rock Paper Scissors its core and that core's first config, its
 * minimum score, and `base`'s ticks; Tick Tock its game and core. `fromHex` turns a hash into bytes.
 */
export function dutyFieldsOf(game, entry, { core = '', preferCore = '', base = {}, fromHex }) {
  const m = entry.manifest, gameId = fromHex(entry.id), ZERO = new Uint8Array(32);
  if (game === 'updown') {
    if (!(Number(m.roundPeriodMs) > 0) || !m.marketTerms) return { ok: false, why: `${entry.name} ${entry.version} is no market (no period or terms)` };
    return { ok: true, fields: { gameId, simCoreHash: ZERO, configHash: ZERO, minScore: 0 }, periodMs: Number(m.roundPeriodMs), marketTerms: m.marketTerms, manifest: m };
  }
  const c = pickCore(m.cores, core, preferCore);
  if (!c.ok) return { ok: false, why: `${entry.name} ${entry.version}: ${c.why}` };
  if (game === 'rps') {
    const configs = (m.cores[c.index].configs || []).map((x) => (typeof x === 'string' ? x : toHex(x)));
    if (!configs.length) return { ok: false, why: `${entry.name} ${entry.version}: its core ${c.hash.slice(0, 8)} names no config` };
    return { ok: true, fields: { ...base, gameId, simCoreHash: fromHex(c.hash), configHash: fromHex(configs[0]), minScore: Number(m.minScore) }, manifest: m };
  }
  if (game === 'nextblock') return { ok: true, fields: { gameId, simCoreHash: fromHex(c.hash) }, manifest: m };
  return { ok: false, why: `no duty fields for ${game}` };
}

/** The block hashes (display order, as getblockhash prints them) of a seat's GET /headers - 80-byte headers end to end. */
export function headerHashes(bytes, blockHashOf) {
  const out = new Set();
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  for (let i = 0; i + 80 <= b.length; i += 80) out.add(toHex(Uint8Array.from(blockHashOf(b.subarray(i, i + 80))).reverse()));
  return out;
}

/**
 * DO THE SEATS' CHAINS HOLD THIS BLOCK (kanban #689 b, 10-26: our nodes sat on their own branch; a census there is no census anywhere
 * else): `answers` one per seat asked - a Set of its block hashes, or null when it did not answer. A majority of those that answered, and
 * at least `minAnswers` answering.
 */
export function chainAgreement({ hash, answers, minAnswers = 3 }) {
  const read = (answers || []).filter((a) => a instanceof Set && a.size);
  const agree = read.filter((a) => a.has(String(hash).toLowerCase())).length;
  const of = read.length, unread = (answers || []).length - of;
  if (of < minAnswers) return { ok: false, agree, of, unread, why: `only ${of} seat(s) answered with their chain (${minAnswers} needed)` };
  if (agree * 2 <= of) return { ok: false, agree, of, unread, why: `block ${String(hash).slice(0, 16)} is on the chain of ${agree} of ${of} seats: a branch the seats do not follow` };
  return { ok: true, agree, of, unread };
}

/**
 * ONE POSTING'S STATE (kanban #689 c), from what was read:
 *   censusOnChain  this node's block at the census height is still the one the posting named (false: the chain left that branch)
 *   seatsAgree     chainAgreement's answer for that block, or null (not asked)
 *   pubHeight      the publication's block, or null;  beaconAt  the beacon block (first median past committee time), or null;  tip
 *   draw           { drawn, undrawn, of, why } - the seats' GET /rounds rows of the posting's game in its day, or null (not asked)
 *   postedAtMs     when its series were last posted to the seats (the grace before an undrawn posting is dead; null: posted before
 *                  this was kept, no grace)
 *   conflicted     the wallet's word that a transaction in a block spends what the publication spends (confirmations < 0): it is never mined
 * -> { state: 'dead' | 'drawable' | 'pending', stage, why }
 */
export function postingVerdict({ conflicted = false, censusOnChain = true, seatsAgree = null, pubHeight = null, beaconAt = null, tip, draw = null, postedAtMs = null, nowMs, depth = DUTY_BEACON_DEPTH, graceMs = DUTY_DRAW_GRACE_MS }) {
  // CONFLICTED (kanban #689, measured 2026-10-26: three emergency grids on the change of a replaced publication waited for hours as
  // "unconfirmed"): dead at once, so the day's emergency grid is not held back by a posting that can never be mined
  if (conflicted && pubHeight === null) return { state: 'dead', stage: 'publication', why: 'a transaction in a block spends what the publication spends: it is never mined' };
  if (censusOnChain === false) return { state: 'dead', stage: 'census', why: 'the chain left the branch its census was taken on' };
  if (seatsAgree && !seatsAgree.ok && seatsAgree.of >= 3) return { state: 'dead', stage: 'census', why: seatsAgree.why };
  if (beaconAt !== null && (pubHeight === null || pubHeight >= beaconAt))
    return { state: 'dead', stage: 'publication', why: pubHeight === null ? `its beacon block ${beaconAt} came while the publication was unconfirmed` : `published at ${pubHeight}, at or above its beacon block ${beaconAt}` };
  if (pubHeight === null) return { state: 'pending', stage: 'unconfirmed', why: 'the publication is not in a block yet' };
  if (beaconAt === null) return { state: 'pending', stage: 'published', why: `published at ${pubHeight}; no beacon yet` };
  const deep = tip - beaconAt + 1;
  if (deep < depth) return { state: 'pending', stage: 'beacon', why: `beacon ${beaconAt} is ${deep} of ${depth} deep` };
  if (!draw || !draw.of) return { state: 'pending', stage: 'seats', why: 'no seat lists its rounds yet' };
  if (draw.drawn * 2 > draw.of) return { state: 'drawable', stage: 'drawn', why: `drawn on ${draw.drawn} of ${draw.of} seats` };
  if (draw.undrawn * 2 > draw.of && (postedAtMs === null || nowMs - postedAtMs > graceMs))
    return { state: 'dead', stage: 'draw', why: `not drawn on ${draw.undrawn} of ${draw.of} seats: ${draw.why || 'no committee'}` };
  return { state: 'pending', stage: 'seats', why: `drawn on ${draw.drawn} of ${draw.of} seats so far` };
}

/** A day's state from its postings' verdicts: drawable when one is, dead when every one is (or there is none), else pending. */
export function dayVerdict(verdicts) {
  const v = verdicts || [];
  if (v.some((x) => x.state === 'drawable')) return { state: 'drawable' };
  if (!v.length) return { state: 'none', why: 'nothing posted for it' };
  if (v.every((x) => x.state === 'dead')) return { state: 'dead', why: v.map((x) => x.why).join('; ') };
  return { state: 'pending', why: (v.find((x) => x.state === 'pending') || {}).why };
}

/**
 * IS AN EMERGENCY GRID DUE FOR THIS DAY (2026-10-25, the owner's standing rule: a day without playable rounds gets one per game as soon
 * as possible; kanban #689 c): the day has not ended, no emergency grid of it is in flight, fewer than `max` were posted, and either every
 * posting of it is dead, or nothing was posted while the duty's own hours for it are over, or it is not drawable `drawableByMs` before it
 * starts (or while it runs) - or, when a posting is still on its way (`pendingCommitteeMs`, its committee time), DUTY_DRAW_ALLOW_MS after
 * that committee time, if that is later.
 */
export function emergencyDue({ nowMs, day, verdict, emergencies = 0, inFlight = false, postedAny = true, dutyOverMs = null,
  drawableByMs = DUTY_DRAWABLE_BY_MS, pendingCommitteeMs = null, max = DUTY_EMERGENCY_MAX }) {
  // A POSTING STILL ON ITS WAY GETS ITS BEACON 6 DEEP AND ITS DRAW FIRST (DUTY_DRAW_ALLOW_MS after its committee time): a day posted at the
  // old 6 h lead is drawn ~21:00Z, after the 20:00Z mark - an emergency grid then would run beside it, not instead of it
  const byMs = Math.max(day.startMs - drawableByMs, pendingCommitteeMs === null ? -Infinity : pendingCommitteeMs + DUTY_DRAW_ALLOW_MS);
  if (nowMs >= day.endMs) return { due: false, why: 'the day is over' };
  if (inFlight) return { due: false, why: 'an emergency grid of it is on its way' };
  if (emergencies >= max) return { due: false, why: `${emergencies} emergency grids were posted for it already` };
  if (verdict.state === 'drawable') return { due: false };
  if (verdict.state === 'dead') return { due: true, why: `every posting is dead: ${verdict.why}` };
  if (!postedAny && dutyOverMs !== null && nowMs >= dutyOverMs) return { due: true, why: 'nothing was posted for it in the duty\'s hours' };
  if (nowMs >= byMs) return { due: true, why: `not drawable by ${new Date(byMs).toISOString()}: ${verdict.why || verdict.state}` };
  return { due: false };
}

/**
 * THE EMERGENCY GRID'S TIMES: committee `committeeLeadMs` past the tip's median (ms); first start at least `seedWaitMs` after it (its beacon
 * 6 deep, the seats seat it), at least a minute from now and not before the day, on the day's period grid; its rounds to the day's end.
 */
export function emergencyPlan({ nowMs, mtpMs, day, shape, committeeLeadMs = DUTY_EMERGENCY_COMMITTEE_LEAD_MS, seedWaitMs = DUTY_SEED_WAIT_MS }) {
  const p = shape.periodMs;
  const committeeMs = Math.floor(mtpMs + committeeLeadMs) + 500;
  const earliest = Math.max(committeeMs + Math.max(45 * 60000, seedWaitMs) + 1000, nowMs + 60000, day.startMs);
  const firstStartMs = day.startMs + Math.ceil((earliest - day.startMs) / p) * p;
  const slots = Math.floor((day.endMs - firstStartMs) / p);
  if (slots < 1) return { ok: false, why: `no round fits between ${new Date(firstStartMs).toISOString()} and the day's end` };
  return { ok: true, committeeMs, firstStartMs, firstCloseMs: firstStartMs + shape.entryAfterStartMs, slots, lostMs: firstStartMs - day.startMs };
}

/** The day's post due from this machine: the duty order's rank, capped at `cap` - no more than `cap` hours into the day. */
export function dayDueCapped({ nowMs, slot, rank, posted, cap = DUTY_DAY_RANK_CAP }) {
  if (!Number.isInteger(rank) || rank < 0) return false;
  return dayPostDue({ nowMs, slot, rank: Math.min(rank, cap), posted });
}

/** The day `slot` posts and its explicit timeline (kanban #689 d). */
export function dayTimeline(slot, { committeeLeadMs = DUTY_DAY_COMMITTEE_LEAD_MS, cap = DUTY_DAY_RANK_CAP, drawableByMs = DUTY_DRAWABLE_BY_MS } = {}) {
  const { startMs, endMs } = targetDay(slot);
  return { slot, postFromMs: dayStartMs(slot), postByMs: dayStartMs(slot) + (cap + 1) * HOUR, committeeMs: startMs - committeeLeadMs,
    drawableByMs: startMs - drawableByMs, startMs, endMs };
}

/** The seats' GET /rounds rows of one game inside [fromMs, toMs): how many seats list one drawn, how many list them all undrawn. */
export function drawCount(listings, { gameId, fromMs, toMs }) {
  let drawn = 0, undrawn = 0, of = 0, why = '';
  const g = String(gameId).toLowerCase();
  for (const l of listings || []) {
    if (!l || !Array.isArray(l.rounds)) continue;
    const rows = l.rounds.filter((r) => r && r.game && String(r.game.id).toLowerCase() === g && Date.parse(r.startTime) >= fromMs && Date.parse(r.startTime) < toMs);
    if (!rows.length) continue;
    // A SEAT STILL READING ITS VIEW (after a reorg, a restart) says nothing either way: "no chain view", "view ... pending"
    if (!rows.some((r) => r.committee && r.committee.drawn) && rows.every((r) => /no chain view|view .*pending/i.test(String((r.committee || {}).why || '')))) continue;
    of++;
    if (rows.some((r) => r.committee && r.committee.drawn)) drawn++;
    else { undrawn++; why = why || String((rows[0].committee || {}).why || '').slice(0, 160); }
  }
  return { drawn, undrawn, of, why };
}

/** The status line a day of a game gets in the journal (kanban #689 e), one JSON object. */
export function statusLine({ item, day, verdict, postings = [], emergency = null }) {
  return { dutyStatus: item, day: new Date(day.startMs).toISOString().slice(0, 10), state: verdict.state, why: verdict.why || undefined,
    postings: postings.map((p) => ({ txid: String(p.txid || '').slice(0, 16), version: p.version ?? null, game: String(p.gameId || '').slice(0, 16), emergency: !!p.emergency,
      firstStart: p.firstStartMs ? new Date(Number(p.firstStartMs)).toISOString() : null, state: p.verdict.state, stage: p.verdict.stage, why: p.verdict.why })),
    ...(emergency ? { emergency } : {}) };
}

export { DUTY_DAY_MS };
