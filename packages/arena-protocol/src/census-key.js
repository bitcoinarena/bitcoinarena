// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE CENSUS KEY, AS PLAIN RULES (spec 5A.3B, RULED 2026-11-02, kanban #1021): who holds how many shares, which record makes a key stand,
// which keys stand, and what each epoch has to do about them. No curve and no round of a DKG here: a signature check is injected, as
// everywhere in this package, and making the key is the seats' work.
import { Writer, Reader } from './encode.js';
import { taggedHash, toHex, fromHex, bytesToBigInt, sha256 } from './hash.js';
import { TAG, CENSUS_KEY_VERSION } from './constants.js';
import { BOND_TEMPLATE_V3, BOND_MATURITY_OFFSET } from './bond-script.js';
import { CENSUS_KEY_SHARES_MAX, censusKeyBondMin } from './genesis.js';

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

/** The height whose block hash a drawn key reads: e x E, the epoch's first, after the census cut, so nobody can bond into a known draw. */
export function censusKeyDrawHeight(epoch, network) {
  const length = BOND_MATURITY_OFFSET[network];
  if (!Number.isInteger(length)) throw new Error(`no epoch length is set for ${network}`);
  return epoch * length;
}

/**
 * WHEN A KEY'S RUN HAPPENS (kanban #1034 answer 5): founding_window from the epoch's first height, the deals in its first half and the holders' signatures
 * on the transcript hash in its second. A node's deal set is every valid deal it holds at the midpoint. Nothing converges by force: nodes that differ
 * sign different hashes, no hash reaches the threshold, the key fails and the newest stands.
 */
export function censusKeyWindow(epoch, network, foundingWindow) {
  if (!Number.isInteger(foundingWindow) || foundingWindow < 2) throw new Error('a census key\'s window reads founding_window, at least 2 blocks');
  const start = censusKeyDrawHeight(epoch, network);
  return { start, midpoint: start + Math.floor(foundingWindow / 2), end: start + foundingWindow };
}

const outpointOf = (e) => {
  const txid = typeof e.txid === 'string' ? e.txid.toLowerCase() : e.txid instanceof Uint8Array ? toHex(e.txid) : null;
  return txid === null || !Number.isInteger(e.vout) ? null : { txid, vout: e.vout };
};
const outpointBefore = (a, b) => a.txid < b.txid || (a.txid === b.txid && a.vout < b.vout);
const shareIndexBytes = (i) => Uint8Array.of(i >>> 24, (i >>> 16) & 255, (i >>> 8) & 255, i & 255);

/**
 * ONE RULE PER EPOCH (kanban #1034, replacing `unit`). `entries` are the census at the epoch's height, { pubkey, bondSats, txid, vout }, a node's bonds one sum.
 * The census is 5A.4's, before any role filter: a key belongs to the network and not to a role (kanban #1031).
 *
 *   exact  when the sum of floor(bond / B) over the census is at most S: shares(node) = floor(bond / B), numbered in ascending key order
 *   drawn  otherwise S shares, one at a time: x_i = tagged_hash("ARENA/v1/CensusKeyShare", h || i) mod T, share i at x = i + 1 to the node whose stretch
 *          of T holds x_i, nodes in ascending lowest outpoint, each stretch its summed bond. i is four bytes, big-endian
 *
 * `blockHash` is h, the block at censusKeyDrawHeight, in the bytes bitcoind prints; an exact key does not read it. B is the network's (censusKeyBondMin) and no
 * caller's; S is genesis' census_key_shares_max. No floor, so a drawn key is linear in sats: a small node holds a share less often, and a node may
 * draw several or none. Holders stand in ascending key order. Answers { drawn, totalSats, total, threshold, holders: [{ key, shares, ids }] },
 * the threshold floor(2 x total / 3) + 1.
 */
