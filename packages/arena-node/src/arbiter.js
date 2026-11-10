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
//   An output an ABANDONED row of a federation record left (§23A.5, kanban #1059, #1062) comes this way from step 3: judgeAbandoned, buildAbandonedSlash, into the liquidation escrow, and step 6 is not
//   its: it waits there for the federation's end.
//   6. THE ESCROW SPENT (payOutSlash): one peg-in per federation, each loss a payout contract to its player, the rest a payout
//      contract to that federation's reserve key (§27A.9.2); what does not fit stays in the escrow until a federation has room.
import * as nodeFs from 'node:fs';
import { schnorr } from '@noble/curves/secp256k1.js';
import { genesisFor } from '../../arena-protocol/src/genesis.js';
import { taggedHash, toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { decodeSpentSet, spentNonceSet, newestSpentSet } from '../../arena-protocol/src/spent-set.js';
import { affectedEntries, realLosses, slashHolds, slashHoldsOnRerun, splitRerunSlashEvidence, slashHeightIsValid, slashDistribution, splitSlashEvidence, REPLAY_CONTRADICTS, TWO_RESULTS,
  splitAuditSlashEvidence, slashHoldsOnAudit, AUDIT_CONTRADICTED, splitDoubleSlashEvidence, slashHoldsOnDoubleSign, splitTableSlashEvidence, slashHoldsOnTable, splitReleaseSlashEvidence, slashHoldsOnRelease, slashHoldsOnReleaseTable,
  namedClaimLosses, OFF_TABLE_CLAIM, FORFEIT_OF_LOST_ENTRY } from '../../arena-protocol/src/slash.js';
import { abandonedSlashStands, abandonedProofId, decodeAbandonedProof } from '../../arena-protocol/src/abandoned-slash.js';
import { verifyFederationRecord, splitSignedRecord } from '../../arena-protocol/src/federation-record.js';
import { abandonedSlashPoint, networkOf } from '../../arena-protocol/src/constants.js';
import { decodeSettlementTable } from '../../arena-protocol/src/settlement-ack.js';
import { tableBuild } from '../../arena-protocol/src/settlement-rebuild.js';
import { splitNamedClaimEvidence, claimReadInput, slashHoldsOnNamedClaim, NAMED_ROW_OFF_TABLE, NAMED_ROW_PAYEE } from '../../arena-protocol/src/named-claim-proof.js';
import { leftTheRound, entryPayeeKeys } from '../../arena-protocol/src/named-claim-payees.js';
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
import { tweakPoint, combine, pointFromScalar } from './curve.js';
import { keyedPay, payoutOf, PAYOUT, runPayouts } from './keyed-payout.js';
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
 * `roundRandomness` the beacon hash. Answers { slashed, offence, bond, proof, playerPubkey, why }, and whoever holds the complete proof adds its hash as `proofId` for buildSlash.
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
  return { slashed: true, offence: held.offence, bond: held.bond, proof, playerPubkey: proof.playerPubkey,
    signed: { outcome: body.outcome, score: body.score }, replayed: checked.replayed, contradictedRunId: toHex(objected), why: held.why };
}

/**
 * THE JUDGEMENT OF A PROOF AGAINST A RE-RUN SIGNER (§13A, slice C2c), as judgeProof judges a first result's: the second objection, the one that held against the agreed re-run, is REPLAYED here, and the
 * run it contradicts must be the one the accused signed. Then slashHoldsOnRerun's comparisons, on the accused's signed re-run. Answers what judgeProof answers.
 */
