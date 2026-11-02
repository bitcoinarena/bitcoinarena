// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// MAKING THE CENSUS KEY (spec 5A.3B, RULED 2026-11-02, kanban #1021, #972): the deal of dkg.js, for a census and not a committee.
//
// dkg.js makes a round's claim key: one share per key, every signer node deals, every one agrees, and it refuses anything else. Rounds lean on
// those refusals, so that file does not change and nothing here touches its bytes. These messages have their own types and tags, so
// neither run can read the other's:
//
//   shares      a holder of w shares deals ONE polynomial and is dealt w shares of each, at the x of censusKeyShares
//   absence     the key stands on the set of deals that holders of the threshold signed. A node that never deals is not in it
//   a bad deal  is named by a complaint anyone can check, and left out of the set
//   batching    one random combination over all deals and all of a node's shares replaces a Feldman check per deal per share.
//               A failure is split in two until the bad deals are named, so the batch costs no accountability
//   reshare     old holders deal their part of the key to the new census, so the public key stays
//
// No curve here, as everywhere in this package: `curve` brings pointFromScalar, combinePoints, ecdhShared, pointX and msm.
import { Writer, Reader } from './encode.js';
import { TAG, PROTOCOL_VERSION, speaksVersion, TYPE_CENSUS_DEAL, TYPE_CENSUS_COMPLAINT, VSS_SEALED_BYTES } from './constants.js';
import { taggedHash, toHex, fromHex, bytesToBigInt } from './hash.js';
import { FIELD, splitSecret, shareOpensTo, scalarFrom32, scalarTo32 } from './shares.js';
import { sealShare, openShare } from './seal.js';
import { proveKnowledge, knowledgeIsProven, groupKeyOf } from './dkg.js';
import { COMMITMENT_BYTES } from './handout.js';

const modN = (v) => ((v % FIELD) + FIELD) % FIELD;
const glue = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};
const u32Bytes = (n) => Uint8Array.of(n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
const sameBytes = (a, b) => toHex(a) === toHex(b);

/**
 * WHICH RUN THIS IS: the network, the key's epoch, the census height, every holder with the x of its shares, the threshold. A drawn key's x are
 * not the count's running sum, so the x themselves are hashed, and they carry h with them. A reshare adds the key
 * it keeps and the old nodes that deal, so an attempt that left one out is another run.
 */
export function censusRunId({ networkId, epoch, censusHeight, holders, threshold, reshareOf = null, dealers = null }) {
  const w = new Writer();
  w.bytes32(networkId);
  w.u32(epoch);
  w.u32(censusHeight);
  w.u32(threshold);
  w.vec(holders, (h, ww) => { ww.bytes32(fromHex(h.key)); ww.vec(h.ids, (x, www) => www.u16(x)); });
  w.u8(reshareOf ? 1 : 0);
  if (reshareOf) { w.bytes32(reshareOf); w.vec(dealers, (k, ww) => ww.bytes32(fromHex(k))); }
  return taggedHash(TAG.censusRun, w.finish());
}

/** The x a dealer proves under: its key and the run, so a proof of knowledge cannot be carried to another run. */
const dealerScalar = (runId, key) => modN(bytesToBigInt(taggedHash(TAG.censusDealer, glue(runId, key))));

const totalShares = (holders) => holders.reduce((a, h) => a + h.shares, 0);

export function encodeCensusDeal(d) {
  const w = new Writer();
  w.u8(TYPE_CENSUS_DEAL);
  w.u16(PROTOCOL_VERSION);
  w.bytes32(d.runId);
  w.bytes32(d.from);
  w.bytes32(d.ephemeralPubkey);
  w.u16(d.needed);
  w.vec(d.commitments, (p, ww) => ww.bytes(p, COMMITMENT_BYTES));
  w.bytes(d.proof, 64);
  w.vec(d.sealed, (s, ww) => { ww.u16(s.x); ww.bytes(s.bytes, VSS_SEALED_BYTES); }, { sortedBy: (a, b) => a.x - b.x });
  return w.finish();
}

export function decodeCensusDeal(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== TYPE_CENSUS_DEAL) throw new Error('not a census deal');
  if (!speaksVersion(r.u16())) throw new Error('unknown protocol version');
  const d = {
    runId: r.bytes32(), from: r.bytes32(), ephemeralPubkey: r.bytes32(), needed: r.u16(),
    commitments: r.vec((rr) => rr.bytes(COMMITMENT_BYTES)), proof: r.bytes(64),
    sealed: r.vec((rr) => ({ x: rr.u16(), bytes: rr.bytes(VSS_SEALED_BYTES) })),
  };
  r.end();
  return d;
}

