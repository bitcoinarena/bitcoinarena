// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE CENSUS KEY, AS PLAIN RULES (spec 5A.3B, RULED 2026-11-02, kanban #1021): who holds how many shares, which record makes a key stand,
// which keys stand, and what each epoch has to do about them. No curve and no round of a DKG here: a signature check is injected, as
// everywhere in this package, and making the key is the seats' work.
import { Writer, Reader } from './encode.js';
import { taggedHash, toHex, fromHex } from './hash.js';
import { TAG } from './constants.js';
import { BOND_TEMPLATE_V3, BOND_MATURITY_OFFSET } from './bond-script.js';

/** epoch(h) = floor(h / E), E being BOND_MATURITY_OFFSET for the network (kanban #1031). */
export function censusKeyEpochOf(height, network) {
  const length = BOND_MATURITY_OFFSET[network];
  if (!Number.isInteger(length)) throw new Error(`no epoch length is set for ${network}`);
  return Math.floor(height / length);
}

/** The census height of epoch e: e x E - census_confirmations. Null before that is a positive height: the network's first key applies. */
export function censusHeightOfEpoch(epoch, network, censusConfirmations) {
  const length = BOND_MATURITY_OFFSET[network];
  if (!Number.isInteger(length)) throw new Error(`no epoch length is set for ${network}`);
  const height = epoch * length - censusConfirmations;
  return height > 0 ? height : null;
}

/**
 * ONE NUMBER PER EPOCH: unit = max(B, ceil(T / S)), shares(node) = floor(sum of its bonds / unit), threshold = floor(2 x total / 3) + 1.
 * `entries` are the census at the epoch's height, { pubkey, bondSats }; `lowestBondMinSats` is B, the lowest bracket's bond_min in force
 * there; `sharesMax` is S. A node under one unit holds no share: a minimum of one would let many small bonds out-count capital.
 * The census is 5A.4's, before any role filter: a key belongs to the network and not to a role (kanban #1031). B is a network number, never a round's.
 * Holders are numbered in ascending key order, so everyone hands out the same x. Answers { unit, totalSats, total, threshold, holders }.
 */
export function censusKeyShares({ entries, lowestBondMinSats, sharesMax }) {
  if (typeof lowestBondMinSats !== 'bigint' || lowestBondMinSats <= 0n) throw new Error('the unit reads a positive bond_min in sats');
  if (!Number.isInteger(sharesMax) || sharesMax < 1) throw new Error('the unit reads census_key_shares_max');
  const bonded = new Map();
  let totalSats = 0n;
  for (const e of entries || []) {
    const k = toHex(e.pubkey);
    bonded.set(k, (bonded.get(k) || 0n) + e.bondSats);
    totalSats += e.bondSats;
  }
  const S = BigInt(sharesMax);
  const fair = (totalSats + S - 1n) / S;
  const unit = fair > lowestBondMinSats ? fair : lowestBondMinSats;
  const holders = [];
  let total = 0;
  for (const key of [...bonded.keys()].sort()) {
    const shares = Number(bonded.get(key) / unit);
    if (!shares) continue;
    holders.push({ key, shares, ids: Array.from({ length: shares }, (_, i) => total + i + 1) });
    total += shares;
  }
  return { unit, totalSats, total, threshold: Math.floor((2 * total) / 3) + 1, holders };
}

/** CensusKeyRecord (5A.3B): what a key is, in the bytes its holders sign and its anchor hashes. */
export function encodeCensusKeyRecord(r) {
  const w = new Writer();
  w.bytes32(r.networkId);
  w.u32(r.epoch);
  w.bytes32(r.publicKey);
  w.u32(r.censusHeight);
  w.u32(r.totalShares);
  w.u32(r.threshold);
  w.bytes32(r.transcriptHash);
  return w.finish();
}

