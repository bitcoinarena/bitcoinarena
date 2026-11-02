// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE CENSUS KEY, MEASURED ON ITS OWN RUN (kanban #972): census-dkg.js and signNodeShare340, a real keygen, signature and reshare, with a node absent.
//
//   node packages/arena-node/tools/census-dkg-measure.mjs --nodes 15 --top 10 --absent 1
//   node packages/arena-node/tools/census-dkg-measure.mjs --nodes 1000 --top 100 --absent 1 --dealers 25 --shares-max 5000
//
// One process plays every node, so what is printed per node is that node's own work, timed on its own.
// --dealers n: only n nodes deal, and the census-wide sums are scaled from them and say so. The key and the signature are still real. The
// reshare there sums the dealers' polynomials before evaluating them: the same shares, for one core's minutes and not hours.
// --shares-max: census_key_shares_max. The ruled 1024 is the default. A census past it draws its shares by bond (kanban #1039).
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { schnorr } from '@noble/curves/secp256k1.js';
import { feldmanGroup } from '../src/curve.js';
import { CENSUS_KEY_SHARES_MAX } from '../../arena-protocol/src/genesis.js';
import { censusKeyShares } from '../../arena-protocol/src/census-key.js';
import {
  censusRunId, dealCensusKey, acceptCensusDeal, openCensusDeal, checkDealsBatched, encodeCensusDeal, combineCensusKey, reshareDealers,
  reshareConstant, lagrangeOf, checkReshareDeals, censusPublicShare,
} from '../../arena-protocol/src/census-dkg.js';
import { shareOpensTo, scalarFrom32, scalarTo32, FIELD } from '../../arena-protocol/src/shares.js';
import { signNodeShare340, aggregate340, nonceGenerate340 } from '../../arena-protocol/src/frost-bip340.js';
import { groupCommitment, bindingFactors } from '../../arena-protocol/src/frost.js';
import { TR_CONTEXT } from '../../arena-protocol/src/frost-bip340.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const curve = feldmanGroup;
const say = (line) => console.log(`#972 ${line}`);
const now = () => Number(process.hrtime.bigint()) / 1e6;
const clock = async (fn) => { const t = now(); const out = await fn(); return { out, ms: now() - t }; };
const s = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms.toFixed(1)} ms`);
const size = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1024).toFixed(1)} KB`);
const random = (n) => new Uint8Array(randomBytes(n));
const scalar = () => { for (;;) { const v = scalarFrom32(random(32)); if (v > 0n && v < FIELD) return v; } };
const mod = (v) => ((v % FIELD) + FIELD) % FIELD;
const BOND_MIN = 100000n;     // the skew case of kanban #1034; B itself is regtest's
const NET = new Uint8Array(32).fill(9);

const censusOf = (weights) => weights.map((w) => { const secret = scalarTo32(scalar()); return { secret, key: schnorr.getPublicKey(secret), bond: BigInt(w) * BOND_MIN, txid: random(32), vout: 0 }; });
const sharesOf = (nodes, max) => censusKeyShares({ entries: nodes.map((n) => ({ pubkey: n.key, bondSats: n.bond, txid: n.txid, vout: n.vout })), network: 'regtest', blockHash: random(32), sharesMax: max });