export const censusDealId = (d) => taggedHash(TAG.censusDeal, encodeCensusDeal(d));

/**
 * ONE HOLDER'S DEAL: a polynomial of `needed` coefficients, a share at every x of the census, each sealed to the holder of that x. One ECDH
 * per holder and not per share: the x is in the key and the nonce (seal.js), so two shares of one holder never share either.
 * `secret` is 32 bytes; a reshare passes its part of the key there.
 */
export async function dealCensusKey({ holders, dealers = holders, runId, from, needed, secret, coefficients, ephemeralSecret, proofNonce, curve }) {
  const total = totalShares(holders);
  const fromHexKey = toHex(from);
  if (!dealers.some((h) => h.key === fromHexKey)) return { ok: false, why: 'that node is not a dealer of this run' };
  let split;
  try { split = splitSecret(secret, { signerNodes: total, needed, coefficients, curve }); }
  catch (e) { return { ok: false, why: e.message }; }
  const ownerOf = new Map();
  for (const h of holders) for (const x of h.ids) ownerOf.set(x, h.key);
  const agreed = new Map();
  const once = { ...curve, ecdhShared: (s, key) => { const k = toHex(key); if (!agreed.has(k)) agreed.set(k, curve.ecdhShared(s, key)); return agreed.get(k); } };
  const sealed = [];
  for (const share of split.shares) {
    sealed.push({ x: share.signerNode,
      bytes: await sealShare({ value: share.value, signerNode: share.signerNode, signerNodePubkey: fromHex(ownerOf.get(share.signerNode)), ephemeralSecret, curve: once }) });
  }
  const proof = proveKnowledge({ id: dealerScalar(runId, from), secret: scalarFrom32(secret), commitment: split.commitments[0], nonce: proofNonce, curve });
  return { ok: true, deal: { runId, from, ephemeralPubkey: curve.pointX(ephemeralSecret), needed, commitments: split.commitments, proof, sealed } };
}

/**
 * The shape of a deal, its dealer and its proof of knowledge: a share at every x, a polynomial of the run's size. `dealers` are the holders in a
 * keygen; in a reshare they are the old nodes, who may have left the new census.
 */
export function acceptCensusDeal(d, { holders, dealers = holders, runId, needed, curve }) {
  if (!d || !sameBytes(d.runId, runId)) return { ok: false, why: 'that deal belongs to another run' };
  if (!dealers.some((h) => h.key === toHex(d.from))) return { ok: false, why: 'that deal is by a node that is not a dealer of this run' };
  if (d.needed !== needed || d.commitments.length !== needed) return { ok: false, why: `that deal publishes ${d.commitments.length} coefficients, and this run is a threshold of ${needed}` };
  const total = totalShares(holders);
  if (d.sealed.length !== total || d.sealed.some((s, i) => s.x !== i + 1)) return { ok: false, why: `that deal does not carry one share for each x of 1..${total}` };
  return knowledgeIsProven({ id: dealerScalar(runId, d.from), commitment: d.commitments[0], proof: d.proof, curve });
}

/** This holder's shares of one deal. An envelope that does not open is a complaint, by x. */
export async function openCensusDeal(d, { ids, secret, curve }) {
  const shares = [];
  const agreed = curve.ecdhShared(secret, d.ephemeralPubkey);
  const once = { ...curve, ecdhShared: () => agreed };
  for (const x of ids) {
    const opened = await openShare({ sealed: d.sealed[x - 1].bytes, signerNode: x, secret, ephemeralPubkey: d.ephemeralPubkey, curve: once });
    if (!opened.ok) return { ok: false, x, why: opened.why };
    shares.push({ x, value: opened.share.value });
  }
  return { ok: true, shares };
}

