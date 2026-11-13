// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A FEDERATION'S RECORD (spec §23A.4): what its guardians say about it, signed by at least its threshold.
//
// The status bands are §23A.1's, counted in guardians that are SEATED - not gone (DEPARTED by notice, or ABANDONED by
// 2f + 1 absence attestations for abandon_blocks):
//     reserve = seated - (2f + 1)
//     OPEN       reserve >= min(2, f)   rounds may name it; deposits accepted
//     DRAINING   reserve == 1           no new round names it; the client refuses deposits into it; succession has begun
//     CRITICAL   reserve == 0           one more loss halts it: the client shows Withdraw and Move only
//     HALTED     seated < 2f + 1        every note and lock frozen (§22)
//     CLOSED                            its successor holds everything (§23A.6)
// The record is the only source a client believes about a federation: "trusts nothing about a federation that has no
// record it can verify". Its signatures are by the guardians' NODE keys (one node is one guardian, §23A.2), each a census
// node whose bond advertisement names this federation and this guardian key in guardian_of[] - so the bonds stand behind
// every signature. No curve here: `verify` (BIP-340) is the caller's.
import { Writer, Reader } from './encode.js';
import { taggedHash, toHex } from './hash.js';
import { TAG, TYPE_FEDERATION_RECORD, PROTOCOL_VERSION, speaksVersion, networkOf } from './constants.js';
import { exposureCap, lockedExposureCap } from './federation-slash.js';

export const FEDERATION_STATUS = Object.freeze({ OPEN: 1, DRAINING: 2, CRITICAL: 3, CLOSED: 4, HALTED: 5 });
export const GONE = Object.freeze({ DEPARTED: 1, ABANDONED: 2 });
/** The capacity band a record names (§23A.3a), after its height; a record that names none ends at its height, as every record before did. */
export const CAPACITY_BAND = Object.freeze({ CALM: 1, PRESSURE: 2, CRITICAL: 3, FULL: 4 });
/**
 * WHEN RECORDS NAME THEIR BAND (§23A.3a, kanban #997/#1028): one point per network, named after every seat and installer node runs this and
 * the page is deployed, because an older seat or page refuses a record with a band, whole. A hard line: a record at or above the point must
 * name a band, one below it must not, anything else is refused by name. Null: not named, and no record may name one.
 */
export const CAPACITY_BAND_HEIGHT = Object.freeze({ mainnet: 0, testnet4: null, regtest: null, devnet: null });
// THE HEIGHT FROM WHICH A RECORD'S CAP COUNTS ONLY LOCKED GUARDIAN BONDS (kanban #1093 part 7, ruling #1104): mainnet from genesis; testnet4
// from a height the 2.0 release names once every seat that signs its records runs 2.0 (null until then); regtest and devnet name their own
export const BOND_LOCK_HEIGHT = Object.freeze({ mainnet: 0, testnet4: null, regtest: null, devnet: null });
export const bondLockPoint = (network) => { const n = network === 'testnet' ? 'testnet4' : network; return Object.prototype.hasOwnProperty.call(BOND_LOCK_HEIGHT, n) ? BOND_LOCK_HEIGHT[n] : null; };
export const capacityBandPoint = (network) => { const n = network === 'testnet' ? 'testnet4' : network; return Object.prototype.hasOwnProperty.call(CAPACITY_BAND_HEIGHT, n) ? CAPACITY_BAND_HEIGHT[n] : null; };
const nameOf = (table, v) => Object.keys(table).find((k) => table[k] === v);
/** A record's status by name, whether it was decoded or kept. */
export const recordStatusName = (r) => nameOf(FEDERATION_STATUS, r.status);
const cmp = (a, b) => { for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i]; return a.length - b.length; };

/** n guardians tolerate f = floor((n - 1) / 3); the stock threshold n - f, which is 2f + 1 wherever §23A writes it. */
export const faultsOf = (n) => Math.floor((n - 1) / 3);
export const thresholdOf = (n) => n - faultsOf(n);