export async function judgeRerunProof({ evidence, bundle, entry, entryId, contract, committee, advert, bondOutpoint, core, roundRandomness, replayRun }) {
  const no = (why) => ({ slashed: false, why });
  let got;
  try { got = splitRerunSlashEvidence(evidence); } catch (e) { return no(`not a slash proof record against a re-run: ${e.message}`); }
  if (!(bundle instanceof Uint8Array) || !bundle.length) return no('no objection bundle to replay');
  let objected, canonical;
  try {
    const b = decodeObjectionBundle(bundle);
    objected = b.objection.signedResultId;
    canonical = transcriptHash(decodeTranscript(b.transcript));
  } catch (e) { return no(`that is not an objection bundle: ${e.message}`); }
  const checked = await checkObjectionBundle({ bundle, roundId: got.proof.roundId, entryId, entry, contract, committee, signedResultId: objected, core, roundRandomness, verify: verifySchnorr,
    ...(replayRun ? { replayRun } : {}) });
  if (!checked.holds) return no(`the replay does not contradict that re-run: ${checked.why}`);
  const held = slashHoldsOnRerun({ proof: got.proof, signedRerun: got.signedRerun, committee, canonicalTranscriptHash: canonical, agreedRunId: objected, replayDiffers: true, verify: verifySchnorr,
    advert: advert ? { ...advert, bondTxid: bondOutpoint.txid, bondVout: bondOutpoint.vout } : null });
  if (!held.slashed) return no(held.why);
  return { slashed: true, offence: held.offence, bond: held.bond, proof: got.proof, playerPubkey: got.proof.playerPubkey, replayed: checked.replayed, contradictedRunId: toHex(objected), why: held.why };
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
  return { slashed: true, offence: held.offence, bond: held.bond, proof, playerPubkey: proof.playerPubkey,
    replayed: checked.replayed, contradictedRunId: toHex(objected), why: held.why };
}

const verifySchnorr = (sig, msg, key) => { try { return schnorr.verify(sig, msg, key); } catch { return false; } };

/**
 * THE JUDGEMENT OF TWO RESULTS (5A.3 row 1, kanban #986). No replay and no objection: the two records beside the proof, each verified under
 * the accused's key, about one player of the round asked after and ONE transcript, the accused on the round's committee and the bond the one its
 * own advertisement names (slashHoldsOnDoubleSign). `roundIdBytes` is the round this arbiter read the committee for: a pair of another round
 * accuses nobody here. Answers what judgeProof answers, less the replay: a doubled result shows no loss (§5A.3), so buildSlash pays its bond
 * to the reserves unless an earlier proof of the round left a correction.
 */
export function judgeDoubleProof({ evidence, roundIdBytes, committee, advert, bondOutpoint }) {
  const no = (why) => ({ slashed: false, why });
  let got;
  try { got = splitDoubleSlashEvidence(evidence); } catch (e) { return no(`not a proof of two results: ${e.message}`); }
  if (toHex(got.proof.roundId) !== toHex(roundIdBytes)) return no('that pair is about another round');
  const held = slashHoldsOnDoubleSign({ proof: got.proof, signedResults: got.signedResults, committee, verify: verifySchnorr,
    advert: advert ? { ...advert, bondTxid: bondOutpoint.txid, bondVout: bondOutpoint.vout } : null });
  if (!held.slashed) return no(held.why);
  return { slashed: true, offence: held.offence, bond: held.bond, proof: got.proof, playerPubkey: got.proof.playerPubkey, why: held.why };
}

/**
 * THE JUDGEMENT OF A FALSE TABLE (§5A.3 table row, kanban #1040, #1043). No replay and no objection. The record carries the accused's ack, the threshold of acks, the table, the Entry
 * Contracts, each P and the FINAL records; the committee, the bond, the guardians' fee rule and the hash are this set's own. `txidOf(table, build)` is the stock client's hash, this set's
 * client of that federation, and `feesOf(federation hex)` its fee rule: no seat's word enters. Where the record shows no P the txid is not read, and the rest still is.
 */
export async function judgeTableProof({ evidence, roundIdBytes, contract, manifest = null, committee, advert, bondOutpoint, txidOf, feesOf = () => null }) {
  const no = (why) => ({ slashed: false, why });
  let got, table;
  try { got = splitTableSlashEvidence(evidence); table = decodeSettlementTable(got.table); } catch (e) { return no(`not a proof of a false table: ${e.message}`); }
  if (toHex(got.proof.roundId) !== toHex(roundIdBytes)) return no('that table is about another round');
  const shown = [...got.entries, ...got.finals.map((f) => f.entry)];
  const built = tableBuild({ table, entries: new Map(shown.map((e) => [toHex(entryIdOf(e)), e])), preimages: new Map(got.preimages.map((p) => [toHex(p.entryId), p.preimage])), pointOf: pointFromScalar });
  const rebuiltTxid = built.ok ? await txidOf(table, built.build) : null;
  const held = slashHoldsOnTable({ proof: got.proof, signedAck: got.signedAck, acks: got.acks, table: got.table, entries: got.entries, finals: got.finals, contract, manifest, committee, verify: verifySchnorr,
    rebuiltTxid, feesOf, own: got.own, advert: advert ? { ...advert, bondTxid: bondOutpoint.txid, bondVout: bondOutpoint.vout } : null });
  if (!held.slashed) return no(held.why);
  return { slashed: true, offence: held.offence, bond: held.bond, proof: got.proof, playerPubkey: got.proof.playerPubkey, why: held.why };
}