/**
 * ONE CHECK INSTEAD OF n x w. Each deal gets a random r and each x a random p, both 128 bits, so a wrong share survives with chance about
 * 2^-127. A plain sum would not do: two dealers who shift a share by +e and -e cancel, and either one left out of the set then leaves the
 * holder a wrong share.
 *
 *   (sum over deals of r_d * sum over x of p_x * s_d(x)) * G = sum over deals, over j, of r_d * (sum over x of p_x * x^j) * C_d,j
 *
 * `opened` is [{ deal, shares }]. `random(n)` brings bytes.
 */
function batchHolds(opened, xs, ps, random, curve) {
  const needed = opened[0].deal.commitments.length;
  const powers = new Array(needed).fill(0n);
  xs.forEach((x, i) => { let v = ps[i]; for (let j = 0; j < needed; j++) { powers[j] = modN(powers[j] + v); v = modN(v * BigInt(x)); } });
  let left = 0n;
  const points = [], scalars = [];
  for (const { deal, shares } of opened) {
    const r = bytesToBigInt(random(16)) + 1n;
    let line = 0n;
    shares.forEach((s, i) => { line = modN(line + ps[i] * s.value); });
    left = modN(left + r * line);
    for (let j = 0; j < needed; j++) { points.push(deal.commitments[j]); scalars.push(modN(r * powers[j])); }
  }
  return toHex(curve.msm(points, scalars)) === toHex(curve.pointFromScalar(left));
}

/** Answers { ok: true, checks } or { ok: false, bad: [deals], checks }: every bad deal is found, by halves, and `checks` counts the batches run. */
export function checkDealsBatched({ opened, random, curve }) {
  if (!opened.length) return { ok: true, bad: [], checks: 0 };
  const xs = opened[0].shares.map((s) => s.x);
  const ps = xs.map(() => bytesToBigInt(random(16)) + 1n);
  let checks = 0;
  const bad = [];
  const walk = (list) => {
    checks += 1;
    if (batchHolds(list, xs, ps, random, curve)) return;
    if (list.length === 1) { bad.push(list[0].deal); return; }
    const half = list.length >> 1;
    walk(list.slice(0, half)); walk(list.slice(half));
  };
  walk(opened);
  return { ok: !bad.length, bad, checks };
}

/**
 * A COMPLAINT ANYONE CAN CHECK: the holder shows the secret it shares with a dealer's ephemeral key, with a proof it is the true one (a
 * Chaum-Pedersen equality of logs against its own node key), so a stranger opens that one envelope and sees it does not lie on the
 * published polynomial. It shows one dealer's ephemeral agreement and nothing of the holder's key.
 */
const complaintChallenge = (runId, dealer, x, P, E, S, A1, A2) => modN(bytesToBigInt(taggedHash(TAG.censusComplaint,
  glue(runId, dealer, u32Bytes(x), P, E, S, A1, A2))));
const liftEven = (key) => glue(Uint8Array.of(0x02), key);

export function makeCensusComplaint({ deal, x, secret, nonce, curve }) {
  const raw = scalarFrom32(secret);
  const own = curve.pointFromScalar(raw);
  const d = own[0] === 0x02 ? raw : FIELD - raw;         // the even key a node is named by
  const P = curve.pointFromScalar(d);
  const E = liftEven(deal.ephemeralPubkey);
  const S = curve.combinePoints([{ point: E, coefficient: d }]);
  const A1 = curve.pointFromScalar(nonce);
  const A2 = curve.combinePoints([{ point: E, coefficient: nonce }]);
  const c = complaintChallenge(deal.runId, deal.from, x, P, E, S, A1, A2);
  return { runId: deal.runId, dealer: deal.from, node: P.subarray(1), x, shared: S, a1: A1, a2: A2, z: modN(nonce + c * d) };
}

