// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE FEDERATION RECORDS A SEAT SIGNS, GATHERS AND MIRRORS (spec §23A.4).
//
// The body is built from what every seat of a series reads the same: the census of the newest round it holds (the
// census nodes whose bond advertisements name the federation in guardian_of[]), at that round's census height - so seats
// on one series build byte-identical bodies and their signatures add up. A guardian is GONE when its own node says it is
// leaving (the owner's leave, owner-leave.js), signed with the node key beside its record signature. ABANDONED needs 2f + 1
// absence attestations for abandon_blocks (absences.js), or a bond the census read as spent; the record says nothing it cannot back.
//
// A seat that is a guardian signs the body (GET /federation-record); every seat gathers the guardians' signatures from
// their endpoints and, at the threshold, keeps the signed record and mirrors it at GET /federations. A record whose status
// is DRAINING, CRITICAL or CLOSED makes the federation draining at this seat (no new round names it).
//
// A GUARDIAN WHO SPENT HIS BOND WHILE SEATED is ABANDONED from that spend (spentGuardians, §23A.5, kanban #1054), read off the census, so no one has to attest it.
// WHAT AN ABANDONED ROW LEFT is listed for the arbitration set (abandonedSlashes, §23A.5, kanban #1059, #1062): the record is the filing, and an output left is slashed on an AbandonedProof, kept
// here by its hash for anyone to fetch and check, the slash long landed or not.
import { schnorr } from '@noble/curves/secp256k1.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { nodeBonds } from '../../arena-protocol/src/census.js';
import { abandonmentProof, bondSpentProof } from '../../arena-protocol/src/absence.js';
import { guardianSlashStands, scheduledDeparture } from '../../arena-protocol/src/federation-slash.js';
import { judgeAbandoned } from './arbiter.js';
import { abandonedRows, outputsLeft, encodeAbandonedProof, decodeAbandonedProof, abandonedProofId } from '../../arena-protocol/src/abandoned-slash.js';
import { abandonedSlashPoint, networkOf } from '../../arena-protocol/src/constants.js';
import { decodeBoundProof, encodeBoundProof, boundProofId, boundSlashStands } from '../../arena-protocol/src/bound-slash.js';
import { encodeTheftProof, decodeTheftProof, theftProofId, theftOutputs, theftSlashStands, theftTakes, sessionsShowMark, spendStands, theftVerifyInput } from '../../arena-protocol/src/theft-slash.js';
import { absenceHex, readAbsenceHex, departureHex, readDepartureHex, dueDeparture, emergencyHex, readEmergencyHex } from './absences.js';
import { emergencyDepartureStands, emergencyDepartureEffect, emergencyDepartureId } from '../../arena-protocol/src/emergency.js';
import { decodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { withConfigEndpoints } from './federation-endpoints.js';
import { buildFederationRecord, encodeFederationRecord, federationRecordId, joinSignedRecord, verifyFederationRecord,
  FEDERATION_STATUS, GONE, decodeFederationRecord, splitSignedRecord, highestVerified, recordStatusName, thresholdOf, loadReserveOf, statusFor, paysDrainShares, playerReserveOf, GATEWAY_FEE_MAX_REFERENCE } from '../../arena-protocol/src/federation-record.js';
import { recordBand, bandOfRecord } from '../../arena-protocol/src/capacity.js';

/** The census nodes guarding `federationId`, as the record lists them. */
export function guardiansOf(census, federationId) {
  const fid = toHex(federationId);
  const out = [];
  // ONE ROW PER NODE, ITS BOND THE SUM OF ITS OUTPUTS (kanban #544): an added second output names the same guardian, not a second one;
  // the row's bond outpoint is the node's lowest
  for (const n of nodeBonds((census.entries || []).filter((e) => ((e.advert && e.advert.guardianOf) || []).some((x) => toHex(x.federationId) === fid)))) {
    const e = n.entry, g = e.advert.guardianOf.find((x) => toHex(x.federationId) === fid);
    out.push({ peerKey: g.guardianKey, nodePubkey: e.pubkey, operatorId: (e.advert && e.advert.operatorId) || '', bondTxid: e.txid, bondVout: e.vout,
      endpoint: (e.advert && e.advert.guardianEndpoint) || '', bondSats: typeof e.bondSats === 'bigint' ? n.bondSats : String(n.bondSats),
      outputs: n.outputs.map((o) => ({ bondSats: BigInt(o.bondSats), maturity: o.maturity })),   // each output's maturity: the lock (kanban #1093 part 7)
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
 *   else                                 -> taken
 * Answers { take, why }.
 */
export const STATUS_RANK = Object.freeze({ OPEN: 0, DRAINING: 1, CRITICAL: 2, HALTED: 3 });
export function recordStep(had, next, from = 'gather') {
  if (!had) return { take: true, why: 'none kept' };
  if (had.height > next.height) return { take: false, why: `a record at ${next.height} is older than the one kept at ${had.height}` };
  if (had.height < next.height) return { take: true, why: 'newer' };
  if (had.status === 'CLOSED' && next.status !== 'CLOSED') return { take: false, why: 'the record kept at that height is CLOSED, and CLOSED is final' };
  if (from === 'mirror' && next.status !== 'CLOSED' && (STATUS_RANK[next.status] ?? 0) > (STATUS_RANK[had.status] ?? 0))
    return { take: false, why: `a mirrored ${next.status} record does not replace the ${had.status} one kept at the same height ${next.height}` };
  return { take: true, why: 'the same height' };
}

// `successorOf(fidHex)`: the successor this seat was told of (hex) or null; `closedOf(fidHex)`: whether the drain is over
// (§23A.6 steps 2 and 4) - both read into the body every guardian seat builds the same way
export function federationRecords({ round, roster, inviteFor, networkId, leavingAtMs = () => null, fetcher = fetch, nowMs = () => Date.now(), newest = null,
  // `playerHeldOf(fidHex)`: { ok, sats: [bigint] } - the gateways' proved e-cash this seat counts (its gateway watch: each paid seat's held
  // lock, heldLockCounted), or { ok: false }; null: this seat names no player reserve (kanban #1322)
  playerHeldOf = null,
  // `successionReasonOf(fidHex)`: { kind: NOMINAL_CHANGE | LISTED_UPGRADE, ref } - why its guardians called the succession (kanban #1321), or null
  successionReasonOf = () => null,
  successorOf = () => null, closedOf = () => false, retiringOf = () => false, reserveOf = null, absences = null, abandonBlocks = null, departureNotice = null,
  // THE GUARDIANS' ADDRESSES FROM THE FEDERATION'S OWN CONFIGURATION (federation-endpoints.js): async (fidHex) -> Map(peer key
  // hex -> API URL) | null; a guardian it names takes that endpoint into the body, one it does not keeps its advert's
  endpointsOf = null,
  // THE CENSUS AT A RECORD'S OWN HEIGHT (measured live 2026-10-15): async (height) -> census entries | null, from this seat's
  // chain (main.js ballot.censusEntriesAt). A seat whose basis is an older census than the record's (node 15: 156388, B's record at
  // 156538, its guardians' current keys in the newer census) checks a mirrored record against the census the record names
  censusAt = null,
  // WHAT ENDED THE BONDS OF THAT CENSUS (§23A.5, kanban #1054): async (height) -> [{ pubkey, txid, vout, spentBy: { txid, height } }], the census's own exclusions (main.js ballot.censusSpendsAt)
  spendsAt = null,
  // EVERY OUTPUT THAT CENSUS READ, THE UNDER-THE-FLOOR ONES AMONG THEM (§23A.5, kanban #1059): async (height) -> its entries and exclusions (main.js ballot.censusBondsAt), for what an ABANDONED row left
  bondsAt = null,
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
  // THE HEIGHT RECORDS NAME THEIR CAPACITY BAND FROM (capacity.js CAPACITY_BAND_HEIGHT, §23A.3a, kanban #997); null: never
  bandFrom = null,
  // AN ABANDONMENT'S PROOF KEPT BY ITS HASH (§23A.5, kanban #1062): (id, bytes) kept, and (id) -> the bytes or null. A row leaves the listing once its output is spent, and the proof must outlive that
  keepProof = null, proofOf = null,
  // THE FIRST since_height A ROW MOVES MONEY FROM (constants.js ABANDONED_SLASH_HEIGHT); a harness names its own
  abandonedFrom = networkId ? abandonedSlashPoint(networkOf(networkId)) : null,
  // A GUARDIAN'S BOND STAYS LOCKED WHILE IT SERVES (kanban #1093 part 7, ruling #1104): { from, drainBlocks, bondMinGuardian } - a body at or
  // above `from` counts in its cap only bonds maturing past its height + drain_blocks (federation-record.js BOND_LOCK_HEIGHT); null: never
  bondLock = null,
  // A RESERVE ALARM (kanban #1093 part 5, ruling #1106): (fid hex) -> { kind: 'inflation' | 'unbacked-spend', session?, txid?, height, ... } | null,
  // a mark of theft this seat saw in the federation's signed history; listed with the record, so every client stops depositing at once
  alarmOf = () => null,
  // A THEFT'S EVIDENCE, AS ITS PROOF CARRIES IT (kanban #1093 part 2, ruling #1109 X): async (fid hex, alarm) -> { mark, config, firstSession, sessions, reserve?, spendTx? } | null - the
  // signed sessions as consensus bytes (from 0 up to an inflation's session; from the reserve outpoint's creation up to an unbacked spend), read by the stake-lock tool
  theftEvidenceOf = async () => null,
  // THE CHECKER'S OWN VERIFIER OF THOSE BYTES: async (theft-slash.js theftVerifyInput) -> the tool's `theft-verify` line, or undefined where this seat runs none;
  // and its chain: async (txid display hex) -> confirmations | null
  verifySessions = async () => undefined, txConfirmations = async () => null }) {
  // THE GUARDIAN BOND LOCK IS ON AT THIS BODY'S HEIGHT (#1104's line; #1318's departure on schedule rides on it)
  const lockOn = (b) => !!(bondLock && Number.isInteger(bondLock.from) && b.height >= bondLock.from);
  const kept = new Map();                    // federation id hex -> { bytes, record, status, height, signers, atMs }
  const draining = new Map();                // federation id hex -> status name
  // THE HALT A LIQUIDATION COUNTS FROM (§23A.5): the lowest-height signed HALTED record of the run of HALTED records
  // this seat holds - kept with its bytes, so anyone checks it - and forgotten once a newer record is not HALTED (a recovery)
  const halted = new Map();                  // federation id hex -> { height, bytes }
  // EVERY RECORD BY ITS HEIGHT TOO (kanban #559/#543, §23A.3a: the pressure weights read "the federation record in force at" the round's
  // census height, which may be older than the newest): each verified record kept per federation and height, in memory and the store
  const history = new Map();                 // fid -> Map(height -> record)
  const remember = (fid, rec) => { if (!history.has(fid)) history.set(fid, new Map()); history.get(fid).set(Number(rec.height), rec);
    if (store && store.saveAt) { try { store.saveAt(fid, Number(rec.height), rec.__hex); } catch { /* in memory */ } } };
  // the history of `fid` with the store's rows read in once (they were each verified when saved), those in memory kept as they are
  const historyRead = new Set();
  const historyOf = (fid) => {
    if (!historyRead.has(fid) && store && store.loadAt) {
      historyRead.add(fid);
      try { for (const r of store.loadAt(fid) || []) { try { if (history.has(fid) && history.get(fid).has(Number(r.height))) continue; const rec = decodeFederationRecord(splitSignedRecord(fromHex(r.record)).body); remember(fid, Object.assign(Object.create(null), rec, { __hex: r.record })); } catch { /* skip */ } } } catch { /* none */ }
    }
    return history.get(fid) || null;
  };
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
    const step = recordStep(had ? { height: had.height, status: had.status } : null, { height: v.record.height, status: v.status }, from);
    if (step.take || (had && had.height > v.record.height)) remember(fid, Object.assign(Object.create(null), v.record, { __hex: toHex(bytes), __status: v.status }));
    if (!step.take) return false;
    kept.set(fid, { bytes, record: v.record, status: v.status, height: v.record.height, signers: v.signers, atMs: nowMs() });
    if (store) { try { store.save(fid, toHex(bytes)); } catch { /* kept in memory */ } }
    if (['DRAINING', 'CRITICAL', 'CLOSED', 'HALTED'].includes(v.status)) draining.set(fid, v.status); else draining.delete(fid);
    if (v.status !== 'HALTED') halted.delete(fid);
    else if (!halted.has(fid)) halted.set(fid, haltStartOf(fid, v.record.height, bytes));
    else if (halted.get(fid).height > v.record.height) halted.set(fid, { height: v.record.height, bytes });
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
  const chainCensus = new Map();             // height -> { entries, spends } once read; null while reading
  const bondsRead = new Map();               // height -> what bondsAt answered, the newest few
  const chainCensusAt = async (h) => {
    const entries = await censusAt(h);
    if (!Array.isArray(entries) || !entries.length) return null;
    let spends = []; if (typeof spendsAt === 'function') { try { spends = (await spendsAt(h)) || []; } catch { spends = []; } }
    return { entries, spends };
  };
  let chainHeight = null;
  const readChainCensus = (h) => {
    if (typeof censusAt !== 'function' || !Number.isInteger(h) || h < 0 || chainCensus.has(h)) return;
    chainCensus.set(h, null);
    chainCensusAt(h).then((c) => { if (c) chainCensus.set(h, c); else chainCensus.delete(h); }, () => chainCensus.delete(h));
    while (chainCensus.size > 8) chainCensus.delete(chainCensus.keys().next().value);
  };
  async function chainAhead() {
    if (typeof chainTip !== 'function' || typeof censusAt !== 'function') return;
    let t = null; try { t = Number(await chainTip()); } catch { t = null; }
    if (!Number.isFinite(t)) return;
    const h = Math.floor((t - CHAIN_BASIS_LAG) / CHAIN_BASIS_STEP) * CHAIN_BASIS_STEP;
    if (!chainCensus.get(h)) { try { const c = await chainCensusAt(h); if (c) chainCensus.set(h, c); } catch { /* the next pass */ } }
    if (chainCensus.get(h)) chainHeight = h;
  }
  // A NAMED HEIGHT NOT READ YET IS READ BEFORE THE ANSWER (kanban #549, measured 2026-10-20 07:37Z: right after a restart every guardian
  // seat of 4dc88be7 answered its gatherer "this seat holds no round with census height 157086" - the read had only been started - so
  // the record waited for the next pass); a held round's census still comes first, and a height already read is not read again
  async function chainReady(atHeight) {
    if (atHeight === null || typeof censusAt !== 'function' || !Number.isInteger(atHeight) || atHeight < 0 || chainCensus.get(atHeight)) return;
    if (roundBasis(atHeight).ok) return;
    try { const c = await chainCensusAt(atHeight); if (c) chainCensus.set(atHeight, c); } catch { /* answered below as before */ }
    while (chainCensus.size > 8) chainCensus.delete(chainCensus.keys().next().value);
  }
  function chainBasis(atHeight) {
    const h = atHeight !== null ? atHeight : chainHeight;
    if (h === null) return null;
    const c = chainCensus.get(h);
    if (!c) { readChainCensus(h); return null; }
    return { ok: true, census: { ok: true, entries: c.entries, spends: c.spends }, height: h, networkId, fromChain: true };
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

  // THE RECORD IN FORCE AT A HEIGHT: the newest this seat verified at or below it (null when it holds none)
  // (historyRead, historyOf above: the federations whose stored history is in memory, shared with the halt start, kanban #1578)
  function recordAt(fid, height) {
    const f = String(fid).toLowerCase(); let m = history.get(f);
    // THE STORED HISTORY ONCE PER FEDERATION, NOT ONLY WHEN NONE IS IN MEMORY (kanban #993): after a restart restore() remembers the newest
    // record alone, and every older height then answered null - a round's census height, or a founding's trigger_height - 12
    if (!historyRead.has(f)) m = historyOf(f);
    if (!m) return null;
    let best = null; for (const [h, rec] of m) if (h <= Number(height) && (!best || h > best.height)) best = rec;
    return best;
  }
  /**
   * THE BAND A NEW RECORD KEEPS ITS GAP FROM (§23A.3a, kanban #997/#1028): the band of the previous record, the highest verified one below this
   * record's height. A body must come out byte for byte at every guardian, so they agree on it before signing: each asks the federation's other
   * guardians for theirs (GET /federation-records-at), takes what the gatherer hands along (`previous`, signed hex), checks each at threshold
   * and uses the highest. A threshold of the guardians, itself among them, must answer, since a record needs that many signers. A guardian that
   * cannot say does not sign this round, and the next step catches up. Answers { ok, was, hex }; `was` null below bandFrom: no band in the body.
   */
  const prevAsked = new Map();               // 'fid:height' -> { atMs, hexes, answered }: one ask a minute, a gather signs each body twice
  async function askPrevious(fidHex, b) {
    const k = `${fidHex}:${b.height}`, had = prevAsked.get(k);
    if (had && nowMs() - had.atMs < 60000) return had;
    const me = toHex(round.pubkey), guardians = guardiansOf(b.census, fromHex(fidHex));
    const others = guardians.filter((g) => toHex(g.nodePubkey) !== me).map((g) => String(g.advertEndpoint || '').replace(/^ws(s?):/, 'http$1:').replace(/\/+$/, '')).filter(Boolean);
    const hexes = new Set(); let answered = 1;
    await Promise.all(others.map(async (base) => {
      try {
        const r = await fetcher(`${base}/federation-records-at?height=${b.height - 1}&federations=${fidHex}`, { signal: AbortSignal.timeout(3000) });
        if (!r.ok) return;
        answered++;
        for (const x of ((await r.json()) || {}).records || []) if (String(x.federation).toLowerCase() === fidHex && x.record) hexes.add(String(x.record).toLowerCase());
      } catch { /* out of reach */ }
    }));
    const got = { atMs: nowMs(), hexes, answered, of: guardians.length };
    prevAsked.set(k, got);
    while (prevAsked.size > 16) prevAsked.delete(prevAsked.keys().next().value);
    return got;
  }
  async function wasFor(fidHex, b, previous = null, inviteFederationId = null) {
    if (!Number.isInteger(bandFrom) || b.height < bandFrom) return { ok: true, was: null, hex: null };
    const fid = String(fidHex).toLowerCase(), rows = [], own = recordAt(fid, b.height - 1);
    if (own) rows.push({ record: own, status: recordStatusName(own), hex: own.__hex });
    const asked = await askPrevious(fid, b);
    if (asked.answered < thresholdOf(asked.of)) return { ok: false, why: `${asked.answered} of ${asked.of} guardians answered with their records below ${b.height}: this guardian does not sign this round` };
    const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
    for (const hex of [...asked.hexes, ...(previous ? [String(previous).toLowerCase()] : [])]) {
      let bytes, r; try { bytes = fromHex(hex); r = splitSignedRecord(bytes).record; } catch { continue; }
      if (toHex(r.federationId) !== fid || r.height >= b.height || !inviteFederationId) continue;
      let v = verifyFederationRecord(bytes, { census: b.census.entries, verify, inviteFederationId, bandPoint: bandFrom });
      if (!v.ok && typeof censusAt === 'function') {
        const entries = await Promise.resolve().then(() => censusAt(r.height)).catch(() => null);
        if (!entries) return { ok: false, why: `the census at ${r.height} is not read, so a record below ${b.height} cannot be checked: this guardian does not sign this round` };
        v = verifyFederationRecord(bytes, { census: entries, verify, inviteFederationId, bandPoint: bandFrom });
      }
      if (v.ok) rows.push({ ...v, hex });
    }
    const best = highestVerified(rows);
    return { ok: true, was: best ? bandOfRecord(best.record) : 'CALM', hex: best ? best.hex || null : null };
  }

  /**
   * A GUARDIAN WHO SPENT HIS BOND WHILE SEATED (§23A.5, kanban #1054: "the census sees it"). The census at this basis has dropped him, so without this his row would just go: the federation's
   * nominal would shrink and nobody would be gone, with its cap resting on the bonds left as if he had never sat. The record in force below this height says who sat. A node of it that this
   * census no longer holds, and whose bond the census read as spent, stays listed and goes ABANDONED from that spend, under its txid: a seat reads the chain's own answer, so nothing is asked
   * of anyone and every seat on this census writes the same row. Still bonded by another output is still seated: the census says so, and the cap follows the sum. A notice served out first is
   * no offence: guardianSlashStands says DEPARTED, and his row goes as any departed node's does. A row once ABANDONED this way stays, after the spend has left the census's window too.
   * Answers [{ row, gone }].
   */
  function spentGuardians(b, federationId) {
    const fid = toHex(federationId);
    const held = recordAt(fid, b.height - 1);
    if (!held || recordStatusName(held) === 'CLOSED') return [];
    const here = new Set(guardiansOf(b.census, federationId).map((g) => toHex(g.nodePubkey)));
    const spends = b.census.spends || (b.census.excluded || []).filter((x) => x.spentBy);
    const out = [];
    for (const g of held.guardians) {
      if (here.has(toHex(g.nodePubkey))) continue;
      const row = { ...g, bondSats: 0n };
      const before = (held.gone || []).find((x) => toHex(x.peerKey) === toHex(g.peerKey));
      if (before) { if (before.kind === GONE.ABANDONED) out.push({ row, gone: before }); continue; }
      const mine = spends.filter((x) => x.pubkey && toHex(x.pubkey) === toHex(g.nodePubkey) && x.spentBy).sort((x, y) => y.spentBy.height - x.spentBy.height)[0];
      if (!mine) continue;
      const proof = bondSpentProof({ peerKey: g.peerKey, spent: mine.spentBy });
      const d = absences && Number.isInteger(departureNotice) ? absences.departureFor(held, g.peerKey, departureNotice, b.height) : { ok: false };
      // A SPEND AT THE BOND'S MATURITY IS A DEPARTURE ON SCHEDULE (#1318), while the guardian bond lock is on (#1104's line, BOND_LOCK_HEIGHT)
      const scheduled = lockOn(b) ? scheduledDeparture({ maturity: mine.advert && Number.isInteger(mine.advert.bondMaturityHeight) ? mine.advert.bondMaturityHeight : mine.maturity, departureNotice }) : null;
      const stands = guardianSlashStands({ proof, departure: d.ok ? { ok: true, peerKey: g.peerKey, leaveAfterHeight: d.notice.leaveAfterHeight } : null, scheduled });
      if (stands.ok && stands.slash) out.push({ row, gone: { peerKey: g.peerKey, sinceHeight: proof.sinceHeight, kind: GONE.ABANDONED, proofRef: proof.id } });
    }
    return out;
  }

  /**
   * THE SLASHES THE RECORDS FILED (§23A.5, RULED 2026-11-02, kanban #1058, #1059): one row per output an ABANDONED row of a kept record left, read off the chain's census at the shared basis
   * height, for the arbitration set's intake (GET /slashes). No row, no read: a seat whose records name nobody ABANDONED pays nothing here. The output's spent state is the census's, and the
   * set reads its own chain before it acts. `proof` is the hash of that output's AbandonedProof (§23A.5, kanban #1062, #1065), with this seat's copy of the record in it, and it is kept under that hash:
   * abandonedProof serves it, at the door that lists it. One output is listed under the first proof built for it: a later record holding the row would only be another proof of one offence. Answers [{ federation, node, peer, proof, proofRef, since, recordHeight, txid, vout, sats, template }].
   */
  async function abandonedSlashes() {
    const rows = [...kept.entries()].flatMap(([federation, k]) => abandonedRows(k.record, abandonedFrom).map((r) => ({ federation, height: k.height, bytes: k.bytes, r })));
    if (!rows.length) return [];
    const h = await bondsAtBasis();
    if (h === null) return [];
    return rows.flatMap(({ federation, height, bytes, r }) => outputsLeft(bondsRead.get(h), r.nodePubkey, r.sinceHeight).map((o) => {
      const name = `${toHex(r.nodePubkey)}:${toHex(r.proofRef)}:${o.txid}:${o.vout}`;
      if (!proofListed.has(name)) { const proof = encodeAbandonedProof({ federationId: fromHex(federation), nodePubkey: r.nodePubkey, proofRef: r.proofRef, txid: fromHex(o.txid), vout: o.vout, record: bytes }), made = toHex(abandonedProofId(proof)); proofListed.set(name, made); keptProof(made, proof); }
      const id = proofListed.get(name);
      return { federation, node: toHex(r.nodePubkey), peer: toHex(r.peerKey), proof: id, proofRef: toHex(r.proofRef), since: r.sinceHeight, recordHeight: height, txid: o.txid, vout: o.vout, sats: String(o.sats), template: o.template };
    }));
  }
  /** The census's bonds at the shared basis height (the tip less CHAIN_BASIS_LAG, down to a CHAIN_BASIS_STEP), read once and kept in `bondsRead`: that height, or null where none is read. */
  async function bondsAtBasis() {
    if (typeof bondsAt !== 'function' || typeof chainTip !== 'function') return null;
    const h = Math.floor((Number(await chainTip()) - CHAIN_BASIS_LAG) / CHAIN_BASIS_STEP) * CHAIN_BASIS_STEP;
    if (!bondsRead.has(h)) {
      const got = await bondsAt(h);
      if (!Array.isArray(got)) return null;
      bondsRead.set(h, got);
      while (bondsRead.size > 2) bondsRead.delete(bondsRead.keys().next().value);
    }
    return h;
  }

  /**
   * THE SLASHES A MARK OF THEFT FILES (kanban #1093 part 2, rulings #1106, #1109): for every federation with a standing alarm in THIS seat's own book (`alarmOf`), every template-3 bond output
   * of every guardian its newest kept record still seats (theftTakes: a DEPARTED one is not taken), read off the census at the shared basis height. Each output's TheftProof (theft-slash.js)
   * carries that record and the whole evidence (`theftEvidenceOf`: the signed sessions, the config, the spend), and is kept under its hash for anyone to fetch, as an abandonment's is; one
   * output is listed under the first proof built for it. No alarm, no read; no evidence, nothing listed. Answers [{ federation, node, proof, kind, markHeight, recordHeight, txid, vout, sats, template }].
   */
  const evidenceHeld = new Map();           // fid -> the evidence read once for its alarm
  const evidenceMark = new Map();           // fid -> the mark that evidence was read for (kanban #1176)
  async function theftSlashes() {
    // kanban #1176: only a CONFIRMED alarm (seated nodes signed the same mark) files slashes; a RAISED one stops deposits only. The evidence
    // is read once per mark: an alarm withdrawn and raised again on another spend reads its own
    const marked = [...kept.entries()].flatMap(([federation, k]) => { const alarm = alarmOf(federation); return alarm && k.record && alarm.state === 'CONFIRMED' ? [{ federation, k, alarm }] : []; });
    for (const f of [...evidenceHeld.keys()]) { const a = alarmOf(f); if (!a || evidenceMark.get(f) !== `${a.kind}:${a.txid || a.session}`) { evidenceHeld.delete(f); evidenceMark.delete(f); } }
    if (!marked.length) return [];
    const h = await bondsAtBasis();
    if (h === null) return [];
    const out = [];
    for (const { federation, k, alarm } of marked) {
      const owed = theftTakes(k.record).flatMap((node) => theftOutputs(bondsRead.get(h), node, h).map((o) => ({ node, o })));
      if (!owed.length) continue;
      if (!evidenceHeld.has(federation)) { let ev = null; try { ev = await theftEvidenceOf(federation, alarm); } catch { ev = null; } if (!ev) continue; evidenceHeld.set(federation, ev); evidenceMark.set(federation, `${alarm.kind}:${alarm.txid || alarm.session}`); }
      const ev = evidenceHeld.get(federation);
      for (const { node, o } of owed) {
        const name = `theft:${federation}:${toHex(node)}:${o.txid}:${o.vout}`;
        if (!proofListed.has(name)) {
          const proof = encodeTheftProof({ federationId: fromHex(federation), nodePubkey: node, txid: fromHex(o.txid), vout: o.vout, record: k.bytes, ...ev }), made = toHex(theftProofId(proof));
          proofListed.set(name, made); keptProof(made, proof);
        }
        out.push({ federation, node: toHex(node), proof: proofListed.get(name), kind: ev.mark.kind, markHeight: ev.mark.height, recordHeight: k.height, txid: o.txid, vout: o.vout, sats: String(o.sats), template: o.template });
      }
    }
    return out;
  }
  /**
   * THE SLASHES A COPY ABOVE THE HALT'S BOUND FILES (kanban #1269, §5A.3, RULED #1262): `cases` [{ federation, copy, observations }] (liquidations.js aboveBound, halts.js observationsOf) -
   * for each, every template-3 output of the copy's signer read off the census at the shared basis height, under its BoundProof (the newest kept record, the copy, the
   * observations), kept under its hash for anyone to fetch. A signer the record does not seat files nothing. Answers [{ federation, node, proof, session, txid, vout, sats, template }].
   */
  async function boundSlashes(cases = []) {
    if (!cases.length) return [];
    const h = await bondsAtBasis();
    if (h === null) return [];
    const out = [];
    for (const { federation, copy, observations } of cases) {
      const k = kept.get(String(federation).toLowerCase());
      if (!k || !k.record || !k.bytes || !theftTakes(k.record).some((x) => toHex(x) === toHex(copy.signer)) || !(observations || []).length) continue;
      for (const o of theftOutputs(bondsRead.get(h), copy.signer, h)) {
        const name = `bound:${federation}:${toHex(copy.signer)}:${copy.session}:${o.txid}:${o.vout}`;
        if (!proofListed.has(name)) {
          const proof = encodeBoundProof({ federationId: fromHex(federation), nodePubkey: copy.signer, txid: fromHex(o.txid), vout: o.vout, record: k.bytes, copy, observations }), made = toHex(boundProofId(proof));
          proofListed.set(name, made); keptProof(made, proof);
        }
        out.push({ federation, node: toHex(copy.signer), proof: proofListed.get(name), session: copy.session, recordHeight: k.height, txid: o.txid, vout: o.vout, sats: String(o.sats), template: o.template });
      }
    }
    return out;
  }
  /** The bytes of a TheftProof by its hash, or null. */
  const theftProof = (id) => {
    const held = proofsHeld.get(id), bytes = held instanceof Uint8Array ? held : proofOf ? proofOf(id) : null;
    try { decodeTheftProof(bytes); return bytes; } catch { return null; }
  };
  /** The signed record a proof carries, held to this seat's census at its own height: { ok, record } or { ok: false, status, wait, why }. */
  async function recordStands(record, inviteFederationId) {
    let height; try { height = splitSignedRecord(record).record.height; } catch (e) { return { ok: false, status: 400, why: e.message }; }
    const entries = typeof censusAt === 'function' ? await Promise.resolve().then(() => censusAt(height)).catch(() => null) : null;
    if (!entries) return { ok: false, status: 503, wait: true, why: `the census at ${height} is not read here` };
    const v = verifyFederationRecord(record, { census: entries, verify: (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } }, inviteFederationId, networkId });
    return v.ok ? { ok: true, record: v.record } : { ok: false, status: 409, why: `that record does not stand: ${v.why}` };
  }
  /** A THEFT'S PROOF HANDED TO THIS SEAT (PUT /slash/<id>): kept when the bytes hash to that id, the record in them stands here, is the proof's federation's, and seats the node. */
  async function takeTheftProof(id, bytes, inviteFederationId) {
    let p;
    try { if (toHex(theftProofId(bytes)) !== id) return { ok: false, status: 409, why: 'those bytes are not the proof that hash names' }; p = decodeTheftProof(bytes); } catch (e) { return { ok: false, status: 400, why: e.message }; }
    const st = await recordStands(p.record, inviteFederationId);
    if (!st.ok) return st;
    if (toHex(st.record.federationId) !== toHex(p.federationId)) return { ok: false, status: 409, why: 'that record is another federation\'s' };
    if (!theftTakes(st.record).some((k) => toHex(k) === toHex(p.nodePubkey))) return { ok: false, status: 409, why: 'that record does not seat that node as a guardian' };
    keptProof(id, bytes);
    return { ok: true, status: 201 };
  }
  /**
   * THIS SEAT'S OWN WORD ON A THEFT'S PROOF (kanban #1093 part 2, ruling #1109 X: the bytes are judged, never a live read nor this seat's alarm book). The record in it on this seat's census, the
   * node seated by it and by the newest record held here, the output that node's unspent template-3 bond output on this seat's chain, an unbacked spend 6 deep here and spending the reserve
   * outpoint, and the signed sessions re-verified by this seat's own verifier (`verifySessions`). Undefined where this seat cannot say yet (no census, no verifier, the spend not deep enough),
   * so a hold's return is never taken on a guess. `beforeHeight` where the bond was started already: the output is read at the block before the start. Answers { verdict, why }.
   */
  async function theftVerdict(bytes, inviteFederationId, beforeHeight = null) {
    let p; try { p = decodeTheftProof(bytes); } catch (e) { return { verdict: false, why: `that is no proof of a theft: ${e.message}` }; }
    const st = await recordStands(p.record, inviteFederationId);
    if (!st.ok) return { verdict: st.wait ? undefined : false, why: st.why };
    if (typeof bondsAt !== 'function' || typeof chainTip !== 'function') return { verdict: undefined, why: 'this seat reads no census from its chain' };
    const at = beforeHeight === null ? Number(await chainTip()) : beforeHeight;
    const bonds = await Promise.resolve().then(() => bondsAt(at)).catch(() => null);
    if (!Array.isArray(bonds)) return { verdict: undefined, why: `the bonds at ${at} are not read here` };
    const fid = toHex(p.federationId), held = kept.get(fid);
    const base = { record: st.record, newest: held && held.record ? { ...held.record, height: held.height } : null, proof: p, bonds, atHeight: at };
    // the cheap checks first: a record or an output that does not stand needs no verifier
    const pre = theftSlashStands({ ...base, shown: { ok: true, why: '' }, spend: { ok: true } });
    if (pre.verdict !== true) return { verdict: pre.verdict, why: pre.why };
    let spend = null, spendHeight = null;
    if (p.mark.kind === 'unbacked-spend') {
      let conf = null; try { conf = await txConfirmations(toHex(p.mark.spendTxid)); } catch { conf = null; }
      spend = spendStands(p, { confirmations: Number.isInteger(conf) ? conf : null });
      if (Number.isInteger(conf)) spendHeight = Number(await chainTip()) - conf + 1;
    }
    let shown;
    if (!spend || spend.ok) {
      let v; try { v = await verifySessions(theftVerifyInput(p)); } catch { v = undefined; }
      shown = v === undefined || v === null ? undefined : sessionsShowMark(p, v, { spendHeight });
    }
    const got = theftSlashStands({ ...base, shown, spend });
    return { verdict: got.verdict, why: got.why };
  }
  /** A BOUND PROOF HANDED TO THIS SEAT (PUT /slash/<id>, kanban #1269): kept when the bytes hash to that id, the record in them stands here, is the proof's federation's, and seats the node. */
  async function takeBoundProof(id, bytes, inviteFederationId) {
    let p;
    try { if (toHex(boundProofId(bytes)) !== id) return { ok: false, status: 409, why: 'those bytes are not the proof that hash names' }; p = decodeBoundProof(bytes); } catch (e) { return { ok: false, status: 400, why: e.message }; }
    const st = await recordStands(p.record, inviteFederationId);
    if (!st.ok) return st;
    if (toHex(st.record.federationId) !== toHex(p.federationId)) return { ok: false, status: 409, why: 'that record is another federation\'s' };
    if (!theftTakes(st.record).some((k) => toHex(k) === toHex(p.nodePubkey))) return { ok: false, status: 409, why: 'that record does not seat that node as a guardian' };
    keptProof(id, bytes);
    return { ok: true, status: 201 };
  }
  /**
   * THIS SEAT'S OWN WORD ON A BOUND PROOF (kanban #1269, §5A.3, RULED #1262): the record in it on this seat's census, the copy the accused signed, a halt proof made of the observations on this
   * seat's census seats, the copy above its bound, and the accused's template-3 output on this seat's chain. Undefined where this seat cannot say yet (no census, no bonds read).
   */
  async function boundVerdict(bytes, inviteFederationId, beforeHeight = null) {
    let p; try { p = decodeBoundProof(bytes); } catch (e) { return { verdict: false, why: `that is no proof of a copy above the halt's bound: ${e.message}` }; }
    const st = await recordStands(p.record, inviteFederationId);
    if (!st.ok) return { verdict: st.wait ? undefined : false, why: st.why };
    if (typeof bondsAt !== 'function' || typeof chainTip !== 'function' || !Number.isInteger(abandonBlocks)) return { verdict: undefined, why: 'this seat reads no census from its chain' };
    const at = beforeHeight === null ? Number(await chainTip()) : beforeHeight;
    const bonds = await Promise.resolve().then(() => bondsAt(at)).catch(() => null);
    if (!Array.isArray(bonds)) return { verdict: undefined, why: `the bonds at ${at} are not read here` };
    const seats = (() => { const b = basis(); return b.ok ? (b.census.entries || []).map((e) => e.pubkey).filter(Boolean) : []; })();
    if (!seats.length) return { verdict: undefined, why: 'this seat holds no census to weigh the halt observations on' };
    const got = boundSlashStands({ record: st.record, proof: p, verify: (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } }, censusSeats: seats, abandonBlocks, bonds, atHeight: at });
    return { verdict: got.verdict, why: got.why };
  }
  const proofListed = new Map();             // the output and the row -> the hash this seat lists it under
  const proofsHeld = new Map();              // id hex -> bytes, what no store keeps; with a store only so each is written once
  const keptProof = (id, bytes) => { if (proofsHeld.has(id)) return; proofsHeld.set(id, keepProof ? true : bytes); if (keepProof) { try { keepProof(id, bytes); } catch { proofsHeld.delete(id); } } };
  /** The bytes of an AbandonedProof by its hash, or null. The relay store keeps other things under other ids, and those are no proof of an abandonment. */
  const abandonedProof = (id) => {
    const held = proofsHeld.get(id), bytes = held instanceof Uint8Array ? held : proofOf ? proofOf(id) : null;
    try { decodeAbandonedProof(bytes); return bytes; } catch { return null; }
  };

  /**
   * A PROOF HANDED TO THIS SEAT (PUT /slash/<id>): the set hands it to every seat, so that the proof a slash commits to can be fetched from any of them. The bytes are what they hash to. Kept when
   * they hash to that id and the record in them stands on the census at its height, as a mirrored record is checked, is the proof's federation's, and its row names the proof's node and proof_ref.
   * Answers { ok, status, why }.
   */
  async function takeAbandonedProof(id, bytes, inviteFederationId) {
    let p, record, height;
    try { if (toHex(abandonedProofId(bytes)) !== id) return { ok: false, status: 409, why: 'those bytes are not the proof that hash names' }; p = decodeAbandonedProof(bytes); record = p.record; height = splitSignedRecord(record).record.height; } catch (e) { return { ok: false, status: 400, why: e.message }; }
    const entries = typeof censusAt === 'function' ? await Promise.resolve().then(() => censusAt(height)).catch(() => null) : null;
    if (!entries) return { ok: false, status: 503, why: `the census at ${height} is not read here` };
    const v = verifyFederationRecord(record, { census: entries, verify: (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } }, inviteFederationId, networkId });
    if (!v.ok) return { ok: false, status: 409, why: `that record does not stand: ${v.why}` };
    if (toHex(v.record.federationId) !== toHex(p.federationId)) return { ok: false, status: 409, why: 'that record is another federation\'s' };
    if (!abandonedRows(v.record, abandonedFrom).some((r) => toHex(r.nodePubkey) === toHex(p.nodePubkey) && toHex(r.proofRef) === toHex(p.proofRef))) return { ok: false, status: 409, why: 'that record has no such ABANDONED row' };
    keptProof(id, bytes);
    return { ok: true, status: 201 };
  }

  /**
   * THIS SEAT'S OWN WORD ON AN ABANDONMENT'S PROOF (§23A.5, 5A.3B, kanban #1065): the record in it on the census at its height, the row and the output on this seat's chain, as the arbitration set judges one.
   * `beforeHeight` where the bond was started already: the output is read at the block before the start, since a started output is no output left. Answers { verdict: true | false | undefined, why }.
   */
  async function abandonedVerdict(bytes, inviteFederationId, beforeHeight = null) {
    let p, height;
    try { p = decodeAbandonedProof(bytes); height = splitSignedRecord(p.record).record.height; } catch (e) { return { verdict: false, why: `that is no proof of an abandonment: ${e.message}` }; }
    if (typeof censusAt !== 'function' || typeof bondsAt !== 'function' || typeof chainTip !== 'function') return { verdict: undefined, why: 'this seat reads no census from its chain' };
    const entries = await Promise.resolve().then(() => censusAt(height)).catch(() => null);
    if (!entries) return { verdict: undefined, why: `the census at ${height} is not read here` };
    const at = beforeHeight === null ? Number(await chainTip()) : beforeHeight;
    const bonds = await Promise.resolve().then(() => bondsAt(at)).catch(() => null);
    if (!Array.isArray(bonds)) return { verdict: undefined, why: `the bonds at ${at} are not read here` };
    const v = judgeAbandoned({ proofBytes: bytes, census: entries, bonds, networkId, inviteFederationId, from: abandonedFrom });
    return { verdict: v.slashed, why: v.why };
  }

  /** The body for one federation from a basis, with `gone` - the guardians whose nodes said they are leaving. */
  function bodyFor(b, federationId, gone = [], reserveSats = 0n, eps = null, was = null, player = null) {
    const fid = toHex(federationId);
    const invite = inviteFor(fid);
    if (!invite) return { ok: false, why: 'this seat names no invite for that federation' };
    const guardians = withConfigEndpoints(guardiansOf(b.census, federationId), eps, toHex);
    if (!guardians.length) return { ok: false, why: 'no census node guards that federation' };
    const succ = successorOf(fid);
    const spent = spentGuardians(b, federationId);
    const rows = [...guardians, ...spent.map((x) => x.row)];
    const lock = lockOn(b) ? { drainBlocks: bondLock.drainBlocks, bondMinGuardian: bondLock.bondMinGuardian } : null;
    // ITS PREDECESSOR, WHILE NOT CLOSED (§23A.6 RULED 2026-11-07, kanban #1298/#1321): the kept record naming this federation its successor - its
    // reserve and its seated guardians, so a bond both name counts once in this cap
    let predecessor = null;
    // (its record in force below this record's height, so every signer reads the same figures)
    for (const [predFid, k] of kept) {
      if (!k.record || !k.record.successorId || toHex(k.record.successorId) !== String(fid).toLowerCase()) continue;
      const rec = recordAt(predFid, b.height - 1) || k.record;
      predecessor = { reserveSats: rec.reserveSats, closed: recordStatusName(rec) === 'CLOSED', nodeKeys: seatedOf(rec).map((key) => toHex(key)) };
      break;
    }
    const r = buildFederationRecord({ federationId, networkId: b.networkId || networkId, invite, nominal: rows.length, guardians: rows, gone: [...gone, ...spent.map((x) => x.gone)], height: b.height, reserveSats, bondLock: lock, predecessor,
      ...(succ ? { successorId: fromHex(succ), closed: !!closedOf(fid) } : retiringOf(fid) ? { closed: true } : {}) });   // retiringOf: federation-retire.js
    // the band read against the players' money when a player reserve is named (§23A.3a: load, the bands ... read it), else the reserve
    if (was !== null) r.capacityBand = recordBand({ reserveSats: player !== null && player !== undefined ? BigInt(player) : reserveSats, exposureCapSats: r.exposureCapSats, was });
    // THE PLAYERS' MONEY (§23A.3a RULED 2026-11-07, kanban #1322): with a band, the reference gateway fee cap and the player reserve named,
    // in the record's order (band, cap, player reserve); none named: the record as before
    if (r.capacityBand !== undefined && player !== null && player !== undefined) { r.gatewayFeeMax = { ...GATEWAY_FEE_MAX_REFERENCE }; r.playerReserveSats = BigInt(player); }
    // THE SUCCESSION'S REASON (§23A.6 RULED 2026-11-07, kanban #1321), after the player reserve: a DRAINING body naming its successor names why
    // its guardians called it, when this seat was told; none told: a guardian-called succession pays no drain shares
    if (r.playerReserveSats !== undefined && succ && r.status === FEDERATION_STATUS.DRAINING) { const why = successionReasonOf(fid); if (why) r.successionReason = why; }
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
  // THE PLAYER RESERVE IN THE BODY (kanban #1322): reserve less the gateways' proved e-cash this seat counts. The gatherer names its figure;
  // a seat signs it only on its own same figure (as the reserve); none named: none in the body
  async function playerFor(federationIdHex, reserveSats, named = null, gatherer = false) {
    if (!gatherer && (named === null || named === undefined)) return { ok: true, player: null };
    if (!playerHeldOf) return gatherer ? { ok: true, player: null } : { ok: false, why: 'this seat counts no gateway e-cash, so it signs no player reserve' };
    let h = null; try { h = await playerHeldOf(federationIdHex); } catch (e) { h = { ok: false, why: e.message }; }
    if (!h || !h.ok) return gatherer ? { ok: true, player: null } : { ok: false, why: `the gateways' e-cash: ${(h && h.why) || 'not read'}` };
    const player = playerReserveOf({ reserveSats, gatewayHeldSats: h.sats || [] });
    if (!gatherer && player !== BigInt(named)) return { ok: false, why: `this seat reads a player reserve of ${player} sat, not ${named}` };
    return { ok: true, player };
  }
  async function mySignature(federationIdHex, atHeight = null, reserveNamed = null, { previous = null, inviteFederationId = null, player: playerNamed = null } = {}) {
    await chainReady(atHeight);
    const b = basisFor(federationIdHex, atHeight);
    if (!b.ok) return b;
    const prior = await wasFor(federationIdHex, b, previous, inviteFederationId);
    if (!prior.ok) return prior;
    const was = prior.was;
    const eps = await epsFor(federationIdHex);
    const first = bodyFor(b, fromHex(federationIdHex), [], 0n, eps);
    if (!first.ok) return first;
    const res = await reserveFor(federationIdHex, first.guardians, reserveNamed);
    if (!res.ok) return res;
    const pl = await playerFor(federationIdHex, res.reserveSats, playerNamed);
    if (!pl.ok) return pl;
    const built = bodyFor(b, fromHex(federationIdHex), [], res.reserveSats, eps, was, pl.player);
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
    const first = bodyFor(b, federationId, [], 0n, eps);
    if (!first.ok) return first;
    // THE RESERVE, read once here and named to every guardian seat, each of which signs only on its own same reading
    const res = await reserveFor(toHex(federationId), first.guardians);
    if (!res.ok) return res;
    const reserveSats = res.reserveSats;
    const prior = await wasFor(toHex(federationId), b, null, inviteFederationId);
    if (!prior.ok) return prior;
    const pl = await playerFor(toHex(federationId), reserveSats, null, true);
    const was = prior.was, handed = (prior.hex ? `&previous=${prior.hex}` : '') + (pl.player !== null ? `&player=${pl.player}` : '');
    const plain = bodyFor(b, federationId, [], reserveSats, eps, was, pl.player);
    const asked = await Promise.all(plain.guardians.map(async (g) => {
      const base = String(g.advertEndpoint || '').replace(/^ws(s?):/, 'http$1:').replace(/\/+$/, '');
      if (toHex(g.nodePubkey) === toHex(round.pubkey)) return { g, said: await mySignature(toHex(federationId), null, reserveSats, { previous: prior.hex, inviteFederationId, player: pl.player }) };
      try { const r = await fetcher(`${base}/federation-record?federation=${toHex(federationId)}&height=${b.height}&reserve=${reserveSats}${handed}`, { signal: AbortSignal.timeout(8000) }); return { g, said: r.ok ? await r.json() : null }; }
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
    const seatedBase = seatedOf(plain.record).length, emRanks = emergencyRanks(absences && absences.emergencyFor
      ? plain.guardians.filter((g) => !gone.some((x) => toHex(x.peerKey) === toHex(g.peerKey))).map((g) => absences.emergencyFor(g.nodePubkey)) : []);
    if (absences) for (const g of plain.guardians) {
      if (gone.some((x) => toHex(x.peerKey) === toHex(g.peerKey))) continue;
      const d = Number.isInteger(departureNotice) ? absences.departureFor(plain.record, g.peerKey, departureNotice, b.height) : { ok: false };
      const p = Number.isInteger(abandonBlocks) ? absences.proofFor(plain.record, g.peerKey, abandonBlocks) : { ok: false };
      const em = absences.emergencyFor ? absences.emergencyFor(g.nodePubkey) : null;
      const out = emergencyDeparted(b, g, em, p, em ? { rank: emRanks.get(toHex(g.nodePubkey)) ?? 0, seatedBase, nominal: plain.record.nominal } : null);
      if (out) { gone.push(out); emergent.push(em); continue; }
      // THE BOND'S MATURITY IS A STANDING NOTICE (#1318): absent from its maturity on, the guardian departed on schedule (while the bond lock is on)
      const scheduled = lockOn(b) ? scheduledDeparture({ outputs: g.outputs, departureNotice }) : null;
      const stands = p.ok ? guardianSlashStands({ proof: p, departure: d.ok ? { ok: true, peerKey: g.peerKey, leaveAfterHeight: d.sinceHeight } : null, scheduled }) : null;
      if (stands && stands.ok && stands.slash) { gone.push({ peerKey: g.peerKey, sinceHeight: p.sinceHeight, kind: GONE.ABANDONED, proofRef: p.id }); absent.push(...p.attestations); }
      else if (d.ok) { gone.push({ peerKey: g.peerKey, sinceHeight: d.sinceHeight, kind: GONE.DEPARTED, proofRef: d.id }); departed.push(d.notice); }
      else if (stands && stands.ok && stands.onSchedule) { gone.push({ peerKey: g.peerKey, sinceHeight: p.sinceHeight, kind: GONE.DEPARTED, proofRef: p.id }); absent.push(...p.attestations); }
    }
    // THE BODY WITH THEM GONE, and the signatures over exactly it: a guardian's signature counts for the body it signed,
    // so with anyone gone every seat signs again - the leave statements move the body, and the seat asks once more
    const final = gone.length ? bodyFor(b, federationId, gone, reserveSats, eps, was, pl.player) : plain;
    const finalBytes = encodeFederationRecord(final.record);
    const id = federationRecordId(final.record);
    let answers = asked;
    if (gone.length) {
      answers = await Promise.all(plain.guardians.map(async (g) => {
        if (toHex(g.nodePubkey) === toHex(round.pubkey)) return { g, said: signBody(final.record) };
        const base = String(g.advertEndpoint || '').replace(/^ws(s?):/, 'http$1:').replace(/\/+$/, '');
        try { const r = await fetcher(`${base}/federation-record?federation=${toHex(federationId)}&height=${b.height}&reserve=${reserveSats}${handed}&gone=${gone.map((x) => toHex(x.peerKey)).join(',')}${absent.length ? `&absent=${absent.map(absenceHex).join(',')}` : ''}${departed.length ? `&departed=${departed.map(departureHex).join(',')}` : ''}${emergent.length ? `&emergency=${emergent.map(emergencyHex).join(',')}` : ''}${left.length ? `&left=${left.join(',')}` : ''}`, { signal: AbortSignal.timeout(8000) }); return { g, said: r.ok ? await r.json() : null }; }
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
    const v = verifyFederationRecord(signed, { census: b.census.entries, verify: (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } }, inviteFederationId, bandPoint: bandFrom });
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
        const v = verifyFederationRecord(bytes, { census: own, verify, inviteFederationId });
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
        let v = b && b.ok ? verifyFederationRecord(bytes, { census: b.census.entries, verify, inviteFederationId, bandPoint: bandFrom }) : { ok: false };
        if (!v.ok && typeof censusAt === 'function') {
          const entries = await Promise.race([Promise.resolve(censusAt(h)).catch(() => null), new Promise((ok) => setTimeout(() => ok(null), 5000))]);
          if (entries) v = verifyFederationRecord(bytes, { census: entries, verify, inviteFederationId, bandPoint: bandFrom });
        }
        // NO CENSUS YET (2026-10-20: "It is also not reading the federations at all reliably so everything gateway related is never
        // shown" - measured 12:48Z: six test host seats restarted one by one under load 18 held no record for minutes, their chain view not
        // built at the 20 s restore, and gathering asked guardians that had restarted too): a record this seat kept was checked in full
        // when it was kept, so it is read back against its own guardian list - every signature and the threshold checked again, the
        // guardians' bonds not; the next gathering, with the census, checks it in full and replaces it
        if (!v.ok) {
          const r = decodeFederationRecord(splitSignedRecord(bytes).body);
          const own = r.guardians.map((g) => ({ pubkey: g.nodePubkey, advert: { guardianOf: [{ federationId: r.federationId, guardianKey: g.peerKey }] } }));
          v = verifyFederationRecord(bytes, { census: own, verify, inviteFederationId, bandPoint: bandFrom });
        }
        if (v.ok) { keep(fid, bytes, v); restored++; }
      } catch { /* not restored: gathered again */ }
    }
    return { restored, of: rows.length };
  }
  const peerTurns = new Map();               // federation id hex -> passes asked: where its next pass starts in peerSeats()
  async function mirror(federationId, b, inviteFederationId) {
    const fid = toHex(federationId);
    const censusKept = new Map();          // record height -> its census (one read per height in a pass)
    const guardians = guardiansOf(b.census, federationId);
    if (!guardians.length) return { ok: false, why: 'no census node guards that federation' };
    const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
    let best = null; let why = 'none of its guardians holds a record';
    const bases = guardians.map((g) => String(g.advertEndpoint || '').replace(/^ws(s?):/, 'http$1:').replace(/\/+$/, '')).filter(Boolean);
    const ask = (list) => Promise.all(list.map(async (base) => {
      try {
        const r = await fetcher(`${base}/federations`, { signal: AbortSignal.timeout(8000) });
        if (!r.ok) return;
        const j = await r.json();
        for (const x of j.federations || []) {
          if (String(x.federation).toLowerCase() !== fid) continue;
          let v = verifyFederationRecord(fromHex(String(x.record)), { census: b.census.entries, verify, inviteFederationId, bandPoint: bandFrom });
          if (!v.ok && typeof censusAt === 'function') {
            let h = null; try { h = decodeFederationRecord(splitSignedRecord(fromHex(String(x.record))).body).height; } catch { h = null; }
            if (Number.isInteger(h)) {
              if (!censusKept.has(h)) censusKept.set(h, Promise.resolve(censusAt(h)).catch(() => null));
              const entries = await censusKept.get(h);
              if (entries) v = verifyFederationRecord(fromHex(String(x.record)), { census: entries, verify, inviteFederationId, bandPoint: bandFrom });
            }
          }
          if (!v.ok) { why = v.why; continue; }
          // the newest; at the same height a CLOSED one (final - see keep), else the better status (kanban #1157: one node serving a worse body
          // at a height others serve better does not set the pick)
          const sameH = best && v.record.height === best.v.record.height;
          if (!best || v.record.height > best.v.record.height || (sameH && v.status === 'CLOSED' && best.v.status !== 'CLOSED')
            || (sameH && best.v.status !== 'CLOSED' && v.status !== 'CLOSED' && (STATUS_RANK[v.status] ?? 0) < (STATUS_RANK[best.v.status] ?? 0))) best = { v, bytes: fromHex(String(x.record)) };
        }
      } catch { /* the next guardian */ }
    }));
    await ask(bases);
    if (!best) {
      let others = []; try { others = [...new Set((peerSeats() || []).map((u) => String(u).replace(/\/+$/, '')))].filter((u) => !bases.includes(u)); } catch { others = []; }
      if (others.length) {
        const turn = peerTurns.get(fid) || 0; peerTurns.set(fid, turn + 1);
        const from = (turn * MIRROR_PEERS) % others.length;
        await ask([...others.slice(from), ...others.slice(0, from)].slice(0, MIRROR_PEERS));
        if (!best) why = `${why}, nor ${Math.min(MIRROR_PEERS, others.length)} of the census seats asked`;
      }
    }
    if (!best) return { ok: false, why, mirrored: false };
    if (!keep(fid, best.bytes, best.v, 'mirror')) { const k = kept.get(fid); return { ok: true, mirrored: false, status: k.status, signers: k.signers, height: k.height, why: recordStep(k, { height: best.v.record.height, status: best.v.status }, 'mirror').why }; }
    return { ok: true, mirrored: true, status: best.v.status, signers: best.v.signers, height: best.v.record.height };
  }

  // THE OWNER'S EMERGENCY DEPARTURE OF A GUARDIAN (§23A.5a, protocol 17): a leave request `d` that stands against the census this record
  // is built on (the node's advertisement names its emergency key, posted at or before the record's height) and arrived before
  // abandon_blocks from the guardian's last seen height (`proof`, the absence attestations held about it, when they make one) is
  // DEPARTED from its posted_at under its id, the bond untouched; a late one changes nothing (the absence is abandonment)
  const emergencyVerify = (sg, m, k) => { try { return schnorr.verify(sg, m, k); } catch { return false; } };
  // FREE ONLY WHILE THE FEDERATION STAYS OPEN (§23A.5a RULED 2026-11-07, kanban #1294/#1320): "A request that takes the federation to CRITICAL or
  // below ... reads as ABANDONED whatever key signed it: the bond pays." `order` { rank, seatedBase, nominal }: this request's place among the
  // body's emergencies (posted_at, then node key), the seated before them, the nominal - it leaves seatedBase - (rank + 1) seated
  function emergencyDeparted(b, g, d, proof, order = null) {
    if (!d || !Number.isInteger(abandonBlocks)) return null;
    const entry = (b.census.entries || []).find((e) => e && e.pubkey && toHex(e.pubkey) === toHex(g.nodePubkey));
    const st = emergencyDepartureStands(d, { advert: entry && entry.advert, tip: b.height, verify: emergencyVerify });
    if (!st.ok) return null;
    const eff = emergencyDepartureEffect(st, { guardian: true, lastSeenHeight: proof && proof.ok ? proof.sinceHeight : null, abandonBlocks });
    if (!eff.departed) return null;
    // the band it leaves: CRITICAL or HALTED reads ABANDONED (the ruling's "to CRITICAL or below"); OPEN or DRAINING stays a free departure
    const stillOpen = !order || !['CRITICAL', 'HALTED'].includes(statusFor({ nominal: order.nominal, seated: Math.max(0, order.seatedBase - (order.rank + 1)) }).status);
    return { peerKey: g.peerKey, sinceHeight: d.postedAt, kind: stillOpen ? GONE.DEPARTED : GONE.ABANDONED, proofRef: emergencyDepartureId(d) };
  }
  /** The body's emergencies in one order every seat takes: posted_at, then node key. Answers node key hex -> rank. */
  const emergencyRanks = (reqs) => new Map([...reqs].filter(Boolean).sort((x, y) => (Number(x.postedAt) - Number(y.postedAt)) || (toHex(x.nodePubkey) < toHex(y.nodePubkey) ? -1 : 1))
    .map((d, i) => [toHex(d.nodePubkey), i]));

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
  async function mySignatureWithGone(federationIdHex, goneHex, atHeight = null, reserveNamed = null, absentHex = [], departedHex = [], emergencyHexes = [], { previous = null, inviteFederationId = null, left = [], player: playerNamed = null } = {}) {
    await chainReady(atHeight);
    const b = basisFor(federationIdHex, atHeight);
    if (!b.ok) return b;
    const prior = await wasFor(federationIdHex, b, previous, inviteFederationId);
    if (!prior.ok) return prior;
    const was = prior.was;
    const eps = await epsFor(federationIdHex);
    const first = bodyFor(b, fromHex(federationIdHex), [], 0n, eps);
    if (!first.ok) return first;
    const res = await reserveFor(federationIdHex, first.guardians, reserveNamed);
    if (!res.ok) return res;
    const pl = await playerFor(federationIdHex, res.reserveSats, playerNamed);
    if (!pl.ok) return pl;
    const plain = bodyFor(b, fromHex(federationIdHex), [], res.reserveSats, eps, was, pl.player);
    if (!plain.guardians.some((g) => toHex(g.nodePubkey) === toHex(round.pubkey))) return { ok: false, why: 'this node does not guard that federation' };
    const keys = new Set(plain.guardians.map((g) => toHex(g.peerKey)));
    if (!goneHex.every((k) => keys.has(k))) return { ok: false, why: 'that names a guardian this federation does not have' };
    const plainId = federationRecordId(plain.record);
    // a peer the attestations handed along are about is ABANDONED - only if they prove it to this seat, on its own record
    let absent; let notices;
    let requests; let statements;
    try { absent = absentHex.map(readAbsenceHex); notices = departedHex.map(readDepartureHex); requests = emergencyHexes.map(readEmergencyHex); statements = (left || []).map(readLeftHex); } catch (e) { return { ok: false, why: e.message }; }
    const me = toHex(round.pubkey);
    const sv = (sg, m, k) => { try { return schnorr.verify(sg, m, k); } catch { return false; } };
    const gone = [];
    const signRanks = emergencyRanks(requests);
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
        const out = emergencyDeparted(b, g, req, own, { rank: signRanks.get(toHex(g.nodePubkey)) ?? 0, seatedBase: seatedOf(plain.record).length, nominal: plain.record.nominal });
        if (!out) return { ok: false, why: 'that emergency departure does not stand here, or came after abandon_blocks' };
        gone.push(out); continue;
      }
      // a notice handed along for this peer: DEPARTED from its leave_after - only if it stands here and is due at this height
      if (notices.some((d) => toHex(d.peerKey) === toHex(g.peerKey))) {
        if (!Number.isInteger(departureNotice)) return { ok: false, why: 'this seat runs no departure_notice clock' };
        const d = dueDeparture(notices, { record: plain.record, peerKey: g.peerKey, departureNotice, height: b.height, verify: sv });
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
      // AN ABSENCE FROM THE BOND'S MATURITY ON IS A DEPARTURE ON SCHEDULE (#1318), judged here as the gatherer judged it
      const onTime = lockOn(b) ? guardianSlashStands({ proof: p, scheduled: scheduledDeparture({ outputs: g.outputs, departureNotice }) }) : null;
      gone.push({ peerKey: g.peerKey, sinceHeight: p.sinceHeight, kind: onTime && onTime.onSchedule ? GONE.DEPARTED : GONE.ABANDONED, proofRef: p.id });
    }
    return signBody(bodyFor(b, fromHex(federationIdHex), gone, res.reserveSats, eps, was, pl.player).record);
  }

  return {
    mySignature, mySignatureWithGone, gather, restore, restoreNow,
    async gatherAll(inviteFederationId) {
      await chainAhead();
      const b = basis();
      // every federation the basis names AND every one only the chain's census names (kanban #549: a successor named after the
      // rounds' census was frozen), each read from the basis that names it
      const cb = chainBasis(null);
      const feds = new Map();
      for (const x of [b, cb]) if (x && x.ok) for (const f of federationsOf(x.census)) if (!feds.has(toHex(f))) feds.set(toHex(f), f);
      if (!feds.size) return [b.ok ? { ok: false, why: 'no census this seat reads names a federation' } : b];
      const out = [];
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
          if (!got || got.ok === false) { const m = await mirror(fid, basisFor(toHex(fid)), inviteFederationId); got = m.ok || !got ? { ...m, ...(got ? { gathered: got.why } : {}) } : got; }
          out.push({ federation: toHex(fid), ...got });
        } catch (e) { out.push({ federation: toHex(fid), ok: false, why: e.message }); }
      }
      return out;
    },
    list: () => [...kept.entries()].map(([federation, k]) => ({ federation, status: k.status, height: k.height, signers: k.signers, record: toHex(k.bytes),
      // ITS FIRST HEIGHT HERE (§23A.2 RULED 2026-11-07, kanban #1297/#1323): the oldest record this seat holds of it - a client sends no first deposit
      // to a federation younger than drain_blocks, and reads its age as the median of the seats' answers
      ...((() => { try { recordAt(federation, 0); const m = history.get(String(federation).toLowerCase()); return m && m.size ? { firstHeight: Math.min(...m.keys()) } : {}; } catch { return {}; } })()),
      ...((() => { let a = null; try { a = alarmOf(federation); } catch { a = null; } return a ? { alarm: a } : {}; })()),
      // THE LOAD (§23A.3): the signed record's reserve over its signed exposure cap
      ...(k.record ? { reserveSats: String(k.record.reserveSats), exposureCapSats: String(k.record.exposureCapSats),
        ...(k.record.playerReserveSats !== undefined && k.record.playerReserveSats !== null ? { playerReserveSats: String(k.record.playerReserveSats) } : {}),
        load: k.record.exposureCapSats > 0n ? Number((loadReserveOf(k.record) * 10000n) / k.record.exposureCapSats) / 10000 : null } : {}),
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
    abandonedSlashes, abandonedProof, takeAbandonedProof, abandonedVerdict, theftSlashes, theftProof, takeTheftProof, theftVerdict, takeBoundProof, boundVerdict, boundSlashes,
    recordOf: (fidHex) => { const k = kept.get(String(fidHex).toLowerCase()); return k ? { record: k.record, status: k.status, height: k.height, bytes: k.bytes } : null; },
    /**
     * HOW MANY OF A FEDERATION'S GUARDIAN SEATS HOLD ITS RECORD CLOSED (kanban #577, measured 2026-10-22 on 89ce310e: the first guardian to
     * hold the CLOSED record set its guardian aside at once, and the others, one guardian short, could never close it): each guardian's
     * node asked (GET /federations) - { closed, of }. A retiring guardian is set aside only once a threshold of them hold it closed.
     */
    async closedAtGuardians(fidHex) {
      const fid = String(fidHex).toLowerCase();
      const b = basisFor(fid);
      if (!b || !b.ok) return { closed: 0, of: 0, why: (b && b.why) || 'no census' };
      const guardians = guardiansOf(b.census, fromHex(fid));
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
    recordAt,
    censusNewestAt() { const cb = chainBasis(null); return cb && cb.ok ? { height: cb.height, entries: cb.census.entries || [] } : null; },
    // THE FEDERATION'S GUARDIANS BY THE CENSUS (kanban #552): node keys hex of the census that names it (the held round's, else the chain's) -
    // what stands before this seat holds its record (seatedGuardians is null then; "the census rule then stands")
    censusGuardians(fidHex) {
      try { const b = basisFor(String(fidHex).toLowerCase()); return b && b.ok ? guardiansOf(b.census, fromHex(String(fidHex))).map((g) => toHex(g.nodePubkey)) : []; } catch { return []; }
    },
    seatedGuardians(fidHex) {
      const k = kept.get(String(fidHex).toLowerCase());
      if (!k || !k.record) return null;
      return seatedOf(k.record);
    },
    // DRAIN SHARES ONLY INSIDE drain_blocks (§23A.6 RULED 2026-11-07, kanban #1309/#1321): "paid only for rounds with census_height < draining_height +
    // drain_blocks; after that the predecessor reads as CLOSED for pay" - draining_height its first DRAINING record held here; with no census height
    // or drain_blocks given, as before
    drainingHeight(predFid) {
      const f = predFid instanceof Uint8Array ? toHex(predFid) : String(predFid).toLowerCase();
      recordAt(f, 0);
      const m = history.get(f);
      let h = null;
      if (m) for (const [at, rec] of m) if (recordStatusName(rec) === 'DRAINING' && (h === null || at < h)) h = at;
      return h;
    },
    predecessorGuardians(fidHex, censusHeight = null, drainBlocks = null) {
      const out = [];
      for (const [predFid, k] of kept) {
        if (!['DRAINING', 'CRITICAL'].includes(k.status) || !k.record || toHex(k.record.successorId) !== String(fidHex).toLowerCase()) continue;
        // A GUARDIAN-CALLED SUCCESSION THAT NAMES NO REASON PAYS NO DRAIN SHARES (§23A.6 RULED 2026-11-07, kanban #1309/#1321)
        if (!paysDrainShares(k.record)) continue;
        if (Number.isInteger(censusHeight) && Number.isInteger(drainBlocks)) {
          const dh = this.drainingHeight(predFid);
          if (dh !== null && censusHeight >= dh + drainBlocks) continue;
        }
        const gone = new Set((k.record.gone || []).map((g) => toHex(g.peerKey)));
        for (const g of k.record.guardians || []) if (!gone.has(toHex(g.peerKey))) out.push(g.nodePubkey);
      }
      return out;
    },
    FEDERATION_STATUS,
  };
}
