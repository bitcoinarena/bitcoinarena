// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// 5A.3B: THE FRAUD PROOF, AND WHAT A SLASHING TRANSACTION MUST COMMIT TO.
//
// "A bond is forfeit on objectively provable misbehaviour, each a portable
// artifact anyone can check" (5A.3). The table there lists six offences; this
// file holds the one 13C names, which is the last of that section's four
// clauses: "nodes whose signature contradicts a replay of the canonical
// transcript are slashed".
//
// THE LAW IS NOT THE ENFORCEMENT, and only one of them is blocked. 5A.3B's
// five steps are: publish the proof, check it mechanically, sign a spend of
// path B with k-of-m arbitration keys, commit H(fraud_proof) in an OP_RETURN,
// pay the distribution. Steps 3 and 5 need an arbitration set, MuSig2 and a
// transaction - a daemon this repo does not have and will not pretend to.
// Steps 1, 2 and 4 need none of that: step 2 says every offence is "either a
// signature comparison or a deterministic replay. No judgement." That is a
// pure function, and it is what is here.
//
// THE REPLAY VERDICT IS INJECTED, exactly as 13A's objection injects it. This
// package steps no simulation and the daemon imports no core; whoever holds a
// replay says whether it differed, and this decides what follows from that.
// A missing verdict is NOT a slash: an accusation nobody has replayed is a
// claim, and a bond taken on a claim is the arbitration set's own offence.
//
// WHERE THE BOND GOES is slashing rule v2 (§5A.3, RULED 2026-11-02, kanban #976): each affected player's real loss, once, and the rest to the
// protocol reserves. `realLosses` and `slashDistribution` at the end of this file.
import { SIGNED_RERUN_BYTES, splitSignedRerun, decodeRerunResult, rerunResultId, runOf, signedRerunBytesOf } from './rerun.js';
import { Writer, Reader } from './encode.js';
import { taggedHash, toHex, fromHex } from './hash.js';
import { parseTransaction } from './tx.js';
import { tapSighash, scriptPathSigners } from './bond-spend.js';
import { tapLeafHash, releaseLeaf } from './bond-script.js';
import { arbitrationCommitmentIn, P2TR_DUST_SATS } from './arbitration-tx.js';
import { carrierEscrowPegInId } from './census-key.js';
import { reserveParts } from './slash-reserves.js';
import {
  PROTOCOL_VERSION, speaksVersion, TYPE_SLASH_PROOF, TYPE_AUDIT_SLASH_PROOF, TYPE_SETTLEMENT_ACK, TYPE_FRAUD_PROOF, TYPE_RERUN_RESULT, TYPE_RELEASE_EVIDENCE, TYPE_NAMED_CLAIM_EVIDENCE,
  SLASH_REMAINDERS, TAG,
} from './constants.js';
import { entryId, roundId as roundIdOf, encodeEntryContract, decodeEntryContract } from './contracts.js';
import { decodePlayerResult, resultId, splitSignedResult, SIGNED_RESULT_BYTES, signedResultBytesOf } from './result.js';
import { computePayoutTable, isRefund, isQualifier, netStakeMsat, withGoneStakes } from './payout.js';
import { refundKeyOf } from './stake-lock.js';
import { payoutRuleForRound, isAttested } from './manifest.js';
import { windowsOf } from './window.js';
import { splitSignedAck, settlementAckId, countAcks, decodeSettlementTable, settlementTableId, namesNoEntry, SIGNED_SETTLEMENT_ACK_BYTES } from './settlement-ack.js';
import { tableFalse, claimsProvedQualifier } from './settlement-rebuild.js';
import { namedClaims } from './arena-lock.js';
import { splitNamedClaimEvidence } from './named-claim-proof.js';
import { decodeFinalSig, splitSignedFinalSig, finalSigned } from './final-sig.js';
import { decodeAudit, auditId, auditStands, auditResultsHash } from './auditor.js';
import { decodeSignedLockSet, lockSetId, lockSetSignatureId } from './lock-set.js';

const hex = (b) => toHex(b);

/** Thirty-two zero bytes: a field this row deliberately does not use. */
const EMPTY = new Uint8Array(32);

/**
 * The offences of 5A.3, by the name this file uses for them.
 *
 * One is implemented. The other five are listed rather than stubbed, because
 * a name in an array that answers nothing is worse than an absence: it reads
 * as coverage.
 */
export const REPLAY_CONTRADICTS = 'REPLAY_CONTRADICTS';

/**
 * §5A.3: "Signing a payout table that does not equal `F(contract, membership, results)`", on the seat's SettlementAck (kanban #1035).
 */
export const TABLE_IS_NOT_F = 'TABLE_IS_NOT_F';

/**
 * 5A.3 row 1: "Signing two different results for the same (round, player)",
 * proof "the two signed results". The purest of them - nothing is recomputed,
 * replayed or injected, because the two objects ARE the offence.
 */
export const TWO_RESULTS = 'TWO_RESULTS';

/**
 * 5A.3 row 5: "Signing for a round in which the operator played (5A.13)",
 * proof "Entry Contract + node signature". Being conflicted is not the
 * offence - signing while conflicted is.
 */
export const OPERATOR_PLAYED = 'OPERATOR_PLAYED';

/**
 * §13A.1 (kanban #724, #725): "an AUDIT over a result that a valid objection later contradicts is a fraud proof against its signer,
 * as for a committee signature ("a result contradicted by replay", §5A.3), and slashes its bond", proof "the AUDIT + the objection
 * that held". Not a row of 5A.3's table but its second row's twin: the auditor signed that a run replays, and the replay says no.
 */
export const AUDIT_CONTRADICTED = 'AUDIT_CONTRADICTED';

/**
 * 5A.3, template 3 (kanban #971): "Signing a release with no valid proof", proof "the release, whose witness names the signers + the bytes
 * that hash to its OP_RETURN and do not check".
 */
export const RELEASE_WITHOUT_PROOF = 'RELEASE_WITHOUT_PROOF';

/** 5A.3, template 3: "Signing a release or an escrow payout that pays other than its payout_table", proof "the release or the payout + the table". slashHoldsOnReleaseTable and slashHoldsOnEscrowSpend. */
export const RELEASE_OFF_TABLE = 'RELEASE_OFF_TABLE';

/**
 * §5A.3 rows (a) and (b) of the named claim (protocol 27, kanban #1044 B1): an off-table claim, and a forfeit of an entry the accused signed lost
 * (named-claim-offence.js). THEIR LOSS RULE IS #976's (RULED 2026-11-06, kanban #1146 B): the whole bond of each named signer, each harmed player's real loss
 * once, the rest to the reserves - `namedClaimLosses` below. The same words as named-claim-offence.js, written here so this list needs no import cycle.
 */
export const OFF_TABLE_CLAIM = 'OFF_TABLE_CLAIM';
export const FORFEIT_OF_LOST_ENTRY = 'FORFEIT_OF_LOST_ENTRY';

// In 5A.3's own document order, which is the order they are being written in; §13A.1's AUDIT after them; the named claim's two rows last (kanban #1146 B).
export const OFFENCES = [
  TWO_RESULTS, REPLAY_CONTRADICTS, TABLE_IS_NOT_F, OPERATOR_PLAYED,
  RELEASE_WITHOUT_PROOF, RELEASE_OFF_TABLE, AUDIT_CONTRADICTED,
  OFF_TABLE_CLAIM, FORFEIT_OF_LOST_ENTRY,
];

/**
 * WHICH WAY A FALSE RESULT WENT, for the player it named (kanban #975): 'RAISED' when the signed result is better for them than
 * the replay's, 'LOWERED' when worse, 'SAME' when neither outcome nor score moved. Better is what a payout reads: a delivery over
 * a stake handed back over a lost one, then the score. `signed` and `replayed` are `{ outcome, score }`; null if either is missing.
 */
const RESULT_STANDING = Object.freeze({ DELIVERED: 2, VOID: 1, FAILED: 0, FORFEIT: 0 });
export function resultMoved({ signed, replayed } = {}) {
  if (!signed || !replayed || !(signed.outcome in RESULT_STANDING) || !(replayed.outcome in RESULT_STANDING)) return null;
  const by = RESULT_STANDING[signed.outcome] - RESULT_STANDING[replayed.outcome] || signed.score - replayed.score;
  return by > 0 ? 'RAISED' : by < 0 ? 'LOWERED' : 'SAME';
}

/**
 * §5A.3 (RULED 2026-09-22): WHO A SLASH HARMED, read off the offence and never judged.
 *
 * Three name ONE entry, and it is not always the one harmed (kanban #975). A result that LOWERED that player harmed them. A result
 * that raised them harmed everybody else, and paying the named player would hand a committee's friend the slash for the lie told
 * in their favour - so they get nothing and the other FINANCIALLY ACTIVATED entries are named. A doubled result says nothing about
 * which way it went, so it is read the same way: a player it lowered is shown by the replay's proof, not this one.
 * The others harmed the whole paying field, so they name every activated entry (§22A's fee base),
 * and `OPERATOR_PLAYED` drops the operator's own, which §5A.13 voids. Being named is not being paid: each gets its real loss
 * (`realLosses`), and an entry with none gets nothing.
 *
 * `entries` are the round's, each `{ playerPubkey, netStakeMsat, activated, operatorOwn }`. The caller
 * supplies them because only a node holding the round knows which entries paid; this decides nothing
 * about them, it only selects.
 */
// A CONTRADICTED AUDIT NAMES ONE ENTRY TOO (kanban #724, #725): the one whose contradicted run its proof names - the auditor
// vouched for every entry, but only that one's player was harmed by the run it said replays.
export const NAMES_ONE_ENTRY = [TWO_RESULTS, REPLAY_CONTRADICTS, AUDIT_CONTRADICTED];
// A RELEASE WITH NO VALID PROOF HARMED A NODE, NOT A PLAYER: it names no entry, and all of the signer's bond goes to the reserves (§5A.3).
export const NAMES_NO_ENTRY = [RELEASE_WITHOUT_PROOF];
export function affectedEntries({ offence, playerPubkey, entries = [], signed, replayed, claimedKeys = null } = {}) {
  if (!OFFENCES.includes(offence)) return { ok: false, why: `${offence} is not one of the offences` };
  if (NAMES_NO_ENTRY.includes(offence)) return { ok: true, affected: [] };
  if (NAMES_ONE_ENTRY.includes(offence)) {
    const one = entries.find((e) => e && hex(e.playerPubkey) === hex(playerPubkey));
    if (!one) return { ok: false, why: 'that proof names a player the round has no entry for' };
    const others = entries.filter((e) => e && e.activated && e !== one);
    if (offence === TWO_RESULTS) return { ok: true, affected: others };
    const moved = resultMoved({ signed, replayed });
    if (!moved) return { ok: false, why: 'who a false result harmed needs both the signed result and the replay' };
    return { ok: true, affected: moved === 'LOWERED' ? [one] : others, moved };
  }
  const paying = entries.filter((e) => e && e.activated);
  // (b) A FORFEIT OF A LOST ENTRY HELPED THAT ENTRY (kanban #1146 B, as RAISED in #975): every other activated entry is harmed, the forfeited one gets nothing
  if (offence === FORFEIT_OF_LOST_ENTRY) return { ok: true, affected: paying.filter((e) => hex(e.playerPubkey) !== hex(playerPubkey)) };
  // (a) AN OFF-TABLE CLAIM HARMED THE ENTRIES WHOSE LOCKS IT CLAIMED: `claimedKeys` (player key hex) - none named, nobody is affected
  if (offence === OFF_TABLE_CLAIM) return { ok: true, affected: paying.filter((e) => claimedKeys && claimedKeys.has(hex(e.playerPubkey))) };
  const affected = offence === OPERATOR_PLAYED ? paying.filter((e) => !e.operatorOwn) : paying;
  return { ok: true, affected };
}

/**
 * The proof body: what a proof names. It has no hash of its own: H(fraud_proof) is of the complete proof (encodeFraudProof, kanban #1065).
 *
 * `bondTxid`/`bondVout` are the outpoint the accused node's own advertisement
 * committed to - the bond is named by the node, not chosen by the accuser.
 */
export function encodeSlashProof(p) {
  const w = new Writer();
  w.u8(TYPE_SLASH_PROOF);
  w.u16(PROTOCOL_VERSION);
  w.bytes32(p.roundId);
  w.bytes32(p.playerPubkey);
  w.bytes32(p.nodePubkey);

  // WHAT WAS REPLAYED, and what was signed about it. Both, because either
  // alone is unfalsifiable: a transcript with no result names no offence, and
  // a result with no transcript names no replay to have contradicted it.
  w.bytes32(p.transcriptHash);
  w.bytes32(p.signedResultId);

  w.bytes32(p.bondTxid);
  w.u32(p.bondVout);
  return w.finish();
}

export function decodeSlashProof(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== TYPE_SLASH_PROOF) throw new Error('not a slash proof');
  if (!speaksVersion(r.u16())) throw new Error('unknown protocol version');
  const p = {
    roundId: r.bytes32(),
    playerPubkey: r.bytes32(),
    nodePubkey: r.bytes32(),
    transcriptHash: r.bytes32(),
    signedResultId: r.bytes32(),
    bondTxid: r.bytes32(),
    bondVout: r.u32(),
  };
  if (r.at !== bytes.length) throw new Error('trailing bytes after the slash proof');
  return p;
}

/** 1 type + 2 version + six 32-byte fields + a 4-byte vout. */
export const SLASH_PROOF_BYTES = 199;
export const SLASH_EVIDENCE_BYTES = SLASH_PROOF_BYTES + SIGNED_RESULT_BYTES;
/** The size of the published proof starting at `at`: the proof and the signed result its type byte sizes (a price round's is 10 longer). */
export const slashEvidenceBytesOf = (bytes, at = 0) => SLASH_PROOF_BYTES + signedResultBytesOf(bytes, at + SLASH_PROOF_BYTES);
/** And a re-run proof's: the proof and the signed re-run result. */
export const rerunSlashEvidenceBytesOf = (bytes, at = 0) => SLASH_PROOF_BYTES + signedRerunBytesOf(bytes, at + SLASH_PROOF_BYTES);
/** Cut a stream of published proofs (results or re-runs, each by its own type byte); a record that does not fit ends the stream. */
export function cutSlashEvidence(body) {
  const out = [];
  for (let at = 0; at < body.length;) {
    let n; try { n = slashEvidenceBytesOf(body, at); } catch { try { n = rerunSlashEvidenceBytesOf(body, at); } catch { break; } }
    if (at + n > body.length) break;
    out.push(body.subarray(at, at + n)); at += n;
  }
  return out;
}

/**
 * A PROOF AS IT IS PUBLISHED (5A.3B step 1, "anyone publishes a fraud
 * proof"): the proof and, beside it, the signed result it accuses. Both fixed
 * sizes, so a stream of them cuts without a framing rule, and a reader holds
 * everything `slashHolds` needs from the round except the replay verdict.
 */
export function joinSlashEvidence(proofBytes, signedResult) {
  if (proofBytes.length !== SLASH_PROOF_BYTES) throw new Error(`a slash proof is ${SLASH_PROOF_BYTES} bytes, got ${proofBytes.length}`);
  let n = -1; try { n = signedResultBytesOf(signedResult); } catch { n = -1; }
  if (signedResult.length !== n) throw new Error(`a signed result is ${n > 0 ? n : SIGNED_RESULT_BYTES} bytes, got ${signedResult.length}`);
  const out = new Uint8Array(SLASH_PROOF_BYTES + n);
  out.set(proofBytes, 0);
  out.set(signedResult, SLASH_PROOF_BYTES);
  return out;
}

