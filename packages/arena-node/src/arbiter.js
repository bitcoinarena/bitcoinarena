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
//   3. slash_height: at or below the tip, at or above the round's census height (slashHeightIsValid). What the bond pays is
//      §5A.3's rule v2 (RULED 2026-11-02, kanban #976): each player's real loss, once, the rest to the protocol reserves.
//   4. THE TRANSACTION: path B of the bond, nLockTime = slash_height, OP_RETURN = H(proof) || slash_height || hint,
//      one escrow output (arbitrationSpend). Each member signs the leaf's sighash on its own (BIP-342 CHECKSIGADD: k plain
//      BIP-340 signatures, no MuSig on this path).
//   5. Fewer than k signatures is never posted; k or more is checked by testmempoolaccept and only then broadcast.
//   6. THE ESCROW SPENT (payOutSlash): one peg-in per federation, each loss a payout contract to its player, the rest a payout
//      contract to that federation's reserve key (§27A.9.2); what does not fit stays in the escrow until a federation has room.
import { schnorr } from '@noble/curves/secp256k1.js';
import { genesisFor } from '../../arena-protocol/src/genesis.js';
import { taggedHash, toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { affectedEntries, realLosses, slashHolds, slashProofId, slashHeightIsValid, slashDistribution, splitSlashEvidence, REPLAY_CONTRADICTS, TWO_RESULTS,
  splitAuditSlashEvidence, slashHoldsOnAudit, auditSlashProofId, AUDIT_CONTRADICTED } from '../../arena-protocol/src/slash.js';
import { planEscrowSpend } from '../../arena-protocol/src/slash-reserves.js';
import { finalSigned, splitSignedFinalSig, decodeFinalSig } from '../../arena-protocol/src/final-sig.js';
import { splitSignedRerun, decodeRerunResult } from '../../arena-protocol/src/rerun.js';
import { decodeEntryContract, entryId as entryIdOf, entryFederation } from '../../arena-protocol/src/contracts.js';
import { windowsOf } from '../../arena-protocol/src/window.js';
import { splitSignedResult, decodePlayerResult, resultId } from '../../arena-protocol/src/result.js';
import { arbitrationSpend, arbitrationSighash, arbitrationWitness, arbitrationTransaction, escrowOutput, escrowSpend, escrowSplitSpend } from '../../arena-protocol/src/arbitration-tx.js';
import { refundKeyOf } from '../../arena-protocol/src/stake-lock.js';
import { bondOutputKey, bondInternalKey, slashLeaf, tapLeafHash, controlBlockFor, bondMaturityOf } from '../../arena-protocol/src/bond-script.js';
import { decodeObjectionBundle } from '../../arena-protocol/src/objection.js';
import { transcriptHash, decodeTranscript } from '../../arena-protocol/src/transcript.js';
import { checkObjectionBundle } from './objection-check.js';
import { runId, verifiedFinal } from './verdict.js';
import { entryForSlash } from './slash-owing.js';
import { REMAINDER_FEE_MARGIN_MSAT } from './liquidation-claims.js';
import { tweakPoint, combine } from './curve.js';
import { nonceGen, bondSigningContext, bondPartialSign, MusigError } from './musig2.js';
import { pluginForRound, hostedPlugins, itemUnlocksOf } from './plugins.js';

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
  return { slashed: true, offence: held.offence, bond: held.bond, proof, proofId: slashProofId(proof), playerPubkey: proof.playerPubkey,
    signed: { outcome: body.outcome, score: body.score }, replayed: checked.replayed, contradictedRunId: toHex(objected), why: held.why };
}

/**
 * THE JUDGEMENT OF A PROOF AGAINST A CONTRADICTED AUDIT (§13A.1, kanban #724, #725), as `judgeProof` judges a signed result: the
 * objection that held against the run the AUDIT vouched for is REPLAYED here under the round's core and beacon (checkObjectionBundle,
 * the seat's door), and then slashHoldsOnAudit's comparisons - the AUDIT the proof names, signed by its node, its VRF proof good and
 * the node drawn out of `eligible`/`total` (the round's census less its drawn nodes and its players, auditEligible), signed 30 s before
 * the window's close; its rows the results it vouched for, the proof's entry among them at the objected run; the bond its own
 * advertisement names. `vrf` is the secp256k1 ECVRF (vrf.js makeVrf). Answers what judgeProof answers, so buildSlash takes either.
 */