/**
 * THE JUDGEMENT OF A NAMED CLAIM (§5A.3 rows (a) and (b), protocol 27, kanban #1044 B1, rulings #1131 4, #1135 2). The proof's sessions are read OFFLINE by
 * `claimRead(input)` (the stake-lock tool's arena-claim-read: every session verified against the config's broadcast keys); for row (a) the shown table is
 * rebuilt into its body by tableBuild and `bodyOf(input, build)` - the judge's own tool, offline and without signers (stake-lock-port.js readBody: the
 * claimed locks' contracts from the proof's own sessions, since its claim spent them at the guardians). `claimRead` or `bodyOf` answering null is "cannot say";
 * `bodyOf` answering { ok: false, why } is a proof whose own bytes do not rebuild that body.
 */
export async function judgeNamedClaimProof({ evidence, roundIdBytes, contract, manifest = null, committee, advert, bondOutpoint, claimRead, bodyOf = async () => null, feesOf = () => null, payees = null, ownEntries = null, forfeitAllowed = null }) {
  const no = (why) => ({ slashed: false, why });
  let got;
  try { got = splitNamedClaimEvidence(evidence); } catch (e) { return no(`not a proof of a named claim: ${e.message}`); }
  if (toHex(got.proof.roundId) !== toHex(roundIdBytes)) return no('that claim is about another round');
  const read = await claimRead(claimReadInput({ config: got.config, firstSession: got.firstSession, sessions: got.sessions, roundId: roundIdBytes }));
  if (!read) return { slashed: undefined, why: 'no claim reader here: the stake-lock tool with arena-claim-read' };
  let rebuiltBodyId = null, bodyCannotSay = null, bodyRefused = null;
  if (got.row === NAMED_ROW_OFF_TABLE) {
    let table;
    try { table = decodeSettlementTable(got.table); } catch (e) { return no(`the table shown does not decode: ${e.message}`); }
    const shown = [...got.entries, ...got.finals.map((f) => f.entry)];
    const built = tableBuild({ table, entries: new Map(shown.map((e) => [toHex(entryIdOf(e)), e])), preimages: new Map(got.preimages.map((p) => [toHex(p.entryId), p.preimage])), pointOf: pointFromScalar });
    if (built.ok) {
      const body = await bodyOf(claimReadInput({ config: got.config, firstSession: got.firstSession, sessions: got.sessions }), built.build);
      if (!body) bodyCannotSay = 'no body rebuilder here: the stake-lock tool with arena-body';
      else if (body.ok) rebuiltBodyId = body.bodyId;
      else bodyRefused = body.why;
    } else bodyRefused = built.why;
  }
  const held = slashHoldsOnNamedClaim({ got, read, contract, committee, verify: verifySchnorr, feesOf, manifest, rebuiltBodyId, bodyCannotSay, bodyRefused, payees, ownEntries, forfeitAllowed,
    advert: advert ? { ...advert, bondTxid: bondOutpoint.txid, bondVout: bondOutpoint.vout } : null });
  if (held.slashed === undefined) return { slashed: undefined, why: held.why };
  if (!held.slashed) return no(held.why);
  // AND WHAT ITS LOSS RULE READS (RULED 2026-11-06, kanban #1146 B; slash.js namedClaimLosses): the accepted transaction's spends of the round's locks, and
  // for row (a) at level 1 the FINAL rows the proof showed exactly F, at level 2 what left the round
  const txid = toHex(got.proof.signedResultId).toLowerCase(), rid = toHex(roundIdBytes).toLowerCase();
  const spends = (read.spends || []).filter((s) => String(s.txid).toLowerCase() === txid && s.lock && String(s.lock.round_id).toLowerCase() === rid);
  const extra = { row: got.row, spends };
  if (got.row === NAMED_ROW_OFF_TABLE) {
    extra.truth = [];
    for (const f of got.finals || []) { try { const b = decodePlayerResult(splitSignedResult(f.signedResult).body); extra.truth.push({ pubkey: f.entry.playerPubkey, outcome: b.outcome, score: b.score }); } catch { /* not a result */ } }
  } else if (got.row === NAMED_ROW_PAYEE && payees) {
    extra.leftMsat = leftTheRound({ spends, entryKeys: entryPayeeKeys([...(ownEntries || []), ...got.entries]), payees }).msat;
  }
  return { slashed: true, offence: held.offence, bond: held.bond, proof: got.proof, playerPubkey: got.proof.playerPubkey, why: held.why, ...extra };
}