export function splitSlashEvidence(bytes) {
  let n = -1; if (bytes instanceof Uint8Array) { try { n = slashEvidenceBytesOf(bytes); } catch { n = -1; } }
  if (n < 0 || bytes.length !== n) throw new Error(`a published slash proof is ${n > 0 ? n : SLASH_EVIDENCE_BYTES} bytes`);
  const proofBytes = bytes.subarray(0, SLASH_PROOF_BYTES);
  return { proof: decodeSlashProof(proofBytes), proofBytes, signedResult: bytes.subarray(SLASH_PROOF_BYTES) };
}

/**
 * A PROOF AGAINST A RE-RUN SIGNER, AS IT IS PUBLISHED (§13A, RULED 2026-09-24, slice C2c): the same proof body,
 * and beside it the accused's own signed RE-RUN result `{ contradictedRunId, result }` - what a re-run signer signed,
 * over `rerunResultId` - never a signed player result, so it does not go through `joinSlashEvidence`. Its own fixed
 * size, so neither shape can be read as the other.
 */
export const RERUN_SLASH_EVIDENCE_BYTES = SLASH_PROOF_BYTES + SIGNED_RERUN_BYTES;

export function joinRerunSlashEvidence(proofBytes, signedRerun) {
  if (proofBytes.length !== SLASH_PROOF_BYTES) throw new Error(`a slash proof is ${SLASH_PROOF_BYTES} bytes, got ${proofBytes.length}`);
  let n = -1; try { n = signedRerunBytesOf(signedRerun); } catch { n = -1; }
  if (signedRerun.length !== n) throw new Error(`a signed re-run result is ${n > 0 ? n : SIGNED_RERUN_BYTES} bytes, got ${signedRerun.length}`);
  const out = new Uint8Array(SLASH_PROOF_BYTES + n);
  out.set(proofBytes, 0);
  out.set(signedRerun, SLASH_PROOF_BYTES);
  return out;
}

export function splitRerunSlashEvidence(bytes) {
  let n = -1; if (bytes instanceof Uint8Array) { try { n = rerunSlashEvidenceBytesOf(bytes); } catch { n = -1; } }
  if (n < 0 || bytes.length !== n) throw new Error(`a published re-run slash proof is ${n > 0 ? n : RERUN_SLASH_EVIDENCE_BYTES} bytes`);
  const proofBytes = bytes.subarray(0, SLASH_PROOF_BYTES);
  return { proof: decodeSlashProof(proofBytes), proofBytes, signedRerun: bytes.subarray(SLASH_PROOF_BYTES) };
}

/**
 * THE COMPLETE PROOF, AND WHAT A SLASH COMMITS TO (5A.3B, RULED 2026-11-03, kanban #1065): "H(fraud_proof) is the hash of the complete proof: everything a checker needs, signatures included. The
 * bytes under that hash are the proof. Bytes that do not hash to it are not a copy of anything."
 *
 *   evidence   the published record of its offence: the proof body and every signature, as each join below writes it
 *   contract   the round's contract: its id is the proof's round
 *   entry      the entry's contract, for a replay or an AUDIT
 *   bundle     the objection that held: the transcript, the receipts and the replay's inputs, for a replay or an AUDIT
 *
 * So a checker fetches by hash from anyone and holds one thing to judge. If it does not check, the start really was false. Two seats may build two valid proofs of one offence, under two sets of
 * signatures or two objections: that is two hashes, one bond has one start, and the holders who signed it hold the bytes of the one that landed. An ABANDONED row's proof needs no round, and
 * carries its record itself (abandoned-slash.js).
 *
 * The retrieval hint is not here. It is where to fetch the proof, and the spec does not fix its shape. What is fixed is the hash it follows.
 */
const NO_PART = new Uint8Array(0);
export function encodeFraudProof({ evidence, contract = NO_PART, entry = NO_PART, bundle = NO_PART }) {
  const w = new Writer();
  w.u8(TYPE_FRAUD_PROOF);
  w.u16(PROTOCOL_VERSION);
  for (const part of [evidence, contract, entry, bundle]) { w.u32(part.length); w.bytes(part, part.length); }
  return w.finish();
}

export function decodeFraudProof(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== TYPE_FRAUD_PROOF) throw new Error('not a fraud proof');
  if (!speaksVersion(r.u16())) throw new Error('unknown protocol version');
  const part = () => r.bytes(r.u32());
  const p = { evidence: part(), contract: part(), entry: part(), bundle: part() };
  r.end();
  return p;
}

/** H(fraud_proof): the 32 bytes a slash's OP_RETURN commits to, of the complete proof's bytes. */
export const fraudProofHash = (bytes) => taggedHash(TAG.slashProof, bytes);

/** Whether `bytes` is a complete proof of a round's offence: a reader of proofs of every kind asks this first. */
export const isFraudProof = (bytes) => bytes instanceof Uint8Array && bytes[0] === TYPE_FRAUD_PROOF;

/** WHICH OFFENCE'S RECORD THIS IS, cut: { kind: 'audit' | 'rerun' | 'table' | 'release' | 'double' | 'result', proof, ...its parts }. Throws on anything else. */
export function readEvidence(evidence) {
  if (evidence[0] === TYPE_AUDIT_SLASH_PROOF) return { kind: 'audit', ...splitAuditSlashEvidence(evidence) };
  if (evidence[SLASH_PROOF_BYTES] === TYPE_RERUN_RESULT) return { kind: 'rerun', ...splitRerunSlashEvidence(evidence) };
  if (evidence[SLASH_PROOF_BYTES] === TYPE_SETTLEMENT_ACK) return { kind: 'table', ...splitTableSlashEvidence(evidence) };
  if (evidence[SLASH_PROOF_BYTES] === TYPE_RELEASE_EVIDENCE) return { kind: 'release', ...splitReleaseSlashEvidence(evidence) };
  if (evidence[SLASH_PROOF_BYTES] === TYPE_NAMED_CLAIM_EVIDENCE) return { kind: 'named', ...splitNamedClaimEvidence(evidence) };
  let doubled = -1; try { doubled = doubleSlashEvidenceBytesOf(evidence); } catch { doubled = -1; }
  if (doubled === evidence.length) return { kind: 'double', ...splitDoubleSlashEvidence(evidence) };
  return { kind: 'result', ...splitSlashEvidence(evidence) };
}

/**
 * DOES THIS PROOF SLASH THIS BOND?
 *
 * Mechanical, in 5A.3B step 2's sense: every check below is a comparison, and
 * the one judgement - did the replay differ - is handed in rather than made.
 *
 * `advert` is the accused node's own signed advertisement, decoded. Its
 * signature is somebody else's business, as always here: no curve lives in
 * this package. What it is for is the BOND, so that an accuser cannot name an
 * outpoint of their choosing and have a stranger take it on their word.
 *
 * Returns `{ slashed: false, why }` or `{ slashed: true, offence, bond, why }`.
 */
export function slashHolds({
  proof, signedResult, advert, committee, canonicalTranscriptHash, replayDiffers,
}) {
  if (!Array.isArray(committee) || !committee.length)
    return { slashed: false, why: 'no committee, so nobody was serving this round' };

  // ONLY A COMMITTEE MEMBER CAN BE SLASHED FOR SIGNING THIS ROUND'S RESULT.
  // A stranger's signature is not misconduct; it is a stranger's signature,
  // and `provisionallyFinal` already ignores it.
  if (!committee.some((k) => hex(k) === hex(proof.nodePubkey)))
    return {
      slashed: false,
      why: `${hex(proof.nodePubkey)} is not on this round's committee, so it signed nothing it owed`,
    };

  let body;
  try { body = decodePlayerResult(splitSignedResult(signedResult).body); }
  catch (e) { return { slashed: false, why: `the evidence is not a signed result: ${e.message}` }; }

  // THE EVIDENCE HAS TO BE THE RESULT THE PROOF ACCUSES. Without this the
  // proof names one result and carries another, and every check below is
  // about the wrong object.
  if (hex(resultId(body)) !== hex(proof.signedResultId))
    return { slashed: false, why: 'the signed result attached is not the one this proof names' };
  if (hex(body.nodePubkey) !== hex(proof.nodePubkey))
    return { slashed: false, why: 'the result attached was signed by a different node' };
  if (hex(body.roundId) !== hex(proof.roundId))
    return { slashed: false, why: 'the result attached is for a different round' };
  if (hex(body.playerPubkey) !== hex(proof.playerPubkey))
    return { slashed: false, why: 'the result attached is for a different player' };

  // AND IT HAS TO BE ABOUT THE CANONICAL TRANSCRIPT. A node that signed a
  // result about some other object did not contradict this replay - it
  // answered a different question, which is 13C's no-quorum case and not a
  // slashing one. Both the proof and the result have to name it, or the
  // accuser could point a genuine replay at a result that never mentioned it.
  if (!(canonicalTranscriptHash instanceof Uint8Array))
    return { slashed: false, why: 'no canonical transcript to have replayed' };
  if (hex(proof.transcriptHash) !== hex(canonicalTranscriptHash))
    return { slashed: false, why: 'the proof names a transcript that is not the canonical one' };
  if (hex(body.transcriptHash) !== hex(canonicalTranscriptHash))
    return {
      slashed: false,
      why: 'the result attached was signed about a different transcript, so no replay of '
        + 'this one contradicts it',
    };

  // THE BOND IS THE NODE'S OWN. 5A.3's eligibility is "bond output exists...
  // committed advertisement body retrievable and hash-matching", so the
  // outpoint a slash spends is the one the node itself advertised. An accuser
  // who could name the outpoint would be naming anybody's money.
  if (!advert || hex(advert.nodePubkey) !== hex(proof.nodePubkey))
    return { slashed: false, why: 'no advertisement from the accused node to name its bond' };
  if (hex(advert.bondTxid) !== hex(proof.bondTxid) || advert.bondVout !== proof.bondVout)
    return {
      slashed: false,
      why: `the proof names bond ${hex(proof.bondTxid)}:${proof.bondVout} and the node `
        + `advertised ${hex(advert.bondTxid)}:${advert.bondVout}`,
    };

  // AND THE ONE JUDGEMENT, WHICH IS NOT MADE HERE. Anything but an explicit
  // yes leaves the bond alone: 5A.3B's own residual is that "any slashing
  // mechanism needs an off-chain party to attest that the proof checks - and
  // that party can, in principle, slash without cause", so the default has to
  // be the one that costs an honest node nothing.
  if (replayDiffers !== true)
    return { slashed: false, why: 'no replay has contradicted the signed result' };

  return {
    slashed: true,
    offence: REPLAY_CONTRADICTS,
    bond: { txid: proof.bondTxid, vout: proof.bondVout },
    why: 'the node signed a result the canonical transcript does not replay to',
  };
}

/**
 * DOES THIS PROOF SLASH A RE-RUN SIGNER'S BOND? (§13A: once a second valid objection has made the entry VOID, "the
 * signers of that result are slashed as well"; RULED 2026-09-24, slice C2c.) The offence is the same,
 * REPLAY_CONTRADICTS, and so are the comparisons, on the record a re-run signer signed: the accused is on the committee;
 * the evidence is their own signature - `verify` is injected, no curve lives in this package - over `rerunResultId`,
 * about this round, this player and the canonical transcript, and it is the agreed re-run's run (`agreedRunId`), not
 * another outcome; the bond is the one their own advertisement names; and the one judgement is handed in, as in
 * `slashHolds`: this node's own re-run differs from the agreed one - the difference that made the second objection hold.
 */
export function slashHoldsOnRerun({
  proof, signedRerun, advert, committee, canonicalTranscriptHash, agreedRunId, replayDiffers, verify,
}) {
  if (!Array.isArray(committee) || !committee.length)
    return { slashed: false, why: 'no committee, so nobody was serving this round' };
  if (!committee.some((k) => hex(k) === hex(proof.nodePubkey)))
    return { slashed: false, why: `${hex(proof.nodePubkey)} is not on this round's committee, so it signed nothing it owed` };
  if (typeof verify !== 'function') return { slashed: false, why: 'checking a re-run signature needs a verifier, and none was injected' };

  let x, signature;
  try { const split = splitSignedRerun(signedRerun); signature = split.signature; x = decodeRerunResult(split.body); }
  catch (e) { return { slashed: false, why: `the evidence is not a signed re-run result: ${e.message}` }; }
  const signed = rerunResultId(x);
  if (hex(signed) !== hex(proof.signedResultId))
    return { slashed: false, why: 'the signed re-run result attached is not the one this proof names' };
  if (hex(x.result.nodePubkey) !== hex(proof.nodePubkey))
    return { slashed: false, why: 'the re-run result attached names a different signer' };
  let theirs = false;
  try { theirs = verify(signature, signed, x.result.nodePubkey) === true; } catch { theirs = false; }
  if (!theirs) return { slashed: false, why: 'the signature on the re-run result attached is not the accused node\'s' };
  if (hex(x.result.roundId) !== hex(proof.roundId))
    return { slashed: false, why: 'the re-run result attached is for a different round' };
  if (hex(x.result.playerPubkey) !== hex(proof.playerPubkey))
    return { slashed: false, why: 'the re-run result attached is for a different player' };
  if (!(canonicalTranscriptHash instanceof Uint8Array))
    return { slashed: false, why: 'no canonical transcript to have replayed' };
  if (hex(proof.transcriptHash) !== hex(canonicalTranscriptHash))
    return { slashed: false, why: 'the proof names a transcript that is not the canonical one' };
  if (hex(x.result.transcriptHash) !== hex(canonicalTranscriptHash))
    return { slashed: false, why: 'the re-run result attached was signed about a different transcript, so no replay of this one contradicts it' };
  if (!(agreedRunId instanceof Uint8Array) || hex(runOf(x.result)) !== hex(agreedRunId))
    return { slashed: false, why: `${hex(proof.nodePubkey)} is not among the agreeing re-runs: its re-run is another outcome` };
  if (!advert || hex(advert.nodePubkey) !== hex(proof.nodePubkey))
    return { slashed: false, why: 'no advertisement from the accused node to name its bond' };
  if (hex(advert.bondTxid) !== hex(proof.bondTxid) || advert.bondVout !== proof.bondVout)
    return {
      slashed: false,
      why: `the proof names bond ${hex(proof.bondTxid)}:${proof.bondVout} and the node advertised ${hex(advert.bondTxid)}:${advert.bondVout}`,
    };
  if (replayDiffers !== true)
    return { slashed: false, why: 'no replay has contradicted the agreed re-run' };
  return {
    slashed: true,
    offence: REPLAY_CONTRADICTS,
    bond: { txid: proof.bondTxid, vout: proof.bondVout },
    why: 'the node signed a re-run the canonical transcript does not replay to, and a second valid objection proved it',
  };
}

