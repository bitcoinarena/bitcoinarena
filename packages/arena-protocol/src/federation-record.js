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
import { TAG, TYPE_FEDERATION_RECORD, PROTOCOL_VERSION, speaksVersion } from './constants.js';
import { exposureCap } from './federation-slash.js';

export const FEDERATION_STATUS = Object.freeze({ OPEN: 1, DRAINING: 2, CRITICAL: 3, CLOSED: 4, HALTED: 5 });
export const GONE = Object.freeze({ DEPARTED: 1, ABANDONED: 2 });
const nameOf = (table, v) => Object.keys(table).find((k) => table[k] === v);
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
  return w.finish();
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
export function buildFederationRecord({ federationId, networkId, invite, nominal, guardians, gone = [], successorId = null, closed = false, reserveSats = 0n, height }) {
  const goneKeys = new Set(gone.map((g) => toHex(g.peerKey)));
  const seatedGuardians = guardians.filter((g) => !goneKeys.has(toHex(g.peerKey)));
  const band = statusFor({ nominal, seated: Math.min(nominal, seatedGuardians.length), closed });
  const cap = seatedGuardians.length ? exposureCap({ bonds: seatedGuardians.map((g) => BigInt(g.bondSats)), f: band.f }) : { ok: false };
  return {
    federationId, networkId, invite, nominal, threshold: band.threshold,
    guardians: guardians.map(({ peerKey, nodePubkey, operatorId, bondTxid, bondVout, endpoint }) => ({ peerKey, nodePubkey, operatorId, bondTxid, bondVout, endpoint }))
      .sort((a, b) => cmp(a.nodePubkey, b.nodePubkey)),
    // A SUCCESSOR NAMED IS A DRAIN (§23A.6 step 2: "The old federation's guardians sign a record with status = DRAINING and
    // successor_id"): OPEN becomes DRAINING; a worse band (CRITICAL, HALTED) and CLOSED stay what they are
    status: FEDERATION_STATUS[!closed && successorId && successorId.some((x) => x) && band.status === 'OPEN' ? 'DRAINING' : band.status],
    successorId: successorId || new Uint8Array(32), gone: [...gone].sort((a, b) => cmp(a.peerKey, b.peerKey)),
    exposureCapSats: cap.ok ? cap.cap : 0n, reserveSats, height,
    seated: seatedGuardians.length, band,
  };
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
 * lists for that node. `inviteFederationId(invite)` reads the invite's federation id (the caller's parser). `guardianKeys`
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
export function verifyFederationRecord(bytes, { census, verify, inviteFederationId, networkId = null, guardianKeys = null }) {
  let s; try { s = splitSignedRecord(bytes); } catch (e) { return { ok: false, why: e.message }; }
  const r = s.record;
  if (networkId && toHex(networkId) !== toHex(r.networkId)) return { ok: false, why: 'that record is of another network' };
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

/** How restrictive a status is, for the no-config guard (kanban #2604): a move to a lower rank is a move toward allowing more. */
export const RESTRICTION_RANK = Object.freeze({ OPEN: 0, DRAINING: 1, CRITICAL: 2, CLOSED: 3, HALTED: 4 });

/**
 * THE RECORDS OF ONE FEDERATION, JUDGED TOGETHER (kanban #2604, feedback #038). verifyFederationRecord without the config holds a record to its
 * own nominal - and one bonded node whose advert names the federation under a made-up key signed { guardians: [itself], nominal 1, OPEN,
 * height genuine + 1 }: it verified alone, was the newest, and a client read the federation OPEN over a genuine 7 of 7 HALTED or CLOSED record.
 * So without the config no record is judged alone. `items`: the records the caller sees of the federation together - bytes, or
 * { bytes, census, context } (`census` this item's own; `context: true` a record the caller already holds, which counts toward N and the
 * guard but whose verdict the caller ignores). Answers one verdict per item, as verifyFederationRecord's.
 *
 *   TIP (rule 3)        a record whose height is above `tip` (when known) is refused: a made-up far height would be "newest" for good.
 *   WITH guardianKeys   each record as verifyFederationRecord with the keys (the config decides who is a guardian); the tip bound too.
 *   WITHOUT (rules 1-2)
 *     self-consistent   thresholdOf(its nominal) of the guardians it lists signed it, each a census node naming the key listed for it.
 *                       (Not every listed guardian need be in the census: only census signers count anyway, so a listed stranger adds
 *                       nothing an attacker could use, and a genuine record whose one guardian's bond lapsed still sets N.)
 *     N                 the largest nominal of a self-consistent record seen (at least 1)
 *     stands            thresholdOf(max(N, its nominal)) valid signers - so a record listing fewer guardians than the federation's largest
 *                       self-consistent record needs that record's threshold; to lift N a sybil set must sign thresholdOf(N) itself
 *     guard             a record that stands and is less restrictive (RESTRICTION_RANK) than a self-consistent record Q at or below its
 *                       height, Q listing at least thresholdOf(N) guardians, also needs valid signatures of thresholdOf(Q.nominal) of
 *                       Q's own guardians: a federation is reopened by the guardians that halted (closed, drained) it, nobody else. A
 *                       sybil's small restrictive record (nominal < thresholdOf(N)) does not hold the genuine one back.
 */
export function verifyFederationRecords(items, { census = null, verify, inviteFederationId, networkId = null, guardianKeys = null, tip = null }) {
  const tipOk = Number.isInteger(tip) && tip >= 0;
  const rows = (items || []).map((it) => {
    const bytes = it instanceof Uint8Array ? it : it && it.bytes;
    const c = it instanceof Uint8Array ? census : (it && it.census) || census;
    let s; try { s = splitSignedRecord(bytes); } catch (e) { return { v: { ok: false, why: e.message } }; }
    const r = s.record;
    if (tipOk && r.height > tip) return { v: { ok: false, why: `its height ${r.height} is above the chain tip ${tip}` } };
    if (guardianKeys !== null && guardianKeys !== undefined) return { v: verifyFederationRecord(bytes, { census: c, verify, inviteFederationId, networkId, guardianKeys }) };
    if (networkId && toHex(networkId) !== toHex(r.networkId)) return { v: { ok: false, why: 'that record is of another network' } };
    let named; try { named = inviteFederationId(r.invite); } catch (e) { return { v: { ok: false, why: `its invite does not read: ${e.message}` } }; }
    if (!named || toHex(named) !== toHex(r.federationId)) return { v: { ok: false, why: 'its invite names another federation than the record' } };
    const fid = toHex(r.federationId);
    const claims = new Map();
    for (const e of c || []) {
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
      if (!key || !claims.has(k) || !claims.get(k).has(key) || signers.has(k) || keysSigned.has(key)) continue;
      let good = false; try { good = verify(sig.signature, id, sig.nodePubkey) === true; } catch { good = false; }
      if (good) { signers.add(k); keysSigned.add(key); }
    }
    return { r, id, fid, listed, signers, selfOk: signers.size >= thresholdOf(r.nominal) };
  });
  if (guardianKeys !== null && guardianKeys !== undefined) return rows.map((x) => x.v);
  // one federation per call; rows of another federation than the first readable one are refused
  const first = rows.find((x) => x.r);
  const fid = first ? first.fid : null;
  let N = 1;
  for (const x of rows) if (x.r && x.fid === fid && x.selfOk) N = Math.max(N, x.r.nominal);
  const restrictive = rows.filter((x) => x.r && x.fid === fid && x.selfOk && RESTRICTION_RANK[nameOf(FEDERATION_STATUS, x.r.status)] > 0 && x.r.nominal >= thresholdOf(N));
  return rows.map((x) => {
    if (x.v) return x.v;
    if (x.fid !== fid) return { ok: false, why: 'one federation\'s records are judged together, and this is another federation' };
    const status = nameOf(FEDERATION_STATUS, x.r.status);
    const need = thresholdOf(Math.max(N, x.r.nominal));
    // A REFUSED RECORD SIGNED BY ITS OWN THRESHOLD SAYS SO (kanban #2614): `self` carries it, so a keyless seat that picks another record in
    // the same pass can hold the restrictive one (selfConsistentRestrictive); a record below its own threshold carries nothing
    const self = x.selfOk ? { self: { record: x.r, status, signers: x.signers.size, id: x.id, n: N, keyed: false } } : {};
    if (x.signers.size < need)
      return { ok: false, ...self, why: `${x.signers.size} of its bonded guardians signed it, and a record needs ${need}${N > x.r.nominal ? ` (another record of this federation, signed by its own threshold, lists ${N} guardians; this one ${x.r.nominal})` : ''}` };
    for (const q of restrictive) {
      if (q === x || q.r.height > x.r.height || RESTRICTION_RANK[status] >= RESTRICTION_RANK[nameOf(FEDERATION_STATUS, q.r.status)]) continue;
      const by = [...x.signers].filter((k) => q.listed.has(k)).length;
      if (by < thresholdOf(q.r.nominal))
        return { ok: false, ...self, why: `it says ${status} over the ${nameOf(FEDERATION_STATUS, q.r.status)} record at ${q.r.height}, and only ${by} of that record's ${q.r.nominal} guardians signed it (it needs ${thresholdOf(q.r.nominal)})` };
    }
    return { ok: true, record: x.r, status, signers: x.signers.size, id: x.id, keyed: false, n: N };
  });
}

/**
 * THE RESTRICTIVE RECORD A KEYLESS PICK MUST NOT DROP (kanban #2614, feedback #043): of `verdicts` (verifyFederationRecords' answers for one
 * federation, without keys), the refused records signed by their own threshold (`self`) that are more restrictive (RESTRICTION_RANK) than
 * `chosen` (the verdict picked) and signed by more than faultsOf(max(N, chosen's nominal)) census guardians - at least f + 1 of the larger
 * guardian set. Without the floor one bonded node's own HALTED record (nominal 1, signed by itself) would halt the federation at every keyless
 * seat; with it a stranger set needs f + 1 signers of its own. The most restrictive, then the newest; null when none. Answers { index, v } with
 * `v` shaped as a verdict that stands ({ ok: true, record, status, signers, id, keyed: false }).
 */
export function selfConsistentRestrictive(verdicts, chosen) {
  if (!chosen || !chosen.ok || chosen.keyed !== false) return null;
  const rank = (st) => RESTRICTION_RANK[st] ?? 0;
  let out = null;
  (verdicts || []).forEach((v, index) => {
    const s = v && !v.ok && v.self;
    if (!s || rank(s.status) <= rank(chosen.status)) return;
    if (s.signers <= faultsOf(Math.max(s.n || 1, chosen.record.nominal))) return;
    if (!out || rank(s.status) > rank(out.v.status) || (rank(s.status) === rank(out.v.status) && s.record.height > out.v.record.height))
      out = { index, v: { ok: true, record: s.record, status: s.status, signers: s.signers, id: s.id, keyed: false } };
  });
  return out;
}

/** Of several verified records of one federation, the newest by height (§23A.4: "newest height with valid signatures wins"). */
export const newestRecord = (verified) => verified.filter((v) => v && v.ok).sort((a, b) => b.record.height - a.record.height)[0] || null;
