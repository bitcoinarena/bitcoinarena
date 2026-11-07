// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
/**
 * THE DAY'S DUTY, ONE ENGINE FOR THE NODE AND THE RUNNER (kanban #702, 2026-10-26: "The round runners must be an integrated part of the
 * node. Who decides what round is posted today? There is something in the spec"). What tools/run-testnet4-paid.mjs PAID_DUTY_DAILY did,
 * lifted out with everything it read handed in: the node's own duty poster (duty-poster.js) runs it on its own chain, census, wallet and
 * seats; the runner keeps working by calling the same code until the six runner processes are retired.
 *
 *   WHO       day d's duty (duty.js): the census at the day's anchor in duty order, H(duty tag || network_id || d || node key); the first
 *             is due from the day's start, each next one an hour later while the day's marker is not seen - capped at rank
 *             DUTY_DAY_RANK_CAP (duty-guard.js), so nodes that post nothing cannot push the post towards the evening
 *   WHAT      ONE transaction per app: the next UTC day's rounds in every federation, the newest version the census can draw, the day's
 *             marker OP_RETURN "ARN" 'D' day item beside the series publications, announced to the seats at once (POST /expected), the
 *             series posted to them once the publication is in a block (POST /series)
 *   AFTER     (kanban #689) every posting judged each look - publication below its beacon, its census on the chain the seats follow,
 *             the beacon 6 deep, the committee drawn on the seats - and a day that is dead, or not drawable 4 h before it starts, gets an
 *             emergency grid of what is left of it, carrying its own marker
 *   REORGS    (2026-10-26, the owner: "The hardened round poster must also check for reorgs and forks and repost automatically as needed.
 *             We may never be without a valid round on a day"): a posting whose census block the chain left, or whose census the seats'
 *             chains do not hold, is dead; one dropped back to the mempool by a reorg is watched again, its fee raised near its committee
 *             time, dead once its beacon passes it unconfirmed; one whose coins a mined transaction spends (conflicted) is dead at once -
 *             and a dead day is posted again, at once, as an emergency grid covering from as soon as it can start
 *
 * Nothing here exits the process: a seat that does not answer, a chain read that fails, a grid that is refused - each is said and the next
 * look (a minute later) tries again.
 */
import { join } from 'node:path';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { daySlotOf, targetDay, anchorHeight, dutyOrder, dutyMarkerOutput, dayMarkersOf, postedSeriesOf, itemTag, DUTY_DAY_MS, DUTY_COMMITTEE_LEAD_MS,
  backupMarkerOutput, backupPostDue, DUTY_BACKUP_COMMITTEE_LEAD_MS, DUTY_BACKUP_CENSUS_DEPTH, DUTY_BACKUP_RANK_CAP,
  dayStartMs, DUTY_BACKUP_AFTER_MS, DUTY_FALLBACK_MS } from '../../arena-protocol/src/duty.js';
import { medianTimePast } from '../../arena-protocol/src/beacon.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { marketExpiryBlocks } from '../../arena-protocol/src/lock-expiry.js';
import { beaconBlockIn } from './publication-wait.js';
import * as guard from './duty-guard.js';

export const DUTY_APPS = Object.freeze(['updown', 'rps', 'nextblock']);
/** How many seats must have answered their rounds before an emergency grid is posted on what they say (fewer known: all of them). */
export const DUTY_MIN_SEATS = 3;
/** A publication sent again (our bitcoind, the public chain) or re-announced at most this often per tx (kanban #1126). */
export const DUTY_RESEND_EVERY_MS = 10 * 60000;
/** A fee raise re-announced to the seats at most this many times while a seat does not take it; parents walked this deep. */
export const DUTY_REANNOUNCE_TRIES = 6;
export const DUTY_RESEND_DEPTH = 4;
// KEPT `ms`, BUT NOT AN ANSWER NOBODY GAVE (#702, measured on seat 4 2026-10-26 11:43Z: a first read that found no seat was kept 10 min and
// judged the days "drawn on 0 of 0 seats"): `empty(v)` true is read again at the next ask
const keptFor = (ms, read, now = Date.now, empty = () => false) => { let at = 0, v = null; return async (fresh = false) => { if (fresh || !v || empty(v) || now() - at > ms) { v = await read(); at = now(); } return v; }; };

/**
 * WHO A DAY MARKER IS FROM (kanban #1168, the state machine audit of 2026-11-06: a day marker is a bare 12-byte OP_RETURN, and any such
 * marker in a block or the mempool read "posted" at every duty node - ~5 near-free transactions an app suppressed its day, and foreign
 * emergency markers held the emergency grid back). A marker COUNTS - for "posted", for another node's posting of the day, for the emergency
 * grids on their way - only when it is
 *   OWN       one of this duty's own postings (its kept file names the txid, or one it replaced by a fee raise), or
 *   DUTY      its transaction publishes a series ("ARN" 'S' output) whose signed line this node holds - the line's creator signature over
 *             the series id checked when the line was taken (POST /series, POST /expected) - and that creator is in the day's duty order
 *             (the census at the day's anchor), or
 *   TRUSTED   that creator is one the operator names (`creators`: ARENA_DUTY_CREATORS on a node, the runner's own creator key and
 *             DUTY_CREATORS on a runner) - the publisher of a runner whose creator key is not a node of the census.
 * Every other marker is UNREAD (no line of its series held here, or no order for its day yet) or FOREIGN (a creator outside both): said in
 * the status, counted for nothing.
 */
/** How much earlier than its creator's hour a marker may be first seen and still count: clocks, and testnet4's block times (kanban #1219). */
export const MARKER_EARLY_SLACK_MS = 30 * 60000;
export const MARKER = Object.freeze({ OWN: 'OWN', DUTY: 'DUTY', TRUSTED: 'TRUSTED', UNREAD: 'UNREAD', FOREIGN: 'FOREIGN' });
export const markerCounts = (standing) => standing === MARKER.OWN || standing === MARKER.DUTY || standing === MARKER.TRUSTED;
/** One marker's standing (MARKER): `own` its txid is one of this duty's postings, `creator` hex of its series' line or null, `order` the day's duty order (keys) or null. */
export function markerStanding({ own = false, creator = null, order = null, trusted = new Set() }) {
  if (own) return MARKER.OWN;
  if (!creator) return MARKER.UNREAD;
  const c = String(creator).toLowerCase();
  if (trusted.has(c)) return MARKER.TRUSTED;
  if (!order || !order.length) return MARKER.UNREAD;
  return order.some((k) => toHex(k) === c) ? MARKER.DUTY : MARKER.FOREIGN;
}

/**
 * A POSTING'S FEE RAISE, ONE STEP AT A TIME (kanban #1168: bumpfee set k.txid, but the file was written only after the re-announce and the
 * rebroadcast - network calls - so a crash between them lost the new txid, and the old one, replaced, read as conflicted: dead, a day posted
 * again). NONE -> ASKED is written before bumpfee is called; ASKED -> DONE with the new txid right after it answers; a duty that starts
 * on ASKED asks the wallet what replaced the old txid (replaced_by_txid) and takes that - or, nothing replaced it, the raise was never made:
 * back to NONE, asked again.
 */
export const BUMP = Object.freeze({ NONE: 'NONE', ASKED: 'ASKED', DONE: 'DONE' });
const BUMP_MOVES = Object.freeze({ [BUMP.NONE]: [BUMP.ASKED, BUMP.DONE], [BUMP.ASKED]: [BUMP.DONE, BUMP.NONE], [BUMP.DONE]: [] });
export const bumpOf = (k) => (k.bump && k.bump.state) || (k.bumped ? BUMP.DONE : BUMP.NONE);
/** The posting `k` moved to bump state `to` (BUMP_MOVES), `fields` merged in: answers false (k unchanged) for a move that is not one. */
export function bumpStep(k, to, { atMs = Date.now(), ...fields } = {}) {
  const from = bumpOf(k);
  if (!BUMP_MOVES[from].includes(to)) return false;
  const was = k.txid;
  Object.assign(k, fields);
  k.bump = { state: to, atMs, ...(to === BUMP.ASKED ? { from: was } : {}) };
  k.bumped = to === BUMP.DONE;
  return true;
}

