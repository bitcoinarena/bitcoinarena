// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHAT THE CENSUS KEY COSTS (kanban #972, spec 5A.3B): "census_key(e) is a FROST key of the census of epoch e, one share per
// weight, threshold 2/3 of the shares", kept across epochs by a reshare. The spec lists this as not measured.
//
//   node packages/arena-node/tools/census-key-measure.mjs --nodes 15 --top 1
//   node packages/arena-node/tools/census-key-measure.mjs --nodes 200 --top 50 --reshare
//   node packages/arena-node/tools/census-key-measure.mjs --nodes 1000 --top 100 --dealers 5
//
// --dealers n: only the first n nodes deal. The key and the signature are still real, at the census' own share count and threshold,
// and every per-node line is the same; the summed-commitment time is that of n deals scaled to the census, and says so. For a census
// whose every deal on one thread would hold a core for most of an hour.
//
// One process plays every node, so what is printed per node is one node's own work, timed on its own, and the "all" lines are
// the sum over the census. Nothing here is a protocol: the deal is the Pedersen deal of arena-protocol/src/dkg.js and the
// signature is frost-bip340.js. What those two cannot do yet, this file does itself, and says so where it does:
//
//   weights     dkg.js has one share per key and one deal per share: `epochId` and `acceptContribution` refuse a key twice.
//               Here a node deals ONE polynomial and is handed `weight` shares of it, at consecutive x.
//   reshare     nothing in the repo has one.
//   one nonce   signShare340 ties one nonce pair to one x, so a node of weight w sends w pairs. signByNode is one pair per node.
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { pippenger } from '@noble/curves/abstract/curve.js';
import {
  epochId, dealContribution, acceptContribution, openMyContribution, combineShares, groupKeyOf,
  proveKnowledge, knowledgeIsProven, encodeContribution, encodeAgreement, contributionSetOf,
} from '../../arena-protocol/src/dkg.js';
import { splitSecret, shareOpensTo, scalarFrom32, scalarTo32, FIELD } from '../../arena-protocol/src/shares.js';
import { sealShare, openShare } from '../../arena-protocol/src/seal.js';
import { bindingFactors, groupCommitment } from '../../arena-protocol/src/frost.js';
import {
  signShare340, aggregate340, nonceGenerate340, challenge340, hasEvenY, xOnly, TR_CONTEXT,
} from '../../arena-protocol/src/frost-bip340.js';
import { feldmanGroup } from '../src/curve.js';