/**
 * A CONTRADICTED AUDIT, AS A SLASH PROOF (§13A.1, kanban #724, #725). Until this an auditor whose AUDIT a valid objection
 * contradicted was only unpaid: the seat kept its bytes as "the fraud proof against its signer" and nothing could carry them to the
 * bond, because every proof above is about a signed player result. The proof body names the AUDIT, the entry whose run it vouched
 * for, that run, the canonical transcript the objection replayed and the bond the auditor's own advertisement names:
 *
 *   type 0x37 | version | round_id | entry_id | player_pubkey | node_pubkey | audit_id | contradicted_run_id | transcript_hash
 *   | bond_txid | bond_vout                                                                             (263 bytes)
 *
 * and beside it, as a player-result proof carries the signed result, the evidence: the AUDIT's bytes, its signature and the rows
 * (entry id, run id) its results_hash is over - so a stranger sees that the AUDIT vouched for exactly that run of that entry:
 *
 *   AUDIT (188) | signature (64) | n (u16) | n x (entry_id 32, run_id 32)
 *
 * The objection that held (the transcript, its receipts, the replay) travels as it does for the player-result kind: the seat's
 * GET /objection-bundle for (round, entry), REPLAYED by whoever judges the proof. Its own type byte, under the same slash-proof tag:
 * the proof's id is what a slashing transaction commits to (5A.3B step 4), and no proof of one kind reads as the other.
 */
export const AUDIT_SLASH_PROOF_BYTES = 263;
/** An AUDIT's own bytes: type, version, three 32-byte fields, its time (u64) and its 81-byte VRF proof. */
export const AUDIT_BYTES = 188;

export function encodeAuditSlashProof(p) {
  const w = new Writer();
  w.u8(TYPE_AUDIT_SLASH_PROOF);
  w.u16(PROTOCOL_VERSION);
  w.bytes32(p.roundId);
  w.bytes32(p.entryId);
  w.bytes32(p.playerPubkey);
  w.bytes32(p.nodePubkey);
  w.bytes32(p.auditId);
  w.bytes32(p.contradictedRunId);
  w.bytes32(p.transcriptHash);
  w.bytes32(p.bondTxid);
  w.u32(p.bondVout);
  return w.finish();
}

export function decodeAuditSlashProof(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== TYPE_AUDIT_SLASH_PROOF) throw new Error('not a slash proof against an AUDIT');
  if (!speaksVersion(r.u16())) throw new Error('unknown protocol version');
  const p = {
    roundId: r.bytes32(), entryId: r.bytes32(), playerPubkey: r.bytes32(), nodePubkey: r.bytes32(), auditId: r.bytes32(),
    contradictedRunId: r.bytes32(), transcriptHash: r.bytes32(), bondTxid: r.bytes32(), bondVout: r.u32(),
  };
  if (r.at !== bytes.length) throw new Error('trailing bytes after the slash proof');
  return p;
}

/** Its id, under the slash-proof tag: the 32 bytes a slashing transaction's OP_RETURN commits to. */

/** The published size of the proof starting at `at`: its body, the AUDIT, the signature and its rows. */
export function auditSlashEvidenceBytesOf(bytes, at = 0) {
  const head = at + AUDIT_SLASH_PROOF_BYTES + AUDIT_BYTES + 64;
  if (!(bytes instanceof Uint8Array) || bytes.length < head + 2 || bytes[at] !== TYPE_AUDIT_SLASH_PROOF)
    throw new Error('not a published slash proof against an AUDIT');
  return head + 2 + ((bytes[head] << 8) | bytes[head + 1]) * 64 - at;
}

/** A PROOF AGAINST AN AUDIT, AS IT IS PUBLISHED: the body, the AUDIT and its signature, its rows. */
export function joinAuditSlashEvidence(proofBytes, auditBytes, signature, rows) {
  if (proofBytes.length !== AUDIT_SLASH_PROOF_BYTES) throw new Error(`a slash proof against an AUDIT is ${AUDIT_SLASH_PROOF_BYTES} bytes, got ${proofBytes.length}`);
  if (auditBytes.length !== AUDIT_BYTES) throw new Error(`an AUDIT is ${AUDIT_BYTES} bytes, got ${auditBytes.length}`);
  if (!(signature instanceof Uint8Array) || signature.length !== 64) throw new Error('an AUDIT\'s signature is 64 bytes');
  if (!Array.isArray(rows) || rows.length > 0xffff) throw new Error('the rows an AUDIT is over are a list');
  const w = new Writer();
  w.bytes(proofBytes, AUDIT_SLASH_PROOF_BYTES); w.bytes(auditBytes, AUDIT_BYTES); w.bytes(signature, 64); w.u16(rows.length);
  for (const x of rows) { w.bytes32(x.entryId); w.bytes32(x.runId); }
  return w.finish();
}

export function splitAuditSlashEvidence(bytes) {
  let n = -1; try { n = auditSlashEvidenceBytesOf(bytes); } catch { n = -1; }
  if (n < 0 || bytes.length !== n) throw new Error('that is not a published slash proof against an AUDIT');
  const proofBytes = bytes.subarray(0, AUDIT_SLASH_PROOF_BYTES);
  let at = AUDIT_SLASH_PROOF_BYTES;
  const audit = bytes.subarray(at, at + AUDIT_BYTES); at += AUDIT_BYTES;
  const signature = bytes.subarray(at, at + 64); at += 64 + 2;
  const rows = [];
  for (; at < bytes.length; at += 64) rows.push({ entryId: bytes.slice(at, at + 32), runId: bytes.slice(at + 32, at + 64) });
  return { proof: decodeAuditSlashProof(proofBytes), proofBytes, audit, signature, rows };
}

/** Cut a stream of published proofs against AUDITs; a record that does not fit ends the stream. */
export function cutAuditSlashEvidence(body) {
  const out = [];
  for (let at = 0; at < body.length;) {
    let n; try { n = auditSlashEvidenceBytesOf(body, at); } catch { break; }
    if (at + n > body.length) break;
    out.push(body.subarray(at, at + n)); at += n;
  }
  return out;
}

/**
 * DOES THIS PROOF SLASH AN AUDITOR'S BOND? (§13A.1, kanban #724, #725.) Mechanical, as `slashHolds` is: every check a comparison or a
 * signature, and the one judgement - did the replay contradict the run - handed in as `replayDiffers`, never made here.
 *
 *   the AUDIT      is the one the proof names, by the node it names, for the round it names; and it STOOD: signed by that node,
 *                  its VRF proof good for the round, the node in the round's eligible set (`eligible`, `total`, as a seat's
 *                  auditStands reads them) and drawn, signed at least 30 s before `windowCloseMs`. An AUDIT no seat could have
 *                  taken vouched for nothing, as a stranger's result signature owes nothing.
 *   the rows       are the results it vouched for: auditResultsHash(rows) is its results_hash, and the row of the proof's entry
 *                  is the run the proof says was contradicted.
 *   the entry      is the proof's (entryId of `entry`), of the proof's round, and its player is the proof's - the one paid.
 *   the objection  held against that run (`objectedRunId`, the run the held objection names), on the canonical transcript.
 *   the bond       is the one the auditor's own advertisement names.
 *
 * `vrf` and `verify` are injected (no curve lives in this package). Returns `{ slashed: false, why }` or `{ slashed: true, offence,
 * bond, why }`.
 */
export function slashHoldsOnAudit({
  proof, audit, signature, rows, entry, advert, eligible, total, vrf, verify, windowCloseMs,
  canonicalTranscriptHash, objectedRunId, replayDiffers,
}) {
  const no = (why) => ({ slashed: false, why });
  if (!proof) return no('no proof');
  if (typeof verify !== 'function' || !vrf || typeof vrf.verify !== 'function') return no('checking an AUDIT needs a verifier and a VRF, and none was injected');
  if (!(eligible instanceof Map) || typeof total !== 'bigint') return no('no eligible set to say who could audit this round');
  let a;
  try { a = decodeAudit(audit); } catch (e) { return no(`the evidence is not an AUDIT: ${e.message}`); }
  if (hex(auditId(a)) !== hex(proof.auditId)) return no('the AUDIT attached is not the one this proof names');
  if (hex(a.nodePubkey) !== hex(proof.nodePubkey)) return no('the AUDIT attached was signed by a different node');
  if (hex(a.roundId) !== hex(proof.roundId)) return no('the AUDIT attached is for a different round');
  if (windowCloseMs === undefined || windowCloseMs === null) return no('no window close to say whether the AUDIT counted');
  let stood;
  try { stood = auditStands(a, { signature, vrf, verify, eligible, total, resultsHash: null, windowCloseMs }); }
  catch (e) { stood = { ok: false, why: e.message }; }
  if (!stood.ok) return no(`the AUDIT attached does not stand: ${stood.why}`);

  // WHAT IT VOUCHED FOR, ROW BY ROW: without the rows the AUDIT names only a hash, and no stranger can say which run of which entry it is
  let vouched;
  try { vouched = auditResultsHash((rows || []).map((x) => ({ entryId: x.entryId, resultDigest: x.runId }))); }
  catch (e) { return no(`the rows attached do not read: ${e.message}`); }
  if (hex(vouched) !== hex(a.resultsHash)) return no('the rows attached are not the results the AUDIT vouched for');
  const row = rows.find((x) => hex(x.entryId) === hex(proof.entryId));
  if (!row) return no('the AUDIT vouched for no run of the entry this proof names');
  if (hex(row.runId) !== hex(proof.contradictedRunId))
    return no('the AUDIT vouched for another run of that entry than the one this proof says was contradicted');

  // THE ENTRY, FOR WHO WAS HARMED: its id is the proof's, its round the AUDIT's
  if (!entry) return no('no entry to name the player harmed');
  let eid;
  try { eid = entryId(entry); } catch (e) { return no(`the entry does not encode: ${e.message}`); }
  if (hex(eid) !== hex(proof.entryId)) return no('the entry attached is not the one this proof names');
  if (hex(entry.roundId) !== hex(proof.roundId)) return no('the entry attached is for a different round');
  if (hex(entry.playerPubkey) !== hex(proof.playerPubkey)) return no('the proof names another player than the entry\'s');

  // THE OBJECTION THAT HELD WAS AGAINST THAT RUN, ON THE CANONICAL TRANSCRIPT. An objection against another run of the entry (the
  // re-run's, a second objection) contradicts something this AUDIT never vouched for.
  if (!(objectedRunId instanceof Uint8Array) || hex(objectedRunId) !== hex(proof.contradictedRunId))
    return no('no objection held against the run this AUDIT vouched for, so nothing contradicts it');
  if (!(canonicalTranscriptHash instanceof Uint8Array)) return no('no canonical transcript to have replayed');
  if (hex(proof.transcriptHash) !== hex(canonicalTranscriptHash)) return no('the proof names a transcript that is not the canonical one');

  if (!advert || hex(advert.nodePubkey) !== hex(proof.nodePubkey)) return no('no advertisement from the accused node to name its bond');
  if (hex(advert.bondTxid) !== hex(proof.bondTxid) || advert.bondVout !== proof.bondVout)
    return no(`the proof names bond ${hex(proof.bondTxid)}:${proof.bondVout} and the node advertised ${hex(advert.bondTxid)}:${advert.bondVout}`);

  // AND THE ONE JUDGEMENT, NOT MADE HERE: anything but an explicit yes leaves the bond alone (5A.3B's residual)
  if (replayDiffers !== true) return no('no replay has contradicted the run the AUDIT vouched for');
  return {
    slashed: true,
    offence: AUDIT_CONTRADICTED,
    bond: { txid: proof.bondTxid, vout: proof.bondVout },
    why: 'the auditor signed that a run replays, and a valid objection replayed the canonical transcript to another result',
  };
}

/**
 * A TABLE READ AGAINST WHAT IS SHOWN (the table row's reading, kanban #1040, #1043; and offence row (a)'s correct table, ruling #1131 4): the entries bound to their
 * rows, tableFalse, the claims of proved qualifiers, and F where F makes the table. Answers { ok: true, differs, complete } - `complete` when F was read and every
 * row has a threshold of FINALs - or { ok: false, why } when it cannot be read.
 */
export function tableAgainstFinals({ claimed, roundId, contract, attested = false, payoutShares = null, entries = [], finals = [], committee, verify, feesOf = () => null, ownTable = null }) {
  const no = (why) => ({ ok: false, why });
  const proof = { roundId };
  const rule = { payoutShares };
  // THE ENTRIES, EACH BOUND TO THE ROW THAT NAMES IT
  let finalAfterMs;
  try { ({ finalAfterMs } = windowsOf(contract)); } catch (e) { return no(`the round's window cannot be read: ${e.message}`); }
  const rowOf = new Map(claimed.rows.map((r) => [hex(r.entryId), r]));
  const differs = [];
  const shown = new Map();
  for (const e of [...entries, ...finals.map((f) => f && f.entry)]) {
    let id;
    try { id = hex(entryId(e)); } catch { continue; }
    shown.set(id, e);
    const row = rowOf.get(id);
    if (!row) continue;
    if (hex(e.roundId) !== hex(proof.roundId)) differs.push(`entry ${id.slice(0, 16)} is of another round`);
    else if (hex(e.playerPubkey) !== hex(row.pubkey)) differs.push(`entry ${id.slice(0, 16)} is another player's`);
  }

  try { differs.push(...tableFalse({ table: claimed, contract, entries: shown, payoutShares: rule.payoutShares, feesOf, attested, ownTable })); }
  catch (e) { return no(`the table cannot be read: ${e.message}`); }

  const proved = new Map();
  for (const f of finals) {
    if (!f || !f.entry) continue;
    let id, body;
    try { id = entryId(f.entry); body = decodePlayerResult(splitSignedResult(f.signedResult).body); } catch { continue; }
    if (hex(body.roundId) !== hex(proof.roundId) || hex(body.playerPubkey) !== hex(f.entry.playerPubkey)) continue;
    // A FINAL SIGNATURE IS JUDGED BY ITS OWN SIGNED TIME HERE: the tolerance is a receiving seat's clock, and a proof has none
    const records = [];
    for (const bytes of f.finalSigs || []) {
      try { records.push({ bytes, seenMs: decodeFinalSig(splitSignedFinalSig(bytes).body).signedAtMs }); } catch { /* it does not count */ }
    }
    const signed = finalSigned({ roundId: proof.roundId, entryId: id, runId: runOf(body), records, committee, slots: contract.settlementSlots, finalAfterMs, verify });
    if (signed.ok) proved.set(hex(id), { entryId: id, pubkey: f.entry.playerPubkey, outcome: body.outcome, score: body.score,
      stakeMsat: f.entry.stakeMsat, feeMsat: f.entry.feeMsat, donationMsat: f.entry.donationMsat });
  }
  differs.push(...claimsProvedQualifier({ table: claimed, proved, minScore: contract.minScore }));

  // F, READ ONLY WHERE F MAKES THE TABLE
  const isLate = hex(claimed.lateEntryId) !== hex(EMPTY);
  const readsF = !isLate && !attested && claimed.rows.length > 0 && !claimed.rows.some(namesNoEntry);
  const complete = readsF && claimed.rows.every((r) => proved.has(hex(r.entryId)));
  if (complete) {
    const rows = claimed.rows.map((r) => proved.get(hex(r.entryId)));
    let honest;
    try { honest = computePayoutTable({ roundId: claimed.roundId, entries: rows, minScore: contract.minScore, payoutShares: rule.payoutShares, protocolVersion: contract.protocolVersion }); }
    catch (e) { return no(`F cannot be computed from those entries: ${e.message}`); }
    const owed = new Map(honest.activated.map((e, i) => [hex(e.entryId), honest.table[i].amountMsat]));
    for (const r of claimed.rows) {
      const id = hex(r.entryId);
      const want = owed.has(id) ? owed.get(id) : 0n;
      if (r.amountMsat !== want) differs.push(`entry ${id.slice(0, 16)} is paid ${r.amountMsat} and F pays ${want}`);
    }
  } else if (readsF) {
    for (const [id, e] of proved) {
      const row = rowOf.get(id);
      if (!row) continue;
      if (!isQualifier(e, contract.minScore)) {
        if (row.amountMsat !== 0n) differs.push(`entry ${id.slice(0, 16)} did not qualify and is paid ${row.amountMsat}`);
      } else if (row.amountMsat < netStakeMsat(e)) differs.push(`entry ${id.slice(0, 16)} qualified and is paid ${row.amountMsat}, under its own net stake`);
    }
  }
  return { ok: true, differs, complete };
}