/**
 * WHAT A GRID OF `game` IS BUILT ON NOW (kanban #689): the census `censusDepth` below the tip, its block hash, the newest version's
 * fields, the donation set in force there - refused (ok false, why) when the seats do not follow that block's chain or no version is
 * drawable. Handed in:
 *   chainCall(method, params)  the chain's RPC (getblockcount, getblockhash)
 *   prepare(height)            makes the census at `height` readable (the runner's view window); may be absent
 *   censusEntriesAt(height, game)  the census there, entries with roles and hostedGames (sync or async)
 *   contractAt(game, height)   the round contract the hosting check reads (networkId, slots, bond floor, protocol)
 *   catalogSeats()             seat URLs whose GET /games is the catalog;  chainSeats() seat URLs asked GET /headers;  localCount
 *   devOf                      { game: developer key hex };  protocolFor(game) the protocol a version may require at most (undefined: any)
 *   pinnedFor(game, slot), builtinFor(game)   the runner's pins and built-in versions (the node has neither)
 *   cores { nextblock, rps }, rpsBase   the core asked for, the RPS ticks a version's fields start from
 *   donationSetAt(height)      the donation set in force there (bytes)
 */
export function createGridBase({ chainCall, prepare = null, censusEntriesAt, contractAt, catalogSeats, chainSeats, localCount = 0, devOf = {},
  protocolFor = () => undefined, pinnedFor = () => null, builtinFor = () => ({ gameId: null, fields: {} }), cores = {}, rpsBase = {},
  donationSetAt, censusDepth = 6, checkSeats = 16, decode, idOf, blockHashOf, fetchFn = fetch, say = () => {}, now = Date.now }) {
  const seatJson = async (url, ms = 20000) => { const r = await fetchFn(url, { signal: AbortSignal.timeout(ms) }); if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.json(); };
  // THE APPS THE SEATS HOLD (GET /games, every manifest checked against its id), read again every 5 min
  const seatCatalog = keptFor(5 * 60000, async () => guard.catalogOf((await Promise.all((await catalogSeats()).map((u) => seatJson(`${u}/games`).catch(() => null)))).filter(Boolean),
    { decode, idOf }), now, (c) => !c || !c.size);
  // THE SEATS' CHAINS (GET /headers), read again every 15 min
  const seatChains = keptFor(15 * 60000, async () => ({ local: localCount, sets: await Promise.all((await chainSeats()).slice(0, checkSeats).map(async (u) => {
    try { const r = await fetchFn(`${u}/headers`, { signal: AbortSignal.timeout(30000) }); return r.ok ? guard.headerHashes(new Uint8Array(await r.arrayBuffer()), blockHashOf) : null; } catch { return null; }
  })) }), now, (c) => !c.sets.some(Boolean));
  // A MAJORITY OF ALL THE SEATS ASKED - and of the OTHER machines' seats when three or more of them answer: seats that read the same
  // bitcoind agree with it on a branch of its own whatever the rest of the network follows (10-26, 157625)
  const agreementOf = (hash, c) => {
    const all = guard.chainAgreement({ hash, answers: c.sets });
    const others = guard.chainAgreement({ hash, answers: c.sets.slice(c.local) });
    return all.ok && !others.ok && others.of >= 3 ? { ...others, why: `${others.why} (the other machines' seats)` } : all;
  };
  const censusAgreed = async (hash) => {
    let got = agreementOf(hash, await seatChains());
    if (!got.ok) got = agreementOf(hash, await seatChains(true));   // asked again once: the seats move
    return got;
  };
  async function newestFields(game, { censusHeight, slot }) {
    let cat = null, entries = null, why = '';
    try { cat = await seatCatalog(); } catch { cat = null; }
    try { entries = await censusEntriesAt(censusHeight, game); } catch (e) { why = e.message; }
    if (!entries && !why) why = `no census at ${censusHeight}`;
    const contract = await contractAt(game, censusHeight);
    const picked = cat && cat.size && entries
      ? guard.pickNewestVersion({ name: guard.DUTY_APP_NAMES[game], dev: devOf[game], catalog: cat, protocol: protocolFor(game), hosts: (id) => guard.hostsOf(entries, contract, fromHex(id)) })
      : { ok: false, tried: [], why: !cat || !cat.size ? 'no seat answered GET /games' : why };
    const pin = pinnedFor(game, slot);
    const v = guard.pinVerdict({ pinId: pin && pin.gameId ? toHex(pin.gameId) : null, picked, catalog: cat });
    if (v.loud) say({ dutyVersion: v.use === 'pick' ? 'PIN REFUSED' : v.use === 'pin' ? 'PIN USED, NEWEST UNKNOWN' : 'BUILT-IN USED, NEWEST UNKNOWN', game, why: v.why, tried: picked.tried });
    if (v.use === 'pick') {
      const f = guard.dutyFieldsOf(game, picked.pick, { core: game === 'nextblock' ? cores.nextblock : cores.rps,
        preferCore: pin && pin.fields.simCoreHash ? toHex(pin.fields.simCoreHash) : '', base: rpsBase, fromHex });
      if (!f.ok) return { ok: false, why: f.why };
      return { ok: true, fields: f.fields, periodMs: f.periodMs, marketTerms: f.marketTerms, version: picked.pick.version, id: picked.pick.id, hosts: `${picked.have}/${picked.need}`,
        requiredProtocol: picked.pick.requiredProtocolVersion };
    }
    const use = v.use === 'pin' ? pin : builtinFor(game);
    // A NODE HAS NO PIN AND NO BUILT-IN VERSION: with no newest one known it posts nothing (the runner posts its own, as before)
    if (!use) return { ok: false, why: v.why || 'no version to post' };
    const id = use.gameId ? toHex(use.gameId) : null;
    return { ok: true, fields: use.fields, periodMs: use.periodMs, marketTerms: use.marketTerms, version: id && cat && cat.get(id) ? cat.get(id).version : null, id, fallback: true };
  }
  async function gridBase(game, slot = daySlotOf(now()), { depth = censusDepth } = {}) {
    const tip = Number(await chainCall('getblockcount', []));
    const censusHeight = tip - depth;
    if (prepare) await prepare(censusHeight);
    const censusHash = String(await chainCall('getblockhash', [censusHeight]));
    const agreed = await censusAgreed(censusHash);
    if (!agreed.ok) return { ok: false, why: `census ${censusHeight} (${censusHash.slice(0, 16)}): ${agreed.why}` };
    const v = await newestFields(game, { censusHeight, slot });
    if (!v.ok) return v;
    say({ dutyVersion: v.fallback ? 'fallback' : 'newest', game, version: v.version, gameId: v.id ? v.id.slice(0, 16) : null, hosts: v.hosts, censusHeight, seatsOnChain: `${agreed.agree}/${agreed.of}` });
    return { ...v, censusHeight, censusHash, seatsOnChain: `${agreed.agree}/${agreed.of}`, donationSetId: await donationSetAt(censusHeight) };
  }
  return { gridBase, newestFields, seatCatalog, seatChains, agreementOf, censusAgreed };
}