export async function judgeAuditProof({ evidence, bundle, entry, contract, committee, advert, bondOutpoint, core, roundRandomness, eligible, total, vrf, replayRun }) {
  const no = (why) => ({ slashed: false, why });
  let got;
  try { got = splitAuditSlashEvidence(evidence); } catch (e) { return no(`not a slash proof record against an AUDIT: ${e.message}`); }
  const { proof } = got;
  if (!(bundle instanceof Uint8Array) || !bundle.length) return no('no objection bundle to replay');
  let objected, canonical;
  try {
    const b = decodeObjectionBundle(bundle);
    objected = b.objection.signedResultId;
    canonical = transcriptHash(decodeTranscript(b.transcript));
  } catch (e) { return no(`that is not an objection bundle: ${e.message}`); }
  // THE REPLAY, AGAIN, HERE: the objection that held against exactly the run the AUDIT vouched for - of this round and this entry
  if (toHex(objected) !== toHex(proof.contradictedRunId)) return no('the objection contradicts another run than the one the AUDIT vouched for');
  const checked = await checkObjectionBundle({ bundle, roundId: proof.roundId, entryId: proof.entryId, entry, contract, committee,
    signedResultId: objected, core, roundRandomness,
    verify: (sig, msg, key) => { try { return schnorr.verify(sig, msg, key); } catch { return false; } },
    ...(replayRun ? { replayRun } : {}) });
  if (!checked.holds) return no(`the replay does not contradict that run: ${checked.why}`);
  let closeMs;
  try { closeMs = windowsOf(contract).closeMs; } catch (e) { return no(`the round names no window: ${e.message}`); }
  const held = slashHoldsOnAudit({ proof, audit: got.audit, signature: got.signature, rows: got.rows, entry, eligible, total, vrf,
    verify: (sig, msg, key) => { try { return schnorr.verify(sig, msg, key); } catch { return false; } },
    windowCloseMs: closeMs, canonicalTranscriptHash: canonical, objectedRunId: objected, replayDiffers: true,
    advert: advert ? { ...advert, bondTxid: bondOutpoint.txid, bondVout: bondOutpoint.vout } : null });
  if (!held.slashed) return no(held.why);
  return { slashed: true, offence: held.offence, bond: held.bond, proof, proofId: auditSlashProofId(proof), playerPubkey: proof.playerPubkey,
    replayed: checked.replayed, contradictedRunId: toHex(objected), why: held.why };
}

const verifySchnorr = (sig, msg, key) => { try { return schnorr.verify(sig, msg, key); } catch { return false; } };

/**
 * THE ROUND AS IT SETTLED, FROM A SEAT'S GET /audit-run, believed for nothing: each entry checked against its id, and each entry's run read off the
 * signatures. The run five seats signed FINAL is the one the round settled on (§13A: "FINAL takes 5 of 7 such signatures", and a settlement waits for it),
 * so a seat cannot say a run settled by saying so; with no FINAL shown it is the agreed first run, marked `finalProven: false`.
 * Answers [{ ...entryForSlash, entryId, federation, runId, outcome, score, finalProven }]; an entry with no agreed run has no outcome.
 */
export function settledEntries({ run, roundId, contract, committee, finalAfterMs }) {
  const out = [];
  for (const e of (run && run.entries) || []) {
    let x;
    try { x = decodeEntryContract(fromHex(e.entry)); } catch { continue; }
    if (toHex(entryIdOf(x)) !== e.id) continue;
    const eid = fromHex(e.id);
    const results = new Map();    // run hex -> { outcome, score }
    const records = (e.results || []).map(fromHex);
    for (const r of records) { try { const b = decodePlayerResult(splitSignedResult(r).body); results.set(toHex(runId(b)), { outcome: b.outcome, score: b.score }); } catch { /* not a result */ } }
    for (const r of e.reruns || []) { try { const b = decodeRerunResult(splitSignedRerun(fromHex(r)).body).result; results.set(toHex(runId(b)), { outcome: b.outcome, score: b.score }); } catch { /* not a re-run */ } }
    // WHEN A SEAT HELD A SIGNATURE IS ITS OWN WORD, so a FINAL counts here on its signed time alone: signed after the window's final_after
    const byRun = new Map();
    for (const f of e.finals || []) {
      try { const bytes = fromHex(f); const d = decodeFinalSig(splitSignedFinalSig(bytes).body); const k = toHex(d.runId); byRun.set(k, [...(byRun.get(k) || []), { bytes, seenMs: d.signedAtMs }]); } catch { /* not a signature */ }
    }
    let settled = null, finalProven = false;
    for (const [k, list] of byRun) {
      if (!results.has(k)) continue;
      if (finalSigned({ roundId, entryId: eid, runId: fromHex(k), records: list, committee, slots: contract.settlementSlots, finalAfterMs, verify: verifySchnorr }).ok) { settled = k; finalProven = true; }
    }
    if (!settled) { const seen = verifiedFinal(records, { contract, signerNodes: committee }); if (seen.ok && seen.final) settled = seen.runId; }
    const fed = entryFederation(contract, x);
    out.push({ ...entryForSlash(x), entryId: e.id, federation: fed.ok ? toHex(fed.federationId) : null, runId: settled, finalProven, ...(settled && results.has(settled) ? results.get(settled) : {}) });
  }
  return out;
}