/** §23A.1's band for `seated` of `nominal` guardians - and the reserve it is read from. CLOSED is the successor's word, not a count. */
export function statusFor({ nominal, seated, closed = false }) {
  if (!Number.isInteger(nominal) || nominal < 1 || !Number.isInteger(seated) || seated < 0 || seated > nominal)
    throw new Error('a federation has 1 or more guardians, and 0 to all of them seated');
  const f = faultsOf(nominal), min = 2 * f + 1, reserve = seated - min;
  const status = closed ? 'CLOSED' : seated < min ? 'HALTED' : reserve >= Math.min(2, f) ? 'OPEN' : reserve === 1 ? 'DRAINING' : 'CRITICAL';
  return { status, reserve, f, min, threshold: thresholdOf(nominal) };
}

export function encodeFederationRecord(r) {
  const w = new Writer();
  w.u8(TYPE_FEDERATION_RECORD);
  w.u16(PROTOCOL_VERSION);
  w.bytes32(r.federationId);
  w.bytes32(r.networkId);
  w.str(r.invite);
  w.u8(r.nominal);
  w.u8(r.threshold);
  if (r.threshold !== thresholdOf(r.nominal)) throw new Error(`a federation of ${r.nominal} signs with ${thresholdOf(r.nominal)}, not ${r.threshold}`);
  w.vec(r.guardians, (g, ww) => { ww.bytes(g.peerKey, 33); ww.bytes32(g.nodePubkey); ww.str(g.operatorId || ''); ww.bytes32(g.bondTxid); ww.u32(g.bondVout); ww.str(g.endpoint || ''); },
    { sortedBy: (a, b) => cmp(a.nodePubkey, b.nodePubkey) });
  if (!nameOf(FEDERATION_STATUS, r.status)) throw new Error(`status ${r.status} is not one of ${Object.keys(FEDERATION_STATUS).join(', ')}`);
  w.u8(r.status);
  w.bytes32(r.successorId || new Uint8Array(32));
  w.vec(r.gone || [], (g, ww) => { ww.bytes(g.peerKey, 33); ww.u32(g.sinceHeight); ww.u8(g.kind); ww.bytes32(g.proofRef || new Uint8Array(32)); },
    { sortedBy: (a, b) => cmp(a.peerKey, b.peerKey) });
  w.u64(r.exposureCapSats);
  w.u64(r.reserveSats);
  w.u32(r.height);
  if (r.capacityBand !== undefined && r.capacityBand !== null) {
    if (!CAPACITY_BAND[r.capacityBand]) throw new Error(`capacity band ${r.capacityBand} is not one of ${Object.keys(CAPACITY_BAND).join(', ')}`);
    w.u8(CAPACITY_BAND[r.capacityBand]);
  }
  // GATEWAY_FEE_MAX (§23A.9, RULED 2026-11-07 kanban #1310): the most a gateway may charge on a send or a receive for a migration or a swap to
  // go through it - after the capacity band, so a record without it keeps its bytes; it needs the band before it
  if (r.gatewayFeeMax !== undefined && r.gatewayFeeMax !== null) {
    if (r.capacityBand === undefined || r.capacityBand === null) throw new Error('a gateway fee cap follows the capacity band: name the band too');
    const f = r.gatewayFeeMax;
    if (!Number.isInteger(f.ppm) || f.ppm < 0 || f.ppm > 1000000 || !Number.isInteger(f.baseMsat) || f.baseMsat < 0 || f.baseMsat > 0xffffffff)
      throw new Error('a gateway fee cap is { ppm 0..1000000, baseMsat } in whole numbers');
    w.u32(f.ppm); w.u32(f.baseMsat);
  }
  // PLAYER_RESERVE (§23A.3a RULED 2026-11-07, kanban #1296/#1322): reserve less the gateways' proved e-cash - load, the bands, the founding trigger and
  // the health line read it. After the gateway fee cap, so a record without it keeps its bytes; it needs the cap before it
  if (r.playerReserveSats !== undefined && r.playerReserveSats !== null) {
    if (r.gatewayFeeMax === undefined || r.gatewayFeeMax === null) throw new Error('a player reserve follows the gateway fee cap: name the cap too');
    if (typeof r.playerReserveSats !== 'bigint' || r.playerReserveSats < 0n || r.playerReserveSats > BigInt(r.reserveSats)) throw new Error('a player reserve is a whole number of sat, 0 to the reserve');
    w.u64(r.playerReserveSats);
  }
  // THE SUCCESSION'S REASON (§23A.6 RULED 2026-11-07, kanban #1309/#1321): "A guardian-called succession names its reason (a federation_nominal
  // change or a listed upgrade) or pays no drain shares" - a DRAINING record naming its successor; after the player reserve, which it needs
  if (r.successionReason !== undefined && r.successionReason !== null) {
    if (r.playerReserveSats === undefined || r.playerReserveSats === null) throw new Error('a succession reason follows the player reserve: name the reserve too');
    if (nameOf(FEDERATION_STATUS, r.status) !== 'DRAINING' || !r.successorId || !r.successorId.some((x) => x)) throw new Error('a succession reason is named by a DRAINING record that names its successor');
    const kind = SUCCESSION_REASON[r.successionReason.kind];
    if (!kind) throw new Error(`a succession reason is one of ${Object.keys(SUCCESSION_REASON).join(', ')}`);
    const ref = r.successionReason.ref || new Uint8Array(32);
    if (!(ref instanceof Uint8Array) || ref.length !== 32) throw new Error('a succession reason\'s reference is 32 bytes (the listed upgrade; zeros for a nominal change)');
    w.u8(kind); w.bytes32(ref);
  }
  return w.finish();
}