/**
 * ONE APP'S DAY DUTY. Handed in:
 *   game, item                  the app (updown | rps | nextblock) and its plan item's name (the marker's tag: sha256(item)[0..4])
 *   networkId                   bytes;  local  a Set of this machine's node keys (hex)
 *   dir                         where the postings are kept (<item>-<slot>.json, <item>-<slot>-e<n>.json, status-<item>.json)
 *   chain { view, censusKeysAt, seatUrls }   the blocks to the tip (headers, transactions), the census's node keys at a height, the seats
 *   chainCall, walletRpc        the chain's RPC and the paying wallet's
 *   gridBase                    createGridBase's;  base.ok false is said, nothing published
 *   openGrid(kind, opts)        builds, funds and sends one grid (waitBeacon false): { ok, txid, series, lines } | { dry, ... } | { ok: false, why }
 *   postSeries(line)            -> { took, of, refused }
 *   fedsNow()                   the federations a day names now (a draining one's successor)
 *   seatCatalog, devOf          the seats' apps, each app's developer key
 *   creator, stakeMsat          what every grid names (creatorSecret), its stake
 *   feeRate, maxFeeRate, dry, gridDry, fromDay, committeeLeadMs, rankCap, drawableByMs, emergencyOn, emergencyCommitteeLeadMs,
 *   seedWaitMs, drawSeats, dryRank0, seatsAgreeOn(hash), canPay()
 *   role                        'primary' (the day's grid, from rank 1) or 'backup' (the day's second grid, from rank 2 - duty.js): a backup
 *                               carries the backup marker, a census DUTY_BACKUP_CENSUS_DEPTH deep, its own committee lead, no emergency grids,
 *                               and is never posted by the node that posted the primary (postedPrimary(slot))
 *   announce({ lines, tx, targets })   (kanban #1126) POST /expected of a posting's lines with its publication (hex) to the seats -> { took, of };
 *                               a fee raise changes the txid, and the seats must name the new one
 *   publicSend(hex)             (kanban #1126) the publication sent to the public chain (Esplora POST /tx) -> { ok, status, text, base }; absent: not sent
 *   say(o), now()
 * -> { look(), state() }: look() runs one pass (never throws); state() what the last pass saw, for GET /duty.
 */
// ONE CHAIN INDEX PER CHAIN VIEW, FOR EVERY DAY DUTY (kanban #791, allocation sampled 2026-10-30 02:3xZ on test host seat 6: 250 of 815 MB
// allocated in 30 s were parseTransaction, its txid hashing and the index around them - every day duty (Up/Down, RPS, Next Block, each
// primary and backup) parsed every transaction of the last 300 blocks on each 60 s pass, while the duty poster's chain view only changes
// with the best block). The view is the key: a new tip is a new view, and the index of the old one goes with it. The index is only
// read (its markers spread, filtered, its `at` asked), and its markers carry no per-duty field (markersOf's 'B:' names every backup alike).
const indexOfView = new WeakMap();