/**
 * DOES THIS ACK SLASH THIS BOND? §5A.3, "a payout table that is not F", RULED 2026-11-02 (kanban #1035, #1040).
 *
 * A row stands only on bytes the accused signed with its node key, and a FROST signature names nobody. So the evidence is the accused's
 * own SettlementAck over the table's id. `verify` is injected, as for every signature here. No verifier, no slash.
 *
 *   proof           `signedResultId` the ack's id, `transcriptHash` the table's id, `playerPubkey` empty: the table names the players
 *   signedAck       the accused's signed ack
 *   acks            the signed acks published with the settlement: at least the threshold over this table, the accused's among them.
 *                   A table only one seat acked moved nothing, and it is how a seat left behind on a §13C clock would look
 *   table           the table's bytes
 *   finals          [{ entry, signedResult, finalSigs }]: an entry contract, a signed result of its run, the threshold of FINAL signatures
 *   entries         other entry contracts, shown for a row they contradict
 *
 * ONLY A SIGNED FINAL IS READ. A §13C outcome is decided on one seat's clock, so an entry with no threshold of FINAL signatures is left
 * out, and the table is not false on it: that is what stops a filer feeding inputs that make an honest table look false. What the seats
 * signed binds everything F reads: the run's id is the result, the entry id is the stake, the round id is the floor and the game.
 *
 * ONE ENTRY OUT, THE EXACT TABLE CANNOT BE READ. With every row of the table proved, F is recomputed over those rows and compared row by
 * row. With a row unproved, what F pays the others moves with it, so only what holds whatever it was is read: a proved non-qualifier
 * is owed nothing, a proved qualifier at least its own net stake. An entry with a signed FINAL and no row is not read either: it can be
 * a late entry the table rightly left to a second settlement.
 *
 * THE PAIR, FALSE BY ITSELF (RULED 2026-11-02, kanban #1043). A txid that does not rebuild from its table is the offence with no FINAL signature at all, and a table
 * marked late, or empty, or naming no entries gains nothing by it: settlement-rebuild.js. `rebuiltTxid` is the injected verdict of that rebuild, as the replay's is
 * in slashHolds: the stock client's hash of tableBuild's answer, or null where a P or an entry is not shown, and then the txid is not read. `feesOf(federation hex)` is the
 * guardians' rule, read by the caller from the federation; `own` { table, acks } is the round's own settlement, for a table marked late: read only if the accused acked it too.
 *
 * F does not make a late loser's table or a market's: F is not read on them, the rebuild and the claims are.
 */
export function slashHoldsOnTable({
  proof, signedAck, acks = [], table, finals = [], entries = [], contract, manifest = null, advert, committee, verify, rebuiltTxid = null, feesOf = () => null, own = null,
}) {
  const no = (why) => ({ slashed: false, why });
  if (!proof) return no('no proof');
  if (!Array.isArray(committee) || !committee.length) return no('no committee, so nobody was serving this round');
  if (!committee.some((k) => hex(k) === hex(proof.nodePubkey)))
    return no(`${hex(proof.nodePubkey)} is not on this round's committee, so it acked nothing it owed`);
  if (typeof verify !== 'function') return no('checking a signed ack needs a verifier, and none was injected');

  // THE CONTRACT IS THE ROUND'S, so the floor and the game's rule are not the filer's to pick
  if (!contract || !Number.isInteger(contract.minScore) || contract.minScore < 0) return no('no round contract to read the score floor from');
  let rid;
  try { rid = roundIdOf(contract); } catch (e) { return no(`the contract does not encode: ${e.message}`); }
  if (hex(rid) !== hex(proof.roundId)) return no('the contract handed in is not this round\'s');
  const attested = !!manifest && isAttested(manifest);
  const rule = attested ? { ok: true, payoutShares: null } : payoutRuleForRound(contract, manifest);
  if (!rule.ok) return no(`F's payout rule cannot be read: ${rule.why}`);

  // THE ACK, THE ACCUSED'S OWN
  let got;
  try { got = splitSignedAck(signedAck); } catch (e) { return no(`the evidence is not a signed ack: ${e.message}`); }
  if (hex(got.nodePubkey) !== hex(proof.nodePubkey)) return no('the ack attached was signed by a different node');
  if (hex(got.ack.roundId) !== hex(proof.roundId)) return no('the ack attached is for a different round');
  // A PROTOCOL-27 ROUND'S ACKS NAME THE SETTLEMENT BODY ID (ruling #1135 2), signed under their own tag: read as body acks, compared on the body id
  const named = namedClaims(contract);
  const signedAs = named ? { roundId: got.ack.roundId, payoutTableId: got.ack.payoutTableId, settlementBodyId: got.ack.settlementTxid } : got.ack;
  const over = (id) => (named ? { settlementBodyId: id } : { settlementTxid: id });
  if (hex(settlementAckId(signedAs)) !== hex(proof.signedResultId)) return no('the ack attached is not the one this proof names');
  if (hex(got.ack.payoutTableId) !== hex(proof.transcriptHash)) return no('the proof is bound to a different table than the ack names');
  if (hex(proof.playerPubkey) !== hex(EMPTY)) return no('this row names no player: the table does');
  let theirs = false;
  try { theirs = verify(got.signature, settlementAckId(signedAs), proof.nodePubkey) === true; } catch { theirs = false; }
  if (!theirs) return no('the signature on the ack is not the accused node\'s');

  // THE TABLE IT NAMES
  let claimed;
  try { claimed = decodeSettlementTable(table); } catch (e) { return no(`the evidence is not a settlement table: ${e.message}`); }
  if (hex(settlementTableId(claimed)) !== hex(got.ack.payoutTableId)) return no('the table attached is not the one the ack names');
  if (hex(claimed.roundId) !== hex(proof.roundId)) return no('the table attached is for a different round');

  // A TABLE THE SETTLEMENT STOOD ON
  let counted;
  try {
    counted = countAcks({ acks: [signedAck, ...acks], seats: committee, slots: contract.settlementSlots, roundId: proof.roundId,
      payoutTableId: got.ack.payoutTableId, ...over(got.ack.settlementTxid), verify });
  } catch (e) { return no(`the acks cannot be counted: ${e.message}`); }
  if (!counted.final) return no(`${counted.agreed} of the ${counted.needed} seats acked that table, so no settlement stood on it`);

  // THE PAIR AGAINST ITSELF: no FINAL signature reads here
  let ownTable = null;
  if (own) {
    try {
      const t = decodeSettlementTable(own.table);
      const first = splitSignedAck(own.acks[0]).ack;
      const c = countAcks({ acks: own.acks, seats: committee, slots: contract.settlementSlots, roundId: proof.roundId, payoutTableId: settlementTableId(t), ...over(first.settlementTxid), verify });
      // THE ACCUSED'S OWN WORD TOO: five seats can ack any table they like, and that must not turn an honest seat's late table false
      const itsOwn = c.kept.some((b) => hex(splitSignedAck(b).nodePubkey) === hex(proof.nodePubkey));
      if (c.final && itsOwn && hex(t.roundId) === hex(proof.roundId) && hex(t.lateEntryId) === hex(EMPTY)) ownTable = t;
    } catch { ownTable = null; }
  }
  const read = tableAgainstFinals({ claimed, roundId: proof.roundId, contract, attested, payoutShares: rule.payoutShares, entries, finals, committee, verify, feesOf, ownTable });
  if (!read.ok) return no(read.why);
  const { differs, complete } = read;
  if (rebuiltTxid && hex(rebuiltTxid) !== hex(got.ack.settlementTxid))
    differs.push(`the acked ${named ? 'settlement body' : 'transaction'} ${hex(got.ack.settlementTxid).slice(0, 16)} does not rebuild from the table, which makes ${hex(rebuiltTxid).slice(0, 16)}`);
  if (!differs.length) return no(complete ? 'the table is exactly F of the signed FINAL results' : 'the table is not false on anything shown, nor on any entry with a signed FINAL result');

  if (!advert || hex(advert.nodePubkey) !== hex(proof.nodePubkey)) return no('no advertisement from the accused node to name its bond');
  if (hex(advert.bondTxid) !== hex(proof.bondTxid) || advert.bondVout !== proof.bondVout)
    return no(`the proof names bond ${hex(proof.bondTxid)}:${proof.bondVout} and the node advertised ${hex(advert.bondTxid)}:${advert.bondVout}`);
  return {
    slashed: true, offence: TABLE_IS_NOT_F, bond: { txid: proof.bondTxid, vout: proof.bondVout }, differs, complete,
    why: `the node acked a false table: ${differs[0]}`,
  };
}

/**
 * A FALSE TABLE, AS PUBLISHED (§5A.3, kanban #1040): the 199-byte proof body - `signedResultId` the ack's id, `transcriptHash` the table's, `playerPubkey` zero - then the
 * accused's signed ack, whose type byte tells this record from the others, then the length of the rest and the rest: the acks, the table, the Entry Contracts, each stake
 * claim's P, the FINAL records, and the round's own settlement for a table marked late. Everything slashHoldsOnTable reads but the committee, the fee rule and the bond.
 */
const long = (w, b) => { w.u32(b.length); w.bytes(b); };
const longOf = (r) => r.bytes(r.u32());
export const tableSlashEvidenceBytesOf = (bytes, at = 0) => {
  const lenAt = at + SLASH_PROOF_BYTES + SIGNED_SETTLEMENT_ACK_BYTES;
  if (bytes[at + SLASH_PROOF_BYTES] !== TYPE_SETTLEMENT_ACK || bytes.length < lenAt + 4) throw new Error('not a proof of a false table');
  return lenAt + 4 - at + new DataView(bytes.buffer, bytes.byteOffset + lenAt, 4).getUint32(0);
};
export function joinTableSlashEvidence(proofBytes, { signedAck, acks, table, entries = [], preimages = [], finals = [], own = null }) {
  if (proofBytes.length !== SLASH_PROOF_BYTES) throw new Error(`a slash proof is ${SLASH_PROOF_BYTES} bytes, got ${proofBytes.length}`);
  if (signedAck.length !== SIGNED_SETTLEMENT_ACK_BYTES) throw new Error(`a signed ack is ${SIGNED_SETTLEMENT_ACK_BYTES} bytes, got ${signedAck.length}`);
  const w = new Writer();
  w.vec(acks, (a, ww) => ww.bytes(a, SIGNED_SETTLEMENT_ACK_BYTES));
  long(w, table);
  w.vec(entries, (e, ww) => long(ww, encodeEntryContract(e)));
  w.vec(preimages, (p, ww) => { ww.bytes32(p.entryId); ww.bytes32(p.preimage); });
  w.vec(finals, (f, ww) => { long(ww, encodeEntryContract(f.entry)); long(ww, f.signedResult); ww.vec(f.finalSigs, (s, w2) => long(w2, s)); });
  w.u8(own ? 1 : 0);
  if (own) { long(w, own.table); w.vec(own.acks, (a, ww) => ww.bytes(a, SIGNED_SETTLEMENT_ACK_BYTES)); }
  const rest = w.finish();
  const out = new Uint8Array(SLASH_PROOF_BYTES + SIGNED_SETTLEMENT_ACK_BYTES + 4 + rest.length);
  out.set(proofBytes, 0);
  out.set(signedAck, SLASH_PROOF_BYTES);
  new DataView(out.buffer).setUint32(SLASH_PROOF_BYTES + SIGNED_SETTLEMENT_ACK_BYTES, rest.length);
  out.set(rest, SLASH_PROOF_BYTES + SIGNED_SETTLEMENT_ACK_BYTES + 4);
  return out;
}
export function splitTableSlashEvidence(bytes) {
  let n = -1; if (bytes instanceof Uint8Array) { try { n = tableSlashEvidenceBytesOf(bytes); } catch { n = -1; } }
  if (n < 0 || bytes.length !== n) throw new Error('that is not a published proof of a false table');
  const proofBytes = bytes.subarray(0, SLASH_PROOF_BYTES);
  const r = new Reader(bytes.subarray(SLASH_PROOF_BYTES + SIGNED_SETTLEMENT_ACK_BYTES + 4));
  const out = { proof: decodeSlashProof(proofBytes), proofBytes, signedAck: bytes.subarray(SLASH_PROOF_BYTES, SLASH_PROOF_BYTES + SIGNED_SETTLEMENT_ACK_BYTES) };
  out.acks = r.vec((rr) => rr.bytes(SIGNED_SETTLEMENT_ACK_BYTES));
  out.table = longOf(r);
  out.entries = r.vec((rr) => decodeEntryContract(longOf(rr)));
  out.preimages = r.vec((rr) => ({ entryId: rr.bytes32(), preimage: rr.bytes32() }));
  out.finals = r.vec((rr) => ({ entry: decodeEntryContract(longOf(rr)), signedResult: longOf(rr), finalSigs: rr.vec(longOf) }));
  out.own = r.u8() ? { table: longOf(r), acks: r.vec((rr) => rr.bytes(SIGNED_SETTLEMENT_ACK_BYTES)) } : null;
  if (r.at !== bytes.length - SLASH_PROOF_BYTES - SIGNED_SETTLEMENT_ACK_BYTES - 4) throw new Error('trailing bytes after the proof of a false table');
  return out;
}
/** Cut a stream of published proofs of false tables; a record that does not fit ends the stream. */
export function cutTableSlashEvidence(body) {
  const out = [];
  for (let at = 0; at < body.length;) {
    let n; try { n = tableSlashEvidenceBytesOf(body, at); } catch { break; }
    if (at + n > body.length) break;
    out.push(body.subarray(at, at + n)); at += n;
  }
  return out;
}

/**
 * NOT AN OFFENCE (RULED 2026-11-02, kanban #1043: my #1035 row went). Withholding a settlement signature is silence, and silence is not signed bytes: an ack says a
 * seat agreed, not that it then refused. An honest seat that acks and crashes must not lose its bond, and with three seats silent the others never reach a share at
 * all. So this stays refused. What that leaves open, three settlement seats stalling alone, is kanban #1044.
 */
export function slashHoldsOnWithheld() {
  return { slashed: false, why: 'refused: silence is not signed bytes, and an ack does not show which seat did not sign (kanban #1043)' };
}

/**
 * THE TWO IDS OF A DOUBLE-SIGNING, IN ONE ORDER AND ONLY ONE.
 *
 * 5A.3 row 1 is about a PAIR, and a pair that could be written either way
 * round is two proofs of one offence with two different commitments. 5A.3B
 * step 4 puts H(fraud_proof) on chain and rests the whole audit story on it -
 * "anyone can fetch the proof later and re-verify it" - so an offence that
 * could be minted twice is an offence a slasher could commit to twice and an
 * auditor could not tell apart from two separate ones.
 *
 * Sorted by their bytes: the lower id is the one the proof NAMES, the higher
 * rides in the field that means "the object this offence is measured against",
 * which for this row is the other result.
 */
const lower = (a, b) => {
  for (let i = 0; i < a.length && i < b.length; i++)
    if (a[i] !== b[i]) return a[i] < b[i];
  return false;
};
export const orderedResultIds = (idA, idB) =>
  (lower(idA, idB) ? { named: idA, other: idB } : { named: idB, other: idA });