export function encodeCensusComplaint(c) {
  const w = new Writer();
  w.u8(TYPE_CENSUS_COMPLAINT);
  w.u16(PROTOCOL_VERSION);
  w.bytes32(c.runId); w.bytes32(c.dealer); w.bytes32(c.node); w.u16(c.x);
  w.bytes(c.shared, 33); w.bytes(c.a1, 33); w.bytes(c.a2, 33); w.bytes32(scalarTo32(c.z));
  return w.finish();
}

export function decodeCensusComplaint(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== TYPE_CENSUS_COMPLAINT) throw new Error('not a census complaint');
  if (!speaksVersion(r.u16())) throw new Error('unknown protocol version');
  const c = { runId: r.bytes32(), dealer: r.bytes32(), node: r.bytes32(), x: r.u16(), shared: r.bytes(33), a1: r.bytes(33), a2: r.bytes(33), z: scalarFrom32(r.bytes32()) };
  r.end();
  return c;
}

/**
 * DOES THIS COMPLAINT PROVE THE DEAL BAD? The complainer holds that x, its shared secret is the true one, and what the envelope holds is not on
 * the polynomial, or does not open. `ok: true` is a proof against the dealer; `ok: false` leaves the deal in, and a complaint against a good
 * deal shows only the complainer's secret for that one envelope.
 */
export async function censusComplaintHolds({ complaint: c, deal, holders, curve }) {
  if (!sameBytes(c.runId, deal.runId) || !sameBytes(c.dealer, deal.from)) return { ok: false, why: 'that complaint is about another deal' };
  const holder = holders.find((h) => h.key === toHex(c.node));
  if (!holder || !holder.ids.includes(c.x)) return { ok: false, why: `that node does not hold share ${c.x}` };
  const P = liftEven(c.node), E = liftEven(deal.ephemeralPubkey);
  const k = complaintChallenge(c.runId, c.dealer, c.x, P, E, c.shared, c.a1, c.a2);
  let sound = false;
  try {
    sound = toHex(curve.pointFromScalar(c.z)) === toHex(curve.combinePoints([{ point: c.a1, coefficient: 1n }, { point: P, coefficient: k }]))
      && toHex(curve.combinePoints([{ point: E, coefficient: c.z }])) === toHex(curve.combinePoints([{ point: c.a2, coefficient: 1n }, { point: c.shared, coefficient: k }]));
  } catch { sound = false; }
  if (!sound) return { ok: false, why: 'that complaint\'s proof of its shared secret does not verify' };
  const agreed = c.shared.subarray(1);
  const opened = await openShare({ sealed: deal.sealed[c.x - 1].bytes, signerNode: c.x, secret: new Uint8Array(32), ephemeralPubkey: deal.ephemeralPubkey, curve: { ...curve, ecdhShared: () => agreed } });
  if (!opened.ok) return { ok: true, why: `share ${c.x} of that deal does not open` };
  const on = shareOpensTo({ signerNode: c.x, value: opened.share.value }, { commitments: deal.commitments, curve });
  if (!on.ok) return { ok: true, why: on.why };
  return { ok: false, why: `share ${c.x} of that deal lies on its polynomial` };
}

/** A set of deals by its one hash, so a statement is a constant size and not n x 64 bytes. */
export function censusSetId(deals) {
  const lines = deals.map((d) => glue(d.from, censusDealId(d))).sort((a, b) => (toHex(a) < toHex(b) ? -1 : 1));
  return taggedHash(TAG.censusSet, glue(...lines));
}

/**
 * WHICH RECORD MAKES THE KEY (kanban #1034 answer 5): the one CensusKeyRecord that holders of the threshold signed, so its transcript hash names the deals.
 * Absent nodes count for nothing and stop nothing. Two records cannot both reach more than 2/3 unless a third of the shares signed both, and a node seen
 * signing two is named and counted for neither. Nodes that differ at the midpoint sign different hashes: then none reaches the threshold, the key fails, and
 * the newest stands. `statements` are { node, recordId, signature } with the signature over recordId; `verify(signature, digest, key)`.
 * Answers { ok, recordId, have } or { ok: false, why, have, equivocated }.
 */
