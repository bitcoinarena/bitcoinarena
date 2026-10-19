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

/**
 * IS THIS A RECORD A CLIENT MAY BELIEVE? `census` is a census this client checked (entries with `pubkey` and `advert`);
 * a signature counts only from a census node whose advertisement names this federation with the guardian key the record
 * lists for that node. `inviteFederationId(invite)` reads the invite's federation id (the caller's parser). Answers
 * { ok, record, status, signers } or { ok: false, why }.
 */
export function verifyFederationRecord(bytes, { census, verify, inviteFederationId, networkId = null }) {
  let s; try { s = splitSignedRecord(bytes); } catch (e) { return { ok: false, why: e.message }; }
  const r = s.record;
  if (networkId && toHex(networkId) !== toHex(r.networkId)) return { ok: false, why: 'that record is of another network' };
  let named; try { named = inviteFederationId(r.invite); } catch (e) { return { ok: false, why: `its invite does not read: ${e.message}` }; }
  if (!named || toHex(named) !== toHex(r.federationId)) return { ok: false, why: 'its invite names another federation than the record' };
  const fid = toHex(r.federationId);
  const guarding = new Map();
  for (const e of census || []) {
    for (const g of (e.advert && e.advert.guardianOf) || []) if (toHex(g.federationId) === fid) guarding.set(toHex(e.pubkey), toHex(g.guardianKey));
  }
  const listed = new Map(r.guardians.map((g) => [toHex(g.nodePubkey), toHex(g.peerKey)]));
  const id = federationRecordId(r);
  const signers = new Set();
  for (const sig of s.signatures) {
    const k = toHex(sig.nodePubkey);
    if (!guarding.has(k) || listed.get(k) !== guarding.get(k)) continue;           // not a bonded guardian of this federation
    let good = false; try { good = verify(sig.signature, id, sig.nodePubkey) === true; } catch { good = false; }
    if (good) signers.add(k);
  }
  if (signers.size < r.threshold)
    return { ok: false, why: `${signers.size} of its bonded guardians signed it, and a record needs ${r.threshold}` };
  return { ok: true, record: r, status: nameOf(FEDERATION_STATUS, r.status), signers: signers.size, id };
}

/** Of several verified records of one federation, the newest by height (§23A.4: "newest height with valid signatures wins"). */
export const newestRecord = (verified) => verified.filter((v) => v && v.ok).sort((a, b) => b.record.height - a.record.height)[0] || null;