/**
 * DID THIS NODE SIGN TWO DIFFERENT RESULTS FOR ONE PLAYER? 5A.3 row 1.
 *
 * "Signing two different results for the same (round, player). Proof: the two
 * signed results."
 *
 * THE PUREST OF THEM. Row 3 recomputes an `F`; this one compares.
 * Nothing is recomputed, nothing is replayed and nothing is injected, so there
 * is no attesting party at any point - the two objects ARE the offence, which
 * is what 5A.3 means by "a portable artifact anyone can check" and what 13B
 * already means one level down, where two marks at one tick forfeit a player.
 *
 * The same rule with the sides swapped: there a player who says two things
 * about one tick loses the stake, here a node that says two things about one
 * player loses the bond. Neither needs anybody's word.
 *
 * THE SAME RESULT TWICE IS NOT AN OFFENCE, exactly as it is not one in 13B: a
 * node re-sending what it already sent is the ordinary case, and taking a bond
 * for a retransmission would punish a dropped socket.
 *
 * NOR ARE TWO ENTRIES OF ONE PLAYER (kanban #986). Every PLAY is an entry, so one player key holds several in a round (season.js, round.js
 * playersOf; measured on the Daily: 7 entries from 1 key), each with its own honest result, and a result names no entry. What ties a
 * result to its run is the transcript hash, whose bytes name the round and the entry. So the pair must name ONE transcript: two
 * different answers about one run are the offence, and two answers about two transcripts are, from these bytes alone, two runs.
 * A node that doubles under a second transcript hash is not caught here; that is the price of no honest seat ever being slashed.
 *
 * THE SIGNATURES ARE THE PROOF. Two results with no signature of the accused's are two strings anybody can write, so both are checked
 * under the accused's key; `verify` is injected, no curve lives in this package. No verifier, no slash.
 */
export function slashHoldsOnDoubleSign({ proof, signedResults, advert, committee, verify }) {
  if (!Array.isArray(committee) || !committee.length)
    return { slashed: false, why: 'no committee, so nobody was serving this round' };
  if (!committee.some((k) => hex(k) === hex(proof.nodePubkey)))
    return {
      slashed: false,
      why: `${hex(proof.nodePubkey)} is not on this round's committee, so it signed nothing it owed`,
    };

  if (!Array.isArray(signedResults) || signedResults.length !== 2)
    return {
      slashed: false,
      why: 'this offence is a PAIR: two signed results, and no other number of them',
    };
  if (typeof verify !== 'function')
    return { slashed: false, why: 'checking two signatures needs a verifier, and none was injected' };

  const bodies = [], signatures = [];
  for (const [at, bytes] of signedResults.entries()) {
    try {
      const split = splitSignedResult(bytes);
      bodies.push(decodePlayerResult(split.body));
      signatures.push(split.signature);
    } catch (e) { return { slashed: false, why: `result ${at} is not a signed result: ${e.message}` }; }
  }
  const [x, y] = bodies;

  // A REPEAT IS NOT A CONTRADICTION, the same rule 13B keeps for marks.
  const idX = resultId(x);
  const idY = resultId(y);
  if (hex(idX) === hex(idY))
    return { slashed: false, why: 'those are the same result, signed twice' };

  // BOTH HAVE TO BE THE ACCUSED'S, AND ABOUT ONE PLAYER OF ONE ROUND. Two
  // results by different nodes are a committee disagreeing, which is 13C's
  // no-quorum case; two about different players are two honest answers.
  for (const [at, b] of bodies.entries()) {
    if (hex(b.nodePubkey) !== hex(proof.nodePubkey))
      return { slashed: false, why: `result ${at} was signed by a different node` };
    if (hex(b.roundId) !== hex(proof.roundId))
      return { slashed: false, why: `result ${at} is for a different round` };
    if (hex(b.playerPubkey) !== hex(proof.playerPubkey))
      return { slashed: false, why: `result ${at} is for a different player` };
    let theirs = false;
    try { theirs = verify(signatures[at], at === 0 ? idX : idY, proof.nodePubkey) === true; } catch { theirs = false; }
    if (!theirs) return { slashed: false, why: `the signature on result ${at} is not the accused node's` };
  }

  // ONE TRANSCRIPT, ONE RUN: two transcripts are two entries of one player until these bytes say otherwise.
  if (hex(x.transcriptHash) !== hex(y.transcriptHash))
    return {
      slashed: false,
      why: 'those results are about two transcripts, so they may be two entries of one player: '
        + 'a result names no entry, and every PLAY is an entry',
    };

  // AND THE PAIR IS NAMED IN ONE ORDER, so one offence has one commitment.
  const { named, other } = orderedResultIds(idX, idY);
  if (hex(proof.signedResultId) !== hex(named) || hex(proof.transcriptHash) !== hex(other))
    return {
      slashed: false,
      why: 'the pair is named in the wrong order: the lower id is the one the '
        + 'proof names, or one offence could be minted as two proofs',
    };

  if (!advert || hex(advert.nodePubkey) !== hex(proof.nodePubkey))
    return { slashed: false, why: 'no advertisement from the accused node to name its bond' };
  if (hex(advert.bondTxid) !== hex(proof.bondTxid) || advert.bondVout !== proof.bondVout)
    return {
      slashed: false,
      why: `the proof names bond ${hex(proof.bondTxid)}:${proof.bondVout} and the node `
        + `advertised ${hex(advert.bondTxid)}:${advert.bondVout}`,
    };

  return {
    slashed: true,
    offence: TWO_RESULTS,
    bond: { txid: proof.bondTxid, vout: proof.bondVout },
    ids: { named, other },
    why: 'the node signed two different results for one run of one player',
  };
}

/**
 * TWO RESULTS, AS PUBLISHED (5A.3 row 1, kanban #986): the same 199-byte proof body - `signedResultId` the lower result id, `transcriptHash`
 * the higher - and beside it both signed results, the lower id's first, each sized by its own type byte. The pair carries everything
 * `slashHoldsOnDoubleSign` reads but the committee and the bond, so a stranger needs nothing from the seat that filed it.
 */
export const doubleSlashEvidenceBytesOf = (bytes, at = 0) => {
  const first = signedResultBytesOf(bytes, at + SLASH_PROOF_BYTES);
  return SLASH_PROOF_BYTES + first + signedResultBytesOf(bytes, at + SLASH_PROOF_BYTES + first);
};

export function joinDoubleSlashEvidence(proofBytes, signedA, signedB) {
  if (proofBytes.length !== SLASH_PROOF_BYTES) throw new Error(`a slash proof is ${SLASH_PROOF_BYTES} bytes, got ${proofBytes.length}`);
  for (const signed of [signedA, signedB]) if (signed.length !== signedResultBytesOf(signed)) throw new Error('that is not one signed result');
  const out = new Uint8Array(SLASH_PROOF_BYTES + signedA.length + signedB.length);
  out.set(proofBytes, 0);
  out.set(signedA, SLASH_PROOF_BYTES);
  out.set(signedB, SLASH_PROOF_BYTES + signedA.length);
  return out;
}

export function splitDoubleSlashEvidence(bytes) {
  let n = -1; if (bytes instanceof Uint8Array) { try { n = doubleSlashEvidenceBytesOf(bytes); } catch { n = -1; } }
  if (n < 0 || bytes.length !== n) throw new Error('that is not a published proof of two results');
  const proofBytes = bytes.subarray(0, SLASH_PROOF_BYTES);
  const first = signedResultBytesOf(bytes, SLASH_PROOF_BYTES);
  return { proof: decodeSlashProof(proofBytes), proofBytes,
    signedResults: [bytes.subarray(SLASH_PROOF_BYTES, SLASH_PROOF_BYTES + first), bytes.subarray(SLASH_PROOF_BYTES + first)] };
}

/** Cut a stream of published proofs of two results; a record that does not fit ends the stream. */
export function cutDoubleSlashEvidence(body) {
  const out = [];
  for (let at = 0; at < body.length;) {
    let n; try { n = doubleSlashEvidenceBytesOf(body, at); } catch { break; }
    if (at + n > body.length) break;
    out.push(body.subarray(at, at + n)); at += n;
  }
  return out;
}

/**
 * DID THIS NODE SIGN FOR A ROUND ITS OWN OPERATOR PLAYED? 5A.3 row 5.
 *
 * 5A.13: "A selected node may not sign anything for a round in which its
 * operator has an Entry Contract... If a selected node's `operator_id` also
 * signed an Entry Contract in that round, the node is conflicted: its result
 * signatures, payout-table signatures and settlement participation are
 * invalid, and it earns no fee share. Signing anyway is a slashable offence
 * with a one-artifact proof."
 *
 * NOTHING IS INJECTED. Like rows 1, 3 and 4 this only compares and reads what
 * two objects already say, so no attesting party enters at any point.
 *
 * BEING CONFLICTED IS NOT THE OFFENCE. SIGNING IS. An operator is free to
 * play a round their node was selected for - what 5A.13 forbids is that node
 * signing in it, and the remedy for the committee falling below its threshold
 * is ENTRY_VOID, a refund, not somebody's bond. A conflicted node that signed
 * nothing has taken nothing from anybody, and this returns no slash for it.
 */
export function slashHoldsOnConflict({ proof, entry, signedByNode, advert, committee }) {
  // WITHDRAWN (§5A.13, RULED 2026-10-14 ~20:01Z): a player declares no operator, and signing in a round one's
  // operator played is no offence; self-dealing is priced by 5 of 7 bonded slots (§5A.6) and overturnable by replay (§13A)
  void proof; void entry; void signedByNode; void advert; void committee;
  return { slashed: false, why: 'withdrawn: a player declares no operator, so signing in a round the operator played is no offence (§5A.13, ruled 2026-10-14)' };
}

/**
 * WHAT A RELEASE PAYS: THE PAYOUT TABLE (§5A.3B, RULED 2026-11-02, kanban #1021). Entries plus every output, these bytes in this order:
 *
 *   version 1 | network_id | round_id | proof_id | bond_txid | bond_vout
 *   entries   ascending entry_id: entry_id, player_pubkey, loss_msat
 *   reserves  ascending federation_id: federation_id, msat
 *   margin    carrier_margin_msat u64, margin_off u8 (0 reserves, 1 players): RULED 2026-11-03, kanban #1086
 *   outputs   the release's outputs after its OP_RETURN, in order: value_sats, u16 length, script, pays
 *
 * The OP_RETURN is left out because it carries this table's hash. A fallback carries a table of this format, with holders as its carriers. reserves[] lists
 * what the release pays in; the part kept in escrow is the `pays = escrow` output, and the escrow's value past the players is placed by load when spent.
 */
export const SLASH_TABLE_VERSION = 1;
export const SLASH_TABLE_PAYS = Object.freeze(['filer', 'player_carrier', 'reserves', 'escrow']);
/**
 * WHERE A CARRIER'S PAYOUT MARGIN COMES FROM (RULED 2026-11-03, kanban #1086), named by a table and by an escrow spend's outputs[]: `reserves`, each player_carrier output holds
 * its loss plus carrier_margin_msat, taken from the reserves' share of that spend; `players`, there is no reserves' share to take it from, the outputs hold the loss alone and
 * the carrier keeps the margin back pro rata to each player's loss.
 */
export const SLASH_MARGIN_OFF = Object.freeze(['reserves', 'players']);
const writeMargin = (w, t) => {
  const off = SLASH_MARGIN_OFF.indexOf(t.marginOff ?? 'reserves');
  if (off < 0) throw new Error(`a margin comes off ${SLASH_MARGIN_OFF.join(' or ')}`);
  w.u64(t.marginMsat ?? 0n); w.u8(off);
};
const readMargin = (r) => { const marginMsat = r.u64(); const marginOff = SLASH_MARGIN_OFF[r.u8()]; if (!marginOff) throw new Error('unknown margin_off byte in a slash table'); return { marginMsat, marginOff }; };
/** What a player_carrier output holds past its loss, msat, by `marginOff`: the table's margin, or nothing when the players bear it. */
export const outputMarginMsat = (t) => ((t.marginOff ?? 'reserves') === 'players' ? 0n : (t.marginMsat ?? 0n));
const ascendingBy = (field) => (a, b) => { const x = hex(a[field]), y = hex(b[field]); return x < y ? -1 : x > y ? 1 : 0; };

function writeTableOutputs(w, outputs) {
  let rank = 0;
  w.vec(outputs, (o, ww) => {
    const pays = SLASH_TABLE_PAYS.indexOf(o.pays);
    if (pays < rank) throw new Error(`a table pays in order: ${SLASH_TABLE_PAYS.join(', ')}`);
    rank = pays;
    ww.u64(o.value); ww.u16(o.script.length); ww.bytes(o.script, o.script.length); ww.u8(pays);
  });
}
const readTableOutputs = (r) => r.vec((rr) => { const value = rr.u64(); const script = rr.bytes(rr.u16()); const pays = SLASH_TABLE_PAYS[rr.u8()]; if (!pays) throw new Error('unknown pays byte in a slash payout table'); return { value, script, pays }; });

export function encodeSlashPayoutTable(t) {
  const w = new Writer();
  w.u8(SLASH_TABLE_VERSION);
  w.bytes32(t.networkId);
  w.bytes32(t.roundId);
  w.bytes32(t.proofId);
  w.bytes32(t.bondTxid);
  w.u32(t.bondVout);
  w.vec(t.entries, (e, ww) => { ww.bytes32(e.entryId); ww.bytes32(e.playerPubkey); ww.u64(e.lossMsat); }, { sortedBy: ascendingBy('entryId') });
  w.vec(t.reserves, (f, ww) => { ww.bytes32(f.federationId); ww.u64(f.msat); }, { sortedBy: ascendingBy('federationId') });
  writeMargin(w, t);
  writeTableOutputs(w, t.outputs);
  return w.finish();
}

export function decodeSlashPayoutTable(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== SLASH_TABLE_VERSION) throw new Error('not a slash payout table of version 1');
  const t = {
    networkId: r.bytes32(), roundId: r.bytes32(), proofId: r.bytes32(), bondTxid: r.bytes32(), bondVout: r.u32(),
    entries: r.vec((rr) => ({ entryId: rr.bytes32(), playerPubkey: rr.bytes32(), lossMsat: rr.u64() })),
    reserves: r.vec((rr) => ({ federationId: rr.bytes32(), msat: rr.u64() })),
    ...readMargin(r),
    outputs: readTableOutputs(r),
  };
  r.end();
  return t;
}

/** payout_table_id, the third field of a release's OP_RETURN. */
export const slashPayoutTableId = (t) => taggedHash(TAG.slashPayoutTable, encodeSlashPayoutTable(t));

/**
 * AN ESCROW SPEND'S OWN outputs[] (5A.3B, kanban #1034 answer 2), in the table's format, after the table's id and the height whose federation records it
 * placed the reserves by (`load_height`, RULED 2026-11-03 #1085: "a height the spend names in its outputs[]"). Its id goes in the spend's OP_RETURN, beside
 * payout_table_id. `escrow` is what goes back to the escrow, and comes last.
 *
 *   version 1 | payout_table_id | load_height u32 | carrier_margin_msat u64 | margin_off u8 | outputs
 *
 * The margin is the table's, repeated; margin_off says whether this spend's player_carrier outputs hold it (`reserves`) or the players bear it pro rata (`players`, kanban #1086).
 */
export function encodeSlashEscrowOutputs({ tableId, loadHeight = 0, marginMsat = 0n, marginOff = 'reserves', outputs }) {
  const w = new Writer();
  w.u8(SLASH_TABLE_VERSION);
  w.bytes32(tableId);
  w.u32(loadHeight);
  writeMargin(w, { marginMsat, marginOff });
  writeTableOutputs(w, outputs);
  return w.finish();
}