export function createDayDuty(o) {
  const { game, item, networkId, local, dir, chain, chainCall, walletRpc, gridBase, openGrid, postSeries, fedsNow, seatCatalog, devOf = {},
    creator = {}, stakeMsat, feeRate = 0.1, maxFeeRate = 1, dry = false, gridDry = false, fromDay = 0,
    committeeLeadMs = guard.DUTY_DAY_COMMITTEE_LEAD_MS, rankCap = guard.DUTY_DAY_RANK_CAP, drawableByMs = guard.DUTY_DRAWABLE_BY_MS,
    emergencyOn = true, emergencyCommitteeLeadMs = guard.DUTY_EMERGENCY_COMMITTEE_LEAD_MS, seedWaitMs = guard.DUTY_SEED_WAIT_MS,
    drawSeats = 12, dryRank0 = false, seatsAgreeOn = null, role = 'primary', postedPrimary = async () => false, fetchFn = fetch, say = () => {}, now = Date.now, canPay = async () => ({ ok: true }),
    announce = null, publicSend = null, creatorOf = null, seriesInfoOf = null, creators = [] } = o;
  // WHO A MARKER IS FROM (kanban #1168, MARKER above): `creatorOf(seriesIdHex)` the creator key (hex) of a series whose signed line this
  // process holds - null for none; `creators` the creator keys the operator names as duty posters beside the day's duty order
  const trusted = new Set((creators || []).map((k) => String(k).trim().toLowerCase()).filter((k) => /^[0-9a-f]{64}$/.test(k)));
  const creatorOfTx = new Map();   // txid -> the creator its series' line names (found ones only: a line not held yet is asked again)
  if (!DUTY_APPS.includes(game)) throw new Error(`no day duty for ${game}`);
  const backup = role === 'backup';
  // A BACKUP'S MARKERS ARE NAMED APART ('B:' before the tag): its marker kind is 'B', the day's own 'D'
  const tag = backup ? `B:${toHex(itemTag(item))}` : toHex(itemTag(item));
  const markersOf = (raw) => dayMarkersOf(raw).map((m) => ({ ...m, tag: m.kind === 'B' ? `B:${m.tag}` : m.tag }));
  // AN EMERGENCY GRID CARRIES ITS OWN MARKER (kanban #689): every machine sees one is on its way, and none is mistaken for the day's posting
  const emergencyItem = `${item}-emergency`, emergencyTag = backup ? 'none' : toHex(itemTag(emergencyItem));
  const emergencyGrids = emergencyOn && !backup;
  const leadMs = backup ? DUTY_BACKUP_COMMITTEE_LEAD_MS : committeeLeadMs;
  mkdirSync(dir, { recursive: true });
  const fileOf = (slot) => join(dir, `${item}-${slot}.json`);
  const censusAt = new Map();
  let busy = false, lastSaid = '';
  const seen = { slot: null, anchor: null, order: [], rank: -1, posted: false, due: false, markers: [], days: {}, error: null, mine: [], wouldPost: [], lookedAtMs: null };
  const fail = (why) => { seen.error = { atMs: now(), why: String(why).slice(0, 400) }; };
  // THE POSTINGS KEPT FOR A DAY SLOT: the day's own (<item>-<slot>.json) and its emergency grids (<item>-<slot>-e<n>.json)
  const keptOf = (slot) => readdirSync(dir).filter((f) => f === `${item}-${slot}.json` || new RegExp(`^${item}-${slot}-e\\d+\\.json$`).test(f)).sort()
    .map((f) => { try { return { file: join(dir, f), ...JSON.parse(readFileSync(join(dir, f), 'utf8')) }; } catch { return null; } }).filter(Boolean);
  const keep = (k) => { const { file, ...rest } = k; writeFileSync(file, JSON.stringify(rest) + '\n'); };
  // THIS DUTY'S OWN POSTINGS OF A DAY: their txids, and the ones a fee raise replaced
  const ownTxids = (slot) => new Set([...keptOf(slot).flatMap((k) => [k.txid, ...(k.replaced || [])]), ...seen.mine.filter((x) => x.slot === slot).map((x) => x.txid)].filter(Boolean));
  // A MARKER'S POSTER IS THE CREATOR OF A SERIES IT PUBLISHES FOR ITS DAY (kanban #1204 FED-C1): with `seriesInfoOf`, only a series of
  // this app (any version) whose first round closes inside the marker's target day speaks for it - a copied id of a series already held
  // (yesterday's, another app's) made one cheap tx count as the day's posting at every seat (the #1168 fix took any held id)
  const allFamilyIds = async () => {
    const all = [...((await seatCatalog().catch(() => null)) || new Map()).values()].filter((g) => g.name === guard.DUTY_APP_NAMES[game] && (!devOf[game] || g.dev === devOf[game]));
    return new Set(all.map((g) => String(g.id)));
  };
  const creatorOfMarker = async (m) => {
    const key = `${m.txid}:${m.slot}:${m.tag}`;
    if (creatorOfTx.has(key)) return creatorOfTx.get(key);
    if (typeof creatorOf !== 'function' && typeof seriesInfoOf !== 'function') return null;
    const day = targetDay(m.slot);
    let family = null;
    for (const id of m.series || []) {
      let c = null;
      if (typeof seriesInfoOf === 'function') {
        let info = null; try { info = await seriesInfoOf(id); } catch { info = null; }
        if (!info || !info.creator) continue;
        if (!(Number(info.firstCloseMs) >= day.startMs && Number(info.firstCloseMs) < day.endMs)) continue;
        if (info.gameId) { if (!family) family = await allFamilyIds(); if (family.size && !family.has(String(info.gameId))) continue; }
        c = info.creator;
      } else { try { c = await creatorOf(id); } catch { c = null; } }
      if (c) { c = String(c).toLowerCase(); creatorOfTx.set(key, c); if (creatorOfTx.size > 5000) creatorOfTx.delete(creatorOfTx.keys().next().value); return c; }
    }
    return null;
  };
  // WHEN THIS NODE FIRST SAW EACH MARKER'S TRANSACTION (kanban #1219): the mempool read's time, else its block's time
  const seenAt = new Map();
  const noteSeen = (txid, ms) => { if (!txid || seenAt.has(txid)) return; seenAt.set(txid, ms); if (seenAt.size > 20000) seenAt.delete(seenAt.keys().next().value); };
  const emergencyTagOf = () => emergencyTag;
  /** The markers with their standing (MARKER) and whether they count, by the duty order of each one's day (`orders`: { slot: { order } }). */
  const standingOf = async (markers, orders) => {
    const own = new Map();
    const out = [];
    for (const m of markers) {
      if (!own.has(m.slot)) own.set(m.slot, ownTxids(m.slot));
      const isOwn = own.get(m.slot).has(m.txid);
      const creator = isOwn ? null : await creatorOfMarker(m);
      const order = orders && orders[m.slot] ? orders[m.slot].order : null;
      let standing = markerStanding({ own: isOwn, creator, order, trusted });
      // A DUTY POSTER COUNTS ONLY FROM ITS OWN HOUR (kanban #1219, audit 3 #1210 FIXES-12): any census node is in the duty order, so a node of
      // rank 9 posting its own grid of the day at 00:00Z, before the nodes whose hour it is, read as the day posted at every node. A primary
      // marker counts from the hour its creator's rank is due (dayDueFromMs), a backup's from the backup's due time for that rank, both as
      // this node first saw it (the mempool, else its block's time) with MARKER_EARLY_SLACK_MS for clocks; an emergency marker is not bound here
      if (standing === MARKER.DUTY && order && m.tag !== emergencyTagOf(m)) {
        const rank = order.findIndex((k) => toHex(k) === String(creator).toLowerCase());
        const backupMarker = String(m.tag).startsWith('B:');
        const dueMs = backupMarker ? (rank >= 1 ? dayStartMs(m.slot) + DUTY_BACKUP_AFTER_MS + (Math.min(rank, DUTY_BACKUP_RANK_CAP) - 1) * DUTY_FALLBACK_MS : Infinity)
          : guard.dayDueFromMs(m.slot, rank, rankCap);
        const seen = seenAt.get(m.txid);
        if (seen !== undefined && seen < dueMs - MARKER_EARLY_SLACK_MS) standing = MARKER.FOREIGN;
      }
      out.push({ ...m, creator, standing, counts: markerCounts(standing) });
    }
    return out;
  };
  /** ONE GRID FOR THE DAY SLOT `slot` POSTS: the whole next day at the day's timeline - or, `emergency` given, a grid of the rest of it. */
  const publish = async (slot, emergency = null) => {
    const postFeds = await fedsNow();
    if (!postFeds.length) throw new Error('no federation to post the day in');
    const { startMs, endMs } = targetDay(slot);
    const base = await gridBase(game, slot, backup ? { depth: DUTY_BACKUP_CENSUS_DEPTH } : {});
    if (!base.ok) throw new Error(`nothing published: ${base.why}`);
    const shape = guard.dayShape(game, base.periodMs);
    // AN EMERGENCY GRID'S TIMES from the tip's median now (emergencyPlan), the day's own from its timeline
    const plan = emergency ? guard.emergencyPlan({ nowMs: now(), mtpMs: emergency.mtpMs, day: { startMs, endMs }, shape, committeeLeadMs: emergency.committeeLeadMs, seedWaitMs: emergency.seedWaitMs }) : null;
    if (plan && !plan.ok) throw new Error(`no emergency grid: ${plan.why}`);
    const times = plan || { committeeMs: startMs - leadMs, firstStartMs: startMs, slots: (endMs - startMs) / shape.periodMs };
    const marker = backup ? backupMarkerOutput(slot, item) : dutyMarkerOutput(slot, plan ? emergencyItem : item);
    const per = (extra) => postFeds.map((f) => ({ donationSetId: base.donationSetId, federationId: fromHex(f), ...extra }));
    const kind = { ...creator, fields: { ...base.fields, censusHeight: base.censusHeight }, tableFields: game === 'rps' ? [...per({}), ...per({})] : per({}), stakeMsat, mustDraw: true,
      base, ...(game === 'updown' ? { stakeExpiryFor: (t) => { const n = marketExpiryBlocks(t, base.marketTerms); if (!n.ok) throw new Error(n.why); return n.blocks; } } : {}) };
    const got = await openGrid(kind, { feeRate, maxFeeRate, committeeTimeMs: BigInt(times.committeeMs), extraOutputs: [marker], waitBeacon: false,
      slots: times.slots, windowMs: BigInt(shape.periodMs), entryAfterStartMs: BigInt(shape.entryAfterStartMs), firstCloseMs: BigInt(times.firstStartMs + shape.entryAfterStartMs) });
    if (got.dry) { say({ dutyDay: 'grid dry', item, slot, emergency: !!plan, version: base.version, accepted: got.accepted, reject: got.reject, rounds: got.rounds, bytes: got.bytes, feeSat: got.feeSat,
      series: (got.series || []).length, firstStart: got.firstStart, lastClose: got.lastClose, committeeTime: got.committeeTime }); return null; }
    if (!got.ok) throw new Error(got.why || 'the grid was not published');
    const n = plan ? keptOf(slot).filter((k) => k.emergency).length + 1 : 0;
    const k = { file: plan ? join(dir, `${item}-${slot}-e${n}.json`) : fileOf(slot), item, slot, target: new Date(startMs).toISOString(), txid: got.txid, series: got.series, lines: got.lines,
      posted: null, emergency: !!plan, committeeMs: times.committeeMs, firstStartMs: times.firstStartMs, censusHeight: base.censusHeight, censusHash: base.censusHash,
      gameId: base.id, version: base.version, publishedAtMs: now(), announcedTxid: got.txid, ...(got.announcedTo ? { announcedTo: got.announcedTo } : {}) };
    keep(k);
    seen.mine.push({ app: game, slot, txid: got.txid, emergency: !!plan, atMs: now() });
    say({ dutyDay: plan ? 'EMERGENCY PUBLISHED' : 'published', item, slot, target: k.target, txid: got.txid, series: got.series.map((x) => x.slice(0, 16)), rounds: got.rounds,
      version: base.version, gameId: String(base.id || '').slice(0, 16), censusHeight: base.censusHeight, committeeTime: new Date(times.committeeMs).toISOString(), firstStart: new Date(times.firstStartMs).toISOString() });
    return k;
  };
  // THE BLOCKS OF THE LAST 300: which transactions are in which block, and the day markers in them (with the series they publish) -
  // made once per chain view (indexOfView), not once per pass of each day duty
  const chainIndex = (view) => {
    const kept = indexOfView.get(view), n = view.blocks.length, last = view.blocks[n - 1];
    // the same view object grown or changed in place (a caller that appends to it) is indexed anew
    if (kept && kept.n === n && kept.last === last && kept.firstHeight === view.firstHeight) return kept.idx;
    const idx = chainIndexOf(view);
    indexOfView.set(view, { n, last, firstHeight: view.firstHeight, idx });
    return idx;
  };
  const chainIndexOf = (view) => {
    const tip = view.firstHeight + view.blocks.length - 1;
    const at = new Map(), markers = [];
    const from = Math.max(0, view.blocks.length - 300);
    for (let i = from; i < view.blocks.length; i++) for (const raw of view.blocks[i].transactions || []) {
      let txid = null;
      try { txid = toHex(Uint8Array.from(parseTransaction(raw).txid).reverse()); at.set(txid, view.firstHeight + i); } catch { /* not one */ }   // display order, as sendrawtransaction names it
      const ms = markersOf(raw);
      if (ms.length) { const series = postedSeriesOf(raw); for (const m of ms) markers.push({ ...m, height: view.firstHeight + i, txid, series });
        // the block's time, for a marker this node never saw in the mempool (kanban #1219)
        try { const h = view.blocks[i].header; noteSeen(txid, new DataView(h.buffer, h.byteOffset, h.byteLength).getUint32(68, true) * 1000); } catch { /* no header */ } }
    }
    return { tip, at, markers };
  };
  // AND THE MEMPOOL'S MARKERS - one transaction gone between the list and the read no longer hides the others (10-26 01:37Z). Each
  // transaction is read once while it stays in the mempool.
  const poolSeen = new Map();
  let poolRead = false;                          // the mempool was read this pass (a pass that could not read it posts nothing)
  let poolIds = null;                            // the mempool's txids as last read (null: not read) - kanban #1126
  const mempoolMarkers = async () => {
    let txids = [];
    try { txids = await chainCall('getrawmempool', []); } catch { poolRead = false; poolIds = null; return [...poolSeen.values()].flat(); }
    poolRead = true;
    const live = new Set(txids);
    poolIds = live;
    for (const t of [...poolSeen.keys()]) if (!live.has(t)) poolSeen.delete(t);
    for (const txid of txids) {
      if (poolSeen.has(txid)) continue;
      try { const raw = fromHex(await chainCall('getrawtransaction', [txid])); const ms = markersOf(raw); const series = ms.length ? postedSeriesOf(raw) : [];
        if (ms.length) noteSeen(txid, now());
        poolSeen.set(txid, ms.map((m) => ({ ...m, height: null, txid, series }))); } catch { /* gone meanwhile */ }
    }
    return [...poolSeen.values()].flat();
  };
  // THE SERIES TO THE SEATS once the publication is in a block - not a dead one, not past its day's end, not more often than every
  // DUTY_REPOST_EVERY_MS (10-26: three dead days were re-posted to 52 seats every ~3.5 min)
  const postKept = async (idx) => {
    const nowMs = now();
    for (const f of readdirSync(dir).filter((x) => x.startsWith(`${item}-`) && x.endsWith('.json'))) {
      let k; try { k = { file: join(dir, f), ...JSON.parse(readFileSync(join(dir, f), 'utf8')) }; } catch { continue; }
      if (!k.lines || !k.txid) continue;
      if (k.posted && k.posted.every((p) => p.took === p.of)) continue;
      if (!idx.at.has(k.txid)) continue;
      if (k.verdict && k.verdict.state === 'dead') continue;
      if (Date.parse(k.target) + DUTY_DAY_MS <= nowMs) continue;
      if (k.postedAtMs && nowMs - k.postedAtMs < guard.DUTY_REPOST_EVERY_MS) continue;
      const posted = [];
      for (const line of k.lines) { try { posted.push(await postSeries(line)); } catch (e) { posted.push({ took: 0, of: 1, refused: [{ who: '-', why: e.message }] }); } }
      k.posted = posted.map((p) => ({ took: p.took, of: p.of }));
      k.postedAtMs = nowMs;
      keep(k);
      say({ dutyDay: 'posted', item, slot: k.slot, emergency: !!k.emergency, seats: posted.map((p) => `${p.took}/${p.of}`), refused: posted.flatMap((p) => p.refused || []).slice(0, 3) });
    }
  };
  // THE SEATS' ROUNDS (GET /rounds?next=1&ahead=50h), read again every 10 min
  const seatRounds = keptFor(10 * 60000, async () => Promise.all((await chain.seatUrls()).slice(0, drawSeats)
    .map(async (u) => { try { const r = await fetchFn(`${u}/rounds?next=1&ahead=50h`, { signal: AbortSignal.timeout(60000) }); return r.ok ? await r.json() : null; } catch { return null; } })), now,
    (l) => !l.some(Boolean));
  // HOW MANY SEATS ANSWERED THEIR ROUNDS: an emergency grid is posted only on the word of DUTY_MIN_SEATS of them (#702, seat 4's first pass)
  const seatsAnswered = async () => { const l = await seatRounds(); return { answered: l.filter(Boolean).length, asked: l.length }; };
  // ONLY THE NEWEST VERSION COUNTS (2026-10-26, the owner: "We should always play the newest version not v13"): a day an older version's
  // grid covers is not covered, so the emergency grid on the newest one is posted
  const familyIds = async () => {
    const all = [...((await seatCatalog().catch(() => null)) || new Map()).values()].filter((g) => g.name === guard.DUTY_APP_NAMES[game] && (!devOf[game] || g.dev === devOf[game]));
    const top = Math.max(0, ...all.map((g) => g.version || 0));
    return new Set(all.filter((g) => (g.version || 0) === top).map((g) => g.id));
  };
  const familyDraw = async (fromMs, toMs) => {
    let best = { drawn: 0, undrawn: 0, of: 0, why: '' };
    for (const id of await familyIds()) { const d = guard.drawCount(await seatRounds(), { gameId: id, fromMs, toMs, nowMs: now() }); if (d.drawn > best.drawn || (!best.of && d.of)) best = d; }
    return best;
  };
  /**
   * A FEE RAISE ASKED AND NOT WRITTEN BACK (a crash between bumpfee and the file, kanban #1168): what the wallet says replaced the old txid is
   * the posting's now - ASKED -> DONE; nothing replaced it: the raise never went out - ASKED -> NONE. Run before anything reads the posting.
   */
  const settleBump = async (k) => {
    if (bumpOf(k) !== BUMP.ASKED) return;
    const from = (k.bump && k.bump.from) || k.txid;
    let by = null; try { const t = await walletRpc('gettransaction', [from]); by = t && t.replaced_by_txid ? String(t.replaced_by_txid) : null; } catch { by = null; }
    if (by) { bumpStep(k, BUMP.DONE, { replaced: [...(k.replaced || []), from], txid: by, atMs: now() }); say({ dutyDay: 'fee raise found', item, slot: k.slot, from: from.slice(0, 16), to: by.slice(0, 16) }); }
    else bumpStep(k, BUMP.NONE, { atMs: now() });
    keep(k);
  };
  /** One kept posting judged (postingVerdict), its fee raised once if it is still unconfirmed close to its committee time. */
  const judge = async (k, view, idx, mtpMs) => {
    const day = targetDay(k.slot), nowMs = now();
    await settleBump(k);
    const committeeMs = Number(k.committeeMs ?? (day.startMs - DUTY_COMMITTEE_LEAD_MS));
    // A REORG THAT LEFT THE CENSUS BLOCK (10-26, our nodes on their own branch from 157625): dead, and the day is posted again
    let censusOnChain = true;
    if (k.censusHash && Number.isInteger(k.censusHeight)) { try { censusOnChain = String(await chainCall('getblockhash', [k.censusHeight])) === k.censusHash; } catch { censusOnChain = true; } }
    let seatsAgree = null;
    if (k.censusHash && seatsAgreeOn) { try { seatsAgree = await seatsAgreeOn(k.censusHash); } catch { seatsAgree = null; } }
    // A REORG THAT DROPPED THE PUBLICATION BACK TO THE MEMPOOL (10-26, 157661): not in a block any more - watched as unconfirmed again
    const pubHeight = idx.at.has(k.txid) ? idx.at.get(k.txid) : null;
    const cut = { firstHeight: Math.max(view.firstHeight, idx.tip - 299), blocks: view.blocks.slice(-300) };
    const beaconAt = beaconBlockIn({ committeeTimeMs: BigInt(committeeMs) }, cut);
    const deep = beaconAt !== null && pubHeight !== null && pubHeight < beaconAt && idx.tip - beaconAt + 1 >= guard.DUTY_BEACON_DEPTH;
    const draw = !deep ? null : k.gameId ? guard.drawCount(await seatRounds(), { gameId: k.gameId, fromMs: Number(k.firstStartMs ?? day.startMs), toMs: day.endMs, nowMs: now() })
      : await familyDraw(day.startMs, day.endMs);
    // CONFLICTED (a fee raise elsewhere replaced the coin under it, 10-26 d2a9c0c7 / 094e6875): the wallet's confirmations < 0
    let conflicted = false;
    if (pubHeight === null) { try { conflicted = Number((await walletRpc('gettransaction', [k.txid])).confirmations) < 0; } catch { conflicted = false; } }
    const v = guard.postingVerdict({ conflicted, censusOnChain, seatsAgree, pubHeight, beaconAt, tip: idx.tip, draw, postedAtMs: k.postedAtMs ?? null, nowMs });
    // STILL UNCONFIRMED DUTY_BUMP_WITHIN_MS (3 h) BEFORE ITS COMMITTEE TIME: its fee raised to maxFeeRate, once (it is replaceable)
    let changed = !k.verdict || k.verdict.state !== v.state || k.verdict.stage !== v.stage;
    if (v.stage === 'unconfirmed' && bumpOf(k) === BUMP.NONE && mtpMs >= committeeMs - guard.DUTY_BUMP_WITHIN_MS && !dry) {
      // WRITTEN BEFORE THE RAISE, AND THE NEW TXID AT ONCE AFTER IT (kanban #1168): nothing between bumpfee and the file but the move
      bumpStep(k, BUMP.ASKED, { atMs: nowMs }); keep(k);
      try { const b = await walletRpc('bumpfee', [k.txid, { fee_rate: maxFeeRate }]); say({ dutyDay: 'fee raised', item, slot: k.slot, from: k.txid.slice(0, 16), to: String(b.txid).slice(0, 16), feeRate: maxFeeRate });
        bumpStep(k, BUMP.DONE, { replaced: [...(k.replaced || []), k.txid], txid: String(b.txid), atMs: nowMs }); }
      catch (e) { say({ dutyDay: 'fee not raised', item, slot: k.slot, txid: k.txid.slice(0, 16), why: e.message }); bumpStep(k, BUMP.DONE, { atMs: nowMs }); }
      keep(k); changed = true;
    }
    // THE SEATS NAME THE NEW TXID (kanban #1126, 11-04: three fee raises left every seat's /expected and /pending on a dead tx)
    if (await reannounce(k, v, nowMs)) changed = true;
    // AND A PUBLICATION NOT IN A BLOCK IS KEPT ALIVE (kanban #1126): in our mempool again, and on the public chain
    if (pubHeight === null) await keepAlive(k, v, nowMs);
    k.verdict = v;
    if (changed) keep(k);
    return v;
  };
  const dayOver = (k, nowMs) => Date.parse(k.target) + DUTY_DAY_MS <= nowMs;
  // A WALLET TRANSACTION'S BYTES (gettransaction hex), else the node's (getrawtransaction - only while it is in the mempool)
  const hexOf = async (txid) => {
    try { const t = await walletRpc('gettransaction', [txid]); if (t && t.hex) return { hex: String(t.hex), confirmations: Number(t.confirmations) }; } catch { /* not the wallet's */ }
    try { return { hex: String(await chainCall('getrawtransaction', [txid])), confirmations: 0 }; } catch { return null; }
  };
  /**
   * RE-ANNOUNCED AFTER A FEE RAISE (kanban #1126): the posting's lines with its new publication to the seats the first announcement went to
   * (and the seats known now); each seat keeps one publication per series and takes the new one in place of the old. Asked again every
   * DUTY_RESEND_EVERY_MS while a seat did not take it, at most DUTY_REANNOUNCE_TRIES times, never past the day's end. -> changed
   */
  const reannounce = async (k, v, nowMs) => {
    if (!announce || dry || !k.bumped || !k.lines || !k.lines.length || k.announcedTxid === k.txid) return false;
    if (v.state === 'dead' || dayOver(k, nowMs)) return false;
    const a = k.announce && k.announce.txid === k.txid ? k.announce : { txid: k.txid, tries: 0, atMs: 0 };
    if (a.tries >= DUTY_REANNOUNCE_TRIES || nowMs - a.atMs < DUTY_RESEND_EVERY_MS) return false;
    const raw = await hexOf(k.txid);
    if (!raw) { say({ dutyDay: 'not re-announced', item, slot: k.slot, txid: k.txid.slice(0, 16), why: 'its bytes are neither in the wallet nor in the mempool' }); k.announce = { ...a, tries: a.tries + 1, atMs: nowMs, why: 'no bytes' }; return true; }
    let r; try { r = await announce({ lines: k.lines, tx: raw.hex, targets: k.announcedTo || [] }); } catch (e) { r = { took: 0, of: 0, why: e.message }; }
    k.announce = { txid: k.txid, tries: a.tries + 1, atMs: nowMs, took: r.took, of: r.of };
    if (r.of > 0 && r.took === r.of) k.announcedTxid = k.txid;
    say({ dutyDay: 're-announced', item, slot: k.slot, txid: k.txid.slice(0, 16), replaced: (k.replaced || []).map((x) => x.slice(0, 16)), seats: `${r.took}/${r.of}`, try: k.announce.tries, ...(r.why ? { why: r.why } : {}) });
    return true;
  };
  /**
   * KEPT ALIVE (kanban #1126): a publication in no block of our chain is sent again, parents first - to our bitcoind when it is in no
   * mempool there (sendrawtransaction), and to the public chain (publicSend, Esplora) - at most once every DUTY_RESEND_EVERY_MS per tx.
   * The public send runs behind the pass (short timeouts, never awaited by it). Each attempt and its answer is said.
   */
  const lastSent = new Map();
  const inFlight = new Set();
  const keepAlive = async (k, v, nowMs) => {
    if (dry || !k.txid || v.state === 'dead' || dayOver(k, nowMs)) return;
    if (nowMs - (lastSent.get(k.txid) || 0) < DUTY_RESEND_EVERY_MS) return;
    const dropped = poolIds !== null && !poolIds.has(k.txid);
    if (!dropped && !publicSend) return;
    lastSent.set(k.txid, nowMs);
    for (const [t] of lastSent) if (nowMs - lastSent.get(t) > DUTY_DAY_MS) lastSent.delete(t);
    // the publication and its unconfirmed parents the wallet holds, parents first (at most DUTY_RESEND_DEPTH generations)
    const order = [], seenIds = new Set();
    const walk = async (txid, depth) => {
      if (seenIds.has(txid)) return; seenIds.add(txid);
      const raw = await hexOf(txid);
      if (!raw || (txid !== k.txid && raw.confirmations !== 0)) return;
      if (depth < DUTY_RESEND_DEPTH) {
        let tx = null; try { tx = parseTransaction(fromHex(raw.hex)); } catch { tx = null; }
        for (const i of (tx && tx.inputs) || []) await walk(toHex(Uint8Array.from(i.previousTxid).reverse()), depth + 1);
      }
      order.push({ txid, hex: raw.hex });
    };
    await walk(k.txid, 0);
    if (!order.length || order[order.length - 1].txid !== k.txid) { say({ dutyDay: 'not rebroadcast', item, slot: k.slot, txid: k.txid.slice(0, 16), why: 'its bytes are neither in the wallet nor in the mempool' }); return; }
    if (dropped) {
      const answers = [];
      for (const t of order) { try { answers.push({ txid: t.txid.slice(0, 16), ok: true, answer: String(await chainCall('sendrawtransaction', [t.hex])).slice(0, 16) }); } catch (e) { answers.push({ txid: t.txid.slice(0, 16), ok: false, answer: String(e.message).slice(0, 120) }); } }
      say({ dutyDay: 'rebroadcast', item, slot: k.slot, txid: k.txid.slice(0, 16), why: 'in no block and not in the mempool', to: 'our bitcoind', answers });
    }
    if (publicSend && !inFlight.has(k.txid)) {
      inFlight.add(k.txid);
      const p = (async () => {
        const answers = [];
        for (const t of order) {
          let r; try { r = await publicSend(t.hex); } catch (e) { r = { ok: false, status: 0, text: e.message }; }
          answers.push({ txid: t.txid.slice(0, 16), ok: !!r.ok, status: r.status ?? null, base: r.base || null, answer: String(r.text ?? '').trim().slice(0, 120) });
        }
        say({ dutyDay: 'sent to the public chain', item, slot: k.slot, txid: k.txid.slice(0, 16), dropped, answers });
      })().catch(() => {}).finally(() => { inFlight.delete(k.txid); sending.delete(p); });
      sending.add(p);
    }
  };
  const sending = new Set();
  // THE DAY'S STATE AND ITS EMERGENCY GRID (kanban #689 c, e): today's day and tomorrow's, every look - a status line when it changes (and
  // every 30 min), the status file tools/duty-status.mjs reads, and an emergency grid of what is left of a day that is dead or not drawable
  // in time. Machines stagger: this one waits its capped duty rank x 20 min after the grid fell due.
  const saidStatus = new Map(), dueSince = new Map();
  const watch = async (view, idx, markers, rank, ready) => {
    const nowMs = now();
    const headers = view.blocks.map((b) => b.header);
    const mtpMs = (medianTimePast(headers, view.firstHeight, idx.tip) || 0) * 1000;
    const status = {};
    for (const slot of [daySlotOf(nowMs) - 1, daySlotOf(nowMs)]) {
      const day = targetDay(slot);
      const ks = keptOf(slot);
      const verdicts = [];
      for (const k of ks) { try { verdicts.push(k.verdict = await judge(k, view, idx, mtpMs)); } catch (e) { verdicts.push(k.verdict = { state: 'pending', stage: 'unread', why: e.message }); } }
      // WHAT THE SEATS DRAW OF THE APP IN WHAT IS LEFT OF THE DAY, whoever posted it: drawn on a majority, the day is drawable
      const drawnNow = await familyDraw(Math.max(day.startMs, nowMs), day.endMs);
      if (drawnNow.of && drawnNow.drawn * 2 > drawnNow.of) verdicts.push({ state: 'drawable', stage: 'drawn', why: `rounds of it drawn on ${drawnNow.drawn} of ${drawnNow.of} seats` });
      // AND ANOTHER MACHINE'S POSTING OF IT (its marker, no kept file here): pending until the seats draw it
      // only a marker that counts (kanban #1168: a bare marker anyone wrote held the day and its emergency grid back)
      const foreign = markers.filter((m) => m.counts && m.slot === slot && (m.tag === tag || m.tag === emergencyTag) && !ks.some((k) => k.txid === m.txid));
      if (foreign.some((m) => m.tag === tag)) verdicts.push({ state: 'pending', stage: 'foreign', why: `posted by another node; drawn on ${drawnNow.drawn} of ${drawnNow.of} seats` });
      const verdict = guard.dayVerdict(verdicts);
      // A DEAD EMERGENCY GRID IS NOT ONE OF THE DAY'S (2026.1.9.11 release check, Up/Down 2026-10-27: two emergency grids died - one
      // published past its beacon, one whose census block the chain left - and with a third node's marker the day reached the cap,
      // so no grid that could be drawn was ever posted): only this node's postings that are not dead count against the cap
      const emergencies = ks.filter((k) => k.emergency && !(k.verdict && k.verdict.state === 'dead')).length + foreign.filter((m) => m.tag === emergencyTag).length;
      const inFlight = ks.some((k) => k.emergency && k.verdict && k.verdict.state === 'pending')
        || foreign.some((m) => m.tag === emergencyTag && (m.height === null || idx.tip - m.height < 15));
      const postedAny = ks.length > 0 || foreign.length > 0;
      // CONFIRMED ROUNDS OF THE DAY (kanban #775): one of this node's postings in a block and not dead, or rounds of it the seats list
      // and another node's posting of it in a block (2026-10-29 ~21:10Z: accepted at its block, nothing new posted)
      const confirmedAny = verdict.state === 'drawable' || ks.some((k) => guard.confirmedPosting(k.verdict)) || drawnNow.of > 0
        || guard.foreignConfirmed({ markers: foreign, slot, tag, tipHeight: idx.tip });
      const pending = ks.filter((k) => k.verdict && k.verdict.state === 'pending').map((k) => Number(k.committeeMs ?? (day.startMs - DUTY_COMMITTEE_LEAD_MS)));
      const due = backup ? { due: false } : guard.emergencyDue({ nowMs, day, verdict, emergencies, inFlight, postedAny, dutyOverMs: guard.dayTimeline(slot, { committeeLeadMs, cap: rankCap }).postByMs + 3600000, drawableByMs, confirmedAny,
        pendingCommitteeMs: pending.length ? Math.max(...pending) : foreign.some((m) => m.tag === tag) ? day.startMs - DUTY_COMMITTEE_LEAD_MS : null });
      let emergency = null;
      if (due.due) {
        if (!dueSince.has(slot)) dueSince.set(slot, nowMs);
        const waitMs = Math.min(Math.max(rank, 0), rankCap) * 20 * 60000;
        const how = { mtpMs, committeeLeadMs: emergencyCommitteeLeadMs, seedWaitMs };
        const plan = guard.emergencyPlan({ nowMs, day, shape: guard.dayShape(game, 900000), ...how });
        emergency = { why: due.why, plan: plan.ok ? { committee: new Date(plan.committeeMs).toISOString(), firstStart: new Date(plan.firstStartMs).toISOString(), slots: plan.slots, lostMin: Math.round(plan.lostMs / 60000) } : plan.why };
        if (!emergencyGrids) emergency.off = backup ? 'a backup posts no emergency grid: the primary\'s duty does' : 'emergency grids are off: not posted';
        else if (rank < 0) emergency.off = 'this node is not in the day\'s census: not posted';
        else if (!ready.ok) emergency.waits = ready.why;
        else if (nowMs - dueSince.get(slot) < waitMs) emergency.waits = `${Math.round((waitMs - (nowMs - dueSince.get(slot))) / 60000)} min (rank ${rank + 1})`;
        else if (plan.ok) {
          const pay = await canPay();
          if (!pay.ok) { emergency.off = `this node cannot pay: ${pay.why}`; seen.wouldPost.push({ app: game, slot, why: `emergency grid due; ${pay.why}` }); }
          else {
            say({ dutyDay: 'EMERGENCY DUE', item, slot, target: new Date(day.startMs).toISOString(), why: due.why, ...emergency });
            try { const k = await publish(slot, how); if (k) emergency.posted = k.txid; dueSince.delete(slot); }
            catch (e) { emergency.failed = e.message; fail(`emergency grid of ${new Date(day.startMs).toISOString().slice(0, 10)}: ${e.message}`); say({ dutyDay: 'EMERGENCY NOT POSTED', item, slot, why: e.message }); }
          }
        }
      } else dueSince.delete(slot);
      const line = guard.statusLine({ item, day, verdict, postings: ks.map((k) => ({ ...k, verdict: k.verdict })), emergency });
      status[line.day] = { ...line, checkedAt: new Date(nowMs).toISOString() };
      const key = JSON.stringify(line), last = saidStatus.get(slot);
      if (!last || last.key !== key || nowMs - last.at > 30 * 60000) { say(line); saidStatus.set(slot, { key, at: nowMs }); }
    }
    seen.days = status;
    try { writeFileSync(join(dir, `status-${item}.json`), JSON.stringify({ item, game, at: new Date(nowMs).toISOString(), days: status }, null, 1) + '\n'); } catch { /* the journal has it */ }
  };
  /** The duty order of day `slot` and this machine's rank in it, from the view (null while the day's anchor is not there). */
  const orderOf = async (slot, view, tip) => {
    const headers = view.blocks.map((b) => b.header);
    const mtpAt = async (h) => { const m = medianTimePast(headers, view.firstHeight, h); return m === null ? -1 : m; };
    const anchor = await anchorHeight(slot, { mtpAt, tip, low: view.firstHeight + 11, slotMs: DUTY_DAY_MS });
    if (anchor === null) return null;
    // AN ANCHOR AT THE VIEW'S LOWEST BLOCK MAY BE OLDER THAN THE VIEW (testnet4 makes hundreds of blocks a day in bursts): not taken - the
    // view is widened (chain.widen) and the next pass finds the real one
    if (anchor <= view.firstHeight + 11 && view.firstHeight > 0) {
      if (typeof chain.widen === 'function') chain.widen();
      return { anchor: null, order: null, rank: -1, why: `the day's anchor is older than the ${view.blocks.length} blocks this node reads: reading more` };
    }
    if (!censusAt.has(anchor)) {
      let keys = null, why = '';
      try { keys = await chain.censusKeysAt(anchor); } catch (e) { why = e.message; }
      if (!keys || !keys.length) return { anchor, order: null, rank: -1, why: `no census at the day's anchor ${anchor} yet${why ? `: ${why}` : ''}` };
      censusAt.set(anchor, keys);
    }
    const order = dutyOrder({ networkId, slot, nodeKeys: censusAt.get(anchor) });
    return { anchor, order, rank: order.findIndex((k) => local.has(toHex(k))) };
  };
  const look = async () => {
    if (busy) return seen;
    busy = true;
    seen.wouldPost = [];
    try {
      const view = await chain.view();
      const idx = chainIndex(view);
      // every fee raise a crash left half done is settled first: "posted" and the verdicts read the posting's real txid (kanban #1168)
      for (const s of [daySlotOf(now()) - 1, daySlotOf(now())]) for (const k of keptOf(s)) { try { await settleBump(k); } catch (e) { fail(`fee raise of ${k.txid}: ${e.message}`); } }
      await postKept(idx);
      const mempool = await mempoolMarkers();
      const nowMs = now(), slot = daySlotOf(nowMs);
      // EVERY DAY THE STATUS NAMES: yesterday's duty (today's rounds) and today's (the next 24 h), each with its order
      seen.orders = {};
      for (const s of [slot - 1, slot]) {
        try { const o2 = await orderOf(s, view, idx.tip); if (o2 && o2.order) seen.orders[s] = o2; else if (o2) { seen.orders[s] = { anchor: o2.anchor, order: [], rank: -1, why: o2.why }; fail(o2.why); } }
        catch (e) { fail(e.message); }
      }
      // THE DAY'S MARKERS AND WHO THEY ARE FROM (kanban #1168): only those that count are postings; the rest are said as ignored
      const mine = (m) => m.tag === tag || m.tag === emergencyTag;
      const marks = await standingOf([...idx.markers, ...mempool].filter(mine), seen.orders);
      seen.markers = marks.filter((m) => m.counts)
        .map((m) => ({ slot: m.slot, emergency: m.tag === emergencyTag, role: backup ? 'backup' : 'primary', txid: m.txid, height: m.height, series: m.series || [], standing: m.standing, creator: m.creator }));
      seen.ignored = marks.filter((m) => !m.counts).slice(0, 20)
        .map((m) => ({ slot: m.slot, emergency: m.tag === emergencyTag, txid: m.txid, height: m.height, standing: m.standing, creator: m.creator }));
      let rank = -1;
      const got = seen.orders[slot] && seen.orders[slot].order.length ? seen.orders[slot] : null;
      seen.slot = slot;
      // READY TO ACT (#702, seat 4 2026-10-26 11:43Z: its first pass after a restart read no census and no seat, and planned emergency grids
      // for days that were posted and drawn): the day's order read from its census, the mempool read this pass, and - for an emergency grid
      // - DUTY_MIN_SEATS seats' rounds; until then a pass judges and says, and posts nothing
      const seatsRead = await seatsAnswered();
      const minSeats = Math.min(DUTY_MIN_SEATS, Math.max(1, seatsRead.asked));
      const ready = !got ? { ok: false, why: seen.orders[slot] && seen.orders[slot].why ? seen.orders[slot].why : 'the day\'s anchor is not in the chain view yet' }
        : !poolRead ? { ok: false, why: 'the mempool could not be read this pass' }
        : seatsRead.answered < minSeats ? { ok: false, why: `${seatsRead.answered} of ${seatsRead.asked} seats answered their rounds (${minSeats} needed)` } : { ok: true };
      seen.ready = ready;
      if (slot + 1 < fromDay || !got) { const w = `wait ${slot} ${ready.why}`; if (lastSaid !== w) say({ dutyDay: 'not ready', item, slot, why: ready.why }); lastSaid = w; seen.anchor = seen.orders[slot] ? seen.orders[slot].anchor : null; seen.order = []; seen.rank = -1; seen.due = false; }
      else {
        const { anchor, order } = got;
        // DUTY_DRY_RANK0 with a dry grid: build today's post as if this machine were first in order - nothing published
        rank = dryRank0 && gridDry ? 0 : got.rank;
        // POSTED: the day's marker in the chain or the mempool, or this machine's own kept posting while the wallet still holds its transaction
        let posted = marks.some((m) => m.counts && m.tag === tag && m.slot === slot);
        if (!posted) for (const k of keptOf(slot).filter((x) => !x.emergency)) {
          try { const t = await walletRpc('gettransaction', [k.txid]); if (Number(t.confirmations) >= 0) posted = true; } catch { /* not the wallet's */ }
        }
        const due = backup ? backupPostDue({ nowMs, slot, rank, posted, postedPrimary: await postedPrimary(slot), cap: DUTY_BACKUP_RANK_CAP })
          : guard.dayDueCapped({ nowMs, slot, rank, posted, cap: rankCap });
        Object.assign(seen, { anchor, order, rank, posted, due });
        const said = `${slot} ${rank} ${posted} ${due}`;
        if (said !== lastSaid) say({ dutyDay: due ? 'due' : posted ? 'posted' : 'not due', item, slot, target: new Date(targetDay(slot).startMs).toISOString(), anchor,
          dutyNode: toHex(order[0] || new Uint8Array(32)).slice(0, 16), rank, rankCap, census: order.length });
        lastSaid = said;
        if (due && slot + 1 >= fromDay && !poolRead) seen.wouldPost.push({ app: game, slot, why: 'due, but the mempool could not be read: not posted this pass' });
        else if (due && slot + 1 >= fromDay) {
          const pay = await canPay();
          // A NODE THAT CANNOT PAY SAYS SO AND SKIPS: the day falls to the next node in order an hour later (duty.js dayPostDue)
          if (!pay.ok) { seen.wouldPost.push({ app: game, slot, why: pay.why }); if (lastSaid !== `${said} nopay`) say({ dutyDay: 'DUE, CANNOT PAY', item, slot, why: pay.why }); lastSaid = `${said} nopay`; }
          else { try { await publish(slot); } catch (e) { fail(`${game} ${new Date(targetDay(slot).startMs).toISOString().slice(0, 10)}: ${e.message}`); say({ dutyDay: 'NOT PUBLISHED', item, slot, why: e.message, at: String(e.stack || '').split('\n').slice(1, 4).map((l) => l.trim()).join(' < ') }); } }
        }
      }
      await watch(view, idx, await standingOf([...idx.markers, ...(await mempoolMarkers())].filter(mine), seen.orders), rank, ready);
      seen.lookedAtMs = now();
    } catch (e) { fail(e.message); say({ dutyDay: 'look failed', item, why: e.message }); } finally { busy = false; }
    return seen;
  };
  // for the tests: the public sends still running
  const settled = () => Promise.all([...sending]);
  return { look, state: () => seen, item, tag, emergencyTag, game, role, settled };
}