/** WHY GUARDIANS CALLED A SUCCESSION (§23A.6 trigger 3): a change of federation_nominal by §27A, or a listed upgrade (`ref` names it). */
export const SUCCESSION_REASON = Object.freeze({ NOMINAL_CHANGE: 1, LISTED_UPGRADE: 2 });
/**
 * A GUARDIAN-CALLED SUCCESSION (§23A.6 trigger 3, kanban #1321): a DRAINING record whose seated guardians alone would read OPEN - DRAINING by
 * its guardians' decision, not by the guardians it lost (trigger 1) or a departure notice (trigger 2, the departing guardian listed gone).
 */
export function guardianCalled(r) {
  if (!r || nameOf(FEDERATION_STATUS, r.status) !== 'DRAINING') return false;
  const gone = new Set((r.gone || []).map((g) => toHex(g.peerKey)));
  const seated = (r.guardians || []).filter((g) => !gone.has(toHex(g.peerKey))).length;
  try { return statusFor({ nominal: r.nominal, seated: Math.min(r.nominal, seated) }).status === 'OPEN'; } catch { return false; }
}
/** WHETHER A DRAINING PREDECESSOR PAYS DRAIN SHARES (§23A.6 RULED 2026-11-07): a forced succession does; a guardian-called one only when it names its reason. */
export const paysDrainShares = (r) => !guardianCalled(r) || !!(r && r.successionReason);

/** THE RESERVE LOAD IS READ AGAINST (§23A.3a, kanban #1322): the players' money when the record names it, else the whole reserve (records before). */
export const loadReserveOf = (r) => (r && r.playerReserveSats !== undefined && r.playerReserveSats !== null ? BigInt(r.playerReserveSats) : BigInt((r && r.reserveSats) ?? 0n));
/** player_reserve = reserve - the gateways' proved e-cash (each counted by heldLockCounted), never below 0. */
export const playerReserveOf = ({ reserveSats, gatewayHeldSats = [] }) => { const held = gatewayHeldSats.reduce((t, x) => t + BigInt(x || 0n), 0n); const r = BigInt(reserveSats); return held >= r ? 0n : r - held; };
/** A FEDERATION OPENS ONLY IF 2 x peg_in_min <= exposure_cap / 4 (§23A.3a RULED 2026-11-07): its two gateways' mandatory peg-ins alone stay under a quarter of the cap. */
export function opensWith({ exposureCapSats, pegInMinSats }) {
  const ok = 2n * BigInt(pegInMinSats) <= BigInt(exposureCapSats) / 4n;
  return { ok, why: ok ? null : `a federation opens only if 2 x peg_in_min (${2n * BigInt(pegInMinSats)} sat) <= exposure_cap / 4 (${BigInt(exposureCapSats) / 4n} sat) (§23A.3a)` };
}