/**
 * THE SLASHING TRANSACTION FOR A JUDGED PROOF, unsigned: its sighash and what its witness needs, and what it pays (§5A.3).
 * `bond` is { txid (internal order), vout, value (BigInt sat), script } as the chain holds it; `advert` the accused's (its template and maturity
 * rebuild the bond's tree); `entries` the round's as they settled (`settledEntries`); `signed` the contradicted run's { outcome, score } (kanban #975);
 * `truth` the corrections earlier proofs of this round made ([{ pubkey, outcome, score }]), `paid` what they pay (key hex -> msat): a late objection
 * adds its own. Only a run proven FINAL can have cost anybody: after an objection in time the result was corrected before any money moved.
 */
export function buildSlash({ verdict, bond, advert, contract, roundId, slashHeight, tipHeight, entries, signed = verdict.signed, truth = [], paid = new Map(), payoutShares = null, set, feeSats = 2000n, hint = new TextEncoder().encode('arena') }) {
  const h = slashHeightIsValid({ slashHeight, censusHeight: contract.censusHeight, tipHeight });
  if (!h.ok) return { ok: false, why: h.why };
  const harmed = affectedEntries({ offence: verdict.offence, playerPubkey: verdict.playerPubkey, entries, signed, replayed: verdict.replayed });
  if (!harmed.ok) return { ok: false, why: harmed.why };
  const named = entries.find((e) => toHex(e.playerPubkey) === toHex(verdict.playerPubkey));
  const settledOnFalse = !!(named && named.finalProven && named.runId === verdict.contradictedRunId && verdict.offence !== TWO_RESULTS && verdict.replayed);
  const correct = [...truth.filter((t) => toHex(t.pubkey) !== toHex(verdict.playerPubkey)), ...(settledOnFalse ? [{ pubkey: verdict.playerPubkey, outcome: verdict.replayed.outcome, score: verdict.replayed.score }] : [])];
  let distribution;
  try {
    const losses = realLosses({ roundId, entries, truth: correct, affected: harmed.affected, minScore: contract.minScore, payoutShares });
    distribution = slashDistribution({ escrowSats: bond.value - feeSats, roundId, contract, losses, paid });
  } catch (e) { return { ok: false, why: e.message }; }
  const maturity = bondMaturityOf(advert, { genesisMaturity: genesisFor(set.network).bondMaturity, network: set.network });
  if (!maturity.ok) return { ok: false, why: maturity.why };
  const nodeKey = advert.nodePubkey;
  const internalKey = bondInternalKey({ nodeKey, arbitrationKeys: set.keys }, { combine }).internalKey;
  const tree = bondOutputKey({ nodeKey, arbitrationKeys: set.keys, arbitrationK: set.k, bondMaturity: maturity.maturity, internalKey }, { tweakPoint, combine });
  if (!tree.ok) return { ok: false, why: tree.why };
  if (toHex(bond.script.subarray(2, 34)) !== toHex(tree.outputKey)) return { ok: false, why: 'that output is not the bond this node\'s advertisement builds' };
  const escrow = escrowOutput({ arbitrationKeys: set.keys, k: set.k }, { tweakPoint, combine });
  const built = arbitrationSpend({ bond, proofId: verdict.proofId, slashHeight, hint, feeSats, escrowScript: escrow.script });
  if (!built.ok) return built;
  const leaf = tapLeafHash(slashLeaf(set.keys, set.k));
  return { ok: true, built, leaf, sighash: arbitrationSighash(built, leaf), controlBlock: controlBlockFor('slash', tree).controlBlock, distribution, truth: correct };
}