export function decodeSlashEscrowOutputs(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== SLASH_TABLE_VERSION) throw new Error('not an escrow spend\'s outputs of version 1');
  const t = { tableId: r.bytes32(), loadHeight: r.u32(), ...readMargin(r), outputs: readTableOutputs(r) };
  r.end();
  return t;
}

export const slashEscrowOutputsId = (t) => taggedHash(TAG.slashEscrowOutputs, encodeSlashEscrowOutputs(t));

/**
 * AN ESCROW SPEND OF A TABLE: OP_RETURN payout_table_id || its outputs' id, then those outputs. What it does not pay goes back to the same escrow script. `payees`
 * are { value, script, pays } with pays player_carrier or reserves, in that order; `loadHeight` the height its reserves were placed at; `sequence` the leaf's
 * wait (none for the panels' leaf, slash_fallback_blocks for the census key's); `marginMsat`, `marginOff` the margin its outputs[] name. Answers { ok, tx, prevouts, fee, outputs }.
 */
export function escrowTableSpend({ escrow, tableId, loadHeight = 0, marginMsat = 0n, marginOff = 'reserves', payees, feeSats, sequence = 0xfffffffd }) {
  const paid = payees.reduce((a, p) => a + p.value, 0n);
  const back = escrow.value - paid - feeSats;
  if (back < 0n) return { ok: false, why: `${paid} sat and a ${feeSats} sat fee out of an escrow of ${escrow.value}` };
  if (back > 0n && back < P2TR_DUST_SATS) return { ok: false, why: `${back} sat left in escrow is below dust` };
  const paying = [...payees.map((p) => ({ value: p.value, script: p.script, pays: p.pays })), ...(back ? [{ value: back, script: escrow.script, pays: 'escrow' }] : [])];
  const outputs = { tableId, loadHeight, marginMsat, marginOff, outputs: paying };
  const opening = { value: 0n, script: Uint8Array.from([0x6a, 64, ...tableId, ...slashEscrowOutputsId(outputs)]) };
  return { ok: true, tx: { version: 2, locktime: 0, inputs: [{ txid: escrow.txid, vout: escrow.vout, sequence }], outputs: [opening, ...paying.map((o) => ({ value: o.value, script: o.script }))] },
    prevouts: [{ value: escrow.value, script: escrow.script }], fee: { sats: feeSats }, outputs };
}

/**
 * THE TABLE, RECOMPUTED: every panel member runs this, and signs only if its bytes are byte-equal. Outputs + fee = the bond, exactly.
 *
 *   entries      [{ entryId, playerPubkey, lossMsat }]: what this bond pays each (slashDistribution)
 *   filer        { script, sats }: repays the start's fee input
 *   carriers     panel A's members in score order, [{ script, bondSats }]: each peg-in no larger than that member's bond
 *   federations  as reserveParts takes them, each with its peg-in `script`
 *   escrowScript under the two panels, or the census key if there are none
 *
 * Players' parts round up and the reserves take the rest, and the fee comes off the reserves, never the players.
 * Each player_carrier output holds its part plus `marginMsat`, the carrier's payout margin the network names (RULED 2026-11-03, kanban #1086), taken from the
 * reserves' share (what is left past the players: reserves and escrow alike); none above its carrier's bond with it. When that share cannot take every output's
 * margin, the outputs hold the parts alone and the table names `marginOff: players`: the carrier keeps the margin back pro rata to each loss. A carrier's part under
 * dust is raised to dust out of the reserves, and merged into the carrier before it if they cannot cover that: players are never short.
 * What fits no carrier and no federation is the escrow; under dust it joins the largest reserve part. A fallback passes `fallbackCarriers`.
 * Players owed and no carrier to take it (kanban #1034 answer 6): all of it goes to the escrow, with no player_carrier output and no reserves. This is
 * not a refusal: the entries stay pending, and the money leaves by an escrow spend when a carrier publishes a signed peg-in.
 */
export function buildSlashPayoutTable({ networkId, roundId, proofId, bond, entries = [], filer = null, carriers = [], federations = [], retired = [], feeSats, escrowScript = null, marginMsat = 0n }) {
  const no = (why) => ({ ok: false, why });
  if (typeof feeSats !== 'bigint' || feeSats < 0n) return no('the fee is BigInt satoshi');
  if (typeof marginMsat !== 'bigint' || marginMsat < 0n) return no('the carrier margin is BigInt msat');
  const outputs = [];
  if (filer && filer.sats > 0n) outputs.push({ value: filer.sats, script: filer.script, pays: 'filer' });
  const owedMsat = entries.reduce((a, e) => a + e.lossMsat, 0n);
  const owedSats = (owedMsat + 999n) / 1000n;
  const head = { networkId, roundId, proofId, bondTxid: bond.txid, bondVout: bond.vout, entries: [...entries].sort(ascendingBy('entryId')) };
  if (owedSats > 0n && !carriers.some((c) => c.bondSats >= P2TR_DUST_SATS)) {
    const held = bond.value - feeSats - (filer ? filer.sats : 0n);
    if (held < owedSats) return no(`a bond of ${bond.value} sat cannot carry ${owedSats} sat and a ${feeSats} sat fee: the losses are this bond's share of them`);
    if (!(escrowScript instanceof Uint8Array)) return no(`${held} sat wait for a carrier and no escrow script was given`);
    if (held < P2TR_DUST_SATS) return no(`${held} sat is left for an escrow, below dust`);
    outputs.push({ value: held, script: escrowScript, pays: 'escrow' });
    return { ok: true, table: { ...head, reserves: [], marginMsat, marginOff: 'reserves', outputs } };
  }
  // THE PLAYERS' OUTPUTS, each its part plus `margin` sat; what is left for the reserves' share (negative: the margin cannot come off it)
  const place = (margin) => {
    const carried = [];
    let owed = owedSats;
    for (const c of carriers) {
      if (owed <= 0n) break;
      if (c.bondSats < P2TR_DUST_SATS || c.bondSats <= margin) continue;
      const cap = c.bondSats - margin;
      const part = owed > cap ? cap : owed;
      const sats = part + margin;
      carried.push({ value: sats < P2TR_DUST_SATS ? P2TR_DUST_SATS : sats, script: c.script, pays: 'player_carrier', exact: part });
      owed -= part;
    }
    const room = () => bond.value - feeSats - (filer ? filer.sats : 0n) - carried.reduce((a, o) => a + o.value, 0n) - owed;
    if (room() < 0n && carried.length > 1 && carried[carried.length - 1].exact + margin < P2TR_DUST_SATS) {
      const last = carried.pop();
      carried[carried.length - 1].value += last.exact;
    }
    return { carried, owed, rest: room() };
  };
  const marginSats = (marginMsat + 999n) / 1000n;
  let placed = place(marginSats), marginOff = 'reserves';
  if (placed.rest < 0n && marginSats > 0n) { placed = place(0n); marginOff = 'players'; }
  const { carried, owed, rest } = placed;
  for (const c of carried) { delete c.exact; outputs.push(c); }
  const spent = outputs.reduce((a, o) => a + o.value, 0n);
  if (rest < 0n) return no(`a bond of ${bond.value} sat cannot carry ${spent + owed} sat and a ${feeSats} sat fee: the losses are this bond's share of them`);
  const { parts, keptSats } = reserveParts({ amountSats: rest, federations, retired, minPartSats: P2TR_DUST_SATS });
  const scriptOf = new Map(federations.map((f) => [String(f.federation).toLowerCase(), f.script]));
  let escrow = keptSats + owed;
  const largest = parts.reduce((a, p) => (!a || p.sats > a.sats ? p : a), null);
  if (escrow > 0n && escrow < P2TR_DUST_SATS && largest) { largest.sats += escrow; escrow = 0n; }
  const reserves = parts.map((p) => ({ federationId: fromHex(p.federation), msat: p.sats * 1000n })).sort(ascendingBy('federationId'));
  for (const p of parts) outputs.push({ value: p.sats, script: scriptOf.get(p.federation), pays: 'reserves' });
  if (escrow > 0n) {
    if (!(escrowScript instanceof Uint8Array)) return no(`${escrow} sat fit nothing and no escrow script was given`);
    if (escrow < P2TR_DUST_SATS) return no(`${escrow} sat is left for an escrow, below dust, and no reserve part can take it`);
    outputs.push({ value: escrow, script: escrowScript, pays: 'escrow' });
  }
  return { ok: true, table: { ...head, reserves, marginMsat, marginOff, outputs } };
}

/**
 * DID THE ACCUSED SIGN THIS SPEND? The evidence shared by both template-3 rows. The spend is the accused's only if its own signature
 * verifies over BIP-341's sighash of this very transaction: a key sitting in a leaf proves nothing, and an empty slot is a member
 * who refused. `prevouts` are the outputs every input spends. A signature of 65 bytes carries its hash type, so choosing
 * an explicit 0x01 over the default does not hide a signer. `verify(signature, digest, key)` is injected.
 */
function signedSpend({ proof, spend, prevouts, verify }) {
  if (typeof verify !== 'function') return { ok: false, why: 'checking a witness needs a verifier, and none was injected' };
  let tx;
  try { tx = parseTransaction(spend); } catch (e) { return { ok: false, why: `the evidence is not a transaction: ${e.message}` }; }
  if (hex(tx.txid) !== hex(proof.signedResultId)) return { ok: false, why: 'the transaction attached is not the one this proof names' };
  if (!Array.isArray(prevouts) || prevouts.length !== tx.inputs.length) return { ok: false, why: 'every input needs the output it spends' };
  const inputs = tx.inputs.map((i) => ({ txid: i.previousTxid, vout: i.previousVout, sequence: i.sequence }));
  for (let inputIndex = 0; inputIndex < tx.inputs.length; inputIndex++) {
    const read = scriptPathSigners(tx.witnesses[inputIndex]);
    if (!read.ok) continue;
    const mine = read.signers.find((x) => hex(x.key) === hex(proof.nodePubkey));
    if (!mine || !mine.signature.length) continue;
    const { signature } = mine;
    if (signature.length !== 64 && signature.length !== 65) continue;
    const hashType = signature.length === 65 ? signature[64] : 0x00;
    let good = false;
    try {
      const digest = tapSighash({ version: tx.version, locktime: tx.locktime, inputs, outputs: tx.outputs, prevouts, inputIndex,
        leafHash: tapLeafHash(read.script), hashType });
      good = verify(signature.subarray(0, 64), digest, proof.nodePubkey) === true;
    } catch { good = false; }
    if (good) return { ok: true, tx, inputIndex, script: read.script };
  }
  return { ok: false, why: `the witness of that transaction carries no good signature by ${hex(proof.nodePubkey)}` };
}

const ownBond = (proof, advert) => {
  if (!advert || hex(advert.nodePubkey) !== hex(proof.nodePubkey)) return 'no advertisement from the accused node to name its bond';
  if (hex(advert.bondTxid) !== hex(proof.bondTxid) || advert.bondVout !== proof.bondVout)
    return `the proof names bond ${hex(proof.bondTxid)}:${proof.bondVout} and the node advertised ${hex(advert.bondTxid)}:${advert.bondVout}`;
  return null;
};

/**
 * A PROOF AGAINST A RELEASE, AS IT IS PUBLISHED (5A.3 rows "a release with no valid proof" and "a release ... other than its payout_table"): the proof body, the raw release, the outputs it spent, and the
 * bytes that hash to its OP_RETURN (`fraudProof`) or the table it committed to (`table`), whichever row this is. Anyone can file one: the release is on the chain.
 */
export function joinReleaseSlashEvidence(proofBytes, { release, prevouts, fraudProof = NO_PART, table = NO_PART }) {
  if (proofBytes.length !== SLASH_PROOF_BYTES) throw new Error(`a slash proof is ${SLASH_PROOF_BYTES} bytes, got ${proofBytes.length}`);
  const w = new Writer();
  w.bytes(proofBytes, SLASH_PROOF_BYTES);
  w.u8(TYPE_RELEASE_EVIDENCE);
  w.u32(release.length); w.bytes(release, release.length);
  w.u32(prevouts.length);
  for (const p of prevouts) { w.u64(p.value); w.u32(p.script.length); w.bytes(p.script, p.script.length); }
  for (const part of [fraudProof, table]) { w.u32(part.length); w.bytes(part, part.length); }
  return w.finish();
}

export function splitReleaseSlashEvidence(bytes) {
  const proof = decodeSlashProof(bytes.subarray(0, SLASH_PROOF_BYTES));
  const r = new Reader(bytes.subarray(SLASH_PROOF_BYTES));
  if (r.u8() !== TYPE_RELEASE_EVIDENCE) throw new Error('not a proof against a release');
  const release = r.bytes(r.u32()), prevouts = [];
  for (let n = r.u32(); n > 0; n--) { const value = r.u64(); prevouts.push({ value, script: r.bytes(r.u32()) }); }
  const fraudProof = r.bytes(r.u32()), table = r.bytes(r.u32());
  r.end();
  return { proof, release, prevouts, fraudProof, table };
}

/**
 * DID THIS PANEL MEMBER SIGN A RELEASE WITH NO VALID PROOF? (§5A.3B: "Signing a release with no valid proof slashes the signer: the release's
 * witness names them.") `panels` are the round's, { panelA, panelB } of keys, redrawn by the caller and never read off the accuser;
 * `holdBlocks` the network's. The proof body is the ordinary one: `signedResultId` the release's txid, `transcriptHash` the id its
 * OP_RETURN commits to, player empty. `fraudProof` the bytes that hash to that id, `proofChecks` the verdict of whoever replayed them,
 * handed in as `replayDiffers` is: anything but an explicit false leaves the bond alone.
 *
 * A release that commits to no proof at all has no valid proof by its own bytes: it needs no verdict, and the proof's id is empty.
 * A commitment whose bytes nobody can produce slashes nobody: an accusation with nothing to check is not a portable artifact.
 */
export function slashHoldsOnRelease({ proof, release, prevouts, panels, holdBlocks, fraudProof, proofChecks, advert, verify }) {
  const no = (why) => ({ slashed: false, why });
  if (!proof) return no('no proof');
  if (!panels || !Array.isArray(panels.panelA) || !Array.isArray(panels.panelB)) return no('no panels, so nobody was responsible for this round');
  if (![...panels.panelA, ...panels.panelB].some((k) => hex(k) === hex(proof.nodePubkey)))
    return no(`${hex(proof.nodePubkey)} is on neither panel of this round, so it owed this round no release`);
  if (hex(proof.playerPubkey) !== hex(EMPTY)) return no('this row names no player: a release is about a bond');
  const signed = signedSpend({ proof, spend: release, prevouts, verify });
  if (!signed.ok) return no(signed.why);
  let wanted;
  try { wanted = releaseLeaf({ ...panels, holdBlocks }); } catch (e) { return no(`those panels write no release leaf: ${e.message}`); }
  if (hex(signed.script) !== hex(wanted)) return no('what the accused signed is not this round\'s release leaf');

  const said = arbitrationCommitmentIn(signed.tx.outputs);
  if (said) {
    if (hex(proof.transcriptHash) !== hex(said.proofId)) return no('the proof is measured against another commitment than the release\'s');
    if (!(fraudProof instanceof Uint8Array) || !fraudProof.length) return no('no bytes attached to show what the release committed to');
    if (hex(fraudProofHash(fraudProof)) !== hex(said.proofId)) return no('the bytes attached do not hash to the release\'s OP_RETURN');
    if (proofChecks !== false) return no('nobody has replayed those bytes and found they do not check');
  } else if (hex(proof.transcriptHash) !== hex(EMPTY)) return no('that release commits to nothing, and the proof names a commitment');

  const elsewhere = ownBond(proof, advert);
  if (elsewhere) return no(elsewhere);
  return {
    slashed: true,
    offence: RELEASE_WITHOUT_PROOF,
    bond: { txid: proof.bondTxid, vout: proof.bondVout },
    why: said ? 'the panel member signed a release whose committed proof does not check' : 'the panel member signed a release that commits to no proof',
  };
}