/** The reference cap (§23A.9): 0.1 % + 10 sat on each leg. */
export const GATEWAY_FEE_MAX_REFERENCE = Object.freeze({ ppm: 1000, baseMsat: 10000 });
/**
 * IS A GATEWAY'S PUBLISHED FEE AT OR UNDER THE CAP: `fees` { send: { ppm, baseMsat }, receive: { ppm, baseMsat } } as its routing info says; a
 * leg it does not publish is not under anything. `max` the record's gatewayFeeMax (none: the reference). Answers { ok } or { ok: false, why }.
 */
export function gatewayFeeWithin(fees, max = null) {
  const cap = max || GATEWAY_FEE_MAX_REFERENCE;
  for (const leg of ['send', 'receive']) {
    const f = fees && fees[leg];
    if (!f || !Number.isFinite(Number(f.ppm)) || !Number.isFinite(Number(f.baseMsat))) return { ok: false, why: `it publishes no ${leg} fee` };
    if (Number(f.ppm) > cap.ppm || Number(f.baseMsat) > cap.baseMsat)
      return { ok: false, why: `its ${leg} fee ${Number(f.ppm) / 10000} % + ${Number(f.baseMsat) / 1000} sat is above the federation's cap of ${cap.ppm / 10000} % + ${cap.baseMsat / 1000} sat` };
  }
  return { ok: true };
}

export function decodeFederationRecord(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== TYPE_FEDERATION_RECORD) throw new Error('not a federation record');
  if (!speaksVersion(r.u16())) throw new Error('unknown protocol version');
  const out = {
    federationId: r.bytes32(), networkId: r.bytes32(), invite: r.str(), nominal: r.u8(), threshold: r.u8(),
    guardians: r.vec((rr) => ({ peerKey: rr.bytes(33), nodePubkey: rr.bytes32(), operatorId: rr.str(), bondTxid: rr.bytes32(), bondVout: rr.u32(), endpoint: rr.str() })),
    status: r.u8(), successorId: r.bytes32(),
    gone: r.vec((rr) => ({ peerKey: rr.bytes(33), sinceHeight: rr.u32(), kind: rr.u8(), proofRef: rr.bytes32() })),
    exposureCapSats: r.u64(), reserveSats: r.u64(), height: r.u32(),
  };
  if (r.at !== bytes.length) { const band = nameOf(CAPACITY_BAND, r.u8()); if (!band) throw new Error('not a capacity band'); out.capacityBand = band; }
  if (bytes.length - r.at >= 8) out.gatewayFeeMax = { ppm: r.u32(), baseMsat: r.u32() };
  if (bytes.length - r.at >= 8) out.playerReserveSats = r.u64();
  if (bytes.length - r.at === 33) { const k = nameOf(SUCCESSION_REASON, r.u8()); if (!k) throw new Error('not a succession reason'); out.successionReason = { kind: k, ref: r.bytes32() }; }
  if (r.at !== bytes.length) throw new Error('trailing bytes after the federation record');
  encodeFederationRecord(out);                       // held to the encoder's rules
  return out;
}

/** The bytes its guardians sign. */
export const federationRecordId = (r) => taggedHash(TAG.federationRecord, encodeFederationRecord(r));

/**
 * THE BODY A GUARDIAN SEAT BUILDS, from what every seat reads the same: the census nodes guarding the federation (their
 * adverts' guardian_of[]), the guardians gone, the height. `bondsSats` is each guardian's bond, by node key hex.
 */