/**
 * AN ESCROW INTO ONE FEDERATION (§23A.5 step 4): the set's spend of an escrow output (`escrow`: { txid
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

// AFTER PATH B (§5A.3, §5A.3B step 5, §27A.9.2): once the slash is confirmed its escrow is spent by k of the set, one peg-in per federation, to a
// peg-in address of the arbiter's own client of that federation (`dirOf`, through the stake-lock tool `bin`), and claimed. Each player's loss is locked to
// refundKeyOf(their entry key), the key a settlement's payout names, so the page collects it the same way; the rest of that federation's claim is a
// payout contract to its reserve key, which enters as any reserve (`slash` in GET /reserves). What did not fit went back to the same escrow, and a later pass
// spends it when a federation has room. Each step is kept (`keep`, the service's state file) before the next, so a restart picks up where it stopped.
// `federations()` is the view planEscrowSpend reads, `rpc` the arbiter's own bitcoind.
export async function payOutSlash({ proof, v, set, rpc, keep = () => {}, say = () => {}, bin, dirOf, federations = async () => [], retired = [], feeSats = 1000n, pegInFeeSats = 1000n, env: runEnv = process.env }) {
  if (!bin) return { why: 'no stake-lock tool here (ARENA_STAKE_LOCK_BIN)' };
  const { execFile } = await import('node:child_process');
  const run = (dir, args, timeoutMs = 120000) => new Promise((done) => execFile(bin, [...args, '--data-dir', dir], { timeout: timeoutMs, maxBuffer: 1 << 24, env: runEnv },
    (err, out) => { const line = String(out || '').split('\n').find((l) => l.startsWith('{')); done(line ? JSON.parse(line) : { error: String((err && err.message) || 'no answer').slice(0, 200) }); }));
  const escrow = escrowOutput({ arbitrationKeys: set.keys, k: set.k }, { tweakPoint, combine });
  v.stages = v.stages || [];
  let stage = v.stages[v.stages.length - 1];
  if (!stage || stage.done) {
    const first = !stage;
    const out = first ? { txid: v.posted, vout: 1, sats: v.escrowSats } : stage.kept;
    if (!out) { v.settled = true; keep(); return { paid: (v.payouts || []).length, reserves: (v.reserves || []).length }; }
    const o = await rpc('gettxout', [out.txid, out.vout, false]).catch(() => null);
    if (!o || o.scriptPubKey.hex !== toHex(escrow.script) || BigInt(Math.round(o.value * 1e8)) !== BigInt(out.sats)) return { why: 'no unspent escrow of that amount (not seen yet, or spent)' };
    if (!(o.confirmations >= 1)) return { why: 'the escrow is not confirmed yet' };
    const plan = planEscrowSpend({ escrowSats: BigInt(out.sats), feeSats, pegInFeeSats, players: first ? v.players : [], federations: await federations(), retired });
    if (!plan.ok) return { why: plan.why };
    const pegIns = [];
    for (const p of plan.pegIns) {
      const dir = dirOf(p.federation);
      if (!dir) return { why: `no client of federation ${p.federation.slice(0, 16)} here` };
      const addr = await run(dir, ['--mode', 'pegin-address']);
      if (!addr.address) return { why: `no peg-in address: ${addr.error || JSON.stringify(addr)}` };
      pegIns.push({ federation: p.federation, reserveKey: p.reserveKey, sats: String(p.sats), playersMsat: String(p.playersMsat), address: addr.address, script: fromHex((await rpc('validateaddress', [addr.address])).scriptPubKey) });
    }
    const payees = pegIns.map((p) => ({ script: p.script, sats: BigInt(p.sats), pays: `the peg-in of ${p.federation.slice(0, 16)}` }));
    if (plan.keptSats > 0n) payees.push({ script: escrow.script, sats: plan.keptSats, pays: 'what does not fit: the same escrow' });
    const built = escrowSplitSpend({ escrow: { txid: fromHex(out.txid).reverse(), vout: out.vout, value: BigInt(out.sats), script: escrow.script }, payees, feeSats });
    if (!built.ok) return { why: built.why };
    const slash = { built, sighash: arbitrationSighash(built, escrow.leaf), controlBlock: escrow.controlBlock };
    const signed = assemble({ slash, signatures: set.members.slice(0, set.k).map((m) => ({ key: m.key, sig: memberSign(m, slash.sighash) })), set });
    if (!signed.ok) return { why: signed.why };
    const sent = await post(rpc, signed.hex);
    if (!sent.ok) return { why: sent.why };
    stage = { txid: sent.txid, feeSats: String(feeSats), players: first, pegIns: pegIns.map(({ script, ...p }, i) => ({ ...p, vout: i })),
      kept: plan.keptSats > 0n ? { txid: sent.txid, vout: pegIns.length, sats: String(plan.keptSats) } : null };
    v.stages.push(stage); keep();
    say({ proof: proof.slice(0, 16), escrowSpent: sent.txid, pegIns: stage.pegIns.map((p) => ({ federation: p.federation.slice(0, 16), sats: p.sats })), keptSats: String(plan.keptSats) });
  }
  for (const p of stage.pegIns) {
    const dir = dirOf(p.federation);
    if (!dir) return { why: `no client of federation ${p.federation.slice(0, 16)} here` };
    if (!p.claimedMsat) {
      const c = await run(dir, ['--mode', 'pegin-claim', '--address', p.address, '--timeout-s', '840'], 900000);
      if (!(c.balance_after_msat > c.balance_before_msat)) return { why: `the peg-in is not claimed yet: ${c.error || JSON.stringify(c)}` };
      p.claimedMsat = String(c.balance_after_msat - c.balance_before_msat); keep();
    }
    if (p.paidTxid) continue;
    // THE LOSSES FIRST, WHOLE WHILE THE CLAIM CARRIES THEM, THE REST TO THE RESERVE KEY; a bond too short pays them pro rata and the next proof pays the rest
    const spendable = BigInt(p.claimedMsat) - REMAINDER_FEE_MARGIN_MSAT;
    const due = stage.players ? v.players.filter((x) => x.federation === p.federation) : [];
    const want = due.reduce((t, x) => t + BigInt(x.msat), 0n);
    const pays = due.map((x) => ({ x, key: toHex(refundKeyOf(fromHex(x.key))), msat: want <= spendable ? BigInt(x.msat) : (BigInt(x.msat) * (spendable > 0n ? spendable : 0n)) / want }));
    const rest = spendable - pays.reduce((t, x) => t + x.msat, 0n);
    const toReserves = p.reserveKey && rest > 0n ? rest : 0n;
    const list = [...pays.map((x) => `${x.key}:${x.msat}`), ...(toReserves > 0n ? [`${p.reserveKey}:${toReserves}`] : [])];
    if (!list.length) { p.paidTxid = 'nothing'; keep(); continue; }
    const paid = await run(dir, ['--mode', 'pay', '--payouts', list.join(',')], 300000);
    if (!paid.txid) return { why: `no payout transaction: ${paid.error || JSON.stringify(paid)}` };
    const rowOf = (key) => (paid.payouts || []).find((y) => String(y.refund_pk).toLowerCase() === key.toLowerCase());
    v.payouts = [...(v.payouts || []), ...pays.map(({ x, key, msat }) => { const y = rowOf(key); x.paidMsat = String(msat);
      return { round: v.round, entry: x.entry || v.entry, federation: p.federation, refundPk: key, msat: String(msat), txid: paid.txid, outIdx: y ? y.out_idx : null, contractId: y ? y.contract_id : null }; })];
    if (toReserves > 0n) { const y = rowOf(p.reserveKey); v.reserves = [...(v.reserves || []), { federation: p.federation, reserveKey: p.reserveKey, msat: String(toReserves), txid: paid.txid, outIdx: y ? y.out_idx : null, contractId: y ? y.contract_id : null }]; }
    p.paidTxid = paid.txid; keep();
    say({ proof: proof.slice(0, 16), federation: p.federation.slice(0, 16), paid: pays.length, reservesMsat: String(toReserves), txid: paid.txid });
  }
  stage.done = true;
  if (!stage.kept) v.settled = true;
  keep();
  return { paid: (v.payouts || []).length, reserves: (v.reserves || []).length };
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

/** TESTMEMPOOLACCEPT, THEN BROADCAST - never the other way: `rpc(method, params)` is the arbiter's own bitcoind. */
export async function post(rpc, hex) {
  const [r] = await rpc('testmempoolaccept', [[hex]]);
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
 */
export function musigParty({ set, allow = () => ({ ok: false, why: 'no spend is agreed to' }) }) {
  const sessions = new Map();
  return {
    nonce({ sessionId, nodeKey, tweak, msg, spend }) {
      if (sessions.has(sessionId)) return { ok: false, why: 'that session is open already' };
      const may = allow({ nodeKey, msg, spend });
      if (!may.ok) return may;
      const bctx = bondSigningContext({ nodeKey, arbitrationKeys: set.keys, tweak });
      const drawn = set.members.map((m) => ({ m, ...nonceGen({ pk: Uint8Array.from([2, ...m.key]), sk: m.secret, msg }) }));
      sessions.set(sessionId, { bctx, msg, drawn, used: false });
      return { ok: true, outputKey: toHex(bctx.outputKey), pubnonces: drawn.map((d) => ({ member: toHex(d.m.key), pubnonce: toHex(d.pubnonce) })) };
    },
    partial({ sessionId, aggnonce }) {
      const s = sessions.get(sessionId);
      if (!s) return { ok: false, why: 'no such session' };
      if (s.used) return { ok: false, why: 'that session signed already: a nonce is used once' };
      s.used = true;
      try {
        const psigs = s.drawn.map((d) => ({ member: toHex(d.m.key), psig: toHex(bondPartialSign(s.bctx, {
          who: s.bctx.inner.pks.findIndex((p) => toHex(p) === toHex(d.m.key)), sk: d.m.secret, secnonce: d.secnonce, aggnonce: fromHex(aggnonce), msg: s.msg })) }));
        return { ok: true, psigs };
      } catch (e) { return { ok: false, why: e instanceof MusigError ? e.message : String(e.message || e) }; } finally { sessions.delete(sessionId); }
    },
  };
}

export { REPLAY_CONTRADICTS, AUDIT_CONTRADICTED };

/**
 * THE ARBITER'S DOORS: POST /musig/nonce { sessionId, nodeKey, tweak, msg, spend } -> the 7 members'
 * pubnonces; POST /musig/partial { sessionId, aggnonce } -> their partial signatures (each nonce used once); GET /status
 * -> the set and what it posted. `posted` is the arbiter loop's record of path B spends it broadcast.
 */
export async function serveArbiter({ set, allow, port = 0, host = '127.0.0.1', posted = [], payouts = () => [], claims = null, liquidationPayouts = () => [] }) {
  const { createServer } = await import('node:http');
  const party = musigParty({ set, allow });
  const server = createServer(async (req, res) => {
    const answer = (code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(body)); };
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
        let body; try { body = JSON.parse(await new Promise((r) => { let s = ''; req.on('data', (d) => { s += d; }); req.on('end', () => r(s)); })); } catch { return answer(400, { ok: false, why: 'a JSON body' }); }
        // a pending-output claim (§23A.5 "Notes still in issuance at the halt") names `pending`; a note claim `ecash`
        const got = Array.isArray(body && body.pending) ? await claims.offerPending(body) : await claims.offer(body);
        return answer(got.ok ? 200 : (got.status || 409), got);
      }
    }
    if (req.method !== 'POST' || !['/musig/nonce', '/musig/partial'].includes(url.pathname)) return answer(404, { ok: false, why: 'no such door' });
    let body; try { body = JSON.parse(await new Promise((r) => { let s = ''; req.on('data', (d) => { s += d; }); req.on('end', () => r(s)); })); } catch { return answer(400, { ok: false, why: 'a JSON body' }); }
    if (url.pathname === '/musig/nonce') {
      const ok32 = (h) => /^[0-9a-f]{64}$/.test(String(h));
      if (!body.sessionId || !ok32(body.nodeKey) || !ok32(body.tweak) || !ok32(body.msg)) return answer(400, { ok: false, why: 'a session id, a node key, a tweak and a message (32 bytes each, hex)' });
      const r = party.nonce({ sessionId: String(body.sessionId), nodeKey: fromHex(body.nodeKey), tweak: fromHex(body.tweak), msg: fromHex(body.msg), spend: body.spend || null });
      return answer(r.ok ? 200 : 409, r);
    }
    const r = party.partial({ sessionId: String(body.sessionId), aggnonce: String(body.aggnonce || '') });
    return answer(r.ok ? 200 : 409, r);
  });
  await new Promise((r) => server.listen(port, host, r));
  return { port: server.address().port, close: () => new Promise((r) => server.close(r)) };
}