export function decodeCensusKeyRecord(bytes) {
  const r = new Reader(bytes);
  const out = { networkId: r.bytes32(), epoch: r.u32(), publicKey: r.bytes32(), censusHeight: r.u32(), totalShares: r.u32(), threshold: r.u32(), transcriptHash: r.bytes32() };
  r.end();
  return out;
}

/** H(record), the hash the anchor carries and the holders sign. */
export const censusKeyRecordId = (r) => taggedHash(TAG.censusKeyRecord, encodeCensusKeyRecord(r));

const ANCHOR_MAGIC = [0x41, 0x52, 0x4e, 0x4b];         // "ARN" 'K'

/** The anchor: OP_RETURN "ARN" 'K' H(record). */
export function censusKeyAnchor(record) {
  return { value: 0n, script: Uint8Array.from([0x6a, 36, ...ANCHOR_MAGIC, ...censusKeyRecordId(record)]) };
}

/** And the reading of one: the record's id, or null. */
export function censusKeyAnchorIn(outputs) {
  for (const o of outputs || []) {
    const s = o.script;
    if (s && s.length === 38 && s[0] === 0x6a && s[1] === 36 && ANCHOR_MAGIC.every((b, i) => s[2 + i] === b)) return s.slice(6);
  }
  return null;
}

/**
 * DOES THIS RECORD STAND? It is this network's, its counts are the census' own (`shares`, censusKeyShares at the record's height), and
 * distinct nodes holding the threshold of its shares signed its id. `signatures` [{ key, signature }]; `verify(signature, digest, key)`.
 */
export function censusKeyRecordStands({ record, signatures, networkId, shares, verify }) {
  if (typeof verify !== 'function') return { ok: false, why: 'checking a record needs a verifier, and none was injected' };
  if (toHex(record.networkId) !== toHex(networkId)) return { ok: false, why: 'that record is for another network' };
  if (!shares || record.totalShares !== shares.total || record.threshold !== shares.threshold)
    return { ok: false, why: `that record says ${record.totalShares} shares, threshold ${record.threshold}, and the census at its height gives ${shares ? shares.total : '?'}, ${shares ? shares.threshold : '?'}` };
  const held = new Map((shares.holders || []).map((h) => [h.key, h.shares]));
  const digest = censusKeyRecordId(record);
  const seen = new Set();
  let have = 0;
  for (const s of signatures || []) {
    const k = toHex(s.key);
    if (seen.has(k) || !held.has(k)) continue;
    let good = false;
    try { good = verify(s.signature, digest, s.key) === true; } catch { good = false; }
    if (good) { seen.add(k); have += held.get(k); }
  }
  if (have < record.threshold) return { ok: false, why: `nodes holding ${have} shares signed that record, and its threshold is ${record.threshold}` };
  return { ok: true, have };
}

/**
 * THE KEYS THAT STAND: the first valid record per epoch, in chain order. `anchors` [{ height, index, id }]; `judge(id)` answers
 * { ok, record } for a record this reader holds and has checked. `genesisKey` is mainnet's key 0, committed in network_id, needing no
 * anchor. Answers [{ epoch, publicKey, height }], oldest first.
 */
export function standingCensusKeys({ genesisKey = null, anchors = [], judge }) {
  const out = genesisKey ? [{ epoch: 0, publicKey: genesisKey, height: 0 }] : [];
  const taken = new Set(out.map((k) => k.epoch));
  for (const a of [...anchors].sort((x, y) => x.height - y.height || x.index - y.index)) {
    const said = judge(a.id);
    if (!said || !said.ok || taken.has(said.record.epoch)) continue;
    taken.add(said.record.epoch);
    out.push({ epoch: said.record.epoch, publicKey: said.record.publicKey, height: a.height });
  }
  return out;
}

/**
 * THE CENSUS' RULE FOR A TEMPLATE-3 BOND: it names a key that was newest at some height of [confirmation - census_confirmations, confirmation]
 * (kanban #1031). A record anchored in the bond's own block stands for it, and a bond does not fail for a race with an anchor. An older
 * key is not enough: a node free to name one could pick a dead key and be unslashable. Other templates answer ok.
 */