// `bondLock` { drainBlocks, bondMinGuardian }: from BOND_LOCK_HEIGHT on, the cap counts only bonds locked past the drain (lockedExposureCap);
// each guardian row then carries its `outputs` [{ bondSats, maturity }]
// `predecessor` { reserveSats, closed, nodeKeys: [hex] } - the federation this one succeeds, from its record (kanban #1298/#1321): while it is not CLOSED,
// a bond both name counts once - this cap is (seated - 2f) x the smallest SHARED bond, less its reserve_old
export function buildFederationRecord({ federationId, networkId, invite, nominal, guardians, gone = [], successorId = null, closed = false, reserveSats = 0n, height, bondLock = null, predecessor = null, successionReason = null }) {
  const goneKeys = new Set(gone.map((g) => toHex(g.peerKey)));
  const seatedGuardians = guardians.filter((g) => !goneKeys.has(toHex(g.peerKey)));
  const band = statusFor({ nominal, seated: Math.min(nominal, seatedGuardians.length), closed });
  const cap = !seatedGuardians.length ? { ok: false }
    : bondLock ? lockedExposureCap({ guardians: seatedGuardians, f: band.f, threshold: band.threshold, height, drainBlocks: bondLock.drainBlocks, bondMinGuardian: bondLock.bondMinGuardian })
      : exposureCap({ bonds: seatedGuardians.map((g) => BigInt(g.bondSats)), f: band.f, threshold: band.threshold });
  return {
    federationId, networkId, invite, nominal, threshold: band.threshold,
    guardians: guardians.map(({ peerKey, nodePubkey, operatorId, bondTxid, bondVout, endpoint }) => ({ peerKey, nodePubkey, operatorId, bondTxid, bondVout, endpoint }))
      .sort((a, b) => cmp(a.nodePubkey, b.nodePubkey)),
    // A SUCCESSOR NAMED IS A DRAIN (§23A.6 step 2: "The old federation's guardians sign a record with status = DRAINING and
    // successor_id"): OPEN becomes DRAINING; a worse band (CRITICAL, HALTED) and CLOSED stay what they are
    status: FEDERATION_STATUS[!closed && successorId && successorId.some((x) => x) && band.status === 'OPEN' ? 'DRAINING' : band.status],
    successorId: successorId || new Uint8Array(32), gone: [...gone].sort((a, b) => cmp(a.peerKey, b.peerKey)),
    exposureCapSats: cap.ok ? successorCap({ cap, seatedGuardians, predecessor }) : 0n, reserveSats, height,
    seated: seatedGuardians.length, band,
    // the guardians' reason for a succession they called (kanban #1321): carried for the encoder, which names it after the player reserve
    ...(successionReason ? { successionReason } : {}),
  };
}

/**
 * A SUCCESSOR'S CAP WHILE ITS PREDECESSOR IS NOT CLOSED (§23A.6 RULED 2026-11-07, kanban #1298/#1321): "A bond counts once across the records that
 * name it: ... the successor's exposure_cap is (seated - 2f) x smallest shared bond - reserve_old, both figures from the records." The places
 * are the cap's own (`cap.halts`); the smallest bond among the seated guardians the predecessor also names (by node key); never below 0. No
 * predecessor, a CLOSED one, or no guardian shared: the cap as it is.
 */
export function successorCap({ cap, seatedGuardians, predecessor }) {
  if (!predecessor || predecessor.closed) return cap.cap;
  const theirs = new Set((predecessor.nodeKeys || []).map((k) => String(k).toLowerCase()));
  const shared = seatedGuardians.filter((g) => theirs.has(toHex(g.nodePubkey))).map((g) => BigInt(g.bondSats ?? 0n)).filter((b) => b > 0n);
  if (!shared.length) return cap.cap;
  const smallest = shared.reduce((a, b) => (b < a ? b : a));
  const gross = BigInt(cap.halts ?? cap.places ?? 0) * smallest, old = BigInt(predecessor.reserveSats ?? 0n);
  return gross > old ? gross - old : 0n;
}

