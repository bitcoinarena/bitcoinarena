// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE FEDERATION RECORDS A SEAT SIGNS, GATHERS AND MIRRORS (spec §23A.4).
//
// The body is built from what every seat of a series reads the same: the census of the newest round it holds (the
// census nodes whose bond advertisements name the federation in guardian_of[]), at that round's census height - so seats
// on one series build byte-identical bodies and their signatures add up. A guardian is GONE when its own node says it is
// leaving (the owner's leave, owner-leave.js), signed with the node key beside its record signature. ABANDONED - 2f + 1
// absence attestations for abandon_blocks - needs each guardian's per-peer consensus view from the federation client and
// is not counted yet; the record says nothing it cannot back.
//
// A seat that is a guardian signs the body (GET /federation-record); every seat gathers the guardians' signatures from
// their endpoints and, at the threshold, keeps the signed record and mirrors it at GET /federations. A record whose status
// is DRAINING, CRITICAL or CLOSED makes the federation draining at this seat (no new round names it).
import { schnorr } from '@noble/curves/secp256k1.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { nodeBonds } from '../../arena-protocol/src/census.js';
import { abandonmentProof } from '../../arena-protocol/src/absence.js';
import { absenceHex, readAbsenceHex, departureHex, readDepartureHex, dueDeparture, emergencyHex, readEmergencyHex } from './absences.js';
import { emergencyDepartureStands, emergencyDepartureEffect, emergencyDepartureId } from '../../arena-protocol/src/emergency.js';
import { decodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { withConfigEndpoints } from './federation-endpoints.js';
import { recordInviteSource, createInviteBuffer } from '../../arena-protocol/src/trusted-guardian-keys.js';
import { readInvite } from './invite.js';
import { buildFederationRecord, encodeFederationRecord, federationRecordId, joinSignedRecord, verifyFederationRecord, verifyFederationRecords,
  FEDERATION_STATUS, GONE, decodeFederationRecord, splitSignedRecord, guardianKeySet, RESTRICTION_RANK, selfConsistentRestrictive, thresholdOf } from '../../arena-protocol/src/federation-record.js';

/**
 * The census nodes guarding `federationId`, as the record lists them. `keys` (optional, kanban #2603): the federation config's guardian
 * keys (`broadcast_public_keys`) - then only a node whose advert names one of them counts, one node per key and one key per node, in
 * census order (as federationIsBonded counts them): a bonded stranger whose advert claims the federation under a made-up key never
 * enters the body this seat builds, so it cannot lift the record's nominal past what the real guardians can sign.
 */
export function guardiansOf(census, federationId, keys = null) {
  const fid = toHex(federationId);
  const wanted = keys ? guardianKeySet(keys) : null;
  const keysTaken = new Set();
  const out = [];
  const claims = (e) => ((e.advert && e.advert.guardianOf) || []).filter((x) => toHex(x.federationId) === fid && (!wanted || wanted.has(toHex(x.guardianKey))));
  // ONE ROW PER NODE, ITS BOND THE SUM OF ITS OUTPUTS (kanban #544): an added second output names the same guardian, not a second one;
  // the row's bond outpoint is the node's lowest
  for (const n of nodeBonds((census.entries || []).filter((e) => claims(e).length))) {
    const e = n.entry, g = wanted ? claims(e).find((x) => !keysTaken.has(toHex(x.guardianKey))) : e.advert.guardianOf.find((x) => toHex(x.federationId) === fid);
    if (!g) continue;
    if (wanted) keysTaken.add(toHex(g.guardianKey));
    out.push({ peerKey: g.guardianKey, nodePubkey: e.pubkey, operatorId: (e.advert && e.advert.operatorId) || '', bondTxid: e.txid, bondVout: e.vout,
      endpoint: (e.advert && e.advert.guardianEndpoint) || '', bondSats: typeof e.bondSats === 'bigint' ? n.bondSats : String(n.bondSats),
      advertEndpoint: (e.advert && e.advert.endpoint) || '' });
  }
  return out;
}

/** A record's seated guardians (§23A.1: listed, not gone), by node key. */
export function seatedOf(record) {
  const gone = new Set((record.gone || []).map((g) => toHex(g.peerKey)));
  return (record.guardians || []).filter((g) => !gone.has(toHex(g.peerKey))).map((g) => g.nodePubkey);
}

/** The federations a census knows: every federation some census node guards. */
/** A seat with no round: the chain census this many blocks below the tip, at a multiple of CHAIN_BASIS_STEP. */
export const CHAIN_BASIS_LAG = 6;
export const CHAIN_BASIS_STEP = 6;

/** How many census seats one mirror pass asks for a record none of its guardians' nodes holds. */
export const MIRROR_PEERS = 8;
// THE RECORDS OF ONE FEDERATION ONE PEER'S ANSWER BRINGS (kanban #2620, feedback #049): a seat serves a few (its kept, the one beside, the held one)
export const MIRROR_ROWS_PER_ANSWER = 8;

/** A mirror pass reads the chain's census (censusAt) at most this many heights per peer answer, and this many in all (kanban #1818).
 * "In all" is the whole gather pass, every federation of it (kanban #2339): one bonded seat listing K made-up federation ids in its
 * advert's guardianOf made each of the K mirrors read MIRROR_CENSUS_PER_ANSWER heights - 2K a pass. And one guardian's node causes at
 * most MIRROR_CENSUS_PER_ANSWER new heights in the whole pass, across every federation it is asked for, so it cannot spend the pass's. */
export const MIRROR_CENSUS_PER_ANSWER = 2;
export const MIRROR_CENSUS_PER_PASS = 8;
/** A PASS IS NOT FREE TO START (kanban #2370, #2373, a45 refute 8 s3 of #1818/#2270/#2339): the census budget above is a pass's, and
 * GET /federations?fresh=1 started a pass for any caller - 51 asks from a stranger were 102 chain census derivations at 102 heights. A
 * pass asked for while one runs joins it (one budget for both), and an ask with minAgeMs (the public door) is answered by the last
 * pass while that one finished less than minAgeMs ago. */
export const GATHER_FRESH_MS = 30000;

/** GET /federation-record's named height (kanban #2270, the #1818 cost through the other door): a chain census read for a height a
 * gatherer names happens only for a federation this seat names an invite for, at a height no further below the tip than this, and at
 * most NAMED_CENSUS_BURST reads at once, refilled at NAMED_CENSUS_PER_MIN a minute. */
export const NAMED_CENSUS_BELOW_TIP = 288;
export const NAMED_CENSUS_BURST = 8;
export const NAMED_CENSUS_PER_MIN = 4;
/** THE SHARED CHAIN BASIS HEIGHTS NEED NO TOKEN (kanban #2348): a multiple of CHAIN_BASIS_STEP not above the tip and above
 * tip - CHAIN_BASIS_LAG - 2 * CHAIN_BASIS_STEP - the height a seat with no round names (chainAhead), its own or a gatherer's a block or a
 * step apart - is read once without the bucket, so a stranger who empties the bucket does not make the guardian refuse its gatherer
 * (the kanban #549 case). There are at most this many such heights at a tip; the bucket holds NAMED_CENSUS_BURST less these, so a burst
 * is still at most NAMED_CENSUS_BURST reads. */
export const NAMED_CENSUS_FREE_HEIGHTS = Math.ceil((CHAIN_BASIS_LAG + 2 * CHAIN_BASIS_STEP) / CHAIN_BASIS_STEP);
const NAMED_CENSUS_BUCKET = Math.max(1, NAMED_CENSUS_BURST - NAMED_CENSUS_FREE_HEIGHTS);

export function federationsOf(census) {
  const ids = new Map();
  for (const e of census.entries || []) for (const g of (e.advert && e.advert.guardianOf) || []) ids.set(toHex(g.federationId), g.federationId);
  return [...ids.values()];
}

/** The leave statement a node signs beside its record signature: (record id || 0x01 leaving | 0x00 staying). */
const leaveMessage = (id, leaving) => Uint8Array.from([...id, leaving ? 1 : 0]);

/**
 * A LEAVE STATEMENT HANDED ALONG (kanban #1157): the gatherer passes each leaving guardian's own signed word to every guardian seat it asks
 * to sign the body with that guardian gone, as `left=<peer key 33 hex><signature 64 hex>,...`. A guardian named gone with no statement,
 * notice, emergency request or attestation set is not signed gone.
 */
export const leftHex = (peerKey, leaveSig) => `${toHex(peerKey)}${String(leaveSig).toLowerCase()}`;
export function readLeftHex(s) {
  const x = String(s || '').toLowerCase();
  if (!/^[0-9a-f]{194}$/.test(x)) throw new Error('a leave statement is a peer key (33 bytes) and a signature (64 bytes), in hex');
  return { peerKey: x.slice(0, 66), signature: x.slice(66) };
}
/** Whether `sig` is `nodePubkey`'s signed word that it leaves, over the body whose id is `id`. */
export function leaveStands(sig, id, nodePubkey) {
  try { return schnorr.verify(fromHex(String(sig)), leaveMessage(id, true), nodePubkey) === true; } catch { return false; }
}

/**
 * THE STATUS ORDER AT ONE HEIGHT (kanban #1157): OPEN < DRAINING < CRITICAL < HALTED, worse to the right. CLOSED stands apart: it is final.
 * recordStep is the one transition of the record a seat keeps for a federation: `had` the kept { height, status } or null, `next` the
 * verified { height, status }, `from` 'gather' (this seat's own threshold of signatures), 'mirror' (a record another node serves) or 'restore'.
 *   older than kept                      -> refused
 *   same height, kept CLOSED, next not   -> refused (CLOSED is final, kanban #577)
 *   same height, from a mirror, worse    -> refused: a node serving a worse body at the height this seat holds moves nothing; the next
 *                                           height's record does, when a threshold signs it
 *   same height, from a mirror, better   -> refused too (kanban #1664, state audit #1489 federation-5): records of one height are signed
 *                                           hours apart (the census height is a day's), so a node that has not gathered since still serves
 *                                           the OLDER, better body - a seat whose own gather failed took it back over the CRITICAL/HALTED one
 *                                           its guardians signed later, cleared `draining` and the halt height. A mirror moves the status only
 *                                           at a newer height (or to CLOSED); this seat's own gather still may at the same height
 *   else                                 -> taken
 * Answers { take, why }.
 */
export const STATUS_RANK = Object.freeze({ OPEN: 0, DRAINING: 1, CRITICAL: 2, HALTED: 3 });
export function recordStep(had, next, from = 'gather') {
  if (!had) return { take: true, why: 'none kept' };
  if (had.height > next.height) return { take: false, why: `a record at ${next.height} is older than the one kept at ${had.height}` };
  if (had.height < next.height) return { take: true, why: 'newer' };
  if (had.status === 'CLOSED' && next.status !== 'CLOSED') return { take: false, why: 'the record kept at that height is CLOSED, and CLOSED is final' };
  if (from === 'mirror' && next.status !== 'CLOSED' && next.status !== had.status)
    return { take: false, why: `a mirrored ${next.status} record does not replace the ${had.status} one kept at the same height ${next.height}` };
  return { take: true, why: 'the same height' };
}

// `successorOf(fidHex)`: the successor this seat was told of (hex) or null; `closedOf(fidHex)`: whether the drain is over
// (§23A.6 steps 2 and 4) - both read into the body every guardian seat builds the same way
export function federationRecords({ round, roster, inviteFor, networkId, leavingAtMs = () => null, fetcher = fetch, nowMs = () => Date.now(), newest = null,
  successorOf = () => null, closedOf = () => false, retiringOf = () => false, reserveOf = null, absences = null, abandonBlocks = null, departureNotice = null,
  // THE GUARDIANS' ADDRESSES FROM THE FEDERATION'S OWN CONFIGURATION (federation-endpoints.js): async (fidHex) -> Map(peer key
  // hex -> API URL) | null; a guardian it names takes that endpoint into the body, one it does not keeps its advert's
  endpointsOf = null,
  // THE CENSUS AT A RECORD'S OWN HEIGHT (measured live 2026-10-15): async (height) -> census entries | null, from this seat's
  // chain (main.js ballot.censusEntriesAt). A seat whose basis is an older census than the record's (node 15: 156388, B's record at
  // 156538, its guardians' current keys in the newer census) checks a mirrored record against the census the record names
  censusAt = null,
  // THE CHAIN'S TIP: async () -> height, for the census a seat that holds no round builds and checks records from
  chainTip = null,
  // THE CHAIN'S CENSUS FIRST: a seat that runs no series - federation T2's relay seats hold 8 old rounds, census 156768
  // with 14 nodes, before T2's own bonds, so they never built T2's record - takes the chain's census before any held round's
  chainFirst = false,
  // THE RECORDS OUTLIVE A RESTART (kanban #552/#557, 2026-10-20: "Federation 337ae01a is missing now" - a seat held its records in
  // memory only, and after a roll of all seats the first gathering found too few of A's guardians up to sign): `store` { load() ->
  // [{ federation, record hex }], save(federation, record hex) }; restore() checks each saved record against the census at its own
  // height before it is kept again, as a mirrored one is
  store = null,
  // A RECORD NONE OF ITS GUARDIANS' NODES HOLDS (kanban #326, measured 2026-10-21 22:3xZ): T2's census guardians are the T nodes,
  // whose seats hold no T2 record, while T2's own seats do - every other seat logged "none of its guardians holds a record" and
  // never observed T2's halt. `peerSeats` () -> [base URL]: the census seats this seat reads; MIRROR_PEERS of them, in turn,
  // are asked too. A record from anywhere stands only as it stands against this seat's census.
  peerSeats = () => [],
  // THE FEDERATION'S OWN GUARDIAN KEYS (kanban #2603): async (fidHex) -> [33-byte key] | null, its config's broadcast_public_keys when
  // this seat holds that config (server.js: its own guardian's client.json, else the stake-lock client of a federation it joined). Every
  // record this seat builds lists only census nodes advertising one of them, and every record it verifies is held to them
  // (verifyFederationRecord guardianKeys). Null: no config here - a record is then held to its own threshold, nothing else
  guardianKeysOf = null }) {
  // the keys once read, by federation id hex: a federation's config keys do not change (a successor is another federation)
  const keysKnown = new Map();
  // THE INVITES THIS SEAT HAS SEEN IN A FEDERATION'S RECORDS (kanban #2609): where the trusted key fetch asks, for a federation this seat
  // names no invite for. Any record's invite, a stranger's too - the fetch takes keys only from a config whose endpoints hash to the id and a
  // threshold of those endpoints agree on, so a made-up invite gets nothing.
  // NOT FIRST COME (kanban #2618, feedback #047): the first 8 were kept for good, and eight strangers' junk invites noted first kept the seat
  // keyless. Each record's invite goes to the fetch with the node keys whose signatures over the record verify (recordInviteSource); the
  // fetch's book (trusted-guardian-keys.js) bounds them per signer, evicts an invite that fails the id check and asks this seat's own invite
  // and the kept record's first. Here they wait only until the next keysFor hands them over.
  // UNDER THE BOOK'S RULES HERE TOO (kanban #2620, feedback #049): this wait was a first-come list of 64 - one stranger answering with 64
  // single-signer fillers, each with its own junk invite, filled it before the genuine HALTED record was noted, and the genuine invite never
  // reached the book. It is now the book's own buffer (createInviteBuffer: per signer, bounded, the most crowded signers' entry given up),
  // and one peer's answer brings at most MIRROR_ROWS_PER_ANSWER records of a federation
  const invitesSeen = new Map();             // fid -> createInviteBuffer()
  const inviteVerify = (sg, m, key) => { try { return schnorr.verify(sg, m, key); } catch { return false; } };
  function noteInvite(fid, bytes) {
    let inv = null; try { inv = decodeFederationRecord(splitSignedRecord(bytes).body).invite; } catch { inv = null; }
    if (typeof inv !== 'string' || !inv) return;
    if (!invitesSeen.has(fid)) invitesSeen.set(fid, createInviteBuffer());
    const m = invitesSeen.get(fid);
    if (m.has(inv)) return;
    const src = recordInviteSource(bytes, inviteVerify);
    if (src) m.admit(src);
  }
  async function keysFor(fidHex) {
    const fid = String(fidHex).toLowerCase();
    if (typeof guardianKeysOf !== 'function') return null;
    const invites = [];
    try { const i = inviteFor(fid); if (i) invites.push(String(i)); } catch { /* none */ }
    { const k = kept.get(fid); if (k && k.record && k.record.invite) invites.push(String(k.record.invite)); }
    { const m = invitesSeen.get(fid); if (m) invites.push(...m.take()); }
    invitesSeen.delete(fid);
    let k = null; try { k = await guardianKeysOf(fid, { invites }); } catch { k = null; }
    if (Array.isArray(k) && guardianKeySet(k)) { const first = !keysKnown.has(fid); keysKnown.set(fid, k); if (first) dropUnkeyed(fid, k); return k; }
    return keysKnown.get(fid) || null;
  }
  // WHAT WAS KEPT WITHOUT KEYS IS JUDGED AGAIN WHEN THEY COME (kanban #2618, feedback #047): a seat that mirrored the strangers' forgery while it
  // held no keys kept it (OPEN at genuine + 7), and the genuine HALTED record below that height could never replace it once the keys came. The
  // first time this seat holds a federation's keys, the kept record - and the one beside it, and the held one - is checked against its own
  // guardian list under those keys (every signer a guardian whose key is the config's, the threshold signed); one that fails is dropped, with
  // its draining word and halt start, so the next pass keeps what stands under the keys
  function dropUnkeyed(fid, keys) {
    const sv = (sg, m, key) => { try { return schnorr.verify(sg, m, key); } catch { return false; } };
    const ifid = (inv) => { const f = readInvite(inv).federationId; return f ? fromHex(f) : null; };
    const stands = (bytes) => {
      try {
        const r = decodeFederationRecord(splitSignedRecord(bytes).body);
        const own = r.guardians.map((g) => ({ pubkey: g.nodePubkey, advert: { guardianOf: [{ federationId: r.federationId, guardianKey: g.peerKey }] } }));
        return verifyFederationRecord(bytes, { census: own, verify: sv, inviteFederationId: ifid, guardianKeys: keys }).ok;
      } catch { return false; }
    };
    const k = kept.get(fid);
    if (k && k.bytes && !stands(k.bytes)) { kept.delete(fid); draining.delete(fid); halted.delete(fid); }
    for (const m of [beside, holding]) { const x = m.get(fid); if (x && x.bytes && !stands(x.bytes)) m.delete(fid); }
  }
  // THE CHAIN TIP A RECORD'S HEIGHT IS BOUNDED BY (kanban #2604): null when this seat reads none
  async function tipNow() {
    if (typeof chainTip !== 'function') return null;
    try { const t = Number(await chainTip()); return Number.isInteger(t) && t >= 0 ? t : null; } catch { return null; }
  }
  /**
   * A FEDERATION'S RECORDS JUDGED TOGETHER (kanban #2604, feedback #038): `items` [{ bytes, census }] the records of `fidHex` this seat sees at
   * once, with the record it keeps as context - so without the config no record stands on its own nominal (verifyFederationRecords), and none
   * above the tip. One verdict per item.
   */
  function judge(fidHex, items, { keys = null, tip = null, census = null, inviteFederationId } = {}) {
    const k = kept.get(String(fidHex).toLowerCase());
    const context = k && k.bytes ? [{ bytes: k.bytes, census: census || (items[0] && items[0].census) || [], context: true }] : [];
    const sv = (sg, m, key) => { try { return schnorr.verify(sg, m, key); } catch { return false; } };
    return verifyFederationRecords([...items, ...context], { verify: sv, inviteFederationId, guardianKeys: keys, tip }).slice(0, items.length);
  }
  const kept = new Map();                    // federation id hex -> { bytes, record, status, height, signers, atMs }
  const beside = new Map();                  // federation id hex -> a newer, less restrictive keyless record held beside the kept one (#2613)
  const holding = new Map();                 // federation id hex -> a restrictive keyless record served for the page's hold only (#2615)
  const draining = new Map();                // federation id hex -> status name
  // THE HALT A LIQUIDATION COUNTS FROM (§23A.5): the lowest-height signed HALTED record of the run of HALTED records
  // this seat holds - kept with its bytes, so anyone checks it - and forgotten once a newer record is not HALTED (a recovery)
  const halted = new Map();                  // federation id hex -> { height, bytes }
  // EVERY RECORD BY ITS HEIGHT TOO (kanban #559/#543, §23A.3a: the pressure weights read "the federation record in force at" the round's
  // census height, which may be older than the newest): each verified record kept per federation and height, in memory and the store
  const history = new Map();                 // fid -> Map(height -> record)
  // ONE BODY PER HEIGHT, THE FIRST, IN MEMORY AS IN THE STORE (kanban #2397, #2466, audit44 refute 67): the store's history is
  // INSERT OR IGNORE - the first body saved at a height stays. Memory overwrote that height when a later body came (a mirror's
  // better body taken at the kept height, a late older record refused as a take), so a running seat read one run and a restarted
  // seat another: two halt starts, two liquidation clocks for one halt (the #1763 effect), and one peer's late HALTED body could
  // move a running seat's halt start down. A held height is never replaced; the store's rows are read in first, so a fresh
  // process does not hold a height the store already has under another body
  const remember = (fid, rec) => {
    historyOf(fid);
    if (!history.has(fid)) history.set(fid, new Map());
    const m = history.get(fid), h = Number(rec.height);
    if (m.has(h)) return;
    m.set(h, rec);
    if (store && store.saveAt) { try { store.saveAt(fid, h, rec.__hex); } catch { /* in memory */ } } };
  // the history of `fid` with the store's rows read in once (they were each verified when saved), those in memory kept as they are
  const historyRead = new Set();
  function historyOf(fid) {
    if (!historyRead.has(fid) && store && store.loadAt) {
      historyRead.add(fid);
      try { for (const r of store.loadAt(fid) || []) { try { if (history.has(fid) && history.get(fid).has(Number(r.height))) continue; const rec = decodeFederationRecord(splitSignedRecord(fromHex(r.record)).body); remember(fid, Object.assign(Object.create(null), rec, { __hex: r.record })); } catch { /* skip */ } } } catch { /* none */ }
    }
    return history.get(fid) || null;
  }
  // THE HALT START OUTLIVES A RESTART (kanban #1578, state audit 2026-11-12): the store keeps only the newest record per federation, and
  // restore() keep()s that one, so a restarted seat counted the halt - and every liquidation clock (liquidatesAt, claim window, late-claim
  // tail, remainder split) - from the NEWEST HALTED record, while a seat that did not restart counted from the first: two seats, two clocks
  // for one halt. The run's start is read back from the record history (saveAt/loadAt): from the kept HALTED record down, height by
  // height, while the record is HALTED - the lowest of that run
  const haltStartOf = (fid, height, bytes) => {
    let start = { height, bytes };
    const m = historyOf(fid);
    if (m) for (const h of [...m.keys()].filter((x) => x < height).sort((a, b) => b - a)) {
      const rec = m.get(h);
      if (Number(rec.status) !== FEDERATION_STATUS.HALTED || !rec.__hex) break;
      start = { height: h, bytes: fromHex(rec.__hex) };
    }
    return start;
  };
  function keep(fid, bytes, v, from = 'gather') {
    // A CLOSED RECORD IS FINAL (kanban #577, measured 2026-10-22 on federation 89ce310e: n495-1 held it CLOSED with 7 of 10 signatures, set its
    // guardian aside, and every other seat kept the OPEN record of the same height - one guardian fewer, they could never sign the closed
    // body again): at the same height a record that is not CLOSED never replaces one that is
    // AND A MIRROR NEVER WORSENS THE STATUS AT ONE HEIGHT (kanban #1157): recordStep. An older record still goes into the history, as
    // before; one refused at the kept height does not overwrite that height's
    const had = kept.get(fid);
    // A KEYLESS SEAT NEVER LOOSENS WHAT IT KEEPS (kanban #2613, feedback #042): a seat that holds no config keys for the federation cannot
    // tell its guardians from bonded strangers - 8 of them signing their own OPEN record (nominal 11, genuine + 1) made the genuine 7 of 7
    // HALTED one need 8, and the seat kept the OPEN one: halt start gone, GET /liquidations and the exchange's halted check passing. A record
    // judged without keys (v.keyed === false) that is less restrictive (RESTRICTION_RANK) than the kept one at or above its height does not
    // replace it: it is held beside it (served by GET /federations next to the kept one, so a client sees both and its restrictive-word hold
    // applies) and the kept record, its halt start and the draining gate stay. A record judged with the config keys decides as before.
    if (v.keyed === false && had && v.record.height >= had.height && toHex(bytes) !== toHex(had.bytes)
      && (RESTRICTION_RANK[v.status] ?? 0) < (RESTRICTION_RANK[had.status] ?? 0)) {
      const a = beside.get(fid);
      if (!a || a.height < v.record.height) beside.set(fid, { bytes, record: v.record, status: v.status, height: v.record.height, signers: v.signers, atMs: nowMs() });
      return false;
    }
    const step = recordStep(had ? { height: had.height, status: had.status } : null, { height: v.record.height, status: v.status }, from);
    const late = !!(had && had.height > v.record.height);
    if (step.take || late) remember(fid, Object.assign(Object.create(null), v.record, { __hex: toHex(bytes), __status: v.status }));
    // ONE DERIVATION FOR THE RUNNING SEAT AND THE RESTART (kanban #2172, #1763/#1578 refuted in audit44): an older record that
    // arrives after a newer one (a lagging guardian, a mirror) changes the history the run is read from - an older HALTED one
    // moves the start down, an older recovery cuts the run - and a restart reads exactly that history. The halt start is
    // therefore always haltStartOf the kept HALTED record, never a value only this process saw
    if (late && had.status === 'HALTED') halted.set(fid, haltStartOf(fid, had.height, had.bytes));
    if (!step.take) return false;
    kept.set(fid, { bytes, record: v.record, status: v.status, height: v.record.height, signers: v.signers, atMs: nowMs() });
    { const a = beside.get(fid); if (a && a.height <= v.record.height) beside.delete(fid); }
    if (store) { try { store.save(fid, toHex(bytes)); } catch { /* kept in memory */ } }
    if (['DRAINING', 'CRITICAL', 'CLOSED', 'HALTED'].includes(v.status)) draining.set(fid, v.status); else draining.delete(fid);
    if (v.status !== 'HALTED') halted.delete(fid);
    else halted.set(fid, haltStartOf(fid, v.record.height, bytes));   // kanban #2172: history-based, as a restart derives it
    return true;
  }

  // ROUNDS BY CENSUS HEIGHT, each read once (measured on testnet4 2026-10-12: a seat holds thousands of rounds,
  // and reading them all at every ask held the loop 3-6 s per GET /federation-record) - AND NEWEST FIRST, only as far as a basis
  // is found (measured 2026-10-14: the first GET /federation-record after a start read and decoded all 86,607 stored
  // rounds, 66 MB of contracts, holding the seat's loop 4.9-9.7 s; the census it wants is a recent round's, among the newest rows)
  const byHeight = new Map();                // census height -> [{ rid, contract }]
  const CHUNK = 500, MAX_CHUNKS = 4;
  let highRow = null, lowRow = null, exhausted = false;
  const keepRow = (r) => {
    let c; try { c = decodeRoundContract(new Uint8Array(r.contract)); } catch { return; }
    if (!byHeight.has(c.censusHeight)) byHeight.set(c.censusHeight, []);
    const at = byHeight.get(c.censusHeight);
    if (at.length < 4) at.push({ rid: new Uint8Array(r.round_id), contract: c });
  };
  /** The rows stored since the last read (none on the first: that starts at the top and reads down, `older`). */
  const newer = () => {
    if (highRow === null) {
      const top = round.db.prepare('SELECT max(rowid) AS m FROM rounds').get();
      highRow = top && top.m !== null ? Number(top.m) : 0; lowRow = highRow + 1;
      return;
    }
    for (const r of round.db.prepare('SELECT rowid, round_id, contract FROM rounds WHERE rowid > ? ORDER BY rowid').all(highRow)) { highRow = r.rowid; keepRow(r); }
  };
  /** The next CHUNK rows below the lowest read so far, newest first. */
  const older = () => {
    if (exhausted) return;
    const rows = round.db.prepare('SELECT rowid, round_id, contract FROM rounds WHERE rowid < ? ORDER BY rowid DESC LIMIT ?').all(lowRow, CHUNK);
    for (const r of rows) { lowRow = r.rowid; keepRow(r); }
    if (rows.length < CHUNK) exhausted = true;
  };
  /**
   * THE CENSUS A RECORD IS BUILT FROM, and its height. Without `atHeight`: the newest held round whose census this seat can
   * read. With it (a gathering seat names its height): a held round at exactly that census height - so every
   * guardian seat builds the gatherer's body, never one of its own. Measured live before: seats 2-7 of testnet4 each took
   * their own newest round, a round posted ahead whose census they could not read yet ("this node has no chain view for
   * that round"), and no record ever had more than 1 signature of the 5 it needs.
   */
  // A SEAT THAT HOLDS NO ROUND READS THE CENSUS OFF ITS OWN CHAIN (measured on the test host 2026-10-18: the seven new seats and
  // the three installer nodes held no round - "this seat holds no round, so it reads no census" - so no federation record, no seated
  // guardians, no gateway seats, ever, on a node that runs no series). The height is shared: the tip less CHAIN_BASIS_LAG, down to a
  // multiple of CHAIN_BASIS_STEP, so a federation's seats name the same one; a gatherer's named height is read too. Read ahead by
  // gatherAll (the census read is async, basis is not) and kept; only when no held round gives a basis, so a seat of a series is as it was.
  const chainCensus = new Map();             // height -> { entries } once read; null while reading
  let chainHeight = null;
  let lastTip = null;                        // the tip last read (kanban #2348: which heights are the shared basis heights)
  const freeHeight = (h, t = lastTip) => Number.isFinite(t) && h % CHAIN_BASIS_STEP === 0 && h <= t
    && h > t - CHAIN_BASIS_LAG - 2 * CHAIN_BASIS_STEP;
  // at most 8 heights kept; a shared basis height is evicted last, so named odd heights do not push it out (kanban #2348)
  const trimChainCensus = () => {
    while (chainCensus.size > 8) {
      let k = null; for (const x of chainCensus.keys()) if (!freeHeight(x)) { k = x; break; }
      chainCensus.delete(k === null ? chainCensus.keys().next().value : k);
    }
  };
  const readChainCensus = (h) => {
    if (typeof censusAt !== 'function' || !Number.isInteger(h) || h < 0 || chainCensus.has(h)) return;
    chainCensus.set(h, null);
    Promise.resolve(censusAt(h)).then((e) => { if (Array.isArray(e) && e.length) chainCensus.set(h, { entries: e }); else chainCensus.delete(h); }, () => chainCensus.delete(h));
    trimChainCensus();
  };
  async function chainAhead() {
    if (typeof chainTip !== 'function' || typeof censusAt !== 'function') return;
    let t = null; try { t = Number(await chainTip()); } catch { t = null; }
    if (!Number.isFinite(t)) return;
    lastTip = t;
    const h = Math.floor((t - CHAIN_BASIS_LAG) / CHAIN_BASIS_STEP) * CHAIN_BASIS_STEP;
    if (!chainCensus.get(h)) { try { const e = await censusAt(h); if (Array.isArray(e) && e.length) chainCensus.set(h, { entries: e }); } catch { /* the next pass */ } }
    if (chainCensus.get(h)) chainHeight = h;
  }
  // A NAMED HEIGHT NOT READ YET IS READ BEFORE THE ANSWER (kanban #549, measured 2026-10-20 07:37Z: right after a restart every guardian
  // seat of 4dc88be7 answered its gatherer "this seat holds no round with census height 157086" - the read had only been started - so
  // the record waited for the next pass); a held round's census still comes first, and a height already read is not read again
  // A STRANGER'S NAMED HEIGHT IS NO CHAIN READ (kanban #2270, a45 refute of #1818): GET /federation-record takes any 64-hex id and any
  // height from anyone, and each censusAt is a walk over ~2,017 blocks plus a census_kept row. So the chain is read for a named height
  // only for a federation this seat names an invite for, at a height not above the tip and at most NAMED_CENSUS_BELOW_TIP below it, and
  // within a token bucket shared by the door (NAMED_CENSUS_BURST, NAMED_CENSUS_PER_MIN). Otherwise the answer is the one before: the
  // basis without that census ("this seat holds no round with census height n").
  // THE GATHERER'S HEIGHT IS NOT IN THE STRANGER'S BUCKET (kanban #2348, a45 refute 8 s2): the bucket was one for the whole door, so a
  // stranger's 8 asks near the tip emptied it and the guardian refused its own gatherer's named height again. A shared chain basis height
  // (freeHeight: what a seat with no round names) is read once a tip without a token; only the other heights spend the bucket, which
  // holds NAMED_CENSUS_BURST less those, so a burst is still at most NAMED_CENSUS_BURST reads.
  let namedTokens = NAMED_CENSUS_BUCKET, namedAt = nowMs();
  const freeTried = new Set();               // shared basis heights read without a token (each once; a failed one then takes a token)
  const namedToken = () => {
    const now = nowMs();
    namedTokens = Math.min(NAMED_CENSUS_BUCKET, namedTokens + Math.max(0, now - namedAt) * NAMED_CENSUS_PER_MIN / 60000); namedAt = now;
    if (namedTokens < 1) return false;
    namedTokens -= 1; return true;
  };
  async function chainReady(atHeight, fidHex = null) {
    if (atHeight === null || typeof censusAt !== 'function' || !Number.isInteger(atHeight) || atHeight < 0 || chainCensus.get(atHeight)) return;
    if (roundBasis(atHeight).ok) return;
    let invite = null; try { invite = fidHex === null ? null : inviteFor(String(fidHex).toLowerCase()); } catch { invite = null; }
    if (!invite) return;
    let free = false;
    if (typeof chainTip === 'function') {
      let t = null; try { t = Number(await chainTip()); } catch { t = null; }
      if (!Number.isFinite(t) || atHeight > t || atHeight < t - NAMED_CENSUS_BELOW_TIP) return;
      lastTip = t;
      if (freeHeight(atHeight, t) && !freeTried.has(atHeight)) {
        free = true; freeTried.add(atHeight);
        for (const x of freeTried) if (!freeHeight(x, t)) freeTried.delete(x);
      }
    }
    if (!free && !namedToken()) return;
    try { const e = await censusAt(atHeight); if (Array.isArray(e) && e.length) chainCensus.set(atHeight, { entries: e }); } catch { /* answered below as before */ }
    trimChainCensus();
  }
  function chainBasis(atHeight) {
    const h = atHeight !== null ? atHeight : chainHeight;
    if (h === null) return null;
    const c = chainCensus.get(h);
    // a named height is read only by chainReady, under its gates (kanban #2270); the read ahead here is for this seat's own height
    if (!c) { if (atHeight === null) readChainCensus(h); return null; }
    return { ok: true, census: { ok: true, entries: c.entries }, height: h, networkId, fromChain: true };
  }
  function basis(atHeight = null) {
    if (chainFirst) { const cb = chainBasis(atHeight); if (cb) return cb; }
    const b = roundBasis(atHeight);
    if (b.ok) return b;
    return chainBasis(atHeight) || b;
  }
  // A FEDERATION THE BASIS DOES NOT NAME IS READ FROM THE CHAIN'S CENSUS (kanban #549, 2026-10-20 ~06:55Z: "federation shows as
  // draining on b18947f085d4 but no new federation is created ... This needs to be fixed automatically each time a federation is shown as
  // draining, it may not be a manual step"): measured, every round the seats held named a census frozen before the successor's guardian
  // adverts (confirmed ~157,071), so no seat's basis named 4dc88be7 and its guardians never gathered its record. Per federation: the
  // basis when its census names it, else the chain's census when that does - with no setting, for a successor and any new federation
  const namesFed = (b, fidHex) => !!(b && b.ok) && federationsOf(b.census).some((f) => toHex(f) === String(fidHex).toLowerCase());
  function basisFor(fidHex, atHeight = null) {
    const b = basis(atHeight);
    if (namesFed(b, fidHex)) return b;
    const cb = chainBasis(atHeight);
    return namesFed(cb, fidHex) ? cb : b;
  }
  function roundBasis(atHeight = null) {
    if (newest) {
      const best = newest();
      if (!best) return { ok: false, why: 'this seat holds no round, so it reads no census' };
      if (atHeight !== null && best.contract.censusHeight !== atHeight) return { ok: false, why: `this seat holds no round with census height ${atHeight}` };
      const census = roster.censusFor(best.rid);
      return census.ok ? { ok: true, census, height: best.contract.censusHeight, networkId: best.contract.networkId } : census;
    }
    newer();
    if (!byHeight.size) older();
    const tried = new Set();
    let why = null, chunks = 0;
    for (;;) {
      const heights = atHeight !== null ? (byHeight.has(atHeight) ? [atHeight] : []) : [...byHeight.keys()].sort((a, b) => b - a).slice(0, 64);
      for (const h of heights) {
        if (tried.has(h)) continue;
        tried.add(h);
        for (const x of byHeight.get(h) || []) {
          const census = roster.censusFor(x.rid);
          // A CENSUS THAT HOLDS NO NODE IS NO BASIS (the owner's playtest 2026-10-13 07:42: "No federation info"): the
          // first v2 grids carried an empty census (fixed in e8f039d8), and as the highest census height they hid every record
          if (census.ok && (census.entries || []).length) return { ok: true, census, height: h, networkId: x.contract.networkId };
          why = census.ok ? `the census at height ${h} holds no node` : census.why;
          // A SEAT STILL READING ITS CHAIN (measured 2026-10-14 12:32Z, the first call 37 s after a start: every census answered
          // "still reading", and reading older rows for one held the loop 4.6 s to a 404) - older rows cannot help: said at once
          if (!census.ok && /still reading its chain view/.test(String(census.why))) return { ok: false, why: census.why };
        }
      }
      // older rows only while nothing read so far gives a basis - at most MAX_CHUNKS a call, and not past 64 heights tried
      if (exhausted || chunks >= MAX_CHUNKS || (atHeight === null && tried.size >= 64)) break;
      older(); chunks++;
    }
    if (atHeight !== null) return { ok: false, why: why ? `census height ${atHeight}: ${why}` : `this seat holds no round with census height ${atHeight}` };
    return { ok: false, why: why || 'this seat holds no round, so it reads no census' };
  }

  /** The body for one federation from a basis, with `gone` - the guardians whose nodes said they are leaving. */
  function bodyFor(b, federationId, gone = [], reserveSats = 0n, eps = null, keys = null) {
    const fid = toHex(federationId);
    const invite = inviteFor(fid);
    if (!invite) return { ok: false, why: 'this seat names no invite for that federation' };
    const guardians = withConfigEndpoints(guardiansOf(b.census, federationId, keys), eps, toHex);
    if (!guardians.length) return { ok: false, why: 'no census node guards that federation' };
    const succ = successorOf(fid);
    // A RETIREMENT CLOSES ONLY AN EMPTY FEDERATION (kanban #1980): the owners' consents were checked against an empty audit and reserve 0
    // when given, and are kept for good - money paid in before the next gather (an empty federation has load 0, so new rounds and first
    // deposits go there) would be closed in by a CLOSED record no seat watches, moves or liquidates. The retirement body is built only
    // while the reserve this body names (read from the guardians, checked by every signer against its own reading) is 0; otherwise the
    // normal OPEN body, and the retirement goes on once the federation is empty again
    const retiring = !succ && retiringOf(fid) && BigInt(reserveSats || 0n) === 0n;
    const r = buildFederationRecord({ federationId, networkId: b.networkId || networkId, invite, nominal: guardians.length, guardians, gone, height: b.height, reserveSats,
      ...(succ ? { successorId: fromHex(succ), closed: !!closedOf(fid) } : retiring ? { closed: true } : {}) });   // retiringOf: federation-retire.js
    return { ok: true, record: r, guardians };
  }

  const epsFor = async (fidHex) => { if (!endpointsOf) return null; try { return await endpointsOf(String(fidHex).toLowerCase()); } catch { return null; } };

  /** THIS SEAT'S SIGNATURE (GET /federation-record): only a guardian of the federation signs, over the body it builds. */
  // THE RESERVE IN THE BODY (§23A.3): the gatherer reads it from the guardians (`reserveOf`, a threshold of them
  // naming one sum) and names it; a seat signs a body naming a reserve only when its own reading is the same
  async function reserveFor(federationIdHex, guardians, named = null) {
    if (!reserveOf) return named === null || BigInt(named) === 0n ? { ok: true, reserveSats: 0n } : { ok: false, why: 'this seat reads no reserve, so it signs none' };
    const r = await reserveOf(federationIdHex, guardians);
    if (!r.ok) return { ok: false, why: `the reserve: ${r.why}` };
    if (named !== null && r.reserveSats !== BigInt(named)) return { ok: false, why: `this seat reads a reserve of ${r.reserveSats} sat, not ${named}` };
    return { ok: true, reserveSats: r.reserveSats };
  }
  async function mySignature(federationIdHex, atHeight = null, reserveNamed = null) {
    await chainReady(atHeight, federationIdHex);
    const b = basisFor(federationIdHex, atHeight);
    if (!b.ok) return b;
    const eps = await epsFor(federationIdHex);
    const keys = await keysFor(federationIdHex);
    const first = bodyFor(b, fromHex(federationIdHex), [], 0n, eps, keys);
    if (!first.ok) return first;
    const res = await reserveFor(federationIdHex, first.guardians, reserveNamed);
    if (!res.ok) return res;
    const built = bodyFor(b, fromHex(federationIdHex), [], res.reserveSats, eps, keys);
    if (!built.guardians.some((g) => toHex(g.nodePubkey) === toHex(round.pubkey))) return { ok: false, why: 'this node does not guard that federation' };
    const leaving = leavingAtMs() !== null;
    const id = federationRecordId(built.record);
    return { ok: true, height: b.height, nodePubkey: toHex(round.pubkey), body: toHex(encodeFederationRecord(built.record)),
      signature: toHex(schnorr.sign(id, round.identity.secret)), leaving, leaveSig: toHex(schnorr.sign(leaveMessage(id, leaving), round.identity.secret)) };
  }

  /** GATHER: every guardian's signature for the federation; the gone are the ones whose own signed word says leaving. */
  async function gather(federationId, inviteFederationId) {
    const b = basisFor(toHex(federationId));
    if (!b.ok) return b;
    const eps = await epsFor(toHex(federationId));
    const keys = await keysFor(toHex(federationId));
    const first = bodyFor(b, federationId, [], 0n, eps, keys);
    if (!first.ok) return first;
    // THE RESERVE, read once here and named to every guardian seat, each of which signs only on its own same reading
    const res = await reserveFor(toHex(federationId), first.guardians);
    if (!res.ok) return res;
    const reserveSats = res.reserveSats;
    const plain = bodyFor(b, federationId, [], reserveSats, eps, keys);
    const asked = await Promise.all(plain.guardians.map(async (g) => {
      const base = String(g.advertEndpoint || '').replace(/^ws(s?):/, 'http$1:').replace(/\/+$/, '');
      if (toHex(g.nodePubkey) === toHex(round.pubkey)) return { g, said: await mySignature(toHex(federationId), null, reserveSats) };
      try { const r = await fetcher(`${base}/federation-record?federation=${toHex(federationId)}&height=${b.height}&reserve=${reserveSats}`, { signal: AbortSignal.timeout(8000) }); return { g, said: r.ok ? await r.json() : null }; }
      catch { return { g, said: null }; }
    }));
    // WHO SAYS IT IS LEAVING, each by its own key over the plain body's id
    const plainId = federationRecordId(plain.record);
    const gone = [];
    // ... and the statements themselves go along on the second ask (kanban #1157): a guardian seat signs one gone only on its own word
    const left = [];
    for (const { g, said } of asked) {
      if (!said || !said.ok || !said.leaving) continue;
      if (leaveStands(said.leaveSig, plainId, g.nodePubkey)) { gone.push({ peerKey: g.peerKey, sinceHeight: b.height, kind: GONE.DEPARTED, proofRef: plainId }); left.push(leftHex(g.peerKey, said.leaveSig)); }
    }
    // WHO IS PROVEN ABANDONED (§23A.4): 2f + 1 guardians' absence attestations this seat holds, for at least
    // abandon_blocks - gone ABANDONED since the proof's height, under the proof's id; the attestations go along on the second
    // ask, so every guardian seat checks exactly that set
    // AND WHO GAVE NOTICE (§23A.5): a standing departure notice due at this height - DEPARTED from its leave_after, under its id
    // BOTH HELD for one guardian (FEDERATION.md rehearsal 14): "a departure that stops serving before its leave_after"
    // is abandonment (§23A.5) - the proof wins when the absence it attests began before the notice's leave_after
    // AND WHOSE OWNER TOOK IT OUT IN TIME (§23A.5a): DEPARTED from the request's posted_at, before the proof is weighed
    const departed = [];
    const absent = [];
    const emergent = [];
    if (absences) for (const g of plain.guardians) {
      if (gone.some((x) => toHex(x.peerKey) === toHex(g.peerKey))) continue;
      const d = Number.isInteger(departureNotice) ? absences.departureFor(plain.record, g.peerKey, departureNotice, b.height) : { ok: false };
      const p = Number.isInteger(abandonBlocks) ? absences.proofFor(plain.record, g.peerKey, abandonBlocks) : { ok: false };
      const em = absences.emergencyFor ? absences.emergencyFor(g.nodePubkey) : null;
      const out = emergencyDeparted(b, g, em, p);
      if (out) { gone.push(out); emergent.push(em); continue; }
      if (p.ok && (!d.ok || p.sinceHeight < d.sinceHeight)) { gone.push({ peerKey: g.peerKey, sinceHeight: p.sinceHeight, kind: GONE.ABANDONED, proofRef: p.id }); absent.push(...p.attestations); }
      else if (d.ok) { gone.push({ peerKey: g.peerKey, sinceHeight: d.sinceHeight, kind: GONE.DEPARTED, proofRef: d.id }); departed.push(d.notice); }
    }
    // THE BODY WITH THEM GONE, and the signatures over exactly it: a guardian's signature counts for the body it signed,
    // so with anyone gone every seat signs again - the leave statements move the body, and the seat asks once more
    const final = gone.length ? bodyFor(b, federationId, gone, reserveSats, eps, keys) : plain;
    const finalBytes = encodeFederationRecord(final.record);
    const id = federationRecordId(final.record);
    let answers = asked;
    if (gone.length) {
      answers = await Promise.all(plain.guardians.map(async (g) => {
        if (toHex(g.nodePubkey) === toHex(round.pubkey)) return { g, said: signBody(final.record) };
        const base = String(g.advertEndpoint || '').replace(/^ws(s?):/, 'http$1:').replace(/\/+$/, '');
        try { const r = await fetcher(`${base}/federation-record?federation=${toHex(federationId)}&height=${b.height}&reserve=${reserveSats}&gone=${gone.map((x) => toHex(x.peerKey)).join(',')}${absent.length ? `&absent=${absent.map(absenceHex).join(',')}` : ''}${departed.length ? `&departed=${departed.map(departureHex).join(',')}` : ''}${emergent.length ? `&emergency=${emergent.map(emergencyHex).join(',')}` : ''}${left.length ? `&left=${left.join(',')}` : ''}`, { signal: AbortSignal.timeout(8000) }); return { g, said: r.ok ? await r.json() : null }; }
        catch { return { g, said: null }; }
      }));
    }
    const signatures = [];
    for (const { g, said } of answers) {
      if (!said || !said.ok || said.body !== toHex(finalBytes)) continue;
      let good = false; try { good = schnorr.verify(fromHex(said.signature), id, g.nodePubkey); } catch { good = false; }
      if (good) signatures.push({ nodePubkey: g.nodePubkey, signature: fromHex(said.signature) });
    }
    const signed = joinSignedRecord(finalBytes, signatures);
    const [v] = judge(toHex(federationId), [{ bytes: signed, census: b.census.entries }], { inviteFederationId, keys, tip: await tipNow() });
    if (!v.ok) return { ok: false, why: v.why, signatures: signatures.length, of: plain.guardians.length };
    keep(toHex(federationId), signed, v);
    return { ok: true, status: v.status, signers: v.signers, height: v.record.height, gone: gone.length, of: plain.guardians.length };
  }

  /** MIRROR: the newest signed record of `federationId` its guardians' nodes hold, checked against this seat's census `b`. */
  // THE RECORDS BEFORE THE FIRST ANSWER (kanban #1765, state audit 2026-11-12): restore() runs 20 s after start, and until then a seat
  // that held a federation HALTED, CRITICAL or DRAINING answered as if it held no record of it - no draining gate, no liquidation
  // guard on POST /exchange (#1244), GET /federations and /liquidations empty. restoreNow() reads the saved records synchronously,
  // each against its own guardian list (every signature and the threshold, as the restore below falls back to), before the doors
  // open; such a record is provisional, and restore() checks it against the census again at 20 s
  const provisional = new Set();             // federation id hex restored by restoreNow, not yet checked against a census
  function restoreNow(inviteFederationId) {
    if (!store || typeof store.loadNow !== 'function') return { restored: 0 };
    let rows = []; try { rows = store.loadNow() || []; } catch { rows = []; }
    const verify = (s2, m, k) => { try { return schnorr.verify(s2, m, k); } catch { return false; } };
    let restored = 0;
    for (const row of rows) {
      const fid = String(row.federation).toLowerCase();
      if (kept.has(fid)) continue;
      try {
        const bytes = fromHex(String(row.record));
        const r = decodeFederationRecord(splitSignedRecord(bytes).body);
        const own = r.guardians.map((g) => ({ pubkey: g.nodePubkey, advert: { guardianOf: [{ federationId: r.federationId, guardianKey: g.peerKey }] } }));
        const [v] = judge(fid, [{ bytes, census: own }], { inviteFederationId, keys: keysKnown.get(fid) || null });
        if (v.ok && keep(fid, bytes, v, 'restore')) { provisional.add(fid); restored++; }
      } catch { /* restored at 20 s, or gathered again */ }
    }
    return { restored, of: rows.length };
  }
  async function restore(inviteFederationId) {
    if (!store) return { restored: 0 };
    let rows = []; try { rows = (await store.load()) || []; } catch { rows = []; }
    const verify = (s2, m, k) => { try { return schnorr.verify(s2, m, k); } catch { return false; } };
    let restored = 0;
    for (const r of rows) {
      const fid = String(r.federation).toLowerCase();
      // a record restoreNow read back from its own guardian list is checked against the census here (kanban #1765)
      const recheck = provisional.has(fid) && kept.has(fid) && toHex(kept.get(fid).bytes) === String(r.record).toLowerCase();
      provisional.delete(fid);
      if (kept.has(fid) && !recheck) continue;
      try {
        const bytes = fromHex(String(r.record));
        const h = decodeFederationRecord(splitSignedRecord(bytes).body).height;
        const b = basisFor(fid);
        const keys = await keysFor(fid);
        const tip = await tipNow();
        let v = b && b.ok ? judge(fid, [{ bytes, census: b.census.entries }], { inviteFederationId, keys, tip })[0] : { ok: false };
        if (!v.ok && typeof censusAt === 'function') {
          const entries = await Promise.race([Promise.resolve(censusAt(h)).catch(() => null), new Promise((ok) => setTimeout(() => ok(null), 5000))]);
          if (entries) v = judge(fid, [{ bytes, census: entries }], { inviteFederationId, keys, tip })[0];
        }
        // NO CENSUS YET (2026-10-20: "It is also not reading the federations at all reliably so everything gateway related is never
        // shown" - measured 12:48Z: six test host seats restarted one by one under load 18 held no record for minutes, their chain view not
        // built at the 20 s restore, and gathering asked guardians that had restarted too): a record this seat kept was checked in full
        // when it was kept, so it is read back against its own guardian list - every signature and the threshold checked again, the
        // guardians' bonds not; the next gathering, with the census, checks it in full and replaces it
        if (!v.ok) {
          const r = decodeFederationRecord(splitSignedRecord(bytes).body);
          const own = r.guardians.map((g) => ({ pubkey: g.nodePubkey, advert: { guardianOf: [{ federationId: r.federationId, guardianKey: g.peerKey }] } }));
          v = judge(fid, [{ bytes, census: own }], { inviteFederationId, keys, tip })[0];
        }
        if (v.ok) { keep(fid, bytes, v); restored++; }
      } catch { /* not restored: gathered again */ }
    }
    return { restored, of: rows.length };
  }
  const peerTurns = new Map();               // federation id hex -> passes asked: where its next pass starts in peerSeats()
  // pass: one per gather pass (gatherAll), shared by every federation mirrored in it (kanban #2339) - kept: record height -> its census
  // (one read per height in a pass); byBase: guardian node -> new heights its answers made this pass read
  async function mirror(federationId, b, inviteFederationId, pass = { kept: new Map(), byBase: new Map() }) {
    const fid = toHex(federationId);
    const censusKept = pass.kept;
    let keys = await keysFor(fid);
    const guardians = guardiansOf(b.census, federationId, keys);
    if (!guardians.length) return { ok: false, why: 'no census node guards that federation' };
    const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
    let best = null; let why = 'none of its guardians holds a record';
    const bases = guardians.map((g) => String(g.advertEndpoint || '').replace(/^ws(s?):/, 'http$1:').replace(/\/+$/, '')).filter(Boolean);
    const ask = (list) => Promise.all(list.map(async (base) => {
      try {
        const r = await fetcher(`${base}/federations`, { signal: AbortSignal.timeout(8000) });
        if (!r.ok) return;
        const j = await r.json();
        // ONE PEER'S ANSWER IS NOT A LIST OF CHAIN READS (kanban #1818): a record's height is its own, unsigned word, and censusAt derives
        // a whole census from bitcoind (kept 3 days) - one guardian listing the federation at 2,000 made-up heights cost 2,000 derivations
        // a pass. A record that does not stand against this seat's census goes to the chain only if it first stands against its own
        // guardian list (every signature and the threshold, bonds not: cheap, and junk with no signatures stops here), newest first, at
        // most MIRROR_CENSUS_PER_ANSWER heights from one answer and MIRROR_CENSUS_PER_PASS in the pass
        const mine = (Array.isArray(j.federations) ? j.federations : []).filter((x) => x && String(x.federation).toLowerCase() === fid).slice(0, MIRROR_ROWS_PER_ANSWER);
        const later = [];
        for (const x of mine) {
          let v; try { v = verifyFederationRecord(fromHex(String(x.record)), { census: b.census.entries, verify, inviteFederationId, guardianKeys: keys }); } catch (e) { v = { ok: false, why: e.message }; }
          if (!v.ok && typeof censusAt === 'function') {
            let rec = null; try { rec = decodeFederationRecord(splitSignedRecord(fromHex(String(x.record))).body); } catch { rec = null; }
            if (rec && Number.isInteger(rec.height) && Array.isArray(rec.guardians)) {
              const own = rec.guardians.map((g) => ({ pubkey: g.nodePubkey, advert: { guardianOf: [{ federationId: rec.federationId, guardianKey: g.peerKey }] } }));
              let self = { ok: false }; try { self = verifyFederationRecord(fromHex(String(x.record)), { census: own, verify, inviteFederationId, guardianKeys: keys }); } catch { self = { ok: false }; }
              if (self.ok) { later.push({ x, h: rec.height }); continue; }
            }
          }
          cand(x, b.census.entries);
        }
        later.sort((p, q) => q.h - p.h);
        for (const { x, h } of later) {
          let v = { ok: false, why: 'its census was not read: too many record heights in one answer' }; let used = null;
          const reads = pass.byBase.get(base) || 0;   // this node's new heights in the whole pass, every federation (kanban #2339)
          if (censusKept.has(h) || (reads < MIRROR_CENSUS_PER_ANSWER && censusKept.size < MIRROR_CENSUS_PER_PASS)) {
            if (!censusKept.has(h)) { censusKept.set(h, Promise.resolve(censusAt(h)).catch(() => null)); pass.byBase.set(base, reads + 1); }
            const entries = await censusKept.get(h);
            used = entries || null;
            if (!entries) v = { ok: false, why: 'no census at that record height' };
          }
          if (used) cand(x, used); else why = v.why;
        }
      } catch { /* the next guardian */ }
    }));
    // EVERY RECORD OF THE FEDERATION THIS MIRROR SEES, JUDGED TOGETHER (kanban #2604): each with the census it stands against
    const cands = [];
    function cand(x, census) { let bytes = null; try { bytes = fromHex(String(x.record)); } catch { return; } noteInvite(fid, bytes); cands.push({ x, bytes, census }); }
    // AND THE RESTRICTIVE RECORD THE PICK WOULD DROP (kanban #2614, feedback #043): a keyless seat with no record of F yet mirrored the genuine
    // 7 of 7 HALTED record and eight strangers' OPEN one (nominal 11) in one pass; the genuine one was refused (it needs 8), the forgery picked,
    // and with nothing kept the #2613 guard had nothing to hold. A refused record signed by its own threshold, more restrictive than the pick and
    // signed by more than f of the larger set (selfConsistentRestrictive), is kept first - with its halt start - and the pick goes beside it
    // A HOLD IS NOT A HALT (kanban #2615, feedback #044): three bonded strangers' own HALTED record (nominal 3, all three signing) passed the
    // #2614 rule beside a genuine 7 of 7 OPEN one, and a keyless seat kept it - halt start, haltOf, GET /liquidations, the draining gate, the
    // exchange's halted check - and kept it after the strangers went silent. A refused restrictive record takes those effects only when its
    // signers reach thresholdOf(the pick's signers): the bar a record of the pick's size clears to stand. The genuine 7 of 7 HALTED one under
    // eight strangers' OPEN (#042/#043) has 7 >= thresholdOf(8) = 6; the three strangers under the genuine 7 of 7 OPEN have 3 < 5. Below the
    // bar it is only HELD: served beside the kept record so the page's restrictive-word hold applies (#2605/#2611), nothing else - and dropped
    // once no one serves it and a newer record is kept
    let restrict = null, hold = null;
    async function settle() {
      best = null; restrict = null; hold = null;
      if (!cands.length) return;
      // the records' invites are known now: a seat that had no keys for the federation asks the trusted fetch before it judges (kanban #2609)
      if (!keys) keys = await keysFor(fid);
      const verdicts = judge(fid, cands.map((c) => ({ bytes: c.bytes, census: c.census })), { inviteFederationId, keys, tip: await tipNow(), census: b.census.entries });
      cands.forEach((c, i) => take(c.x, verdicts[i]));
      if (!keys && best) {
        const r = selfConsistentRestrictive(verdicts, best.v);
        if (r) {
          const it = { bytes: cands[r.index].bytes, v: r.v };
          if (r.v.signers >= thresholdOf(best.v.signers)) restrict = it; else hold = it;
        }
      }
    }
    function take(x, v) {
      if (!v.ok) { why = v.why; return; }
      // the newest; at the same height a CLOSED one (final - see keep), else the better status (kanban #1157: one node serving a worse body
      // at a height others serve better does not set the pick)
      const sameH = best && v.record.height === best.v.record.height;
      if (!best || v.record.height > best.v.record.height || (sameH && v.status === 'CLOSED' && best.v.status !== 'CLOSED')
        || (sameH && best.v.status !== 'CLOSED' && v.status !== 'CLOSED' && (STATUS_RANK[v.status] ?? 0) < (STATUS_RANK[best.v.status] ?? 0))) best = { v, bytes: fromHex(String(x.record)) };
    }
    await ask(bases);
    await settle();
    if (!best) {
      let others = []; try { others = [...new Set((peerSeats() || []).map((u) => String(u).replace(/\/+$/, '')))].filter((u) => !bases.includes(u)); } catch { others = []; }
      if (others.length) {
        const turn = peerTurns.get(fid) || 0; peerTurns.set(fid, turn + 1);
        const from = (turn * MIRROR_PEERS) % others.length;
        await ask([...others.slice(from), ...others.slice(0, from)].slice(0, MIRROR_PEERS));
        await settle();
        if (!best) why = `${why}, nor ${Math.min(MIRROR_PEERS, others.length)} of the census seats asked`;
      }
    }
    if (!best) return { ok: false, why, mirrored: false };
    if (restrict) keep(fid, restrict.bytes, restrict.v, 'mirror');
    const kept0 = keep(fid, best.bytes, best.v, 'mirror');
    if (hold) holding.set(fid, { bytes: hold.bytes, record: hold.v.record, status: hold.v.status, height: hold.v.record.height, signers: hold.v.signers });
    else if (holding.has(fid)) {
      const h = holding.get(fid), k = kept.get(fid);
      if (!cands.some((c) => toHex(c.bytes) === toHex(h.bytes)) && k && k.height > h.height) holding.delete(fid);
    }
    if (!kept0) { const k = kept.get(fid); return { ok: true, mirrored: false, status: k.status, signers: k.signers, height: k.height, why: recordStep(k, { height: best.v.record.height, status: best.v.status }, 'mirror').why }; }
    return { ok: true, mirrored: true, status: best.v.status, signers: best.v.signers, height: best.v.record.height };
  }

  // THE OWNER'S EMERGENCY DEPARTURE OF A GUARDIAN (§23A.5a, protocol 17): a leave request `d` that stands against the census this record
  // is built on (the node's advertisement names its emergency key, posted at or before the record's height) and arrived before
  // abandon_blocks from the guardian's last seen height (`proof`, the absence attestations held about it, when they make one) is
  // DEPARTED from its posted_at under its id, the bond untouched; a late one changes nothing (the absence is abandonment)
  const emergencyVerify = (sg, m, k) => { try { return schnorr.verify(sg, m, k); } catch { return false; } };
  function emergencyDeparted(b, g, d, proof) {
    if (!d || !Number.isInteger(abandonBlocks)) return null;
    const entry = (b.census.entries || []).find((e) => e && e.pubkey && toHex(e.pubkey) === toHex(g.nodePubkey));
    const st = emergencyDepartureStands(d, { advert: entry && entry.advert, tip: b.height, verify: emergencyVerify });
    if (!st.ok) return null;
    const eff = emergencyDepartureEffect(st, { guardian: true, lastSeenHeight: proof && proof.ok ? proof.sinceHeight : null, abandonBlocks });
    return eff.departed ? { peerKey: g.peerKey, sinceHeight: d.postedAt, kind: GONE.DEPARTED, proofRef: emergencyDepartureId(d) } : null;
  }

  /** A body this seat builds anyway (with the gone it was told), signed: the second ask of `gather`. */
  function signBody(record) {
    const id = federationRecordId(record);
    return { ok: true, nodePubkey: toHex(round.pubkey), body: toHex(encodeFederationRecord(record)), signature: toHex(schnorr.sign(id, round.identity.secret)) };
  }

  /** GET /federation-record with `gone` named: the same body with those peer keys gone, signed - if they are its guardians. */
  // A GUARDIAN IS SIGNED GONE ONLY ON A PROOF THIS SEAT CHECKS (kanban #1157): its own signed leave statement over this seat's plain body
  // (`left`), a standing notice, an emergency request this seat took itself, or 2f + 1 absence attestations for abandon_blocks - never on
  // the gatherer's word alone. And THIS SEAT'S OWN GUARDIAN by a leave statement only while this node is leaving: never by one it does not
  // stand behind now. Its owner's notice or emergency request, and 2f + 1 attestations (a threshold of observers), stand for it as for any
  async function mySignatureWithGone(federationIdHex, goneHex, atHeight = null, reserveNamed = null, absentHex = [], departedHex = [], emergencyHexes = [], { left = [] } = {}) {
    await chainReady(atHeight, federationIdHex);
    const b = basisFor(federationIdHex, atHeight);
    if (!b.ok) return b;
    const eps = await epsFor(federationIdHex);
    const keys = await keysFor(federationIdHex);
    const first = bodyFor(b, fromHex(federationIdHex), [], 0n, eps, keys);
    if (!first.ok) return first;
    const res = await reserveFor(federationIdHex, first.guardians, reserveNamed);
    if (!res.ok) return res;
    const plain = bodyFor(b, fromHex(federationIdHex), [], res.reserveSats, eps, keys);
    if (!plain.guardians.some((g) => toHex(g.nodePubkey) === toHex(round.pubkey))) return { ok: false, why: 'this node does not guard that federation' };
    const listedKeys = new Set(plain.guardians.map((g) => toHex(g.peerKey)));
    if (!goneHex.every((k) => listedKeys.has(k))) return { ok: false, why: 'that names a guardian this federation does not have' };
    const plainId = federationRecordId(plain.record);
    // a peer the attestations handed along are about is ABANDONED - only if they prove it to this seat, on its own record
    let absent; let notices;
    let requests; let statements;
    try { absent = absentHex.map(readAbsenceHex); notices = departedHex.map(readDepartureHex); requests = emergencyHexes.map(readEmergencyHex); statements = (left || []).map(readLeftHex); } catch (e) { return { ok: false, why: e.message }; }
    const me = toHex(round.pubkey);
    const sv = (sg, m, k) => { try { return schnorr.verify(sg, m, k); } catch { return false; } };
    const gone = [];
    for (const g of plain.guardians.filter((x) => goneHex.includes(toHex(x.peerKey)))) {
      // an owner's leave request handed along for this guardian's node (§23A.5a): DEPARTED from its posted_at - only if it stands here
      // and arrived in time against the absence attestations this seat holds itself
      // ... and only one this seat took itself, fresh (emergency.js EMERGENCY_FRESH_BLOCKS): a handed request it never held could be dated back
      const handed = requests.find((d) => toHex(d.nodePubkey) === toHex(g.nodePubkey));
      const mine = handed && absences && absences.emergencyFor ? absences.emergencyFor(g.nodePubkey) : null;
      if (handed && !(mine && mine.postedAt === handed.postedAt)) return { ok: false, why: 'that emergency departure is not one this seat took itself' };
      const req = mine;
      if (req) {
        const own = absences && Number.isInteger(abandonBlocks) ? absences.proofFor(plain.record, g.peerKey, abandonBlocks) : { ok: false };
        const out = emergencyDeparted(b, g, req, own);
        if (!out) return { ok: false, why: 'that emergency departure does not stand here, or came after abandon_blocks' };
        gone.push(out); continue;
      }
      // a notice handed along for this peer: DEPARTED from its leave_after - only if it stands here and is due at this height
      if (notices.some((d) => toHex(d.peerKey) === toHex(g.peerKey))) {
        if (!Number.isInteger(departureNotice)) return { ok: false, why: 'this seat runs no departure_notice clock' };
        // EACH ANCHOR READ ON THIS SEAT'S OWN CHAIN (kanban #2608): the height a handed notice counts from is never the gatherer's word
        const mine = await Promise.all(notices.filter((d) => toHex(d.peerKey) === toHex(g.peerKey))
          .map((d) => (absences && typeof absences.anchorDeparture === 'function' ? absences.anchorDeparture(d) : { ...d, anchor: undefined })));
        const d = dueDeparture(mine, { record: plain.record, peerKey: g.peerKey, departureNotice, height: b.height, verify: sv, gate: absences ? absences.anchorGate ?? null : null });
        if (!d.ok) return { ok: false, why: `that departure does not stand here: ${d.why}` };
        gone.push({ peerKey: g.peerKey, sinceHeight: d.sinceHeight, kind: GONE.DEPARTED, proofRef: d.id }); continue;
      }
      const self = toHex(g.nodePubkey) === me;
      // its own word that it leaves, over exactly the plain body this seat built: DEPARTED from this height, under that body's id
      const said = statements.find((x) => x.peerKey === toHex(g.peerKey));
      if (said) {
        if (!leaveStands(said.signature, plainId, g.nodePubkey)) return { ok: false, why: `the leave statement of guardian ${toHex(g.peerKey).slice(0, 16)} is not its node's signature over this body` };
        if (self && leavingAtMs() === null) return { ok: false, why: 'this node is not leaving: it does not sign itself gone' };
        gone.push({ peerKey: g.peerKey, sinceHeight: b.height, kind: GONE.DEPARTED, proofRef: plainId }); continue;
      }
      const about = absent.filter((a) => toHex(a.peerKey) === toHex(g.peerKey));
      if (!about.length) return { ok: false, why: `guardian ${toHex(g.peerKey).slice(0, 16)} is named gone with no proof: no leave statement, notice, emergency request or absence attestations` };
      if (!Number.isInteger(abandonBlocks)) return { ok: false, why: 'this seat runs no abandon_blocks clock' };
      const p = abandonmentProof(about, { record: plain.record, peerKey: g.peerKey, abandonBlocks, verify: (sg, m, k) => { try { return schnorr.verify(sg, m, k); } catch { return false; } } });
      if (!p.ok) return { ok: false, why: `that abandonment does not stand here: ${p.why}` };
      gone.push({ peerKey: g.peerKey, sinceHeight: p.sinceHeight, kind: GONE.ABANDONED, proofRef: p.id });
    }
    return signBody(bodyFor(b, fromHex(federationIdHex), gone, res.reserveSats, eps, keys).record);
  }

  // one gather pass (gatherAll starts it): kanban #2370 - never two at once, and the public door's no more often than GATHER_FRESH_MS
  const passes = { running: null, last: null, doneAt: 0 };
  async function gatherPass(inviteFederationId) {
    await chainAhead();
    const b = basis();
    // every federation the basis names AND every one only the chain's census names (kanban #549: a successor named after the
    // rounds' census was frozen), each read from the basis that names it
    const cb = chainBasis(null);
    const feds = new Map();
    for (const x of [b, cb]) if (x && x.ok) for (const f of federationsOf(x.census)) if (!feds.has(toHex(f))) feds.set(toHex(f), f);
    if (!feds.size) return [b.ok ? { ok: false, why: 'no census this seat reads names a federation' } : b];
    const out = [];
    const pass = { kept: new Map(), byBase: new Map() };   // the chain census reads of this whole pass (kanban #2339)
    // A FEDERATION THIS SEAT HAS NO INVITE FOR IS MIRRORED, NOT SKIPPED (2026-10-12: "Make it happen
    // automatically so we don't have to update nodes, it needs to find federations"): its guardians' own nodes - their bond
    // adverts' endpoints in this census - are asked for its signed record, which stands only against this seat's census
    // AND A GATHER THAT FAILS IS MIRRORED TOO (measured live 2026-10-15): a seat that holds a federation's invite but
    // whose own basis is another census height than its guardians' (node 15: newest readable round at 156388, B's guardians sign
    // at 156538) gathered "0 of its bonded guardians signed it" every pass and never held B's record; the record its guardians keep
    // stands against this seat's census all the same
    for (const fid of feds.values()) {
      try {
        let got = inviteFor(toHex(fid)) ? await gather(fid, inviteFederationId) : null;
        if (!got || got.ok === false) { const m = await mirror(fid, basisFor(toHex(fid)), inviteFederationId, pass); got = m.ok || !got ? { ...m, ...(got ? { gathered: got.why } : {}) } : got; }
        out.push({ federation: toHex(fid), ...got });
      } catch (e) { out.push({ federation: toHex(fid), ok: false, why: e.message }); }
    }
    return out;
  }

  const api = {
    mySignature, mySignatureWithGone, gather, restore, restoreNow,
    gatherAll(inviteFederationId, { minAgeMs = 0 } = {}) {
      if (passes.running) return passes.running;
      if (minAgeMs > 0 && passes.doneAt && nowMs() - passes.doneAt < minAgeMs) return Promise.resolve(passes.last || []);
      passes.running = gatherPass(inviteFederationId).then((out) => { passes.last = out; return out; })
        .finally(() => { passes.doneAt = nowMs(); passes.running = null; });
      return passes.running;
    },
    /** WHAT GET /federations SERVES (kanban #2613): every kept record, and beside it a newer, less restrictive one this seat judged without
     * the config keys and did not keep - so a client reads both words. One row more per such federation; list() stays one row each. */
    served() {
      const out = api.list();
      for (const [federation, a] of [...holding].map(([f, h]) => [f, { ...h, held: true }]).concat([...beside])) {
        if (!kept.has(federation) || out.some((x) => x.federation === federation && x.record === toHex(a.bytes))) continue;
        out.push({ federation, status: a.status, height: a.height, signers: a.signers, record: toHex(a.bytes), ...(a.held ? { held: true } : { beside: true }),
          ...(a.record ? { reserveSats: String(a.record.reserveSats), exposureCapSats: String(a.record.exposureCapSats),
            load: a.record.exposureCapSats > 0n ? Number((a.record.reserveSats * 10000n) / a.record.exposureCapSats) / 10000 : null } : {}) });
      }
      return out;
    },
    /** The restrictive keyless record served for the page's hold only - no halt, no gate (kanban #2615) - or null. */
    heldOf: (fidHex) => { const h = holding.get(String(fidHex).toLowerCase()); return h ? { record: h.record, status: h.status, height: h.height } : null; },
    /** The newer, less restrictive keyless record held beside the kept one, or null (kanban #2613). */
    besideOf: (fidHex) => { const a = beside.get(String(fidHex).toLowerCase()); return a ? { record: a.record, status: a.status, height: a.height } : null; },
    list: () => [...kept.entries()].map(([federation, k]) => ({ federation, status: k.status, height: k.height, signers: k.signers, record: toHex(k.bytes),
      // THE LOAD (§23A.3): the signed record's reserve over its signed exposure cap
      ...(k.record ? { reserveSats: String(k.record.reserveSats), exposureCapSats: String(k.record.exposureCapSats),
        load: k.record.exposureCapSats > 0n ? Number((k.record.reserveSats * 10000n) / k.record.exposureCapSats) / 10000 : null } : {}),
      // the successor's guardian pool takes this drain's seated guardians (predecessorGuardians), shown with the record
      ...(k.record && k.record.successorId && k.record.successorId.some((x) => x) ? { successor: toHex(k.record.successorId) } : {}) })),
    draining: (fidHex) => draining.get(fidHex) || null,
    /** THE INVITE A FEDERATION'S SIGNED RECORD CARRIES: how this node joins a federation it did not found. */
    inviteOf: (fidHex) => { const k = kept.get(String(fidHex).toLowerCase()); return k && k.record && k.record.invite ? String(k.record.invite) : null; },
    /** The kept record of a federation ({ record, status, height }) and, while it is HALTED, the halt it counts from. */
    /** THE ACTIVE SEATS OF THIS SEAT'S CENSUS, by node key (halts.js): who may observe a halt. */
    censusKeys: () => { const b = basis(); return b.ok ? (b.census.entries || []).map((e) => e.pubkey).filter(Boolean) : []; },
    /** THE CENSUS THIS SEAT READS, its entries and height (GET /roles), or why none. */
    censusNow: () => { const b = basis(); return b.ok ? { ok: true, height: b.height, entries: b.census.entries || [] } : { ok: false, why: b.why }; },
    recordOf: (fidHex) => { const k = kept.get(String(fidHex).toLowerCase()); return k ? { record: k.record, status: k.status, height: k.height } : null; },
    /**
     * HOW MANY OF A FEDERATION'S GUARDIAN SEATS HOLD ITS RECORD CLOSED (kanban #577, measured 2026-10-22 on 89ce310e: the first guardian to
     * hold the CLOSED record set its guardian aside at once, and the others, one guardian short, could never close it): each guardian's
     * node asked (GET /federations) - { closed, of }. A retiring guardian is set aside only once a threshold of them hold it closed.
     */
    async closedAtGuardians(fidHex) {
      const fid = String(fidHex).toLowerCase();
      const b = basisFor(fid);
      if (!b || !b.ok) return { closed: 0, of: 0, why: (b && b.why) || 'no census' };
      const guardians = guardiansOf(b.census, fromHex(fid), await keysFor(fid));
      const answers = await Promise.all(guardians.map(async (g) => {
        const base = String(g.advertEndpoint || '').replace(/^ws(s?):/, 'http$1:').replace(/\/+$/, '');
        if (toHex(g.nodePubkey) === toHex(round.pubkey)) { const k = kept.get(fid); return !!k && k.status === 'CLOSED'; }
        try {
          const r = await fetcher(`${base}/federations`, { signal: AbortSignal.timeout(8000) });
          if (!r.ok) return false;
          return ((await r.json()).federations || []).some((x) => String(x.federation).toLowerCase() === fid && x.status === 'CLOSED');
        } catch { return false; }
      }));
      return { closed: answers.filter(Boolean).length, of: guardians.length };
    },
    haltOf: (fidHex) => halted.get(String(fidHex).toLowerCase()) || null,
    haltedFederations: () => [...halted.keys()],
    // THE DRAIN IS PAID (§23A.6 step 5): the seated guardians of every federation whose verified record says
    // DRAINING and names `fidHex` as its successor - not gone, by node key. A CLOSED predecessor names nobody. One that fell to
    // CRITICAL while draining is still drained by its seated guardians, and paid ("until its record is CLOSED"); a HALTED one
    // serves nothing
    // THE FEDERATION'S SEATED GUARDIANS, BY NODE KEY (§22A v4.6.4 from SEATED_GUARDIAN_VERSION): its newest record's
    // guardians that are not gone (§23A.1); null when this seat holds no record of it (the census rule then stands)
    // THE NEWEST CENSUS THIS SEAT READS (kanban #552: an operator's new advertisement counts once its update is in the chain's census, not
    // only when the rounds' census moves past it, a day later): the chain's when read, else the basis's
    censusNewest() { const cb = chainBasis(null); if (cb && cb.ok) return cb.census.entries || []; const b = basis(); return b.ok ? b.census.entries || [] : []; },
    // and with its height (GET /roles, kanban #560: every seat answers the same census - the chain's at the same step - not its newest round's)
    // the record in force at `height`: the newest this seat verified at or below it (null when it holds none)
    recordAt(fid, height) {
      const f = String(fid).toLowerCase(); let m = history.get(f);
      if (!m || !m.size) m = historyOf(f);
      if (!m) return null;
      let best = null; for (const [h, rec] of m) if (h <= Number(height) && (!best || h > best.height)) best = rec;
      return best;
    },
    censusNewestAt() { const cb = chainBasis(null); return cb && cb.ok ? { height: cb.height, entries: cb.census.entries || [] } : null; },
    // THE FEDERATION'S GUARDIANS BY THE CENSUS (kanban #552): node keys hex of the census that names it (the held round's, else the chain's) -
    // what stands before this seat holds its record (seatedGuardians is null then; "the census rule then stands")
    censusGuardians(fidHex) {
      try { const b = basisFor(String(fidHex).toLowerCase()); return b && b.ok ? guardiansOf(b.census, fromHex(String(fidHex)), keysKnown.get(String(fidHex).toLowerCase()) || null).map((g) => toHex(g.nodePubkey)) : []; } catch { return []; }
    },
    seatedGuardians(fidHex) {
      const k = kept.get(String(fidHex).toLowerCase());
      if (!k || !k.record) return null;
      return seatedOf(k.record);
    },
    predecessorGuardians(fidHex) {
      const out = [];
      for (const [, k] of kept) {
        if (!['DRAINING', 'CRITICAL'].includes(k.status) || !k.record || toHex(k.record.successorId) !== String(fidHex).toLowerCase()) continue;
        const gone = new Set((k.record.gone || []).map((g) => toHex(g.peerKey)));
        for (const g of k.record.guardians || []) if (!gone.has(toHex(g.peerKey))) out.push(g.nodePubkey);
      }
      return out;
    },
    FEDERATION_STATUS,
  };
  return api;
}