/** Sign with one nonce per node, and time one node's share with nothing kept. */
function sign(key, signers, message) {
  const all = signers.flatMap((x) => [...x.held.keys()]);
  const lambda = new Map();
  const lambdaMs = [];
  for (const x of signers) { const t = now(); for (const [k, v] of lagrangeOf(all, [...x.held.keys()])) lambda.set(k, v); lambdaMs.push(now() - t); }
  const nonces = signers.map((x) => { const v = [...x.held.values()][0]; return { hiding: nonceGenerate340(random(32), v), binding: nonceGenerate340(random(32), v) }; });
  const commitments = signers.map((x, i) => ({ id: x.id, hiding: curve.pointFromScalar(nonces[i].hiding), binding: curve.pointFromScalar(nonces[i].binding) }));
  const first = now();
  const one = signNodeShare340({ id: signers[0].id, held: signers[0].held, lambda, groupPublicKey: key, nonces: nonces[0], message, commitments, curve });
  const oneMs = now() - first;
  const R = groupCommitment({ commitments, factors: bindingFactors({ groupPublicKey: key, commitments, message, context: TR_CONTEXT }), curve });
  const once = { ...curve, combinePoints: () => R };
  const shares = [one, ...signers.slice(1).map((x, i) => signNodeShare340({ id: x.id, held: x.held, lambda, groupPublicKey: key, nonces: nonces[i + 1], message, commitments, curve: once }))];
  const out = aggregate340({ commitments, message, groupPublicKey: key, shares, curve });
  return { out, oneMs, lambdaMs: Math.max(...lambdaMs), nodes: signers.length, listBytes: 98 * signers.length };
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name, fallback) => { const at = args.indexOf(`--${name}`); return at < 0 ? fallback : Number(args[at + 1]); };
  const count = opt('nodes', 15), top = opt('top', 1), absentN = opt('absent', 1), max = opt('shares-max', CENSUS_KEY_SHARES_MAX);
  const weights = Array.from({ length: count }, (_, i) => Math.max(1, Math.floor(top / (i + 1))));
  const nodes = censusOf(weights);
  const shares = sharesOf(nodes, max);
  const { holders, total, threshold, drawn } = shares;
  const held = (n) => holders.find((h) => h.key === toHex(n.key));
  const inCensus = nodes.filter(held);
  const dealersN = Math.min(opt('dealers', inCensus.length), inCensus.length);
  const sampled = dealersN < inCensus.length;
  say(`census: ${count} nodes bonded, ${holders.length} hold shares, ${drawn ? 'drawn' : 'exact'}, ${total} shares, threshold ${threshold}, top node ${Math.max(...holders.map((h) => h.shares))} shares, cap ${max}`);

  const up = [...inCensus].sort((a, b) => held(b).shares - held(a).shares);
  const absent = up.slice(up.length - absentN);
  const present = up.slice(0, up.length - absentN);
  const dealing = sampled ? present.slice(0, dealersN) : present;
  say(`absent: ${absent.length} node(s) of ${absent.reduce((a, n) => a + held(n).shares, 0)} share(s): no deal, no statement, no signature; ${dealing.length} nodes deal${sampled ? ' (SAMPLED: census-wide sums are scaled from these)' : ''}`);
  const runId = censusRunId({ networkId: NET, epoch: 1, censusHeight: 4320, holders, threshold });
  const run = { holders, runId, needed: threshold };

  // ---- the deals
  const deals = [];
  const dealMs = [];
  for (const n of dealing) {
    const { out: made, ms } = await clock(() => dealCensusKey({ ...run, from: n.key, secret: scalarTo32(scalar()), coefficients: Array.from({ length: threshold - 1 }, scalar),
      ephemeralSecret: scalarTo32(scalar()), proofNonce: scalar(), curve }));
    if (!made.ok) throw new Error(made.why);
    deals.push(made.deal); dealMs.push(ms);
  }
  const dealAvg = dealMs.reduce((a, b) => a + b, 0) / dealMs.length;
  const dealBytes = encodeCensusDeal(deals[0]).length;
  const directBytes = 3 + 96 + 2 + 33 * threshold + 64;
  say(`keygen, rounds: 2 and a third only if a deal is bad: deal, complaint, statement. One deal: ${s(dealAvg)} with its sealing, ${size(dealBytes)}`);

  // ---- what one node does with them, the top node and one of weight 1
  const opensOf = new Map();
  const openFor = async (n) => { const list = []; for (const deal of deals) { const o = await openCensusDeal(deal, { ids: held(n).ids, secret: n.secret, curve }); if (!o.ok) throw new Error(o.why); list.push({ deal, shares: o.shares }); } opensOf.set(toHex(n.key), list); return list; };
  const proofRun = await clock(() => { for (const d of deals.slice(0, 5)) { const a = acceptCensusDeal(d, { ...run, curve }); if (!a.ok) throw new Error(a.why); } });
  const proofMs = proofRun.ms / Math.min(5, deals.length);
  const small = present[present.length - 1], big = present[0];
  const scale = inCensus.length / dealing.length;
  const report = async (n, label) => {
    const opened = await clock(() => openFor(n));
    const batch = await clock(() => checkDealsBatched({ opened: opened.out, random, curve }));
    if (!batch.out.ok) throw new Error('an honest deal failed its batch');
    const one = opened.out[0].shares[opened.out[0].shares.length - 1];
    const feldman = await clock(() => shareOpensTo({ signerNode: one.x, value: one.value }, { commitments: deals[0].commitments, curve }));
    const w = held(n).shares;
    const each = (proofMs * inCensus.length) + opened.ms * scale;
    say(`keygen, ${label} node of ${w} share(s): per deal per share ${s(dealAvg + each + inCensus.length * w * feldman.ms)} (Feldman ${s(feldman.ms)} each); one batch ${s(dealAvg + each + batch.ms * scale)} (batch ${s(batch.ms)}${sampled ? ` over ${dealing.length} deals, scaled ${scale.toFixed(0)}x` : ''})`);
    return { batchMs: batch.ms * scale };
  };
  await report(big, 'top');
  await report(small, 'smallest');

  // ---- a cheat: the batch has to name it
  const opened = opensOf.get(toHex(big.key));
  const crooked = opened.map((o, i) => (i === Math.floor(opened.length / 2) ? { deal: o.deal, shares: o.shares.map((v, k) => (k === 0 ? { x: v.x, value: mod(v.value + 1n) } : v)) } : o));
  const named = await clock(() => checkDealsBatched({ opened: crooked, random, curve }));
  say(`a bad share among ${crooked.length} deals: ${named.out.checks} batches, ${s(named.ms)}${sampled ? ' (sampled deals)' : ''}, dealer named: ${toHex(named.out.bad[0].from) === toHex(opened[Math.floor(opened.length / 2)].deal.from)}`);

  const statement = 32 + 32 + 64;        // node, record id, signature
  say(`keygen, bytes per node: sends ${size(dealBytes + statement)}; receives ${size(inCensus.length * (dealBytes + statement))} if all is broadcast, ${size(inCensus.length * (directBytes + statement) + 50 * inCensus.length)} if each dealer sends the polynomial and that node's own share (weight 1)`);
  const verifyAll = await clock(() => { const sig = schnorr.sign(random(32), big.secret); const m = random(32); const signed = schnorr.sign(m, big.secret); for (let i = 0; i < Math.min(50, inCensus.length); i++) schnorr.verify(signed, m, big.key); return sig; });
  say(`statements: one ${statement} bytes, a record's hash in place of ${inCensus.length} lines; checking all ${s(verifyAll.ms / Math.min(50, inCensus.length) * inCensus.length)}`);

  // ---- the key, and a signature: present nodes up to the threshold
  const signers = [];
  let have = 0;
  let key = null;
  const sumOf = (list) => {
    const m = new Map();
    for (const o of list) for (const v of o.shares) m.set(v.x, mod((m.get(v.x) || 0n) + v.value));
    if (key.negated) for (const [x, v] of m) m.set(x, mod(-v));
    return m;
  };
  for (const n of present) {
    if (have >= threshold) break;
    const list = opensOf.get(toHex(n.key)) || await openFor(n);
    // the key once, from public data; every other signer only adds up its own shares
    if (!key) {
      key = combineCensusKey({ opened: list, holders: sampled ? [{ key: toHex(big.key), shares: total, ids: [] }, ...holders] : holders, threshold: sampled ? 1 : threshold, curve });
      if (!key.ok) throw new Error(key.why);
    }
    const shares = sumOf(list);
    signers.push({ id: signers.length + 1, held: shares });
    have += shares.size;
    if (n !== big && n !== small) opensOf.delete(toHex(n.key));
  }
  const message = random(32);
  const signed = await clock(() => sign(key.groupPublicKey, signers, message));
  const ok = schnorr.verify(signed.out.out.signature, message, key.groupPublicKey.subarray(1));
  say(`sign, rounds: 2. ${signers.length} nodes for ${have} shares: list ${size(signed.out.listBytes)} (${size(98 * have)} with a pair per share). One node: coefficients ${s(signed.out.lambdaMs)}, share ${s(signed.out.oneMs)}. This process ${s(signed.ms)}. BIP-340 verify: ${ok}`);
  if (!ok) throw new Error('the signature did not verify');
  say(`one public share ${s((await clock(() => censusPublicShare({ commitments: key.commitments, x: total, curve }))).ms)}`);

  // ---- the reshare: every tenth node gone, as many new at weight 1; the old nodes present deal
  const next = [...nodes.filter((_, i) => (i + 1) % 10 !== 0)];
  next.push(...censusOf(new Array(nodes.length - next.length).fill(1)));
  const nextShares = sharesOf(next, max);
  const presentKeys = present.map((n) => toHex(n.key));
  const chosen = reshareDealers({ holders, threshold, present: presentKeys });
  if (!chosen.ok) throw new Error(chosen.why);
  const partOf = new Map();
  const nodeOf = new Map(present.map((n) => [toHex(n.key), n]));
  let partsMs = 0;
  for (const h of chosen.dealers) {
    const n = nodeOf.get(h.key);
    const list = opensOf.get(h.key) || await openFor(n);
    const mineShares = sumOf(list);
    const t = now();
    partOf.set(h.key, reshareConstant({ xs: chosen.xs, shares: mineShares }));
    partsMs = Math.max(partsMs, now() - t);
    if (h.key !== toHex(big.key) && h.key !== toHex(small.key)) opensOf.delete(h.key);
  }
  const reRunId = censusRunId({ networkId: NET, epoch: 2, censusHeight: 8640, holders: nextShares.holders, threshold: nextShares.threshold, reshareOf: key.groupPublicKey.subarray(1), dealers: chosen.dealers.map((h) => h.key) });
  const reRun = { holders: nextShares.holders, runId: reRunId, needed: nextShares.threshold };
  const sample = await clock(() => dealCensusKey({ ...reRun, dealers: chosen.dealers, from: nodeOf.get(chosen.dealers[0].key).key, secret: scalarTo32(partOf.get(chosen.dealers[0].key)),
    coefficients: Array.from({ length: nextShares.threshold - 1 }, scalar), ephemeralSecret: scalarTo32(scalar()), proofNonce: scalar(), curve }));
  if (!sample.out.ok) throw new Error(sample.out.why);
  // the same shares as every dealer's own polynomial: the coefficients are summed before they are evaluated
  const t3 = now();
  const summed = new Array(nextShares.threshold).fill(0n);
  const firsts = [];
  for (const h of chosen.dealers) {
    summed[0] = mod(summed[0] + partOf.get(h.key));
    firsts.push({ deal: { from: h.key, commitments: [curve.pointFromScalar(partOf.get(h.key))] }, ids: h.ids });
    for (let j = 1; j < summed.length; j++) summed[j] = mod(summed[j] + scalar());
  }
  const nextValue = (x) => { let v = 0n; for (let j = summed.length - 1; j >= 0; j--) v = mod(v * BigInt(x) + summed[j]); return v; };
  const reCheck = await clock(() => checkReshareDeals({ deals: firsts, xs: chosen.xs, oldCommitments: key.commitments, groupPublicKey: key.groupPublicKey, random, curve }));
  if (!reCheck.out.ok) throw new Error(reCheck.out.why || 'a reshare part is wrong');
  const reSigners = [];
  let reHave = 0;
  for (const h of nextShares.holders) { if (reHave >= nextShares.threshold) break; const m = new Map(h.ids.map((x) => [x, nextValue(x)])); reSigners.push({ id: reSigners.length + 1, held: m }); reHave += m.size; }
  const m2 = random(32);
  const reSigned = sign(key.groupPublicKey, reSigners, m2);
  const reOk = schnorr.verify(reSigned.out.signature, m2, key.groupPublicKey.subarray(1));
  say(`reshare, rounds: 2 and a run again if a dealer fails. ${chosen.dealers.length} old nodes (${chosen.xs.length} shares, the absent left out) to ${nextShares.holders.length} holders of ${nextShares.total} shares, threshold ${nextShares.threshold}: a part ${s(partsMs)}, a deal ${s(sample.ms)}, ${size(encodeCensusDeal(sample.out.deal).length)}; checking all parts ${s(reCheck.ms)}; this process ${s(now() - t3)}; same public key, new shares sign: ${reOk}`);
  if (!reOk) throw new Error('the reshared key did not sign');
  say(`peak memory ${size(process.memoryUsage().rss)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