/** Signed bytes: the body, then (u8 count) of (node key 32 || signature 64), sorted by key. */
export function joinSignedRecord(bodyBytes, signatures) {
  const sigs = [...signatures].sort((a, b) => cmp(a.nodePubkey, b.nodePubkey));
  const out = new Uint8Array(bodyBytes.length + 1 + sigs.length * 96);
  out.set(bodyBytes, 0); out[bodyBytes.length] = sigs.length;
  sigs.forEach((s, i) => { out.set(s.nodePubkey, bodyBytes.length + 1 + i * 96); out.set(s.signature, bodyBytes.length + 33 + i * 96); });
  return out;
}

export function splitSignedRecord(bytes) {
  // the body's own length: decode tolerates no trailing bytes, so find the split by the count byte at the end of the body
  for (let n = 0; n <= 32; n++) {
    const at = bytes.length - 1 - n * 96;
    if (at < 1 || bytes[at] !== n) continue;
    try {
      const record = decodeFederationRecord(bytes.subarray(0, at));
      const signatures = [];
      for (let i = 0; i < n; i++) signatures.push({ nodePubkey: bytes.slice(at + 1 + i * 96, at + 33 + i * 96), signature: bytes.slice(at + 33 + i * 96, at + 97 + i * 96) });
      return { record, body: bytes.subarray(0, at), signatures };
    } catch { /* not this split */ }
  }
  throw new Error('that is not a signed federation record');
}

/** The federation config's guardian keys (`broadcast_public_keys`) as a hex set, or null when none are given or they do not read. */
export function guardianKeySet(guardianKeys) {
  if (!Array.isArray(guardianKeys) || !guardianKeys.length) return null;
  const out = new Set();
  for (const k of guardianKeys) {
    const h = typeof k === 'string' ? k.toLowerCase() : k instanceof Uint8Array ? toHex(k) : null;
    if (!h || !/^[0-9a-f]{66}$/.test(h)) return null;
    out.add(h);
  }
  return out;
}

/**
 * IS THIS A RECORD A CLIENT MAY BELIEVE? `census` is a census this client checked (entries with `pubkey` and `advert`);
 * a signature counts only from a census node whose advertisement names this federation with the guardian key the record
 * lists for that node. `inviteFederationId(invite)` reads the invite's federation id (the caller's parser). `bandPoint`: the height records
 * name their band from, by default the one of the network the record names. `guardianKeys`
 * (optional): the federation's own config keys (`broadcast_public_keys`), when the caller holds that config. Answers
 * { ok, record, status, signers, keyed } or { ok: false, why }.
 *
 * THE THRESHOLD (kanban #2599, #2603):
 *   with guardianKeys   thresholdOf(max(nominal, guardianKeys.length)); a record that lists a peer key not in the config is refused, and
 *                       only signers whose listed key is a config key count, one key per node and one node per key. A guardian that
 *                       lists only itself (#2599: nominal 1) still needs the threshold of the whole config.
 *   without             thresholdOf(nominal), the record's own. A census advert's guardianOf is the node's own word, never checked
 *                       against the federation: #2599's max(nominal, census guardians) let four bonded strangers naming the
 *                       federation lift a genuine HALTED record's 5 of 7 to 8 (#2603, feedback #037) - refused, and the client read
 *                       the federation as allow-everything. Without the config an omitted real guardian and a stranger's advert look
 *                       the same, so no census count can stand in for it; the caller that holds the config passes it.
 */