export function censusRecordAgreed({ holders, threshold, statements, verify }) {
  if (typeof verify !== 'function') return { ok: false, why: 'checking statements needs a verifier, and none was injected' };
  const held = new Map(holders.map((h) => [h.key, h.shares]));
  const said = new Map();
  const equivocated = new Set();
  for (const s of statements || []) {
    const who = toHex(s.node);
    if (!held.has(who)) continue;
    let good = false;
    try { good = verify(s.signature, s.recordId, s.node) === true; } catch { good = false; }
    if (!good) continue;
    const set = toHex(s.recordId);
    if (said.has(who) && said.get(who) !== set) equivocated.add(who);
    said.set(who, set);
  }
  const count = new Map();
  for (const [who, set] of said) if (!equivocated.has(who)) count.set(set, (count.get(set) || 0) + held.get(who));
  let best = null;
  for (const [set, have] of count) if (!best || have > best.have) best = { set, have };
  const out = { equivocated: [...equivocated] };
  if (!best || best.have < threshold)
    return { ok: false, have: best ? best.have : 0, ...out, why: `holders of ${best ? best.have : 0} shares signed one record, and the threshold is ${threshold}` };
  return { ok: true, recordId: fromHex(best.set), have: best.have, ...out };
}

/**
 * THE KEY FROM THE AGREED DEALS, from public data, and this holder's shares of it. The dealers must hold the threshold, or too few chose it:
 * `holders` and `threshold` here are the dealers' own, which a reshare has from the old key. `opened` [{ deal, shares }] in any order.
 * As in dkg.js, an odd key has every share and commitment negated, each node alone.
 * Answers { ok, groupPublicKey, negated, shares: Map x -> scalar, commitments } with the polynomial as the even key's.
 */
export function combineCensusKey({ opened, holders, threshold, curve }) {
  const dealers = new Set(opened.map((o) => toHex(o.deal.from)));
  if (dealers.size !== opened.length) return { ok: false, why: 'one node dealt twice in that set' };
  const dealt = holders.filter((h) => dealers.has(h.key)).reduce((a, h) => a + h.shares, 0);
  if (dealt < threshold) return { ok: false, why: `the dealers of that set hold ${dealt} shares, under the threshold of ${threshold}` };
  const needed = opened[0].deal.commitments.length;
  const summed = [];
  for (let j = 0; j < needed; j++) summed.push(curve.combinePoints(opened.map((o) => ({ point: o.deal.commitments[j], coefficient: 1n }))));
  const key = groupKeyOf([{ commitments: [summed[0]] }], curve);
  if (!key.ok) return key;
  const sign = key.negated ? FIELD - 1n : 1n;
  const shares = new Map();
  for (const { shares: mine } of opened) for (const s of mine) shares.set(s.x, modN((shares.get(s.x) || 0n) + s.value));
  for (const [x, v] of shares) shares.set(x, modN(sign * v));
  const commitments = key.negated ? summed.map((p) => curve.combinePoints([{ point: p, coefficient: sign }])) : summed;
  return { ok: true, groupPublicKey: key.groupPublicKey, negated: key.negated, shares, commitments };
}

/** Y_x off a key's polynomial: what naming a bad signature share, or checking a reshare, reads. */
export function censusPublicShare({ commitments, x, curve }) {
  let power = 1n;
  const scalars = commitments.map(() => { const p = power; power = modN(power * BigInt(x)); return p; });
  return curve.msm(commitments, scalars);
}

/** What a run's key is, as CensusKeyRecord says it (census-key.js). The transcript is the run and the set of deals. */
export const censusRecordOf = ({ networkId, epoch, censusHeight, runId, setId, groupPublicKey, total, threshold }) => ({
  networkId, epoch, censusHeight, publicKey: groupPublicKey.subarray(1), totalShares: total, threshold, transcriptHash: taggedHash(TAG.censusRun, glue(runId, setId)),
});