/**
 * THE JUDGEMENT OF A RELEASE (5A.3 template-3 rows, kanban #1065). The record names one row: with a table, a release that pays other than it; without, a release with no valid proof, `proofChecks` being
 * this reader's own word on the bytes the release committed to, as `replayDiffers` is for a replay. `panels` { panelA, panelB } of keys, redrawn by the reader and never read off the accuser; `holdBlocks` the network's.
 */
export function judgeReleaseProof({ evidence, panels, holdBlocks, proofChecks, advert, bondOutpoint }) {
  const no = (why) => ({ slashed: false, why });
  let got;
  try { got = splitReleaseSlashEvidence(evidence); } catch (e) { return no(`not a proof against a release: ${e.message}`); }
  const own = advert ? { ...advert, bondTxid: bondOutpoint.txid, bondVout: bondOutpoint.vout } : null;
  const held = got.table.length
    ? slashHoldsOnReleaseTable({ proof: got.proof, spend: got.release, prevouts: got.prevouts, table: got.table, advert: own, verify: verifySchnorr })
    : slashHoldsOnRelease({ proof: got.proof, release: got.release, prevouts: got.prevouts, panels, holdBlocks, fraudProof: got.fraudProof, proofChecks, advert: own, verify: verifySchnorr });
  if (!held.slashed) return no(held.why);
  return { slashed: true, offence: held.offence, bond: held.bond, proof: got.proof, why: held.why };
}

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
  const owed = slashLosses({ verdict, entries, contract, roundId, signed, truth, payoutShares });
  if (!owed.ok) return owed;
  let distribution;
  try { distribution = slashDistribution({ escrowSats: bond.value - feeSats, roundId, contract, losses: owed.losses, paid }); } catch (e) { return { ok: false, why: e.message }; }
  const spend = pathBSpend({ bond, advert, proofId: verdict.proofId, slashHeight, hint, set, feeSats });
  return spend.ok ? { ...spend, distribution, truth: owed.truth } : spend;
}

/**
 * WHO A JUDGED PROOF HARMED, AND BY HOW MUCH (§5A.3 real loss): the entries the offence names, against the round as it settled, with the truth the replay gave where the round
 * settled on the false run. Shared by path B here and a template-3 release or fallback (slash-release-run.js), so both pay one loss the same way. Answers { ok, losses (Map key hex ->
 * msat), truth } or { ok: false, why }. Only a run proven FINAL can have cost anybody: after an objection in time the result was corrected before any money moved.
 */
export function slashLosses({ verdict, entries, contract, roundId, signed = verdict.signed, truth = [], payoutShares = null, settled = true }) {
  // THE NAMED CLAIM'S ROWS (a) AND (b) (RULED 2026-11-06, kanban #1146 B): #976's rule on what the judge read of the transaction - one function for path B,
  // a template-3 release and its fallback. `settled` false: (b)'s round still has unsettled locks at the cap, each read as gone back to its player
  if (verdict.offence === OFF_TABLE_CLAIM || verdict.offence === FORFEIT_OF_LOST_ENTRY) {
    const got = namedClaimLosses({ held: verdict, entries, roundId, minScore: contract.minScore, payoutShares, settled });
    return got.ok ? { ok: true, losses: got.losses, truth: [], level: got.level } : got;
  }
  const harmed = affectedEntries({ offence: verdict.offence, playerPubkey: verdict.playerPubkey, entries, signed, replayed: verdict.replayed });
  if (!harmed.ok) return { ok: false, why: harmed.why };
  const named = entries.find((e) => toHex(e.playerPubkey) === toHex(verdict.playerPubkey));
  const settledOnFalse = !!(named && named.finalProven && named.runId === verdict.contradictedRunId && verdict.offence !== TWO_RESULTS && verdict.replayed);
  const correct = [...truth.filter((t) => toHex(t.pubkey) !== toHex(verdict.playerPubkey)), ...(settledOnFalse ? [{ pubkey: verdict.playerPubkey, outcome: verdict.replayed.outcome, score: verdict.replayed.score }] : [])];
  try { return { ok: true, losses: realLosses({ roundId, entries, truth: correct, affected: harmed.affected, minScore: contract.minScore, payoutShares }), truth: correct }; }
  catch (e) { return { ok: false, why: e.message }; }
}