/**
 * AN ESCROW SPEND ANSWERS TO THE RELEASE'S TABLE (5A.3B, kanban #1031, #1034 answer 2). It has its own outputs[], and opens with an OP_RETURN of payout_table_id and
 * that list's id. All money goes through a carrier, the reserves' part too: a payable script is one a carrier's node key signed as its peg-in address for this
 * table. Amounts are checked by `pays` against what the table left unpaid: player_carrier up to the players' part the release did not carry plus the carrier
 * margin of each player_carrier output whose spend names `marginOff: reserves` (RULED 2026-11-03, kanban #1086), and no more; reserves up to the rest of the escrow
 * past the players' part and those margins, counted with every earlier spend. Every spend names the table's own carrier_margin_msat. Sats round up once over the players'
 * part; a player_carrier output raised to dust may hold up to dust past its share.
 *
 *   outputs    this spend's encodeSlashEscrowOutputs bytes
 *   release    the raw release, which carries the table
 *   earlier    [{ spend, outputs }], the spends before this one
 *   pegInOf    script -> { key, signature, outpoint, federationId } or null, the CarrierPegIn carriers have published for it (outpoint: the escrow it was for)
 *   isCarrier  key hex -> true for a carrier of this slash: panel A's members, or on a fallback the census key's holders
 */
export function slashHoldsOnEscrowSpend({ proof, spend, outputs, release, earlier = [], prevouts, table, pegInOf, isCarrier, advert, verify }) {
  const no = (why) => ({ slashed: false, why });
  if (!proof) return no('no proof');
  if (hex(proof.playerPubkey) !== hex(EMPTY)) return no('this row names no player: the table does');
  if (typeof pegInOf !== 'function' || typeof isCarrier !== 'function') return no('no way to read which peg-ins are payable');
  const signed = signedSpend({ proof, spend, prevouts, verify });
  if (!signed.ok) return no(signed.why);
  let carrier, t, spent;
  try { carrier = parseTransaction(release); } catch (e) { return no(`the release attached is not a transaction: ${e.message}`); }
  try { t = decodeSlashPayoutTable(table); } catch (e) { return no(`the evidence is not a slash payout table: ${e.message}`); }
  const id = slashPayoutTableId(t);
  const said = arbitrationCommitmentIn([carrier.outputs[0] || {}]);
  if (!said || hex(said.hint) !== hex(id)) return no('the table attached is not the one the release committed to');
  if (hex(proof.transcriptHash) !== hex(id)) return no('the proof is measured against another table');
  const escrow = t.outputs.find((o) => o.pays === 'escrow');
  if (!escrow) return no('that table leaves nothing in escrow');
  let chain;
  try {
    chain = [...earlier.map((e) => ({ tx: parseTransaction(e.spend), outputs: decodeSlashEscrowOutputs(e.outputs) }))];
    spent = decodeSlashEscrowOutputs(outputs);
  } catch (e) { return no(`the evidence does not read: ${e.message}`); }
  const known = (i) => [carrier, ...chain.map((c) => c.tx)].some((c) => hex(i.previousTxid) === hex(c.txid));
  if (!signed.tx.inputs.some(known)) return no('that spend does not spend the release\'s escrow');

  const opening = signed.tx.outputs[0] && signed.tx.outputs[0].script[0] === 0x6a ? signed.tx.outputs[0].script.subarray(2) : null;
  const names = !!opening && opening.length === 64 && hex(opening.subarray(0, 32)) === hex(id);
  if (names && hex(opening.subarray(32)) !== hex(slashEscrowOutputsId(spent))) return no('the outputs attached are not the ones that spend committed to');
  const paid = signed.tx.outputs.slice(1);
  const same = paid.length === spent.outputs.length && paid.every((o, i) => o.value === spent.outputs[i].value && hex(o.script) === hex(spent.outputs[i].script));
  const payable = (o) => {
    if (o.pays === 'escrow') return hex(o.script) === hex(escrow.script);
    if (o.pays !== 'player_carrier' && o.pays !== 'reserves') return false;
    const peg = pegInOf(o.script);
    if (!peg || !isCarrier(hex(peg.key))) return false;
    if (!peg.outpoint || !signed.tx.inputs.some((i) => hex(i.previousTxid) === hex(peg.outpoint.txid) && i.previousVout === peg.outpoint.vout)) return false;
    try { return verify(peg.signature, carrierEscrowPegInId({ tableId: id, outpoint: peg.outpoint, federationId: peg.federationId, script: o.script }), peg.key) === true; } catch { return false; }
  };
  const stray = spent.outputs.find((o) => !payable(o));
  // WHAT THE TABLE LEFT THE PLAYERS: their losses less what its player_carrier outputs carried (each its value less the margin it holds, carrierSlices)
  const owedMsat = t.entries.reduce((a, e) => a + e.lossMsat, 0n);
  const tableMargin = outputMarginMsat(t);
  const roomMsat = t.outputs.filter((o) => o.pays === 'player_carrier').reduce((a, o) => a + (o.value * 1000n > tableMargin ? o.value * 1000n - tableMargin : 0n), 0n);
  const unpaidMsat = owedMsat > roomMsat ? owedMsat - roomMsat : 0n;
  const spends = [...chain.map((c) => c.outputs), spent];
  const wrongMargin = spends.some((sp) => sp.marginMsat !== (t.marginMsat ?? 0n));
  // EACH player_carrier OUTPUT OF A SPEND THAT NAMES `reserves` HOLDS ONE MARGIN PAST ITS SHARE; one raised to dust holds up to dust past it
  const theirs = spends.flatMap((sp) => sp.outputs.filter((o) => o.pays === 'player_carrier').map((o) => ({ o, margin: (outputMarginMsat(sp) + 999n) / 1000n })));
  const marginSats = theirs.reduce((a, x) => a + x.margin, 0n);
  const dustSlack = BigInt(theirs.filter((x) => x.o.value === P2TR_DUST_SATS).length) * (P2TR_DUST_SATS - 1n);
  const unpaidSats = (unpaidMsat + 999n) / 1000n;
  const playersLeft = unpaidSats + marginSats + dustSlack;
  const reservesLeft = escrow.value > unpaidSats + marginSats ? escrow.value - unpaidSats - marginSats : 0n;
  const all = spends.flatMap((sp) => sp.outputs);
  const paidAs = (pays) => all.filter((o) => o.pays === pays).reduce((a, o) => a + o.value, 0n);
  const players = paidAs('player_carrier'), reserves = paidAs('reserves');
  const over = players > playersLeft || reserves > reservesLeft;
  if (names && same && !stray && !over && !wrongMargin) return no('that spend answers to its table');

  const elsewhere = ownBond(proof, advert);
  if (elsewhere) return no(elsewhere);
  return {
    slashed: true,
    offence: RELEASE_OFF_TABLE,
    bond: { txid: proof.bondTxid, vout: proof.bondVout },
    why: !names ? 'the node signed an escrow spend that does not carry payout_table_id' : !same ? 'the node signed an escrow spend that pays other than its own outputs' : stray ? 'the node signed an escrow spend into a script no carrier signed for this table'
      : wrongMargin ? `the node signed an escrow spend that names a carrier margin other than its table's ${t.marginMsat ?? 0n} msat` : `the node signed escrow spends of ${players} sat to players and ${reserves} sat to reserves where the table left ${playersLeft} and ${reservesLeft}`,
  };
}

/**
 * DID THIS NODE SIGN A RELEASE THAT PAYS OTHER THAN ITS TABLE? Nothing is injected but the verifier: the release's OP_RETURN comes first
 * and commits to the table, and every output after it is compared with the table's, in order, value and script.
 * `signedResultId` is the release's txid, `transcriptHash` the table's id.
 *
 * A spend signed by the census key is one FROST signature that names no one. An escrow spend answers in slashHoldsOnEscrowSpend.
 */
export function slashHoldsOnReleaseTable({ proof, spend, prevouts, table, advert, verify }) {
  const no = (why) => ({ slashed: false, why });
  if (!proof) return no('no proof');
  if (hex(proof.playerPubkey) !== hex(EMPTY)) return no('this row names no player: the table does');
  const signed = signedSpend({ proof, spend, prevouts, verify });
  if (!signed.ok) return no(signed.why);
  const [first, ...paid] = signed.tx.outputs;
  const said = first ? arbitrationCommitmentIn([first]) : null;
  if (!said || said.hint.length !== 32) return no('that release does not open with the OP_RETURN of its table');
  let t;
  try { t = decodeSlashPayoutTable(table); } catch (e) { return no(`the evidence is not a slash payout table: ${e.message}`); }
  const id = slashPayoutTableId(t);
  if (hex(id) !== hex(said.hint)) return no('the table attached is not the one the release committed to');
  if (hex(proof.transcriptHash) !== hex(id)) return no('the proof is measured against another table');
  if (hex(t.roundId) !== hex(proof.roundId)) return no('the table attached is for a different round');
  if (hex(t.proofId) !== hex(said.proofId)) return no('the table attached is for a different fraud proof than the release');

  const same = paid.length === t.outputs.length && paid.every((o, i) => o.value === t.outputs[i].value && hex(o.script) === hex(t.outputs[i].script));
  if (same) return no('the release pays exactly its table');

  const elsewhere = ownBond(proof, advert);
  if (elsewhere) return no(elsewhere);
  return {
    slashed: true,
    offence: RELEASE_OFF_TABLE,
    bond: { txid: proof.bondTxid, vout: proof.bondVout },
    why: `the node signed a release of ${paid.length} outputs that is not the ${t.outputs.length} of its table, in order`,
  };
}

/**
 * §5A.3 (RULED 2026-09-22): the slashing height is one the ARBITRATION SET NAMES, not one the chain hands
 * back. Valid iff `censusHeight <= slashHeight <= tipHeight` at the moment they sign. It goes into the
 * slashing transaction's OP_RETURN and its nLockTime, so the transaction cannot confirm earlier than the
 * height it names. It records when the proof was ruled on, and no payment depends on it. The height at which a bond happens to be SPENT
 * is not it: that height exists for spends that are not slashes at all.
 */
export function slashHeightIsValid({ slashHeight, censusHeight, tipHeight } = {}) {
  if (!Number.isInteger(slashHeight) || slashHeight < 0)
    return { ok: false, why: 'a slashing height is a block height' };
  if (!Number.isInteger(censusHeight) || !Number.isInteger(tipHeight))
    return { ok: false, why: 'the round census height and the chain tip are block heights' };
  if (slashHeight < censusHeight)
    return { ok: false, why: `that slashing height ${slashHeight} is below the round's census height `
      + `${censusHeight}: the census it names would predate the round` };
  if (slashHeight > tipHeight)
    return { ok: false, why: `that slashing height ${slashHeight} is above the tip ${tipHeight} the `
      + 'arbitration set signs at: a height nobody can read yet' };
  return { ok: true, slashHeight };
}

/**
 * WHAT F PAYS EACH ENTRY, in msat, by key: a table row, or the net stake where the money never left the player or comes back to them (a VOID
 * entry's refund, a delivered player under the round's floor, computePayoutTable's `settling`).
 */
// `protocolVersion`: the round's (kanban #1614: from 29 score ties go by H(round_id || pubkey))
function receivedBy({ roundId, rows, minScore, payoutShares, protocolVersion = null }) {
  const computed = computePayoutTable({ roundId, entries: rows, minScore, payoutShares, protocolVersion });
  const out = new Map(computed.table.map((r) => [hex(r.pubkey), r.amountMsat]));
  const settling = new Set(computed.settling);
  for (const e of rows) if (isRefund(e.outcome) || (computed.activated.includes(e) && !settling.has(e))) out.set(hex(e.pubkey), netStakeMsat(e));
  return out;
}

/**
 * THE REAL LOSS (§5A.3, RULED 2026-11-02, kanban #976): "what the player should have received less what they did receive, floored at zero:
 * F(contract, membership, true results) against the settlement that happened. It is an amount, never a share of the bond."
 *
 * `entries` are the round's as they SETTLED, each { pubkey, stakeMsat, feeMsat, donationMsat, outcome, score }; `truth` the results the
 * settlement got wrong, [{ pubkey, outcome, score }]; `affected` the entries the offence names (`affectedEntries`), read by `playerPubkey`.
 * An empty `truth` is the case with no loss: an objection in time (the result was corrected before any money moved) and a doubled result
 * with no replay. Answers a Map of player key hex -> msat, holding only losses above zero.
 */
export function realLosses({ roundId, entries = [], truth = [], affected = [], minScore = 0, payoutShares = null, protocolVersion = null } = {}) {
  const losses = new Map();
  if (!truth.length || !affected.length) return losses;
  const correct = new Map(truth.map((t) => [hex(t.pubkey), t]));
  // AN ENTRY WITH NO RESULT YET IS NOT IN F, as a table leaves it out until it is decided
  const settled = entries.filter((e) => e.outcome);
  const did = receivedBy({ roundId, rows: settled, minScore, payoutShares, protocolVersion });
  const should = receivedBy({ roundId, minScore, payoutShares, protocolVersion,
    rows: settled.map((e) => { const t = correct.get(hex(e.pubkey)); return t ? { ...e, outcome: t.outcome, score: t.score } : e; }) });
  for (const e of affected) {
    const k = hex(e.playerPubkey);
    const loss = (should.get(k) || 0n) - (did.get(k) || 0n);
    if (loss > 0n) losses.set(k, loss);
  }
  return losses;
}

/**
 * WHERE ONE SLASHED BOND GOES (§5A.3, slashing rule v2): each player its real loss, once, and the rest to the protocol reserves. Nothing to
 * the nodes, nothing to the developers, nothing back to the slashed node, nothing burned.
 *
 * `escrowSats` is the bond less path B's fee: all this slash has. `losses` is `realLosses`' Map; `paid` (key hex -> msat) what earlier proofs
 * of this round already paid - "the proofs of a round are taken in ascending proof id; the first pays each loss, and each later one pays only
 * what is still owed". A bond that cannot cover what it owes "pays pro rata by loss and the next proof pays the rest": shares floored, the
 * leftover one msat at a time in ascending H(round_id || pubkey), the order §22A names for fees. Pure: it moves nothing.
 *
 * Answers { players: Map key hex -> msat, playersMsat, reservesMsat, shortMsat, burned: 0n }; playersMsat + reservesMsat is the escrow, to the msat.
 */