export const curve = feldmanGroup;
const Point = secp256k1.Point;
const mod = (v) => ((v % FIELD) + FIELD) % FIELD;
const say = (line) => console.log(`#972 ${line}`);
const now = () => Number(process.hrtime.bigint()) / 1e6;
const timed = (fn) => { const t = now(); const out = fn(); return { out, ms: now() - t }; };
const timedAsync = async (fn) => { const t = now(); const out = await fn(); return { out, ms: now() - t }; };
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
const mb = (n) => (n < 1048576 ? kb(n) : `${(n / 1048576).toFixed(1)} MB`);
const s = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms.toFixed(1)} ms`);

export const randomScalar = () => {
  for (;;) { const v = scalarFrom32(randomBytes(32)); if (v > 0n && v < FIELD) return v; }
};

function inverse(a) {
  let [oldR, r] = [mod(a), FIELD];
  let [oldS, t] = [1n, 0n];
  while (r !== 0n) { const q = oldR / r; [oldR, r] = [r, oldR - q * r]; [oldS, t] = [t, oldS - q * t]; }
  return mod(oldS);
}

/** Every Lagrange coefficient at zero over `ids`, in O(t^2) multiplications (interpolatingValue does one in O(t^2) comparisons). */
function lagrangeAtZero(ids) {
  const out = new Map();
  for (const x of ids) {
    let num = 1n, den = 1n;
    const X = BigInt(x);
    for (const y of ids) if (y !== x) { const Y = BigInt(y); num = mod(num * Y); den = mod(den * (Y - X)); }
    out.set(x, mod(num * inverse(den)));
  }
  return out;
}

/**
 * THE WEIGHTS: `floor(bond / bond_min)` of 5A.6 for a census of `nodes`, the largest bond `top` times the floor and each next one
 * smaller as 1/rank, never below 1. A skew and not a forecast: nobody knows mainnet's bonds yet, so the runs vary it.
 */
export const weightsFor = (nodes, top) => Array.from({ length: nodes }, (_, i) => Math.max(1, Math.floor(top / (i + 1))));

/** Consecutive x per node, 1.. */
export function shareMap(weights) {
  let next = 1;
  return weights.map((w) => { const ids = Array.from({ length: w }, (_, k) => next + k); next += w; return ids; });
}

/** "Threshold 2/3 of the shares": the smallest count that is at least 2/3 of them. */
export const thresholdOf = (total) => Math.ceil((2 * total) / 3);

const groupFromSum = (first) => groupKeyOf([{ commitments: [first] }], curve);

/** One dealer's polynomial: `constant` (or a fresh secret), commitments, the proof of knowledge of a0, every share. */
function dealPolynomial({ dealer, needed, total, constant = null }) {
  const a0 = constant === null ? randomScalar() : constant;
  const coefficients = Array.from({ length: needed - 1 }, randomScalar);
  const split = splitSecret(scalarTo32(a0), { signerNodes: total, needed, coefficients, curve });
  const proof = proveKnowledge({ id: dealer + 1, secret: a0, commitment: split.commitments[0], nonce: randomScalar(), curve });
  return { commitments: split.commitments, proof, shares: split.shares };
}

/**
 * THE WEIGHTED DEAL, every node once. `sealed` deals go through ECDH and AES-GCM to every share, the rest only compute: the seal
 * does not change the key, and a census-wide run of it would be hours on one thread for a figure one dealer already gives.
 */
export async function weightedKeygen({ weights, sealed = 1, dealers = weights.length, onDeal = null }) {
  const total = weights.reduce((a, b) => a + b, 0);
  const needed = thresholdOf(total);
  const ids = shareMap(weights);
  const owner = new Array(total + 1);
  ids.forEach((list, node) => { for (const x of list) owner[x] = node; });
  const sum = new Array(total + 1).fill(0n);
  const sumC = new Array(needed).fill(null);
  const keys = Array.from({ length: Math.min(sealed, weights.length) }, () => scalarTo32(randomScalar()));
  const costs = { dealMs: [], sealMs: [], addMs: 0, contributionBytes: 0, feldmanMs: [], proofMs: [], openMs: [] };
  const firsts = [];

  for (let dealer = 0; dealer < dealers; dealer++) {
    const { out: deal, ms } = timed(() => dealPolynomial({ dealer, needed, total }));
    costs.dealMs.push(ms);
    if (dealer < keys.length) {
      // The shape dkg.js would send, one sealed share per x: bytes taken from its own encoder. It needs a distinct key per share,
      // so the x stands in for the key here, which a real node cannot do.
      const eph = scalarTo32(randomScalar());
      const { out: sealedShares, ms: sealMs } = await timedAsync(async () => {
        const out = [];
        for (const share of deal.shares) {
          const signerNodePubkey = curve.pointX(keys[owner[share.signerNode] % keys.length]);
          out.push({ signerNode: share.signerNode, signerNodePubkey,
            sealed: await sealShare({ value: share.value, signerNode: share.signerNode, signerNodePubkey, ephemeralSecret: eph, curve }) });
        }
        return out;
      });
      costs.sealMs.push(sealMs);
      const wire = encodeContribution({ epochId: new Uint8Array(32), from: new Uint8Array(32), ephemeralPubkey: new Uint8Array(32), needed,
        commitments: deal.commitments, proof: deal.proof, shares: sealedShares });
      costs.contributionBytes = wire.length;
      // and the receiving end of one envelope
      const k = owner[deal.shares[0].signerNode] % keys.length;
      const { out: opened, ms: openMs } = await timedAsync(() => openShare({ sealed: sealedShares[0].sealed, signerNode: sealedShares[0].signerNode, secret: keys[k], ephemeralPubkey: curve.pointX(eph), curve }));
      if (!opened.ok) throw new Error(opened.why);
      costs.openMs.push(openMs);
    }
    for (let x = 1; x <= total; x++) sum[x] = mod(sum[x] + deal.shares[x - 1].value);
    const { ms: addMs } = timed(() => {
      for (let j = 0; j < needed; j++) {
        const P = Point.fromBytes(deal.commitments[j]);
        sumC[j] = sumC[j] === null ? P : sumC[j].add(P);
      }
    });
    costs.addMs += addMs;
    firsts.push(deal.commitments[0]);
    // The checks a receiver makes, on the first few deals: every later one costs the same.
    if (dealer < 3) {
      const proofRun = timed(() => knowledgeIsProven({ id: dealer + 1, commitment: deal.commitments[0], proof: deal.proof, curve }));
      if (!proofRun.out.ok) throw new Error(proofRun.out.why);
      costs.proofMs.push(proofRun.ms);
      // At the last x: at x = 1 every power is 1 and shareOpensTo multiplies nothing, which would time the wrong thing.
      const share = { signerNode: total, value: deal.shares[total - 1].value };
      const feldmanRun = timed(() => shareOpensTo(share, { commitments: deal.commitments, curve }));
      if (!feldmanRun.out.ok) throw new Error(feldmanRun.out.why);
      costs.feldmanMs.push(feldmanRun.ms);
    }
    if (onDeal) onDeal(dealer);
  }

  const summed = sumC.map((p) => p.toBytes(true));
  const key = groupFromSum(summed[0]);
  if (!key.ok) throw new Error(key.why);
  const shares = sum.map((v) => (key.negated ? mod(FIELD - v) : v));
  // THE KEY IS THE DEALERS' SUM, AND EVERY SHARE LIES UNDER IT: one Feldman check on the summed polynomial is what a receiver
  // needs instead of n of them, when nobody cheated. Timed by the code the seats run and by a Pippenger sum.
  const x0 = total;
  const plain = timed(() => shareOpensTo({ signerNode: x0, value: sum[x0] }, { commitments: summed, curve }));
  if (!plain.out.ok) throw new Error(plain.out.why);
  costs.summedFeldmanMs = plain.ms;
  const powers = []; let power = 1n;
  for (let j = 0; j < needed; j++) { powers.push(power); power = mod(power * BigInt(x0)); }
  costs.pippengerMs = timed(() => pippenger(Point, sumC, powers)).ms;
  return { weights, ids, owner, total, needed, shares, summed, sumC, groupPublicKey: key.groupPublicKey, negated: key.negated, firsts, costs };
}

/** The nodes that sign, largest first, and exactly `needed` of their shares. */
export function signersFor({ ids, needed }, { skip = 0 } = {}) {
  const order = ids.map((list, node) => ({ node, list })).filter((x) => x.list.length).sort((a, b) => b.list.length - a.list.length).slice(skip);
  const out = []; let have = 0;
  for (const { node, list } of order) {
    if (have >= needed) break;
    const use = list.slice(0, needed - have);
    out.push({ node, list: use }); have += use.length;
  }
  if (have < needed) throw new Error(`${have} of ${needed} shares are online`);
  return out;
}

/** frost-bip340.js unchanged: every share is a participant with its own nonce pair. */
export function signByShare(key, message, signers) {
  const list = signers.flatMap((x) => x.list);
  const nonces = new Map(list.map((id) => {
    const hiding = nonceGenerate340(randomBytes(32), key.shares[id]);
    const binding = nonceGenerate340(randomBytes(32), key.shares[id]);
    return [id, { hiding, binding }];
  }));
  const commitments = list.map((id) => ({ id, hiding: curve.pointFromScalar(nonces.get(id).hiding), binding: curve.pointFromScalar(nonces.get(id).binding) }));
  const plain = { ...curve };
  const first = timed(() => signShare340({ id: list[0], share: key.shares[list[0]], groupPublicKey: key.groupPublicKey, nonces: nonces.get(list[0]), message, commitments, curve: plain }));
  // Everyone reads the same group commitment, so this process works it out once; `first` is what one share costs a real signer.
  const R = groupCommitment({ commitments, factors: bindingFactors({ groupPublicKey: key.groupPublicKey, commitments, message, context: TR_CONTEXT }), curve });
  const once = { ...curve, combinePoints: () => R };
  const shares = [first.out];
  for (const id of list.slice(1))
    shares.push(signShare340({ id, share: key.shares[id], groupPublicKey: key.groupPublicKey, nonces: nonces.get(id), message, commitments, curve: once }));
  const sig = aggregate340({ commitments, message, groupPublicKey: key.groupPublicKey, shares, curve });
  return { sig, oneShareMs: first.ms, commitments, participants: list.length };
}

/**
 * NOT IN frost-bip340.js: one nonce pair per NODE, its several shares summed under their Lagrange coefficients. A node's message is
 * then 66 + 32 bytes whatever its weight. The binding factor is the node's, the coefficient the shares'.
 */
export function signByNode(key, message, signers) {
  const lambda = lagrangeAtZero(signers.flatMap((x) => x.list));
  const participants = signers.map((x) => {
    const hiding = randomScalar(), binding = randomScalar();
    return { id: x.node + 1, list: x.list, hiding, binding,
      commitment: { id: x.node + 1, hiding: curve.pointFromScalar(hiding), binding: curve.pointFromScalar(binding) } };
  });
  const commitments = participants.map((p) => p.commitment);
  const factors = bindingFactors({ groupPublicKey: key.groupPublicKey, commitments, message, context: TR_CONTEXT });
  const rho = new Map(factors.map((f) => [f.id, f.factor]));
  const R = groupCommitment({ commitments, factors, curve });
  const flip = hasEvenY(R) ? 1n : FIELD - 1n;
  const c = challenge340(xOnly(R), xOnly(key.groupPublicKey), message);
  const t = now();
  const shares = participants.map((p) => {
    let held = 0n;
    for (const id of p.list) held = mod(held + lambda.get(id) * key.shares[id]);
    return mod(flip * mod(p.hiding + mod(p.binding * rho.get(p.id))) + mod(c * held));
  });
  const sumMs = now() - t;
  return { sig: aggregate340({ commitments, message, groupPublicKey: key.groupPublicKey, shares, curve }), sumMs, participants: participants.length };
}

export const verifies = (sig, message, key) => schnorr.verify(sig.signature, message, xOnly(key.groupPublicKey));

/**
 * THE RESHARE: at least `needed` old shares deal the key to a new census of `weights`. Each old node deals a polynomial whose constant
 * is the sum of its shares under the Lagrange coefficients of the set, so the constants add up to the key and the public key stays.
 */
export function reshare(old, weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  const needed = thresholdOf(total);
  const ids = shareMap(weights);
  const signers = signersFor(old);
  const lambda = lagrangeAtZero(signers.flatMap((x) => x.list));
  const sum = new Array(total + 1).fill(0n);
  const sumC = new Array(needed).fill(null);
  const dealMs = [];
  let constantsSum = null;
  signers.forEach((holder, dealer) => {
    let constant = 0n;
    for (const id of holder.list) constant = mod(constant + lambda.get(id) * old.shares[id]);
    const { out: deal, ms } = timed(() => dealPolynomial({ dealer, needed, total, constant }));
    dealMs.push(ms);
    for (let x = 1; x <= total; x++) sum[x] = mod(sum[x] + deal.shares[x - 1].value);
    for (let j = 0; j < needed; j++) { const P = Point.fromBytes(deal.commitments[j]); sumC[j] = sumC[j] === null ? P : sumC[j].add(P); }
    const first = Point.fromBytes(deal.commitments[0]);
    constantsSum = constantsSum === null ? first : constantsSum.add(first);
  });
  // No negation here: the old shares are already shares of the even key, so the sum of the constants IS the even key.
  const same = constantsSum.toBytes(true);
  if (same.some((b, i) => b !== old.groupPublicKey[i])) throw new Error('the reshare moved the public key');
  return { weights, ids, total, needed, shares: sum, groupPublicKey: old.groupPublicKey, dealers: signers.length, dealMs };
}

/** The Y of one x off the summed polynomial: what naming a bad signature share or checking a reshare's constant needs, once per x. */
export function publicShareMs(key, x) {
  const powers = []; let power = 1n;
  for (let j = 0; j < key.needed; j++) { powers.push(power); power = mod(power * BigInt(x)); }
  return timed(() => pippenger(Point, key.sumC, powers)).ms;
}

/** EVERY LINE OF dkg.js UNTOUCHED, one share per key: what the seats run today, at `n` nodes of weight one. */
export async function plainDkg(n) {
  const secrets = Array.from({ length: n }, () => scalarTo32(randomScalar()));
  const nodes = secrets.map((k) => schnorr.getPublicKey(k));
  const needed = thresholdOf(n);
  const id = epochId(nodes);
  const contributions = [];
  const dealRun = await timedAsync(async () => {
    for (let i = 0; i < n; i++) {
      const eph = scalarTo32(randomScalar());
      const made = await dealContribution({ secret: scalarTo32(randomScalar()), signerNodes: nodes, epochId: id, from: nodes[i], ephemeralSecret: eph,
        ephemeralPubkey: schnorr.getPublicKey(eph), coefficients: Array.from({ length: needed - 1 }, randomScalar), needed, curve });
      if (!made.ok) throw new Error(made.why);
      contributions.push(made.contribution);
    }
  });
  const acceptRun = timed(() => { for (const c of contributions) { const a = acceptContribution(c, { curve }); if (!a.ok) throw new Error(a.why); } });
  const openRun = await timedAsync(async () => {
    const out = [];
    for (let i = 0; i < n; i++) {
      const opened = [];
      for (const c of contributions) { const o = await openMyContribution(c, { pubkey: nodes[i], secret: secrets[i], curve }); if (!o.ok) throw new Error(o.why); opened.push(o); }
      const combined = combineShares({ opened, signerNodes: nodes, contributions, curve });
      if (!combined.ok) throw new Error(combined.why);
      out.push(combined);
    }
    return out;
  });
  const key = { shares: [0n, ...openRun.out.map((x) => x.share)], groupPublicKey: openRun.out[0].groupPublicKey };
  const agreement = encodeAgreement({ epochId: id, signerNode: nodes[0], held: contributionSetOf(contributions) });
  return { needed, key, contributionBytes: encodeContribution(contributions[0]).length, agreementBytes: agreement.length + 64,
    dealMs: dealRun.ms / n, acceptMs: acceptRun.ms / n, openMs: openRun.ms / n };
}

/** The two refusals that stop a weighted census at dkg.js, read off the code rather than from memory. */
export function weightedRefusals() {
  const a = schnorr.getPublicKey(scalarTo32(randomScalar()));
  const b = schnorr.getPublicKey(scalarTo32(randomScalar()));
  let epoch = null;
  try { epochId([a, a, b]); } catch (e) { epoch = e.message; }
  const accept = acceptContribution({ epochId: new Uint8Array(32), from: a, ephemeralPubkey: new Uint8Array(32), needed: 2,
    commitments: [new Uint8Array(33), new Uint8Array(33)], proof: new Uint8Array(64),
    shares: [{ signerNode: 1, signerNodePubkey: a, sealed: new Uint8Array(48) }, { signerNode: 2, signerNodePubkey: a, sealed: new Uint8Array(48) }] }, { curve });
  return { epoch, accept: accept.why };
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name, fallback) => { const at = args.indexOf(`--${name}`); return at < 0 ? fallback : Number(args[at + 1]); };
  const nodes = opt('nodes', 15), top = opt('top', 1), churn = opt('churn', 10), dealers = opt('dealers', nodes);
  const weights = weightsFor(nodes, top);
  const total = weights.reduce((a, b) => a + b, 0);
  const needed = thresholdOf(total);
  say(`census: ${nodes} nodes, top weight ${top}, shares ${total}, threshold ${needed}, largest node ${(100 * weights[0] / total).toFixed(1)} % of the shares`);

  if (args.includes('--plain')) {
    const r = await plainDkg(nodes);
    const message = randomBytes(32);
    const signers = Array.from({ length: r.needed }, (_, i) => ({ node: i, list: [i + 1] }));
    const run = signByShare({ ...r.key, needed: r.needed }, message, signers);
    say(`dkg.js untouched, ${nodes} of weight 1: deal ${s(r.dealMs)}, accept ${s(r.acceptMs)}, open and combine ${s(r.openMs)} per node; contribution ${kb(r.contributionBytes)}, agreement ${kb(r.agreementBytes)}; signature valid: ${verifies(run.sig, message, r.key)}`);
  }

  const t0 = now();
  const key = await weightedKeygen({ weights, dealers, onDeal: (d) => { if (d && d % 100 === 0) say(`  ... ${d} of ${nodes} deals, ${s(now() - t0)}`); } });
  const allMs = now() - t0;
  const c = key.costs;
  const avg = (list) => list.reduce((a, b) => a + b, 0) / list.length;
  const dealMs = avg(c.dealMs), sealMs = avg(c.sealMs), proofMs = avg(c.proofMs), feldmanMs = avg(c.feldmanMs), openMs = avg(c.openMs);
  const agreement = encodeAgreement({ epochId: new Uint8Array(32), signerNode: new Uint8Array(32), held: Array.from({ length: nodes }, (_, i) => { const d = new Uint8Array(32); d[0] = i >> 8; d[1] = i & 255; return { dealer: d, id: new Uint8Array(32) }; }) }).length + 64;
  say(`keygen, rounds: 2 (deal, then a signed agreement over all ${nodes} deals), no round for an absent node: every one must deal`);
  say(`keygen, one dealer: polynomial ${s(dealMs)}, sealing ${total} shares ${s(sealMs)}, contribution ${kb(c.contributionBytes)}`);
  say(`keygen, one receiver of weight 1, per deal: proof ${s(proofMs)}, open ${s(openMs)}, Feldman by shareOpensTo ${s(feldmanMs)}`);
  const perDeal = proofMs + openMs + feldmanMs;
  say(`keygen, per node as the code checks now (each deal, each share): ${s(dealMs + sealMs + nodes * perDeal)} at weight 1, ${s(dealMs + sealMs + nodes * (proofMs + weights[0] * (openMs + feldmanMs)))} at the top weight`);
  const sumMs = c.addMs * (nodes / dealers);
  if (dealers < nodes) say(`SAMPLED: ${dealers} of ${nodes} nodes dealt; the key and signatures below are real, the census-wide sums are scaled from ${dealers} deals`);
  say(`keygen, per node with the deals summed first: add the commitments ${s(sumMs)}, one Feldman ${s(c.summedFeldmanMs)} (Pippenger ${s(c.pippengerMs)}), so ${s(dealMs + sealMs + nodes * (proofMs + openMs) + sumMs + c.pippengerMs)} at weight 1`);
  say(`keygen, bytes per node: sends ${kb(c.contributionBytes + agreement)}, receives ${mb(nodes * (c.contributionBytes + agreement))} if all is broadcast; ${mb(nodes * (33 * needed + 64 + 48 + agreement))} if each dealer sends a node only the commitments and its own share (weight 1)`);
  say(`keygen, this process (${dealers} dealers on one thread, one of them sealing): ${s(allMs)}; key ${Buffer.from(xOnly(key.groupPublicKey)).toString('hex').slice(0, 16)}`);

  const message = new Uint8Array(randomBytes(32));
  const signers = signersFor(key);
  const t1 = now();
  const byShare = signByShare(key, message, signers);
  const shareMs = now() - t1;
  const okShare = verifies(byShare.sig, message, key);
  say(`sign, rounds: 2 (commit, share). frost-bip340.js as it is, ${byShare.participants} participants from ${signers.length} nodes: one share ${s(byShare.oneShareMs)}, a node of weight w does that w times; commit ${kb(66 * signers[0].list.length)} at the top weight, list ${kb(98 * byShare.participants)} received; this process ${s(shareMs)}; BIP-340 verify: ${okShare}`);
  const t2 = now();
  const byNode = signByNode(key, message, signers);
  const nodeMs = now() - t2;
  const okNode = verifies(byNode.sig, message, key);
  say(`sign, one nonce per node (not in frost-bip340.js), ${byNode.participants} participants: list ${kb(98 * byNode.participants)} received; this process ${s(nodeMs)}, of which the shares ${s(byNode.sumMs)}; BIP-340 verify: ${okNode}`);
  if (!okShare || !okNode) throw new Error('a signature did not verify');
  const yMs = publicShareMs(key, key.total);
  say(`one public share Y_x (Pippenger) ${s(yMs)}: ${s(yMs * needed)} for the ${needed} a reshare or a bad-share check reads, ${s(yMs * total)} for all`);

  if (args.includes('--reshare')) {
    // The next census: every `churn`-th node gone, the same number new at weight 1.
    const next = weights.filter((_, i) => (i + 1) % churn !== 0);
    while (next.length < weights.length) next.push(1);
    const t3 = now();
    const after = reshare(key, next);
    const allReshare = now() - t3;
    const again = new Uint8Array(randomBytes(32));
    const later = signByNode(after, again, signersFor(after));
    const ok = verifies(later.sig, again, after);
    say(`reshare, rounds: 2 as the deal. ${after.dealers} old nodes dealt to ${after.total} new shares, threshold ${after.needed}: one dealer ${s(avg(after.dealMs))}; this process ${s(allReshare)}; same public key, new shares sign: ${ok}`);
    if (!ok) throw new Error('the reshared key did not sign');
  }
  const refused = weightedRefusals();
  say(`dkg.js on one key twice: epochId "${refused.epoch}"; acceptContribution "${refused.accept}"`);
  say(`peak memory ${mb(process.memoryUsage().rss)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