/** PATH B OF A BOND INTO THE ESCROW (5A.3B step 4): the output rebuilt from the node's advertisement and held to it, and the unsigned spend committing to `proofId`. */
function pathBSpend({ bond, advert, proofId, slashHeight, hint, set, feeSats }) {
  const maturity = bondMaturityOf(advert, { genesisMaturity: genesisFor(set.network).bondMaturity, network: set.network });
  if (!maturity.ok) return { ok: false, why: maturity.why };
  const nodeKey = advert.nodePubkey;
  const internalKey = bondInternalKey({ nodeKey, arbitrationKeys: set.keys }, { combine }).internalKey;
  const tree = bondOutputKey({ nodeKey, arbitrationKeys: set.keys, arbitrationK: set.k, bondMaturity: maturity.maturity, internalKey }, { tweakPoint, combine });
  if (!tree.ok) return { ok: false, why: tree.why };
  if (toHex(bond.script.subarray(2, 34)) !== toHex(tree.outputKey)) return { ok: false, why: 'that output is not the bond this node\'s advertisement builds' };
  const escrow = escrowOutput({ arbitrationKeys: set.keys, k: set.k }, { tweakPoint, combine });
  const built = arbitrationSpend({ bond, proofId, slashHeight, hint, feeSats, escrowScript: escrow.script });
  if (!built.ok) return built;
  const leaf = tapLeafHash(slashLeaf(set.keys, set.k));
  return { ok: true, built, leaf, sighash: arbitrationSighash(built, leaf), controlBlock: controlBlockFor('slash', tree).controlBlock };
}

/**
 * THE JUDGEMENT OF AN ABANDONMENT'S PROOF (§23A.5, RULED 2026-11-02, kanban #1058, #1059, #1062, #1065). `proofBytes`, the proof with the signed record in it, are what a seat handed over, believed
 * for nothing: the record is held to its threshold of bonded guardians against `census`, this reader's own entries at the record's height, it must be the proof's federation's,
 * and the row it holds must name the proof's node and proof_ref. Then abandonedSlashStands over
 * `bonds`, this reader's own census, with the network's ABANDONED_SLASH_HEIGHT or `from`. Answers { slashed, offence, proofId (the hash a slash commits to), proofRef, federation, node, output,
 * bondSpent, why }; a template-3 output comes back judged, for the census key's holders: path B is not this set's on such a bond.
 */
export function judgeAbandoned({ proofBytes, census, bonds, networkId, inviteFederationId, from = abandonedSlashPoint(networkOf(networkId)) }) {
  const no = (why) => ({ slashed: false, why });
  let p; try { p = decodeAbandonedProof(proofBytes); } catch (e) { return no(`that is no proof of an abandonment: ${e.message}`); }
  const v = verifyFederationRecord(p.record, { census, verify: verifySchnorr, inviteFederationId, networkId });
  if (!v.ok) return no(`that record does not stand: ${v.why}`);
  if (toHex(v.record.federationId) !== toHex(p.federationId)) return no('that record is another federation\'s');
  const stands = abandonedSlashStands({ record: v.record, nodePubkey: p.nodePubkey, proofRef: p.proofRef, bonds, txid: toHex(p.txid), vout: p.vout, from });
  if (!stands.ok) return no(stands.why);
  return { slashed: true, offence: stands.kind, proofId: abandonedProofId(proofBytes), proofRef: toHex(stands.proofRef), sinceHeight: stands.sinceHeight, federation: toHex(v.record.federationId), node: toHex(stands.nodePubkey), output: stands.output, bondSpent: stands.bondSpent, why: stands.why };
}

/**
 * THE SLASH OF AN OUTPUT A ROW LEFT, unsigned: path B committing to the proof's hash, the federation in the hint, and the whole output less the fee into the liquidation escrow (§23A.5, as for
 * abandonment by absence). It waits there for the federation's end, so nothing here says who it pays. Answers what buildSlash does, less its distribution, so memberSign and assemble take it.
 */