export function slashDistribution({ escrowSats, roundId, contract, losses = new Map(), paid = new Map() }) {
  if (typeof escrowSats !== 'bigint' || escrowSats < 0n) throw new Error('an escrow is BigInt satoshi');
  if (!contract || !SLASH_REMAINDERS.includes(contract.slashRemainder)) throw new Error('that round contract names no slashing rule this build runs');
  const haveMsat = escrowSats * 1000n;
  const owed = new Map();
  for (const [k, loss] of losses) { const left = loss - (paid.get(k) || 0n); if (left > 0n) owed.set(k, left); }
  const owedMsat = [...owed.values()].reduce((a, b) => a + b, 0n);
  const players = new Map();
  if (owedMsat <= haveMsat) for (const [k, v] of owed) players.set(k, v);
  else {
    let left = haveMsat;
    for (const [k, v] of owed) { const share = (haveMsat * v) / owedMsat; players.set(k, share); left -= share; }
    for (const k of remainderKeys(roundId, [...owed.keys()].map(fromHex))) {
      if (left <= 0n) break;
      players.set(hex(k), players.get(hex(k)) + 1n);
      left -= 1n;
    }
  }
  const playersMsat = [...players.values()].reduce((a, b) => a + b, 0n);
  return { players, playersMsat, reservesMsat: haveMsat - playersMsat, shortMsat: owedMsat - playersMsat, burned: 0n };
}

/**
 * THE REAL LOSS OF A NAMED CLAIM'S OFFENCE (RULED 2026-11-06, kanban #1146 B; #976's rule). Answers { ok: true, losses (Map player key hex -> msat, above
 * zero only), level } or { ok: false, why }. Pure. `entries` the round's as they settled (arbiter.js settledEntries: an entry with no FINAL run has no
 * outcome), `held` the judge's answer (arbiter.js judgeNamedClaimProof):
 *
 *   (b) FORFEIT_OF_LOST_ENTRY, `held.playerPubkey` the forfeited entry. Affected: every activated entry but it.
 *       level 1, every entry settled: F(true) - F′ (payout.js withGoneStakes, the table the round settles on). `settled` false - the round's remaining
 *         locks still unsettled at the cap (#1130's, start + slash_fallback_blocks / 4 since #1340) - reads each unsettled lock as gone back to its player: its net stake.
 *       level 2, an entry not settled: the forfeited net stake, owed to the round's proved qualifiers pro rata by their F′ payouts; none proved, no loss.
 *   (a) OFF_TABLE_CLAIM, `held.spends` the accepted transaction's spends of the round's locks (the tool's read: each `lock` with its refund key and
 *       amount, and the transaction's `outputs`). Affected: every activated entry whose lock it claimed.
 *       level 1 (`held.truth`, the proof's FINAL rows, shown exactly F): F(true) - what the transaction paid them, a stake it did not claim counted as
 *         gone back to its player.
 *       level 2 (`held.leftMsat`, what left the round: paid to keys the round may not pay, and any excess over a cap - named-claim-payees.js
 *         leftTheRound): owed to the entries whose locks it claimed, pro rata by the amounts it claimed of each.
 * Shares are floored; the msat a split leaves goes one at a time in ascending H(round_id || pubkey), as §22A's remainder.
 */
export function namedClaimLosses({ held, entries = [], roundId, minScore = 0, payoutShares = null, settled = true, protocolVersion = null } = {}) {
  if (!held || !OFFENCES.includes(held.offence)) return { ok: false, why: 'not a named claim\'s offence' };
  const losses = new Map();
  if (held.offence === FORFEIT_OF_LOST_ENTRY) {
    const forfeited = held.playerPubkey;
    const harmed = affectedEntries({ offence: held.offence, playerPubkey: forfeited, entries });
    if (!harmed.ok) return harmed;
    const out = entries.find((e) => hex(e.playerPubkey) === hex(forfeited));
    if (!out) return { ok: false, why: 'the round as it settled has no entry for the forfeited player' };
    const gone = new Set([hex(forfeited)]);
    const exact = entries.every((e) => !e.activated || e.outcome);
    if (exact) {
      const should = receivedBy({ roundId, rows: entries, minScore, payoutShares, protocolVersion });
      const did = settled ? receivedBy({ roundId, rows: withGoneStakes(entries, gone), minScore, payoutShares, protocolVersion }) : new Map(entries.map((e) => [hex(e.playerPubkey), netStakeMsat(e)]));
      for (const e of harmed.affected) { const k = hex(e.playerPubkey); const loss = (should.get(k) || 0n) - (did.get(k) || 0n); if (loss > 0n) losses.set(k, loss); }
      return { ok: true, losses, level: 1 };
    }
    const proved = entries.filter((e) => e.outcome);
    const fPrime = receivedBy({ roundId, rows: withGoneStakes(proved, gone), minScore, payoutShares, protocolVersion });
    const weights = new Map();
    for (const e of harmed.affected) if (e.outcome && isQualifier(e, minScore)) { const w = fPrime.get(hex(e.playerPubkey)) || 0n; if (w > 0n) weights.set(hex(e.playerPubkey), w); }
    for (const [k, v] of proRata(netStakeMsat(out), weights, roundId)) if (v > 0n) losses.set(k, v);
    return { ok: true, losses, level: 2 };
  }
  // (a): WHOSE LOCKS THE TRANSACTION CLAIMED, by the lock's refund key - a stake lock's or a fee lock's
  const spends = Array.isArray(held.spends) ? held.spends : [];
  const low = (x) => String(x || '').toLowerCase();
  const claimed = new Map();            // refund key hex -> { stake: bool, msat }
  for (const sp of spends) {
    if (!sp || !sp.lock || sp.kind !== 'claim') continue;
    const k = low(sp.lock.refund_pk), c = claimed.get(k) || { stake: false, msat: 0n };
    if (!(sp.lock.payment_image && sp.lock.payment_image.hash !== undefined)) c.stake = true;
    c.msat += BigInt(sp.lock.amount_msat);
    claimed.set(k, c);
  }
  const refundOf = (e) => hex(refundKeyOf(e.playerPubkey));
  const claimedKeys = new Set(entries.filter((e) => claimed.has(refundOf(e))).map((e) => hex(e.playerPubkey)));
  const harmed = affectedEntries({ offence: held.offence, entries, claimedKeys });
  if (!harmed.ok) return harmed;
  if (Array.isArray(held.truth) && held.truth.length) {
    const paid = new Map();
    for (const o of (spends[0] && spends[0].outputs) || []) if (o && o.amount_msat !== undefined) paid.set(low(o.refund_pk), (paid.get(low(o.refund_pk)) || 0n) + BigInt(o.amount_msat));
    const truthByKey = new Map(held.truth.map((t) => [hex(t.pubkey), t]));
    const rows = entries.map((e) => { const t = truthByKey.get(hex(e.playerPubkey)); return t ? { ...e, outcome: t.outcome, score: t.score } : e; }).filter((e) => e.outcome);
    const should = receivedBy({ roundId, rows, minScore, payoutShares, protocolVersion });
    for (const e of harmed.affected) {
      const k = hex(e.playerPubkey), c = claimed.get(refundOf(e));
      const did = (paid.get(refundOf(e)) || 0n) + (c && c.stake ? 0n : netStakeMsat(e));
      const loss = (should.get(k) || 0n) - did;
      if (loss > 0n) losses.set(k, loss);
    }
    return { ok: true, losses, level: 1 };
  }
  const left = typeof held.leftMsat === 'bigint' ? held.leftMsat : 0n;
  const weights = new Map();
  for (const e of harmed.affected) { const c = claimed.get(refundOf(e)); if (c && c.msat > 0n) weights.set(hex(e.playerPubkey), c.msat); }
  for (const [k, v] of proRata(left, weights, roundId)) if (v > 0n) losses.set(k, v);
  return { ok: true, losses, level: 2 };
}

/** `totalMsat` split by `weights` (key hex -> BigInt), each share floored, the msat left one at a time in ascending H(round_id || pubkey). */
function proRata(totalMsat, weights, roundId) {
  const out = new Map();
  const sum = [...weights.values()].reduce((a, b) => a + b, 0n);
  if (totalMsat <= 0n || sum <= 0n) return out;
  let left = totalMsat;
  for (const [k, w] of weights) { const share = (totalMsat * w) / sum; out.set(k, share); left -= share; }
  for (const k of remainderKeys(roundId, [...weights.keys()].map(fromHex))) {
    if (left <= 0n) break;
    out.set(hex(k), out.get(hex(k)) + 1n);
    left -= 1n;
  }
  return out;
}

/** Ascending `H(roundId || pubkey)`, the order 22A names and payout.js uses. */
function remainderKeys(roundId, keys) {
  return [...keys].sort((a, b) => {
    const x = taggedHash(TAG.remainder, concat(roundId, a));
    const y = taggedHash(TAG.remainder, concat(roundId, b));
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i];
    return 0;
  });
}

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * A NODE'S OPERATOR, the key its advertisement declares (5A.13): 32 bytes, or null for a declaration that names no key, which conflicts with nobody.
 * operator-conflict.js reads it (kept when the conflict check left this file, kanban #1040).
 */
export function operatorKeyOf(advert) {
  const said = advert && advert.operatorId;
  if (typeof said !== 'string' || !/^[0-9a-f]{64}$/.test(said)) return null;
  const key = new Uint8Array(32);
  for (let i = 0; i < 32; i++) key[i] = parseInt(said.slice(i * 2, i * 2 + 2), 16);
  return key;
}

/**
 * RULING #2587 (kanban #2606), a new §5A.3 row: "signing two `LockSet`s for one `round_id` with different entries. Proof: the two signed
 * LockSets, the accused's node key on both." An honest seat signs ONE set per round and keeps it before it serves it (lock-set-book.js), so a
 * restart cannot make it sign a second; a committee of 2t - 1 has two thresholds overlapping in one seat, and that seat signing both sets is
 * what makes two certificates (a contested set: the round is VOID, every lock back). No player lost money, so THE WHOLE BOND GOES TO THE
 * RESERVES (#976): lockSetSlashDistribution. Not one of the OFFENCES rows above (it names no entry, so no player has a real loss),
 * so it is listed on its own.
 */
export const TWO_LOCK_SETS = 'TWO_LOCK_SETS';
export const LOCK_SET_OFFENCES = [TWO_LOCK_SETS];

/**
 * THE PROOF BODY of a double-signed lock set, in the slash proof's one encoding (encodeSlashProof): the round, the accused, its advertised
 * bond, and the two set ids in one order - the lower names (`signedResultId`), the higher rides in `transcriptHash` (as orderedResultIds does
 * for TWO_RESULTS) - so one offence has one commitment. No player is named (`playerPubkey` 32 zero bytes). `a`, `b`: the two signed LockSets
 * (bytes, lock-set.js encodeSignedLockSet), which travel beside the proof.
 */
export function twoLockSetsProof({ nodePubkey, a, b, bondTxid, bondVout }) {
  const x = decodeSignedLockSet(a), y = decodeSignedLockSet(b);
  const { named, other } = orderedResultIds(lockSetId(x.set), lockSetId(y.set));
  return { roundId: x.set.roundId, playerPubkey: EMPTY, nodePubkey, transcriptHash: other, signedResultId: named, bondTxid, bondVout };
}

/**
 * DID THIS NODE SIGN TWO DIFFERENT LOCK SETS FOR ONE ROUND? Only bytes the accused signed; nothing replayed, nothing injected but the
 * BIP-340 verifier. `signedLockSets`: the two signed LockSets (bytes); `committee` the round's seat keys; `advert` the accused's advertisement
 * naming its bond. A signature under the VIEW tag never counts (it is what a seat saw, not a set it signed), and the same set twice is a
 * retransmission, not an offence. Answers { slashed: false, why } or { slashed: true, offence, bond, commitment, ids, toReserves: true, why }.
 */
export function slashHoldsOnTwoLockSets({ proof, signedLockSets, advert, committee, verify }) {
  if (typeof verify !== 'function') return { slashed: false, why: 'checking two signed lock sets needs a verifier, and none was injected' };
  if (!Array.isArray(committee) || !committee.length) return { slashed: false, why: 'no committee, so nobody was serving this round' };
  if (!proof || !committee.some((k) => hex(k) === hex(proof.nodePubkey)))
    return { slashed: false, why: `${proof ? hex(proof.nodePubkey) : '(none)'} is not on this round's committee, so it signed no lock set it owed` };
  if (!Array.isArray(signedLockSets) || signedLockSets.length !== 2)
    return { slashed: false, why: 'this offence is a PAIR: two signed lock sets, and no other number of them' };
  const sets = [];
  for (const [at, bytes] of signedLockSets.entries()) {
    let s; try { s = decodeSignedLockSet(bytes); } catch (e) { return { slashed: false, why: `lock set ${at} is not a signed lock set: ${e.message}` }; }
    if (hex(s.set.roundId) !== hex(proof.roundId)) return { slashed: false, why: `lock set ${at} is for a different round` };
    const setId = lockSetId(s.set);
    let good = false;
    try { good = !!verify(s.sig, lockSetSignatureId({ setId, atMs: s.atMs }), proof.nodePubkey); } catch { good = false; }
    if (!good) return { slashed: false, why: `lock set ${at} is not signed by ${hex(proof.nodePubkey)} as a set signature` };
    sets.push(setId);
  }
  if (hex(sets[0]) === hex(sets[1])) return { slashed: false, why: 'those are the same set, signed twice: a retransmission, not an offence' };
  const { named, other } = orderedResultIds(sets[0], sets[1]);
  if (hex(proof.signedResultId) !== hex(named) || hex(proof.transcriptHash) !== hex(other))
    return { slashed: false, why: 'the pair is named in the wrong order: the lower set id is the one the proof names, or one offence could be minted as two proofs' };
  if (hex(proof.playerPubkey) !== hex(EMPTY)) return { slashed: false, why: 'this offence names no player: the proof\'s player field is 32 zero bytes' };
  if (!advert || hex(advert.nodePubkey) !== hex(proof.nodePubkey)) return { slashed: false, why: 'no advertisement from the accused node to name its bond' };
  if (hex(advert.bondTxid) !== hex(proof.bondTxid) || advert.bondVout !== proof.bondVout)
    return { slashed: false, why: `the proof names bond ${hex(proof.bondTxid)}:${proof.bondVout} and the node advertised ${hex(advert.bondTxid)}:${advert.bondVout}` };
  // 2.0: the commitment is H(fraud_proof) of the complete proof - the body, then the two signed sets with the named (lower id) first
  const ordered = hex(sets[0]) === hex(named) ? signedLockSets : [signedLockSets[1], signedLockSets[0]];
  const fraudProof = twoLockSetsFraudProof({ proof, signedLockSets: ordered });
  return { slashed: true, offence: TWO_LOCK_SETS, bond: { txid: proof.bondTxid, vout: proof.bondVout }, commitment: fraudProofHash(fraudProof), fraudProof,
    ids: { named, other }, toReserves: true, why: 'the node signed two different lock sets for one round (ruling #2587)' };
}

/** The complete proof's bytes (encodeFraudProof): the slash proof body, then each signed LockSet as u32 length + bytes, in the order given. */
export function twoLockSetsFraudProof({ proof, signedLockSets }) {
  const w = new Writer();
  const body = encodeSlashProof(proof);
  w.bytes(body, body.length);
  for (const b of signedLockSets) { w.u32(b.length); w.bytes(b, b.length); }
  return encodeFraudProof({ evidence: w.finish() });
}

/** RULING #2587 + #976: no player lost money in a contested (VOID) round, so the whole slashed bond goes to the protocol reserves. */
export function lockSetSlashDistribution({ bondSats }) {
  if (typeof bondSats !== 'bigint' || bondSats < 0n) throw new Error('a bond is BigInt satoshi');
  // slashing rule v2's shape (slashDistribution): no player owed, so every msat to the reserves
  return { toReserves: bondSats, toPlayers: 0n, players: new Map(), playersMsat: 0n, reservesMsat: bondSats * 1000n, shortMsat: 0n, burned: 0n };
}
