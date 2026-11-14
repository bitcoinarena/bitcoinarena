// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ARBITRATION SET, AS A SERVICE (spec 5A.3B "From proof to transaction" steps 1-5). Disjoint from every
// round committee and from settlement: it touches bonds only, never a player stake, a round or a result.
//
// Until this the seats FILED slash proofs (verify.js fileSlashProofs) and said what one would owe (slash-owing.js), and
// arbitration-tx.js could BUILD a path B spend - and nothing ever signed or posted one. Here:
//   1. INTAKE: a filed proof, its evidence (the accused node's own signed result), the objection bundle that held against
//      that result, the entry and the round - read from a seat, believed for nothing.
//   2. THE ONE JUDGEMENT, MADE HERE: the bundle is checked and REPLAYED again with the round's core under the round's
//      beacon (checkObjectionBundle, the function a seat's objection door runs) - it must contradict exactly the result
//      the proof names - and the accused's signature over that result is verified. Then slashHolds' comparisons:
//      committee member, same round/player/transcript, the bond the node's own advertisement names.
//   3. slash_height: at or below the tip, at or above the round's census height (slashHeightIsValid); the distribution
//      from the census at that height (slashDistribution): players' escrow, nodes, developers.
//   4. THE TRANSACTION: path B of the bond, nLockTime = slash_height, OP_RETURN = H(proof) || slash_height || hint,
//      three outputs (arbitrationSpend). Each member signs the leaf's sighash on its own (BIP-342 CHECKSIGADD: k plain
//      BIP-340 signatures, no MuSig on this path).
//   5. Fewer than k signatures is never posted; k or more is checked by testmempoolaccept and only then broadcast.
// The nodes' and developers' outputs go to the arbitration escrow too (k-of-m), to be paid on by the same set: the spec
// names who is paid, not the script (arbitration-tx.js) - and the federation step (pegin) waits for the stake-lock tool.
import * as nodeFs from 'node:fs';
import { readBody, BODY_MOST } from './body-read.js';
// kanban #1592: the arbiter's MuSig doors take a few hundred bytes; 64 KiB is ample
const ARBITER_DOOR_MOST = 64 * 1024;
import { schnorr } from '@noble/curves/secp256k1.js';
import { genesisFor } from '../../arena-protocol/src/genesis.js';
import { taggedHash, toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { decodeSpentSet, spentNonceSet, newestSpentSet } from '../../arena-protocol/src/spent-set.js';
import { splitSignedRecord, verifyFederationRecord } from '../../arena-protocol/src/federation-record.js';
import { liquidationSchedule } from '../../arena-protocol/src/federation-slash.js';
import { slashHolds, slashProofId, slashHeightIsValid, slashDistribution, splitSlashEvidence, REPLAY_CONTRADICTS } from '../../arena-protocol/src/slash.js';
import { splitSignedResult, decodePlayerResult, resultId } from '../../arena-protocol/src/result.js';
import { arbitrationSpend, arbitrationSighash, arbitrationWitness, arbitrationTransaction, escrowOutput, escrowSpend } from '../../arena-protocol/src/arbitration-tx.js';
import { refundKeyOf } from '../../arena-protocol/src/stake-lock.js';
import { bondOutputKey, bondInternalKey, slashLeaf, tapLeafHash, controlBlockFor, bondMaturityOf } from '../../arena-protocol/src/bond-script.js';
import { decodeObjectionBundle } from '../../arena-protocol/src/objection.js';
import { transcriptHash, decodeTranscript } from '../../arena-protocol/src/transcript.js';
import { checkObjectionBundle } from './objection-check.js';
import { runId } from './verdict.js';
import { tweakPoint, combine } from './curve.js';
import { keyedPay, runPayouts } from './keyed-payout.js';
import { nonceGen, bondSigningContext, bondPartialSign, MusigError } from './musig2.js';
import { pluginForRound, hostedPlugins, itemUnlocksOf } from './plugins.js';
import { bodyBudget } from './body-budget.js';

// the arbiter's body limits (kanban #1724, #1794; see serveArbiter)
const ARBITER_MUSIG_MOST = 64 * 1024;
const ARBITER_CLAIM_MOST = 1024 * 1024;
// ALL ARBITER BODIES IN FLIGHT SHARE ONE BUDGET (kanban #1911, #1953): the limits above are per request, so 150 parallel unfinished
// claim bodies just under 1 MiB pinned ~150 MiB. 8 MiB together (ARENA_ARBITER_BODY_BUDGET), counted on bytes received, one address
// at most half, a small body always admitted from a reserve, a body silent for 10 s dropped (body-budget.js, as server.js)
const ARBITER_BODY_BUDGET = Math.max(ARBITER_CLAIM_MOST, Number(process.env.ARENA_ARBITER_BODY_BUDGET) > 0 ? Number(process.env.ARENA_ARBITER_BODY_BUDGET) : 8 * ARBITER_CLAIM_MOST);
const arbiterBodies = bodyBudget({ total: ARBITER_BODY_BUDGET, perAddress: Math.max(ARBITER_CLAIM_MOST, Math.floor(ARBITER_BODY_BUDGET / 2)), reserve: 1024 * 1024, smallMost: ARBITER_MUSIG_MOST, defaultMax: ARBITER_CLAIM_MOST });
// a request not received whole within 30 s ends (ARENA_ARBITER_REQUEST_TIMEOUT_MS; Node's default is 300 s)
const ARBITER_REQUEST_MS = Number(process.env.ARENA_ARBITER_REQUEST_TIMEOUT_MS) > 0 ? Number(process.env.ARENA_ARBITER_REQUEST_TIMEOUT_MS) : 30000;

/** THE ROUND'S CORE, as a seat's verifier resolves it (verify.js #coreOf): its plugin's, with the round's world rule. */
export function coreForRound(contract, roundIdBytes, plugins) {
  const found = pluginForRound(contract, hostedPlugins(plugins));
  return found.ok ? { ...found.core, config: found.config, runTicks: found.runTicks, items: itemUnlocksOf(found.plugin),
    world: { configHash: contract.configHash, censusRoot: contract.censusRoot, roundId: new Uint8Array(roundIdBytes), sharedWorld: [...found.plugin.sharedWorld] } } : null;
}

/**
 * THE MEMBERS OF A TEST NETWORK'S ARBITRATION SET: on regtest and testnet4 the secrets are derivable by anyone, by design
 * (genesis-ids.js), so this service may hold all of them - each its own signer. Mainnet has no set: real keys held by
 * real people are a ruling, not a derivation, and this refuses rather than invents one.
 */
export function arbitrationMembers(network) {
  const chain = { regtest: 'bitcoin-regtest', testnet4: 'bitcoin-testnet4' }[network];
  if (!chain) throw new Error(`${network} has no arbitration set this service may hold`);
  const g = genesisFor(network);
  const members = [];
  for (let i = 0; i < g.arbitrationM; i++) {
    const secret = taggedHash('BLWP/v1/TestArbitration', new TextEncoder().encode(`${chain}:${i}`));
    members.push({ index: i, secret, key: schnorr.getPublicKey(secret) });
  }
  const want = g.arbitrationKeys.map(toHex).sort().join(',');
  if (members.map((m) => toHex(m.key)).sort().join(',') !== want) throw new Error(`the derived keys are not ${network}'s arbitration set`);
  return { members, keys: g.arbitrationKeys, k: g.arbitrationK, network };
}

/**
 * THE JUDGEMENT. `evidence` is a seat's slash-proof record (proof || the accused's signed result); `bundle` the objection
 * that held against that result; `entry` its signed entry contract (decoded), `contract` the round's, `committee` its
 * signer nodes, `advert` the accused's census advertisement with `bond` its census outpoint, `core` the round's core,
 * `roundRandomness` the beacon hash. Answers { slashed, offence, bond, proof, proofId, playerPubkey, why }.
 */
export async function judgeProof({ evidence, bundle, entry, entryId, contract, committee, advert, bondOutpoint, core, roundRandomness, replayRun }) {
  const no = (why) => ({ slashed: false, why });
  let proof, signedResult;
  try { ({ proof, signedResult } = splitSlashEvidence(evidence)); } catch (e) { return no(`not a slash proof record: ${e.message}`); }
  // THE ACCUSED'S OWN SIGNATURE over the result the proof names: evidence anybody could have written is no evidence
  let body;
  try {
    const s = splitSignedResult(signedResult);
    body = decodePlayerResult(s.body);
    if (!schnorr.verify(s.signature, resultId(body), body.nodePubkey)) return no('the result attached is not signed by the node it names');
  } catch (e) { return no(`the result attached does not read: ${e.message}`); }
  // THE REPLAY, AGAIN, HERE: the objection that held against exactly this result
  if (!(bundle instanceof Uint8Array) || !bundle.length) return no('no objection bundle to replay');
  // THE RUN, NOT THE SIGNER'S RECORD: an objection names the committee's run (a result with no signer), and the accused is
  // slashed for having signed THAT run - so its own result must be the run the objection contradicts
  let objected;
  try { objected = decodeObjectionBundle(bundle).objection.signedResultId; } catch (e) { return no(`that is not an objection bundle: ${e.message}`); }
  if (toHex(runId(body)) !== toHex(objected)) return no('the accused signed another run than the one the objection contradicts');
  const checked = await checkObjectionBundle({ bundle, roundId: proof.roundId, entryId, entry, contract, committee,
    signedResultId: objected, core, roundRandomness,
    verify: (sig, msg, key) => { try { return schnorr.verify(sig, msg, key); } catch { return false; } },
    ...(replayRun ? { replayRun } : {}) });
  if (!checked.holds) return no(`the replay does not contradict that result: ${checked.why}`);
  let canonical;
  try { canonical = transcriptHash(decodeTranscript(decodeObjectionBundle(bundle).transcript)); } catch { canonical = null; }
  const held = slashHolds({ proof, signedResult, committee, canonicalTranscriptHash: canonical, replayDiffers: true,
    advert: advert ? { ...advert, bondTxid: bondOutpoint.txid, bondVout: bondOutpoint.vout } : null });
  if (!held.slashed) return no(held.why);
  return { slashed: true, offence: held.offence, bond: held.bond, proof, proofId: slashProofId(proof), playerPubkey: proof.playerPubkey, why: held.why };
}

/**
 * THE SLASHING TRANSACTION FOR A JUDGED PROOF, unsigned: its sighash and what its witness needs.
 * `bond` is { txid (internal order), vout, value (BigInt sat), script } as the chain holds it; `advert` the accused's
 * (its template and maturity rebuild the bond's tree); `censusNodes` the census keys at `slashHeight`; `seats` the round's.
 */
export function buildSlash({ verdict, bond, advert, contract, roundId, slashHeight, tipHeight, censusNodes, seats, set, feeSats = 2000n, hint = new TextEncoder().encode('arena') }) {
  const h = slashHeightIsValid({ slashHeight, censusHeight: contract.censusHeight, tipHeight });
  if (!h.ok) return { ok: false, why: h.why };
  // AS slash-owing.js PAYS IT: the accused out of the census it would be paid from, the round's seats out by the rule
  const accused = toHex(verdict.proof.nodePubkey);
  let distribution;
  try {
    distribution = slashDistribution({ bondSats: bond.value, roundId, contract, affectedPlayers: [verdict.playerPubkey],
      censusNodes: censusNodes.filter((k) => toHex(k) !== accused), seats });
  } catch (e) { return { ok: false, why: e.message }; }
  const maturity = bondMaturityOf(advert, { genesisMaturity: genesisFor(set.network).bondMaturity, network: set.network });
  if (!maturity.ok) return { ok: false, why: maturity.why };
  const nodeKey = advert.nodePubkey;
  const internalKey = bondInternalKey({ nodeKey, arbitrationKeys: set.keys }, { combine }).internalKey;
  const tree = bondOutputKey({ nodeKey, arbitrationKeys: set.keys, arbitrationK: set.k, bondMaturity: maturity.maturity, internalKey }, { tweakPoint, combine });
  if (!tree.ok) return { ok: false, why: tree.why };
  if (toHex(bond.script.subarray(2, 34)) !== toHex(tree.outputKey)) return { ok: false, why: 'that output is not the bond this node\'s advertisement builds' };
  const escrow = escrowOutput({ arbitrationKeys: set.keys, k: set.k }, { tweakPoint, combine });
  const built = arbitrationSpend({ bond, proofId: verdict.proofId, slashHeight, hint, distribution, feeSats,
    escrowScript: escrow.script, nodesScript: escrow.script, developersScript: escrow.script });
  if (!built.ok) return built;
  const leaf = tapLeafHash(slashLeaf(set.keys, set.k));
  return { ok: true, built, leaf, sighash: arbitrationSighash(built, leaf), controlBlock: controlBlockFor('slash', tree).controlBlock, distribution };
}

/**
 * THE ESCROW INTO THE FEDERATION (§5A.3B): the set's spend of a players' escrow output (`escrow`: { txid
 * (internal order), vout, value }) to the peg-in script `toScript`. The escrow must be the set's own escrowOutput; answers
 * the same shape as buildSlash, so memberSign and assemble take it as they take path B.
 */
export function buildEscrowPegin({ escrow, set, toScript, feeSats = 1000n }) {
  const out = escrowOutput({ arbitrationKeys: set.keys, k: set.k }, { tweakPoint, combine });
  if (escrow.script && toHex(escrow.script) !== toHex(out.script)) return { ok: false, why: 'that output is not this arbitration set\'s escrow' };
  const built = escrowSpend({ escrow: { ...escrow, script: out.script }, toScript, feeSats });
  if (!built.ok) return built;
  return { ok: true, built, leaf: out.leaf, sighash: arbitrationSighash(built, out.leaf), controlBlock: out.controlBlock, escrow: out };
}

// AFTER PATH B (spec §5A.3B: "the arbitration set pegs it into the round's federation and locks each share to its player",
//): once the slash is confirmed, its players' escrow is spent by k of the set to a peg-in address of the
// arbiter's own client of the round's federation (ARENA_ARBITER_CLIENT_DIR, through ARENA_STAKE_LOCK_BIN), claimed, and each
// wronged player's share locked to refundKeyOf(their entry key) - the key a settlement's payout names, so the page collects
// it the same way. Each step is kept (`keep`, the service's state file) before the next, so a restart picks up where it
// stopped. `bin` is the stake-lock tool, `dir` its client of the round's federation, `rpc` the arbiter's own bitcoind.
export async function payOutSlash({ proof, v, set, rpc, keep = () => {}, say = () => {}, bin, dir: dataDir, feeSats = 1000n, env: runEnv = process.env }) {
  if (!bin || !dataDir) return { why: 'no client of the round\'s federation here (ARENA_STAKE_LOCK_BIN, ARENA_ARBITER_CLIENT_DIR)' };
  const { execFile } = await import('node:child_process');
  const run = (args, timeoutMs = 120000) => new Promise((done) => execFile(bin, args, { timeout: timeoutMs, maxBuffer: 1 << 24, env: runEnv },
    (err, out) => { const line = String(out || '').split('\n').find((l) => l.startsWith('{')); done(line ? JSON.parse(line) : { error: String((err && err.message) || 'no answer').slice(0, 200) }); }));
  const dir = ['--data-dir', dataDir];
  if (!v.escrowTxid && v.escrowIntent) {
    const i = v.escrowIntent;
    const r = await resumeIntent(rpc, i, { txid: v.posted, vout: i.vout });
    if (!r.ok) { delete v.escrowIntent; keep(); return { why: `the recorded escrow spend is refused: ${r.why}` }; }
    Object.assign(v, { escrowTxid: i.txid, pegInAddress: i.pegInAddress, pegInSats: i.pegInSats }); delete v.escrowIntent; keep();
    say({ proof: proof.slice(0, 16), escrowIntoFederation: i.txid, sats: i.pegInSats, resumed: r.landed ? 'found' : r.inferred ? 'its input is spent' : 'sent again' });
  }
  if (!v.escrowTxid) {
    // THE ESCROW OUTPUT FROM THE UTXO SET (gettxout: no transaction index needed): path B carries at most four outputs
    const escrow = escrowOutput({ arbitrationKeys: set.keys, k: set.k }, { tweakPoint, combine });
    let o = null;
    for (let n = 0; n < 6 && !o; n++) {
      const x = await rpc('gettxout', [v.posted, n, false]).catch(() => null);
      if (x && x.scriptPubKey.hex === toHex(escrow.script) && BigInt(Math.round(x.value * 1e8)) === BigInt(v.playersSats)) o = { n, confirmations: x.confirmations };
    }
    if (!o) return { why: 'path B holds no unspent players\' escrow of that amount (not confirmed and seen yet, or spent)' };
    if (!(o.confirmations >= 1)) return { why: 'path B is not confirmed yet' };
    const addr = await run(['--mode', 'pegin-address', ...dir]);
    if (!addr.address) return { why: `no peg-in address: ${addr.error || JSON.stringify(addr)}` };
    const toScript = fromHex((await rpc('validateaddress', [addr.address])).scriptPubKey);
    const spend = buildEscrowPegin({ escrow: { txid: fromHex(v.posted).reverse(), vout: o.n, value: BigInt(v.playersSats), script: escrow.script }, set, toScript,
      feeSats });
    if (!spend.ok) return { why: spend.why };
    const signed = assemble({ slash: spend, signatures: set.members.slice(0, set.k).map((m) => ({ key: m.key, sig: memberSign(m, spend.sighash) })), set });
    if (!signed.ok) return { why: signed.why };
    // RECORDED BEFORE ITS BROADCAST (kanban #1232): a lost answer left the escrow spent and every later pass "no unspent escrow"
    const txid = await txidOf(rpc, signed.hex);
    if (txid) { v.escrowIntent = { txid, hex: signed.hex, vout: o.n, pegInAddress: addr.address, pegInSats: String(spend.built.amounts.pegIn) }; keep(); }
    const sent = await post(rpc, signed.hex);
    if (!sent.ok) { delete v.escrowIntent; keep(); return { why: sent.why }; }
    Object.assign(v, { escrowTxid: sent.txid, pegInAddress: addr.address, pegInSats: String(spend.built.amounts.pegIn) }); delete v.escrowIntent; keep();
    say({ proof: proof.slice(0, 16), escrowIntoFederation: sent.txid, sats: String(spend.built.amounts.pegIn) });
  }
  if (!v.claimedMsat) {
    const c = await run(['--mode', 'pegin-claim', ...dir, '--address', v.pegInAddress, '--timeout-s', '840'], 900000);
    if (!(c.balance_after_msat > c.balance_before_msat)) return { why: `the peg-in is not claimed yet: ${c.error || JSON.stringify(c)}` };
    v.claimedMsat = String(c.balance_after_msat - c.balance_before_msat); keep();
  }
  if (!v.payouts) {
    // THE SHARES AS THE DISTRIBUTION NAMES THEM, scaled to what the federation credited (the peg-in's own fee came off it)
    const want = v.players.reduce((t, p) => t + BigInt(p.sats) * 1000n, 0n);
    const have = BigInt(v.claimedMsat);
    const payouts = v.players.map((p) => ({ key: toHex(refundKeyOf(fromHex(p.key))), msat: have >= want ? BigInt(p.sats) * 1000n : (BigInt(p.sats) * 1000n * have) / want }));
    // THE PAYOUT ONCE (kanban #1174, keyed-payout.js): its record ASKED - key (the proof) and list - written before the tool; after a stop it is read
    // back under its key (pay-sent), never paid twice; a tool without pay-sent holds it
    if (!v.pay) v.pay = {};
    const got = await keyedPay({ rec: v.pay, save: keep, list: payouts, key: `slash-arb:${proof}`,
      ...runPayouts((args) => run([...args.slice(0, 2), ...dir, ...args.slice(2)], 300000)) });
    if (!got.ok) return { why: `no payout transaction: ${got.why}`, held: !!got.held };
    const paid = { txid: got.txid, payouts: got.payouts };
    v.payouts = paid.payouts.map((x) => ({ round: v.round, entry: v.entry, refundPk: x.refund_pk, msat: String(x.amount_msat), txid: paid.txid, outIdx: x.out_idx, contractId: x.contract_id }));
    keep();
    say({ proof: proof.slice(0, 16), paid: v.payouts.length, txid: paid.txid });
  }
  return { paid: v.payouts.length };
}

/** One member's signature: its own key over the spend's sighash, nothing else. */
export const memberSign = (member, sighash) => schnorr.sign(sighash, member.secret);

/**
 * THE SIGNED TRANSACTION, ONLY FROM k VERIFIED SIGNATURES. `signatures` is [{ key, sig }]; each is checked against its
 * key and the sighash, and a key outside the set counts for nothing. Fewer than k: refused, nothing to post.
 */
export function assemble({ slash, signatures, set }) {
  const byKey = new Map();
  const members = new Set(set.keys.map(toHex));
  for (const { key, sig } of signatures) {
    const k = toHex(key);
    if (!members.has(k)) continue;
    let good = false; try { good = schnorr.verify(sig, slash.sighash, key); } catch { good = false; }
    if (good) byKey.set(k, sig);
  }
  if (byKey.size < set.k) return { ok: false, why: `${byKey.size} valid arbitration signatures, and path B needs ${set.k}: nothing is posted` };
  const w = arbitrationWitness({ arbitrationKeys: set.keys, k: set.k, signatures: byKey, controlBlock: slash.controlBlock });
  if (!w.ok) return w;
  const bytes = arbitrationTransaction(slash.built, w.witness);
  return { ok: true, hex: toHex(bytes), signers: byKey.size };
}

/**
 * A TRANSACTION THE ARBITER RECORDED BEFORE IT BROADCAST IT, FOUND (kanban #1232): in the mempool or a block (getrawtransaction), or its output
 * `vout` unspent in either (gettxout) - then it was posted, whatever answer its broadcast got. False when neither knows it.
 */
export async function intentLanded(rpc, txid, vout = 1) {
  try { if (await rpc('getrawtransaction', [txid])) return true; } catch { /* no txindex, or not there */ }
  try { if (await rpc('gettxout', [txid, vout, true])) return true; } catch { /* not there */ }
  return false;
}
/** WRITTEN WHOLE OR NOT AT ALL (kanban #1232): a temp file, synced, renamed over `path` - a stop mid-write leaves the last good file. */
export function writeJsonAtomic(path, value, { fs = null } = {}) {
  const f = fs || nodeFs;
  const tmp = `${path}.tmp`;
  f.writeFileSync(tmp, JSON.stringify(value, null, 1));
  try { const fd = f.openSync(tmp, 'r'); f.fsyncSync(fd); f.closeSync(fd); } catch { /* synced as the file system allows */ }
  f.renameSync(tmp, path);
}

/** TESTMEMPOOLACCEPT, THEN BROADCAST - never the other way: `rpc(method, params)` is the arbiter's own bitcoind. */
/**
 * THE SPENT SET A LIQUIDATION IS PAID AGAINST, FROM EVERY SEAT (kanban #1236, audit 2 #1204 RES-4): the arbiter took the first copy the
 * first seat listed, unchecked - a seat holding an older session (or none after a restart, or one serving an old signed copy) let notes
 * already redeemed in the federation be claimed and paid from the escrow. `listings` are the seats' GET /liquidations rows of one
 * federation. The record is the one most seats list (a seat can list a wrong one, not outvote the rest); every copy any seat lists is
 * checked against it (spentSetStands: of that federation, signed by one of its guardians) and the newest session signed wins
 * (newestSpentSet). Answers { spentNonces, session, signers } or { spentNonces: null, why }.
 */
export function spentSetFromSeats(listings, { verify, readRecord = (hex) => splitSignedRecord(fromHex(hex)).record, record: given = null }) {
  const votes = new Map();
  for (const l of listings || []) { const r = l && (l.record || l.haltRecord); if (typeof r === 'string' && r) votes.set(r, (votes.get(r) || 0) + 1); }
  const recHex = [...votes.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map((e) => e[0])[0] || null;
  // THE VERIFIED HALT RECORD, when the caller holds one (kanban #2617): the copies are checked against it, not against the one most listings name
  if (!given && !recHex) return { spentNonces: null, why: 'no seat lists the federation\'s record: no spent set can be checked' };
  let record = given; if (!record) { try { record = readRecord(recHex); } catch (e) { return { spentNonces: null, why: `the record the seats list does not read: ${e.message}` }; } }
  if (!record) return { spentNonces: null, why: 'the record the seats list does not read' };
  const copies = []; const seen = new Set();
  for (const l of listings || []) {
    for (const c of (l && l.spentSet && l.spentSet.copies) || []) {
      const k = `${c && c.spentSet}:${c && c.signature}`; if (seen.has(k)) continue; seen.add(k);
      try { copies.push({ ...decodeSpentSet(fromHex(String(c.spentSet))), signature: fromHex(String(c.signature)) }); } catch { /* not a copy */ }
    }
  }
  // THE HALT'S BOUND (kanban #1262): the halt proof's session as most seats list it, + 1
  const halts = new Map();
  for (const l of listings || []) { const hs = l && l.haltProof && l.haltProof.session; if (Number.isInteger(hs)) halts.set(hs, (halts.get(hs) || 0) + 1); }
  const haltSession = [...halts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map((e) => e[0])[0];
  const pick = newestSpentSet(copies, { record, verify, maxSession: Number.isInteger(haltSession) ? haltSession + 1 : null });
  return pick.copy ? { spentNonces: spentNonceSet(pick.copy), session: pick.session, signers: pick.signers } : { spentNonces: null, why: pick.why };
}

const verifySchnorr = (sig, m, k) => { try { return schnorr.verify(sig, m, k); } catch { return false; } };

/**
 * IS THIS THE HALT A LIQUIDATION MAY COUNT FROM? (kanban #2617, feedback #046) `bytes` a signed record some seats list, believed for nothing.
 * It stands only as a HALTED record of `fid`, at or below this arbiter's `tip`, signed by thresholdOf(max(nominal, keys)) of the federation's
 * own guardians: `keys` its config's broadcast_public_keys (trusted-guardian-keys.js, or a config the arbiter holds), `census` this arbiter's
 * own census at the record's height (entries with pubkey and advert). No keys: refused - a record judged by counting alone loses to bonds
 * (#2599-#2615). Answers verifyFederationRecord's verdict, or { ok: false, why }.
 */
export function verifyHaltRecord(bytes, { fid, keys, census, tip, networkId = null, inviteFederationId, verify = verifySchnorr }) {
  let r; try { r = splitSignedRecord(bytes).record; } catch (e) { return { ok: false, why: `it does not read: ${e.message}` }; }
  if (toHex(r.federationId) !== String(fid).toLowerCase()) return { ok: false, why: 'it is another federation\'s record' };
  if (!Number.isInteger(tip) || r.height > tip) return { ok: false, why: `its height ${r.height} is above this arbiter's tip ${tip}` };
  if (!Array.isArray(keys) || !keys.length) return { ok: false, why: 'this arbiter holds no guardian keys of that federation: no halt record can be checked' };
  const v = verifyFederationRecord(bytes, { census, verify, inviteFederationId, networkId, guardianKeys: keys });
  if (!v.ok) return v;
  if (v.status !== 'HALTED') return { ok: false, why: `it says ${v.status}, not HALTED` };
  return v;
}

/**
 * THE LIQUIDATION THE ARBITER SETTLES, FROM EVERY SEAT AND ITS OWN CHECKS (kanban #2617, feedback #046). It took the first seat's listing whole:
 * haltHeight, liquidatesAt, claimWindowCloses, lateClaimsUntil and haltRecord unchecked - one seat listed first moved the halt back, voided every
 * claim and named the remainder's payees through an unsigned record. Now:
 *   THE RECORD     the halt record a STRICT MAJORITY of the arbiter's `seatCount` seats list (which HALTED record starts the run is each seat's
 *                  history, not derivable here), and it must stand: `verifyHalt(bytes)` (verifyHaltRecord - HALTED, signed by the guardians
 *                  whose keys this arbiter holds). A halt proof alone (no record) is not settled here.
 *   THE CLOCKS     haltHeight is that record's height; liquidatesAt, the window, the late tail and the split are liquidationSchedule over this
 *                  arbiter's own `clocks` - nothing a seat says about them is read.
 *   FROZEN         `frozen` (the halt height kept at the first good pass): a later record at another height is refused, not followed.
 *   THE REST       the spent set checked against the verified record (spentSetFromSeats); the issued set only as a strict majority lists it.
 * Answers { ok: true, haltHeight, record (the verified record), haltRecord (hex), ... } or { ok: false, why } - the arbiter then settles nothing.
 */
export async function liquidationFromSeats(fidHex, listings, { seatCount, clocks, verifyHalt, verify = verifySchnorr, frozen = null }) {
  const fid = String(fidHex).toLowerCase();
  const rows = (listings || []).filter((l) => l && String(l.federation || '').toLowerCase() === fid);
  if (!rows.length) return { ok: false, why: 'no seat lists that federation as liquidating' };
  const n = Math.max(Number(seatCount) || 0, rows.length);
  const need = Math.floor(n / 2) + 1;
  const votes = new Map();
  for (const l of rows) { const h = typeof l.haltRecord === 'string' ? l.haltRecord.toLowerCase() : ''; if (h && /^[0-9a-f]+$/.test(h)) votes.set(h, (votes.get(h) || 0) + 1); }
  const [recHex, count] = [...votes.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0] || [null, 0];
  if (!recHex) return { ok: false, why: 'no seat lists a signed HALTED record of that federation: a halt proof alone is not settled by this arbiter' };
  if (count < need) return { ok: false, why: `the seats disagree on the halt record: the most listed one is listed by ${count} of ${n} seats, ${need} needed` };
  let v; try { v = await verifyHalt(fromHex(recHex)); } catch (e) { v = { ok: false, why: e.message }; }
  if (!v || !v.ok) return { ok: false, why: `the halt record ${count} of ${n} seats list does not stand: ${(v && v.why) || 'not verified'}` };
  const haltHeight = Number(v.record.height);
  if (frozen && Number.isInteger(frozen.height) && frozen.height !== haltHeight)
    return { ok: false, why: `the seats now list a halt at ${haltHeight}; this arbiter counts from ${frozen.height} since its first pass` };
  const when = liquidationSchedule({ haltHeight, clocks });
  if (!when.ok) return { ok: false, why: when.why };
  const ss = spentSetFromSeats(rows, { verify, record: v.record });
  // the issued set (pending outputs): only as a strict majority of the seats list it, element for element
  const issuedVotes = new Map();
  for (const l of rows) if (Array.isArray(l.issuedHashes)) { const k = JSON.stringify(l.issuedHashes.map((h) => String(h).toLowerCase()).sort()); issuedVotes.set(k, (issuedVotes.get(k) || 0) + 1); }
  const [issuedKey, issuedCount] = [...issuedVotes.entries()].sort((a, b) => b[1] - a[1])[0] || [null, 0];
  return { ok: true, federation: fid, haltHeight, haltRecord: recHex, record: v.record, haltSigners: v.signers, seatsAgree: count, seats: n,
    liquidatesAt: when.claimWindowOpens, claimWindowCloses: when.claimWindowCloses, lateClaimsUntil: when.lateClaimsUntil, remainderSplitsAt: when.remainderSplitsAt,
    spentNonces: ss.spentNonces, spentSetSession: ss.session ?? null, ...(ss.spentNonces === null ? { spentSetWhy: ss.why } : {}),
    issuedHashes: issuedKey && issuedCount >= need ? JSON.parse(issuedKey) : null };
}

/**
 * A RECORDED SPEND RESUMED (kanban #1232): `intent` { txid, hex } was kept before its broadcast, spending `input` { txid, vout }, an
 * output only this set signs. Found on the chain or in the mempool: posted. Its input spent: posted too (nobody else can spend it).
 * Its input still unspent: the same bytes are sent again. Refused with the input unspent: { ok: false, drop: true } - built anew.
 */
export async function resumeIntent(rpc, intent, input) {
  if (await intentLanded(rpc, intent.txid, 0)) return { ok: true, landed: true };
  // AN ERROR IS NOT "SPENT" (audit 5 #1403): a bitcoind still warming up (-28) or a timeout read as a spent input marked a slash posted that never
  // went out, and its intent was dropped for good - the bond never slashed. Only gettxout's own null (no such unspent output) is spent.
  let still;
  try { still = await rpc('gettxout', [input.txid, input.vout, true]); } catch (e) { return { ok: false, why: `the chain could not be read: ${String((e && e.message) || e).slice(0, 120)}` }; }
  if (!still) return { ok: true, inferred: true };
  const sent = await post(rpc, intent.hex);
  return sent.ok ? { ok: true, again: true } : { ok: false, drop: true, why: sent.why };
}

/**
 * A KEPT SLASH INTENT, RESUMED (kanban #1357, audit 4 fixesA-3): `intent` { txid, hex, bond: { txid, vout }, slashHeight }. Answers
 *   { step: 'posted', why }   on the chain or in the mempool, its bond spent (only this set signs it), or its bytes sent again
 *   { step: 'wait', why }     refused, and younger than `rebuildBlocks` past its slash height: a node that lost it while its peers hold it
 *   { step: 'rebuild', why }  refused with its bond unspent, `rebuildBlocks` past its slash height: built anew
 * Never a new build while the first one may still confirm - a later tip gives another locktime and txid, and the escrow of the one that
 * confirmed was never paid out.
 */
export async function resumeSlashIntent(rpc, intent, { rebuildBlocks = 6 } = {}) {
  const r = await resumeIntent(rpc, intent, intent.bond).catch((e) => ({ ok: false, why: e.message }));
  if (r.ok) return { step: 'posted', why: r.landed ? 'its recorded slash is on the chain' : r.again ? 'its recorded slash sent again' : 'its bond is spent: the recorded slash' };
  const tip = await rpc('getblockcount').then(Number).catch(() => null);
  if (r.drop && tip !== null && tip >= Number(intent.slashHeight) + rebuildBlocks) return { step: 'rebuild', why: r.why };
  return { step: 'wait', why: r.why || 'no answer' };
}

/** The display txid of a signed transaction's hex, or null (kanban #1232). */
export async function txidOf(rpc, hex) { try { return String((await rpc('decoderawtransaction', [hex])).txid); } catch { return null; } }

export async function post(rpc, hex) {
  const [r] = await rpc('testmempoolaccept', [[hex]]);
  // SENT BEFORE (kanban #1232): the same bytes already in the mempool are this transaction posted, its answer lost
  if (r && !r.allowed && /txn-already-in-mempool|txn-already-known|txn-same-nonwitness-data-in-mempool/.test(String(r['reject-reason'] || ''))) return { ok: true, txid: r.txid, tested: r, again: true };
  if (!r || !r.allowed) return { ok: false, why: `the mempool refuses it: ${r && r['reject-reason']}`, tested: r };
  const txid = await rpc('sendrawtransaction', [hex]);
  return { ok: true, txid, tested: r };
}

// ---- the arbitration set's half of a cooperative key-path spend (POST /musig/nonce, /musig/partial) ----

/**
 * THE MEMBERS AS ONE MUSIG2 PARTY for a bond's key path (spec 5A.3B key path). A session is opened by a
 * coordinator with the bond's node key, its tree's tweak and the 32-byte sighash; each member draws its nonce pair here
 * and keeps its secret nonce, and signs once, only for the message the session was opened with. `allow(session)` is the
 * set's policy - which spends it agrees to (a release with no open proof against the node, a judged slash).
 *
 * ONE SESSION, ONE STATE (kanban #1194, the state machine audit of 2026-11-06): MUSIG_SESSION open (nonces drawn) -> signing (taken by one partial ask,
 * before any signature) -> closed (signed, refused or failed; the session and its secret nonces are dropped). Moved by musigSessionStep only, compare and set.
 * `allow` is asked at the nonce AND again at the partial, for the very spend the nonce was drawn for: a proof that arrives between the two calls stops the
 * signature. The secret nonces live in this process alone and are never written: a restart loses every open session, so no nonce can sign twice across one.
 */
export const MUSIG_SESSION = Object.freeze({ OPEN: 'open', SIGNING: 'signing', CLOSED: 'closed' });
const MUSIG_MOVES = Object.freeze({ [MUSIG_SESSION.OPEN]: [MUSIG_SESSION.SIGNING, MUSIG_SESSION.CLOSED], [MUSIG_SESSION.SIGNING]: [MUSIG_SESSION.CLOSED], [MUSIG_SESSION.CLOSED]: [] });
/** The session moved from `from` to `to`: false, nothing changed, unless it is in `from` now and MUSIG_MOVES allows it. */
export function musigSessionStep(s, from, to) {
  if (!s || s.state !== from || !MUSIG_MOVES[from].includes(to)) return false;
  s.state = to;
  return true;
}

export function musigParty({ set, allow = () => ({ ok: false, why: 'no spend is agreed to' }) }) {
  const sessions = new Map();
  const ask = (s) => { try { const may = allow({ nodeKey: s.nodeKey, msg: s.msg, spend: s.spend }); return may && typeof may.ok === 'boolean' ? may : { ok: false, why: 'the policy gave no answer' }; } catch (e) { return { ok: false, why: `the policy could not be read: ${String(e.message || e).slice(0, 160)}` }; } };
  const close = (sessionId, s) => { musigSessionStep(s, s.state, MUSIG_SESSION.CLOSED); for (const d of s.drawn) d.secnonce = null; sessions.delete(sessionId); };
  return {
    nonce({ sessionId, nodeKey, tweak, msg, spend }) {
      if (sessions.has(sessionId)) return { ok: false, why: 'that session is open already' };
      const may = ask({ nodeKey, msg, spend });
      if (!may.ok) return may;
      const bctx = bondSigningContext({ nodeKey, arbitrationKeys: set.keys, tweak });
      const drawn = set.members.map((m) => ({ m, ...nonceGen({ pk: Uint8Array.from([2, ...m.key]), sk: m.secret, msg }) }));
      sessions.set(sessionId, { state: MUSIG_SESSION.OPEN, nodeKey, spend: spend ?? null, bctx, msg, drawn });
      return { ok: true, outputKey: toHex(bctx.outputKey), pubnonces: drawn.map((d) => ({ member: toHex(d.m.key), pubnonce: toHex(d.pubnonce) })) };
    },
    partial({ sessionId, aggnonce }) {
      const s = sessions.get(sessionId);
      if (!s) return { ok: false, why: 'no such session' };
      if (!musigSessionStep(s, MUSIG_SESSION.OPEN, MUSIG_SESSION.SIGNING)) return { ok: false, why: 'that session signed already: a nonce is used once' };
      try {
        // THE POLICY AGAIN, NOW (kanban #1194): a proof against the node that arrived after the nonce refuses the signature
        const may = ask(s);
        if (!may.ok) return may;
        const psigs = s.drawn.map((d) => ({ member: toHex(d.m.key), psig: toHex(bondPartialSign(s.bctx, {
          who: s.bctx.inner.pks.findIndex((p) => toHex(p) === toHex(d.m.key)), sk: d.m.secret, secnonce: d.secnonce, aggnonce: fromHex(aggnonce), msg: s.msg })) }));
        return { ok: true, psigs };
      } catch (e) { return { ok: false, why: e instanceof MusigError ? e.message : String(e.message || e) }; } finally { close(sessionId, s); }
    },
  };
}

export { REPLAY_CONTRADICTS };

/**
 * THE ARBITER'S DOORS: POST /musig/nonce { sessionId, nodeKey, tweak, msg, spend } -> the 7 members'
 * pubnonces; POST /musig/partial { sessionId, aggnonce } -> their partial signatures (each nonce used once); GET /status
 * -> the set and what it posted. `posted` is the arbiter loop's record of path B spends it broadcast.
 */
export async function serveArbiter({ set, allow, port = 0, host = '127.0.0.1', posted = [], payouts = () => [], claims = null, liquidationPayouts = () => [] }) {
  const { createServer } = await import('node:http');
  const party = musigParty({ set, allow });
  // EVERY ARBITER BODY HAS A LIMIT (kanban #1724, #1794, refute of #1469: these doors buffered a body of any size as a string before
  // JSON.parse, so one large POST filled the memory of the service that signs slash and liquidation payouts). A nonce or partial
  // request is a few hundred bytes (ARBITER_MUSIG_MOST, 64 KiB); a claim carries notes (ARBITER_CLAIM_MOST, 1 MiB). Past it the body
  // is dropped, the request ended, and the door answers 413 where it still can.
  // the bytes count against the arbiter's shared budget (kanban #1911, #1953); a refused body is answered before its socket ends
  const readBody = async (req, max) => (await arbiterBodies.read(req, max)).toString('utf8');
  const jsonBody = async (req, res, max, answer) => {
    let raw; try { raw = await readBody(req, max); } catch (e) { if (e && (e.tooLarge || e.busy)) { try { answer(e.tooLarge ? 413 : 503, { ok: false, why: e.message }); } catch { /* gone */ } } return null; }
    try { return { body: JSON.parse(raw) }; } catch { answer(400, { ok: false, why: 'a JSON body' }); return null; }
  };
  const server = createServer(async (req, res) => {
    arbiterBodies.attach(req, res);
    const answer = (code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(body)); };
    // kanban #1592 / #1469: a body past its limit was dropped and the request ended - answer 413 while the socket still takes it
    const tooBig = (e) => { if (!(e && e.tooLarge)) return false; try { res.setHeader('connection', 'close'); answer(413, { ok: false, why: e.message }); } catch { /* gone */ } return true; };
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/status')
      return answer(200, { network: set.network, k: set.k, members: set.members.map((m) => toHex(m.key)), posted });
    // THE SLASH'S PAYOUTS: every share this set locked to a wronged player - round, entry, the player's refund
    // key, msat, and the pre-expired lock's outpoint - for one round with ?round=, else all; a page collects its own
    if (req.method === 'GET' && url.pathname === '/slash-payouts') {
      const round = String(url.searchParams.get('round') || '').toLowerCase();
      if (round && !/^[0-9a-f]{64}$/.test(round)) return answer(400, { ok: false, why: 'a round id, 32 bytes hex' });
      return answer(200, { network: set.network, payouts: payouts().filter((p) => !round || p.round === round) });
    }
    // A HALTED FEDERATION'S CLAIMS (§23A.5): the notes a client presents, and the table the window's end pays
    // THE CLAIMS PAID: each lock the set made to a claim's key - the halted federation, the federation it was paid in
    // (`into`), the key, msat, txid and out_idx - so a page collects its own by Refund, as a slash payout
    if (req.method === 'GET' && url.pathname === '/liquidation-payouts') {
      const fid = String(url.searchParams.get('federation') || '').toLowerCase();
      return answer(200, { network: set.network, payouts: liquidationPayouts().filter((p) => !fid || p.federation === fid) });
    }
    if (url.pathname === '/liquidation-claims' && claims) {
      if (req.method === 'GET') { const p = await claims.plan(url.searchParams.get('federation')); return answer(p.ok ? 200 : (p.status || 409), p); }
      if (req.method === 'POST') {
        const got0 = await jsonBody(req, res, ARBITER_CLAIM_MOST, answer); if (!got0) return undefined;
        const { body } = got0;
        // a pending-output claim (§23A.5 "Notes still in issuance at the halt") names `pending`; a note claim `ecash`
        const got = Array.isArray(body && body.pending) ? await claims.offerPending(body) : await claims.offer(body);
        return answer(got.ok ? 200 : (got.status || 409), got);
      }
    }
    if (req.method !== 'POST' || !['/musig/nonce', '/musig/partial'].includes(url.pathname)) return answer(404, { ok: false, why: 'no such door' });
    const got1 = await jsonBody(req, res, ARBITER_MUSIG_MOST, answer); if (!got1) return undefined;
    const { body } = got1;
    if (!body || typeof body !== 'object') return answer(400, { ok: false, why: 'a JSON object' });
    if (url.pathname === '/musig/nonce') {
      const ok32 = (h) => /^[0-9a-f]{64}$/.test(String(h));
      if (!body.sessionId || !ok32(body.nodeKey) || !ok32(body.tweak) || !ok32(body.msg)) return answer(400, { ok: false, why: 'a session id, a node key, a tweak and a message (32 bytes each, hex)' });
      const r = party.nonce({ sessionId: String(body.sessionId), nodeKey: fromHex(body.nodeKey), tweak: fromHex(body.tweak), msg: fromHex(body.msg), spend: body.spend || null });
      return answer(r.ok ? 200 : 409, r);
    }
    const r = party.partial({ sessionId: String(body.sessionId), aggnonce: String(body.aggnonce || '') });
    return answer(r.ok ? 200 : 409, r);
  });
  server.requestTimeout = ARBITER_REQUEST_MS; server.headersTimeout = Math.min(server.headersTimeout || 60000, ARBITER_REQUEST_MS);   // kanban #1911, #1953
  await new Promise((r) => server.listen(port, host, r));
  return { port: server.address().port, server, close: () => new Promise((r) => server.close(r)) };
}