export function censusKeyShares({ entries, network, genesis = null, blockHash = null, sharesMax = CENSUS_KEY_SHARES_MAX }) {
  const B = censusKeyBondMin(network, genesis);
  if (!Number.isInteger(sharesMax) || sharesMax < 1) throw new Error('the shares read census_key_shares_max');
  const bonded = new Map();
  let totalSats = 0n;
  for (const e of entries || []) {
    const key = toHex(e.pubkey);
    const held = bonded.get(key) || { key, sats: 0n, lowest: null };
    const at = outpointOf(e);
    if (at && (!held.lowest || outpointBefore(at, held.lowest))) held.lowest = at;
    held.sats += e.bondSats;
    bonded.set(key, held);
    totalSats += e.bondSats;
  }
  const byKey = [...bonded.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
  const whole = byKey.reduce((n, h) => n + h.sats / B, 0n);
  const drawn = whole > BigInt(sharesMax);
  const idsOf = new Map(byKey.map((h) => [h.key, []]));
  if (drawn) {
    if (!(blockHash instanceof Uint8Array) || blockHash.length !== 32) throw new Error('a drawn key reads the block hash at the epoch\'s first height');
    if (byKey.some((h) => !h.lowest)) throw new Error('a drawn key orders its nodes by lowest outpoint, and an entry names none');
    const order = [...byKey].sort((a, b) => (outpointBefore(a.lowest, b.lowest) ? -1 : 1));
    let end = 0n;
    const ends = order.map((h) => (end += h.sats));
    for (let i = 0; i < sharesMax; i++) {
      const hit = bytesToBigInt(taggedHash(TAG.censusKeyShare, Uint8Array.from([...blockHash, ...shareIndexBytes(i)]))) % totalSats;
      let lo = 0, hi = ends.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (hit < ends[mid]) hi = mid; else lo = mid + 1; }
      idsOf.get(order[lo].key).push(i + 1);
    }
  } else {
    let x = 0;
    for (const h of byKey) for (let n = h.sats / B; n > 0n; n--) idsOf.get(h.key).push(++x);
  }
  const holders = byKey.filter((h) => idsOf.get(h.key).length).map((h) => ({ key: h.key, shares: idsOf.get(h.key).length, ids: idsOf.get(h.key) }));
  const total = holders.reduce((n, h) => n + h.shares, 0);
  return { drawn, totalSats, total, threshold: Math.floor((2 * total) / 3) + 1, holders };
}

/**
 * THE HOLDERS OF CENSUS KEY 0 AS censusKeyShares ANSWERS ANY KEY'S (kanban #1050): one share each, x = the place in genesis' list plus 1, in ascending key as every holder list stands.
 * From here the key has no other rule.
 */