/** Every Lagrange coefficient at zero a node needs: `mine` of the x in `all`. */
export function lagrangeOf(all, mine) {
  const out = new Map();
  for (const x of mine) {
    let num = 1n, den = 1n;
    const X = BigInt(x);
    for (const y of all) if (y !== x) { const Y = BigInt(y); num = modN(num * Y); den = modN(den * (Y - X)); }
    let [a, b, s, t] = [den, FIELD, 1n, 0n];
    while (b !== 0n) { const q = a / b; [a, b] = [b, a - q * b]; [s, t] = [t, s - q * t]; }
    out.set(x, modN(num * s));
  }
  return out;
}

/**
 * WHO DEALS A RESHARE: old holders, by key order, among those `present`, until they hold the old threshold. Fixed at its start. A keygen tolerates absence and
 * a reshare does not: each dealer's part is a Lagrange term over exactly that set, so one who drops out restarts it at the next step with those left, a
 * new run (censusRunId names the set). Nothing is lost meanwhile, since the old shares still work.
 */
export function reshareDealers({ holders, threshold, present }) {
  const up = new Set(present);
  const dealers = [];
  let have = 0;
  for (const h of holders) {
    if (have >= threshold) break;
    if (!up.has(h.key)) continue;
    dealers.push(h); have += h.shares;
  }
  if (have < threshold) return { ok: false, have, why: `old holders of ${have} shares are present, under the old threshold of ${threshold}` };
  return { ok: true, dealers, xs: dealers.flatMap((h) => h.ids) };
}

/** This old holder's part of the key: the sum of its shares under the Lagrange coefficients of the dealing set. */
export function reshareConstant({ xs, shares }) {
  const lambda = lagrangeOf(xs, [...shares.keys()]);
  let part = 0n;
  for (const [x, v] of shares) part = modN(part + lambda.get(x) * v);
  return part;
}

/**
 * EVERY RESHARE DEAL HOLDS ITS DEALER'S TRUE PART. Each first commitment must be the dealer's shares under their coefficients, off the OLD key's
 * polynomial, and they must add up to the key itself: without this one dealer moves the key. One random combination, split by halves on a
 * failure, as checkDealsBatched does. `deals` [{ deal, ids }], `oldCommitments` the even key's. Answers { ok, bad }.
 */
export function checkReshareDeals({ deals, xs, oldCommitments, groupPublicKey, random, curve, complete = true }) {
  const sum = curve.combinePoints(deals.map((d) => ({ point: d.deal.commitments[0], coefficient: 1n })));
  const lambda = lagrangeOf(xs, xs);
  const lines = deals.map((d) => {
    const line = new Array(oldCommitments.length).fill(0n);
    for (const x of d.ids) { let v = lambda.get(x); for (let j = 0; j < line.length; j++) { line[j] = modN(line[j] + v); v = modN(v * BigInt(x)); } }
    return { deal: d.deal, line };
  });
  const holds = (list) => {
    const points = [...oldCommitments], scalars = oldCommitments.map(() => 0n);
    for (const { deal, line } of list) {
      const r = bytesToBigInt(random(16)) + 1n;
      points.push(deal.commitments[0]); scalars.push(modN(-r));
      line.forEach((v, j) => { scalars[j] = modN(scalars[j] + r * v); });
    }
    const out = curve.msm(points, scalars);
    return out.every((b) => b === 0);
  };
  const bad = [];
  const walk = (list) => {
    if (holds(list)) return;
    if (list.length === 1) { bad.push(list[0].deal); return; }
    const half = list.length >> 1;
    walk(list.slice(0, half)); walk(list.slice(half));
  };
  walk(lines);
  if (bad.length) return { ok: false, bad };
  if (complete && toHex(sum) !== toHex(groupPublicKey)) return { ok: false, bad: [], why: 'the parts of that reshare do not add up to the key' };
  return { ok: true, bad: [] };
}