export function verifyFederationRecord(bytes, { census, verify, inviteFederationId, networkId = null, bandPoint = undefined, guardianKeys = null }) {
  let s; try { s = splitSignedRecord(bytes); } catch (e) { return { ok: false, why: e.message }; }
  const r = s.record;
  if (networkId && toHex(networkId) !== toHex(r.networkId)) return { ok: false, why: 'that record is of another network' };
  const point = bandPoint === undefined ? capacityBandPoint(networkOf(r.networkId)) : bandPoint;
  const due = Number.isInteger(point) && r.height >= point;
  if (due && !r.capacityBand) return { ok: false, why: `a record at ${r.height} must name its capacity band: CAPACITY_BAND_HEIGHT is ${point}` };
  if (!due && r.capacityBand) return { ok: false, why: `a record at ${r.height} must not name a capacity band: CAPACITY_BAND_HEIGHT is ${point === null ? 'not named' : point}` };
  let named; try { named = inviteFederationId(r.invite); } catch (e) { return { ok: false, why: `its invite does not read: ${e.message}` }; }
  if (!named || toHex(named) !== toHex(r.federationId)) return { ok: false, why: 'its invite names another federation than the record' };
  const fid = toHex(r.federationId);
  const wanted = guardianKeys === null || guardianKeys === undefined ? null : guardianKeySet(guardianKeys);
  if ((guardianKeys !== null && guardianKeys !== undefined) && !wanted) return { ok: false, why: 'the federation config names no 33-byte guardian keys' };
  if (wanted) {
    const stranger = r.guardians.find((g) => !wanted.has(toHex(g.peerKey)));
    if (stranger) return { ok: false, why: `it lists guardian key ${toHex(stranger.peerKey).slice(0, 16)}, which the federation's config does not name` };
  }
  // node -> the guardian keys its census advert names for this federation (a node may name more than one; the record picks)
  const claims = new Map();
  for (const e of census || []) {
    if (!e || !e.pubkey) continue;
    for (const g of (e.advert && e.advert.guardianOf) || []) {
      if (toHex(g.federationId) !== fid) continue;
      const k = toHex(e.pubkey);
      if (!claims.has(k)) claims.set(k, new Set());
      claims.get(k).add(toHex(g.guardianKey));
    }
  }
  const listed = new Map(r.guardians.map((g) => [toHex(g.nodePubkey), toHex(g.peerKey)]));
  const id = federationRecordId(r);
  const signers = new Set(), keysSigned = new Set();
  for (const sig of s.signatures) {
    const k = toHex(sig.nodePubkey), key = listed.get(k);
    if (!key || !claims.has(k) || !claims.get(k).has(key)) continue;               // not a bonded guardian of this federation
    if (wanted && !wanted.has(key)) continue;                                       // not one of the config's guardians
    if (signers.has(k) || keysSigned.has(key)) continue;                            // one node per key, one key per node
    let good = false; try { good = verify(sig.signature, id, sig.nodePubkey) === true; } catch { good = false; }
    if (good) { signers.add(k); keysSigned.add(key); }
  }
  const need = wanted ? thresholdOf(Math.max(r.nominal, wanted.size)) : thresholdOf(r.nominal);
  if (signers.size < need)
    return { ok: false, why: `${signers.size} of its bonded guardians signed it, and a record needs ${need}${need > r.threshold ? ` (the federation's config names ${wanted.size} guardians, the record ${r.nominal})` : ''}` };
  return { ok: true, record: r, status: nameOf(FEDERATION_STATUS, r.status), signers: signers.size, id, keyed: !!wanted };
}

/**
 * Of a federation's verified records [{ record, status }], the one to read: the highest height. Two can stand at one height, since a record's
 * reserve is read when it is gathered: a CLOSED one first, then the lowest record id (§23A.3a), so seats that hold both pick the same.
 */
export function highestVerified(rows) {
  const idOf = (r) => toHex(federationRecordId(r));
  let best = null;
  for (const x of rows) {
    if (!best || x.record.height > best.record.height) { best = x; continue; }
    if (x.record.height !== best.record.height) continue;
    const closed = (y) => y.status === 'CLOSED';
    if (closed(x) !== closed(best)) { if (closed(x)) best = x; continue; }
    if (idOf(x.record) < idOf(best.record)) best = x;
  }
  return best;
}

/** Of several verified records of one federation, the newest by height (§23A.4: "newest height with valid signatures wins"). */
export const newestRecord = (verified) => verified.filter((v) => v && v.ok).sort((a, b) => b.record.height - a.record.height)[0] || null;