export function buildAbandonedSlash({ verdict, bond, slashHeight, tipHeight, recordHeight, set, feeSats = 2000n }) {
  const h = slashHeightIsValid({ slashHeight, censusHeight: recordHeight, tipHeight });
  if (!h.ok) return { ok: false, why: h.why };
  return pathBSpend({ bond, advert: verdict.output.advert, proofId: verdict.proofId, slashHeight, hint: fromHex(verdict.federation), set, feeSats });
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
  if (stage && stage.pending) {
    const r = await resumeIntent(rpc, stage.pending, stage.pending.input);
    if (!r.ok) { v.stages.pop(); keep(); return { why: `the recorded escrow spend is refused: ${r.why}` }; }
    delete stage.pending; keep();
    say({ proof: proof.slice(0, 16), escrowSpent: stage.txid, resumed: r.landed ? 'found' : r.inferred ? 'its input is spent' : 'sent again' });
  }
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
    // THE STAGE IS RECORDED BEFORE ITS BROADCAST (kanban #1232): a lost answer left the escrow spent, no stage kept, and every later
    // pass "no unspent escrow" - the peg-ins never claimed. A pending stage is resumed by resumeIntent above.
    const txid = await txidOf(rpc, signed.hex);
    const stageOf = (t) => ({ txid: t, feeSats: String(feeSats), players: first, pegIns: pegIns.map(({ script, ...p }, i) => ({ ...p, vout: i })),
      kept: plan.keptSats > 0n ? { txid: t, vout: pegIns.length, sats: String(plan.keptSats) } : null });
    if (txid) { stage = { ...stageOf(txid), pending: { txid, hex: signed.hex, input: { txid: out.txid, vout: out.vout } } }; v.stages.push(stage); keep(); }
    const sent = await post(rpc, signed.hex);
    if (!sent.ok) { if (txid) { v.stages.pop(); keep(); } return { why: sent.why }; }
    if (txid) { delete stage.pending; keep(); } else { stage = stageOf(sent.txid); v.stages.push(stage); keep(); }
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
    let toReserves = p.reserveKey && rest > 0n ? rest : 0n;
    const list = [...pays.map((x) => `${x.key}:${x.msat}`), ...(toReserves > 0n ? [`${p.reserveKey}:${toReserves}`] : [])];
    if (!list.length && payoutOf(p.pay) !== PAYOUT.ASKED) { p.paidTxid = 'nothing'; keep(); continue; }
    // THE PAYOUT ONCE (kanban #1174, keyed-payout.js): ASKED - its key (the proof, the stage, the federation) and its list - written before the tool;
    // after a stop the recorded list is read back under its key (the pays below are taken from it), never paid twice
    if (!p.pay) p.pay = {};
    const asList = list.map((x) => { const [key, msat] = x.split(':'); return { key, msat }; });
    const got = await keyedPay({ rec: p.pay, save: keep, list: asList, key: `slash-arb:${proof}:${v.stages.length - 1}:${p.federation}`, ...runPayouts((args) => run(dir, args, 300000)) });
    if (!got.ok) return { why: `no payout transaction: ${got.why}`, held: !!got.held };
    if (p.pay.list) {   // what was paid is the recorded list (a pay after a stop pays it, not one worked out again)
      const at = new Map(p.pay.list.map((x) => [x.key.toLowerCase(), BigInt(x.msat)]));
      for (const x of pays) x.msat = at.get(x.key.toLowerCase()) ?? 0n;
      if (p.reserveKey) toReserves = at.get(String(p.reserveKey).toLowerCase()) ?? 0n;
    }
    const paid = { txid: got.txid, payouts: got.payouts };
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
export function spentSetFromSeats(listings, { verify, readRecord = (hex) => splitSignedRecord(fromHex(hex)).record }) {
  const votes = new Map();
  for (const l of listings || []) { const r = l && (l.record || l.haltRecord); if (typeof r === 'string' && r) votes.set(r, (votes.get(r) || 0) + 1); }
  const recHex = [...votes.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map((e) => e[0])[0] || null;
  if (!recHex) return { spentNonces: null, why: 'no seat lists the federation\'s record: no spent set can be checked' };
  let record; try { record = readRecord(recHex); } catch (e) { return { spentNonces: null, why: `the record the seats list does not read: ${e.message}` }; }
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
  if (r && !r.allowed && /txn-already-in-mempool|txn-already-known/.test(String(r['reject-reason'] || ''))) return { ok: true, txid: r.txid, tested: r, again: true };
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