export function bondNamesStandingKey(advert, confirmationHeight, standing, censusConfirmations = 0) {
  if (!advert || advert.bondScriptTemplateVersion !== BOND_TEMPLATE_V3) return { ok: true };
  const known = (standing || []).filter((k) => k.height <= confirmationHeight);
  if (!known.length) return { ok: false, why: 'no census key stands at that bond\'s confirmation, so this network cannot take a template-3 bond yet' };
  const from = confirmationHeight - censusConfirmations;
  const atStart = known.filter((k) => k.height <= from);
  const window = [...atStart.slice(-1), ...known.filter((k) => k.height > from)];
  const named = window.find((k) => toHex(k.publicKey) === toHex(advert.censusKey));
  if (!named) {
    const newest = known[known.length - 1];
    return { ok: false, why: `that bond names census key ${toHex(advert.censusKey).slice(0, 16)}, and the newest standing at its confirmation is ${toHex(newest.publicKey).slice(0, 16)}` };
  }
  return { ok: true, epoch: named.epoch };
}

/** What a holder signs to name its peg-in address, for the carrying of a fallback: `carrier_peg_in(network, script)`. */
export const carrierPegInId = (networkId, script) => taggedHash(TAG.carrierPegIn, Uint8Array.from([...networkId, ...script]));

/**
 * WHO CARRIES THE PLAYERS' SHARE ON A FALLBACK, AND WHERE THERE ARE NO PANELS (kanban #1031): a fallback means the panels did not sign, so panel A
 * cannot be trusted with it. The census key's holders in descending shares, less `excluded` (hex: the accused, the proof's other slashed
 * nodes, the round's seats), each with a peg-in address signed by its node key. A holder with none is passed over.
 *
 *   holders   censusKeyShares' list; `bonds` Map hex -> sats; `pegIns` Map hex -> { script, signature }
 *
 * Answers [{ key, script, bondSats }], the `carriers` of buildSlashPayoutTable.
 */
export function fallbackCarriers({ holders, bonds, excluded = [], pegIns, networkId, verify }) {
  const out = new Set(excluded);
  return [...holders].sort((a, b) => b.shares - a.shares || (a.key < b.key ? -1 : 1)).flatMap((h) => {
    const peg = pegIns.get(h.key);
    if (out.has(h.key) || !peg) return [];
    let good = false;
    try { good = verify(peg.signature, carrierPegInId(networkId, peg.script), fromHex(h.key)) === true; } catch { good = false; }
    return good ? [{ key: h.key, script: peg.script, bondSats: bonds.get(h.key) || 0n }] : [];
  });
}

const RESHARE_BELOW_PERCENT = 80;

/**
 * WHAT AN EPOCH HAS TO DO ABOUT ITS KEYS. `keys`, oldest first: { epoch, totalShares, threshold, heldNow, named }, with `heldNow` the
 * shares held by nodes of the current census and `named` the unspent bonds and hold outputs naming the key.
 *
 *   retired  named by nothing: nothing is done for it again
 *   dead     held under its threshold: its bonds stay valid, cannot be started, and path A still works
 *   reshare  the oldest live key held under 80 %, at most one
 *   newKey   at an epoch's start, only if the newest key has been named by a bond
 */
export function censusKeyPlan({ keys = [], epochStart = false }) {
  const retired = [], dead = [], live = [];
  for (const k of keys) {
    if (!k.named) retired.push(k);
    else if (k.heldNow < k.threshold) dead.push(k);
    else live.push(k);
  }
  const reshare = live.find((k) => k.heldNow * 100 < k.totalShares * RESHARE_BELOW_PERCENT) || null;
  const newest = keys[keys.length - 1];
  return { retired, dead, reshare, newKey: !!epochStart && (!newest || newest.named > 0) };
}