export function censusKey0Shares(k0) {
  const holders = k0.holders.map((h, i) => ({ key: toHex(h), shares: 1, ids: [i + 1] })).sort((a, b) => (a.key < b.key ? -1 : 1));
  return { drawn: false, total: holders.length, threshold: k0.threshold, holders };
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
const RESHARE_MAGIC = [0x41, 0x52, 0x4e, 0x52];        // "ARN" 'R'
const censusKeyJoin = (parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out; };
const censusKeyU32 = (n) => Uint8Array.of(n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);

/** The anchor: OP_RETURN "ARN" 'K' H(record). */
export function censusKeyAnchor(record) {
  return { value: 0n, script: Uint8Array.from([0x6a, 36, ...ANCHOR_MAGIC, ...censusKeyRecordId(record)]) };
}

const hashPushIn = (outputs, magic) => {
  for (const o of outputs || []) {
    const s = o.script;
    if (s && s.length === 38 && s[0] === 0x6a && s[1] === 36 && magic.every((b, i) => s[2 + i] === b)) return s.slice(6);
  }
  return null;
};

/** And the reading of one: the record's id, or null. */
export const censusKeyAnchorIn = (outputs) => hashPushIn(outputs, ANCHOR_MAGIC);

/**
 * WHO IS PRESENT AT A RESHARE (kanban #1048 answer 1): the chain says, so every node has one set. Old holders sign ReshareReady { key, run } in the first quarter of founding_window, and
 * the first holder in duty order with signatures covering the old threshold anchors them, the list in its leaf, OP_RETURN "ARN" 'R' H(list). The first valid anchor of a run IS
 * `present`. A key's run is the epoch whose window it runs in, so a run that fails is followed by the next epoch's.
 */
export const reshareReadyId = ({ networkId, key, run }) => taggedHash(TAG.reshareReady, censusKeyJoin([networkId, key, censusKeyU32(run)]));

export function encodeReshareList({ networkId, key, run, signatures }) {
  const w = new Writer();
  w.bytes32(networkId);
  w.bytes32(key);
  w.u32(run);
  w.vec(signatures, (s, ww) => { ww.bytes32(s.key); ww.bytes(s.signature, 64); }, { sortedBy: (a, b) => (toHex(a.key) < toHex(b.key) ? -1 : 1) });
  return w.finish();
}

export function decodeReshareList(bytes) {
  const r = new Reader(bytes);
  const out = { networkId: r.bytes32(), key: r.bytes32(), run: r.u32(), signatures: r.vec((rr) => ({ key: rr.bytes32(), signature: rr.bytes(64) })) };
  r.end();
  return out;
}

export const reshareListId = (bytes) => taggedHash(TAG.reshareList, bytes);
export const reshareAnchor = (bytes) => ({ value: 0n, script: Uint8Array.from([0x6a, 36, ...RESHARE_MAGIC, ...reshareListId(bytes)]) });
export const reshareAnchorIn = (outputs) => hashPushIn(outputs, RESHARE_MAGIC);

/** The list an 'R' anchor's own transaction carries, by the id its OP_RETURN names, or null. */
export function reshareListIn(tx, id) {
  const want = toHex(id);
  for (const body of envelopesIn(tx)) {
    if (toHex(reshareListId(body)) !== want) continue;
    try { return decodeReshareList(body); } catch { /* not a list after all */ }
  }
  return null;
}

/**
 * A RESHARE'S WINDOW: the epoch's founding_window, as a keygen's. Its first quarter is for ReshareReady, and the deals run in the rest as in a keygen: the rest's first half deals, its
 * second half signatures. An anchor counts from the window's first block until the midpoint, so at least one block of deals follows it.
 */
export function reshareWindow(epoch, network, foundingWindow) {
  const { start, end } = censusKeyWindow(epoch, network, foundingWindow);
  const ready = start + Math.floor(foundingWindow / 4);
  return { start, ready, midpoint: ready + Math.floor((end - ready) / 2), end };
}

/**
 * IS THIS LIST `present`? This network's, and every signer an old holder whose signature on ReshareReady verifies, together holding the old threshold. `holders` and `threshold` are the
 * key's as its newest record stands. Answers { ok, present: [hex], have } or { ok: false, why }.
 */
export function reshareListStands({ list, networkId, holders, threshold, verify }) {
  if (typeof verify !== 'function') return { ok: false, why: 'checking a list needs a verifier, and none was injected' };
  if (toHex(list.networkId) !== toHex(networkId)) return { ok: false, why: 'that list is for another network' };
  const held = new Map(holders.map((h) => [h.key, h.shares]));
  const digest = reshareReadyId(list);
  const present = new Set();
  let have = 0;
  for (const s of list.signatures) {
    const k = toHex(s.key);
    if (!held.has(k)) return { ok: false, why: `${k.slice(0, 16)} holds no share of that key` };
    let good = false;
    try { good = verify(s.signature, digest, s.key) === true; } catch { good = false; }
    if (!good) return { ok: false, why: `${k.slice(0, 16)}'s ReshareReady does not verify` };
    if (!present.has(k)) { present.add(k); have += held.get(k); }
  }
  if (have < threshold) return { ok: false, why: `holders of ${have} shares signed that list, and the key's threshold is ${threshold}` };
  return { ok: true, present: [...present], have };
}

const RECORD_BYTES = 112;

/**
 * THE BODY OF AN ANCHOR (kanban #1041 answer 3): the record and its signatures, on the chain with the anchor transaction, as an advertisement body is (5A.2, 25.1).
 * So it is retrievable by anyone with the chain, there is nothing to serve, and a census stays a pure function of the chain. Signers in ascending key.
 */
export function encodeCensusKeyBody({ record, signatures }) {
  const w = new Writer();
  w.bytes(encodeCensusKeyRecord(record), RECORD_BYTES);
  w.vec(signatures, (s, ww) => { ww.bytes32(s.key); ww.bytes(s.signature, 64); }, { sortedBy: (a, b) => (toHex(a.key) < toHex(b.key) ? -1 : 1) });
  return w.finish();
}

export function decodeCensusKeyBody(bytes) {
  const r = new Reader(bytes);
  const record = decodeCensusKeyRecord(r.bytes(RECORD_BYTES));
  const signatures = r.vec((rr) => ({ key: rr.bytes32(), signature: rr.bytes(64) }));
  r.end();
  return { record, signatures };
}

const ENVELOPE_PIECE = 520;     // the most one push may hold

/**
 * AN ANCHOR'S BODY LIVES IN THE LEAF ITS TRANSACTION SPENDS (kanban #1048): `<key> CHECKSIG OP_0 OP_IF <pushes> OP_ENDIF`. The funded output commits to the leaf, so no relay can take the
 * body off a spend, and the signatures are as safe as the record. It costs nothing: a piece of 520 bytes takes 3 bytes of script where 80 bytes on the stack took 2.
 */
export function censusKeyEnvelope(body) {
  const parts = [Uint8Array.of(0x00, 0x63)];
  for (let at = 0; at < body.length; at += ENVELOPE_PIECE) {
    const piece = body.subarray(at, Math.min(at + ENVELOPE_PIECE, body.length));
    parts.push(piece.length < 76 ? Uint8Array.of(piece.length) : piece.length < 256 ? Uint8Array.of(0x4c, piece.length) : Uint8Array.of(0x4d, piece.length & 255, piece.length >> 8), piece);
  }
  parts.push(Uint8Array.of(0x68));
  return censusKeyJoin(parts);
}

/** The pushes of an envelope at `at`, joined, or null where the script is not one to its last byte. */
function envelopeBody(script, at) {
  if (script[at] !== 0x00 || script[at + 1] !== 0x63) return null;
  const parts = [];
  let i = at + 2;
  while (i < script.length && script[i] !== 0x68) {
    const op = script[i];
    const wide = op === 0x4d ? 3 : op === 0x4c ? 2 : op >= 1 && op < 76 ? 1 : 0;
    if (!wide || i + wide > script.length) return null;
    const length = op === 0x4d ? script[i + 1] | (script[i + 2] << 8) : op === 0x4c ? script[i + 1] : op;
    i += wide;
    if (i + length > script.length) return null;
    parts.push(script.subarray(i, i + length));
    i += length;
  }
  return i === script.length - 1 ? censusKeyJoin(parts) : null;
}

/** Every envelope a transaction's inputs reveal: the leaf is the last witness item but the control block, an annex aside. */
function envelopesIn(tx) {
  const out = [];
  for (const stack of tx.witnesses || []) {
    const items = stack.length > 2 && stack[stack.length - 1][0] === 0x50 ? stack.slice(0, -1) : stack;
    const script = items[items.length - 2];
    if (!script || script.length < 37 || script[0] !== 0x20 || script[33] !== 0xac) continue;
    const body = envelopeBody(script, 34);
    if (body) out.push(body);
  }
  return out;
}

/** THE BODY AN ANCHOR'S OWN TRANSACTION CARRIES, by the id its OP_RETURN names, or null. */
export function censusKeyBodyIn(tx, id) {
  const want = toHex(id);
  for (const body of envelopesIn(tx)) {
    if (body.length < RECORD_BYTES || toHex(taggedHash(TAG.censusKeyRecord, body.subarray(0, RECORD_BYTES))) !== want) continue;
    try { return decodeCensusKeyBody(body); } catch { /* not a body after all */ }
  }
  return null;
}

/**
 * THE CENSUS A KEY READS (5A.4, before any role filter). A pure function of the chain, so it names no version a build moves: the key's census is read at
 * CENSUS_KEY_VERSION, the version that runs the daemon, with B as its floor and the network's census_confirmations (kanban #1048 answer 2).
 */
export const censusKeyContract = ({ networkId, network, height, censusConfirmations, genesis = null }) => ({
  networkId, censusHeight: height, censusConfirmations, bondMinSats: censusKeyBondMin(network, genesis), protocolVersion: CENSUS_KEY_VERSION,
});

/**
 * IS THIS RECORD THE ONE ITS EPOCH CAN HAVE, BEFORE ANY CENSUS IS READ? An epoch at or after the network's first height, the census height that epoch's rule gives, and
 * an anchor no earlier than the block its draw reads. Cheap, and it comes first: an anchor anyone can post must not buy a census read for nothing.
 * Answers { ok, censusHeight, drawHeight } or { ok: false, why }.
 */
export function censusKeyRecordDue({ record, height, network, firstHeight, censusConfirmations }) {
  if (firstHeight === null || firstHeight === undefined) return { ok: false, why: `${network} names no first census key height, so it has no census key` };
  const drawHeight = censusKeyDrawHeight(record.epoch, network);
  if (drawHeight < firstHeight) return { ok: false, why: `epoch ${record.epoch} starts at ${drawHeight}, before this network's first key height ${firstHeight}` };
  if (height < drawHeight) return { ok: false, why: `that record was anchored at ${height}, before its epoch's first height ${drawHeight}` };
  const censusHeight = censusHeightOfEpoch(record.epoch, network, censusConfirmations);
  if (censusHeight === null || record.censusHeight !== censusHeight) return { ok: false, why: `that record names census height ${record.censusHeight}, and epoch ${record.epoch} reads ${censusHeight}` };
  return { ok: true, censusHeight, drawHeight };
}

/**
 * THE STANDING KEYS AS ONE SHORT NAME, for a cache: a census reads only the keys that stood at or below its own height, so a key anchored later does not move an older
 * census, and with no key the name is empty and every kept census keeps its old name.
 */
export function standingKeysName(standing, height) {
  const held = (standing || []).filter((k) => k.height <= height);
  if (!held.length) return '';
  const w = new Writer();
  w.vec(held, (k, ww) => { ww.u32(k.epoch); ww.u32(k.height); ww.bytes32(k.publicKey); });
  return toHex(sha256(w.finish())).slice(0, 16);
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
 * What a carrier signs to name its peg-in address for an escrow spend of one table (kanban #1034 answer 2). The table exists by then, so this one names it;
 * a peg-in is per wallet, so no record lists these. The table id commits to the network.
 */
export const carrierEscrowPegInId = (tableId, script) => taggedHash(TAG.carrierEscrowPegIn, Uint8Array.from([...tableId, ...script]));

/**
 * WHO CARRIES THE PLAYERS' SHARE ON A FALLBACK, AND WHERE THERE ARE NO PANELS (kanban #1031): a fallback means the panels did not sign, so panel A
 * cannot be trusted with it. The census key's holders in descending shares, less `excluded` (hex: the accused, the proof's other slashed
 * nodes, the round's seats), each with a peg-in address signed by its node key. A holder with none is passed over. An empty answer is no refusal:
 * buildSlashPayoutTable then leaves it all in escrow and the players wait for a carrier (kanban #1034 answer 6).
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
