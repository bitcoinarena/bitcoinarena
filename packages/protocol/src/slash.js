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
// WHAT IS DELIBERATELY NOT HERE. The distribution - "half to the affected
// players of that round, half burned or to the remaining honest committee
// members, as fixed by the Round Contract" - needs a contract field that does
// not exist yet, and adding one moves every round id. It is named and left.
import { Writer, Reader } from './encode.js';
import { taggedHash, toHex } from './hash.js';
import {
  PROTOCOL_VERSION, TYPE_SLASH_PROOF, TYPE_PAYOUT_TABLE, TYPE_SETTLEMENT_RECORD,
  TYPE_RESULT, TYPE_FEE_CLAIM, TYPE_SERVICE_RECORD, ROLES, roleByte,
  SLASH_REMAINDERS, SLASH_TO_PLAYERS_BPS, TAG,
} from './constants.js';
import { entryId } from './contracts.js';
import { feeOwed, feeTableId } from './fee.js';
import { decodePlayerResult, resultId, splitSignedResult } from './result.js';
import {
  computePayoutTable, payoutTableId, decodePayoutTable,
  settlementAction, actionByte, actionOf, NOTHING,
} from './payout.js';
import { outcomeByte, outcomeOf } from './result.js';

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
 * 5A.3 row 3: "Signing a payout table that does not equal
 * `F(contract, membership, results)`", proof "the table and its inputs".
 *
 * §20 is what makes it mechanical: "PayoutTable = F(RoundContract, Membership,
 * FinalResults). Deterministic. Nodes sign the payout-table hash... A node
 * signing a table that does not equal F(...) of its published inputs is
 * slashable." So the check is a recomputation and a comparison of two hashes,
 * and no verdict is injected at all - unlike the replay, this one nobody has
 * to attest to, because `F` is right here.
 */
export const TABLE_IS_NOT_F = 'TABLE_IS_NOT_F';

/**
 * 5A.3 row 4: "Settlement action without the required 5-of-7 result and payout
 * signatures", proof "the settlement record".
 *
 * 23.2's table is the law and `settlementAction` is that table, so like row 3
 * this needs no attesting party: the record's own published conditions are
 * recomputed and compared with what was done.
 */
export const SETTLED_WITHOUT_AUTHORITY = 'SETTLED_WITHOUT_AUTHORITY';

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
 * 5A.3 row 6: "Claiming a fee share without meeting the availability rule
 * (22A)", proof "the receipt record". Claiming nothing is not the offence -
 * 22A redistributes an unearned share rather than taking a bond for one
 * nobody asked for.
 */
export const FEE_WITHOUT_SERVICE = 'FEE_WITHOUT_SERVICE';

// In 5A.3's own document order, which is the order they are being written in.
export const OFFENCES = [
  TWO_RESULTS, REPLAY_CONTRADICTS, TABLE_IS_NOT_F, SETTLED_WITHOUT_AUTHORITY,
  OPERATOR_PLAYED, FEE_WITHOUT_SERVICE,
];

/**
 * The proof body. The signed result it accuses travels BESIDE it, like every
 * other signature in this protocol, so the proof's own id does not move when
 * the evidence is attached.
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
  if (r.u16() !== PROTOCOL_VERSION) throw new Error('unknown protocol version');
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

export const slashProofId = (p) => taggedHash(TAG.slashProof, encodeSlashProof(p));

/**
 * WHAT THE SLASHING TRANSACTION HAS TO CARRY, 5A.3B step 4:
 * `OP_RETURN = H(fraud_proof) ‖ retrieval hint`.
 *
 * The same 32 bytes as the id, and named separately because the two say
 * different things: an id addresses a proof, and this is the commitment a
 * spend makes to one. "Because the slashing transaction commits to the proof,
 * every slash is permanently auditable... A slash whose committed proof does
 * not retrieve, or does not check, is itself public evidence against the
 * arbitration set."
 *
 * The retrieval hint is NOT here. It is where to fetch the proof - a URL, a
 * torrent, an IPFS root - and the spec does not fix its shape; inventing one
 * would be inventing a second protocol. What is fixed is the hash it follows.
 */
export const slashCommitment = (p) => slashProofId(p);

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
 * Returns `{ slashed: false, why }` or `{ slashed: true, offence, bond,
 * commitment, why }`.
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
    commitment: slashCommitment(proof),
    why: 'the node signed a result the canonical transcript does not replay to',
  };
}

/**
 * DOES THIS TABLE SLASH THIS BOND? 5A.3 row 3.
 *
 * §20: "PayoutTable = F(RoundContract, Membership, FinalResults).
 * Deterministic. Nodes sign the payout-table hash; 5-of-7 matching signatures
 * make it final. A node signing a table that does not equal F(...) of its
 * published inputs is slashable."
 *
 * NOTHING IS INJECTED HERE, and that is the difference from the replay
 * offence. `F` is `computePayoutTable`, it is in this package, and it is the
 * same function the node, the client and the replayer already share - so this
 * needs no attesting party at all, and 5A.3B's residual about one who "can, in
 * principle, slash without cause" does not reach this row.
 *
 * ITS PUBLISHED INPUTS, not the accuser's. The entries and the score floor are
 * what the accused node published; recomputing from an accuser's own inputs
 * would let them pick a set that disagrees with anything. The caller has to
 * say what those inputs were, and `inputsHash` is how the proof is bound to
 * them - see `payoutInputsId`.
 *
 * AND F ITSELF MAY REFUSE. `computePayoutTable` throws when its own invariant
 * breaks - paid against staked - and a table whose inputs cannot be computed
 * at all is not evidence that the signer was dishonest about them. That is
 * refused as unusable rather than counted as an offence.
 */
export function slashHoldsOnTable({
  proof, signedTable, advert, committee, entries, contract,
}) {
  if (!Array.isArray(committee) || !committee.length)
    return { slashed: false, why: 'no committee, so nobody was serving this round' };

  // THE SCORE FLOOR COMES OFF THE ROUND CONTRACT, not off the accuser.
  //
  // It was an argument here, defaulted to zero, while `minScore` has been a
  // signed field of the contract all along. Binding it into `payoutInputsId`
  // stopped an accuser SWAPPING it after the fact and did nothing about the
  // accuser CHOOSING it: whoever writes the proof picks the floor, and F at
  // another floor is a different table, so a node whose table was right is
  // slashed for it. Measured on the same entries: F is f5abb801d78b2153 at a
  // floor of 0 and f69f32a60d912403 at 999.
  //
  // The same fault the fee minimum had, on a different row, and the same fix:
  // the number every player and node signed up to is the only one that
  // produces a table here.
  if (!contract || !Number.isInteger(contract.minScore) || contract.minScore < 0)
    return { slashed: false, why: 'no round contract to read the score floor from' };
  const minScore = contract.minScore;
  if (!committee.some((k) => hex(k) === hex(proof.nodePubkey)))
    return {
      slashed: false,
      why: `${hex(proof.nodePubkey)} is not on this round's committee, so it signed nothing it owed`,
    };

  // THE EVIDENCE IS THE TABLE THE PROOF NAMES. The id the node signed is what
  // travels in `signedResultId` - the field names the object under accusation,
  // and for this row that object is a table rather than a result.
  if (!(signedTable instanceof Uint8Array) || !signedTable.length)
    return { slashed: false, why: 'no signed table attached to check against F' };
  let claimed;
  try { claimed = decodePayoutTable(signedTable); }
  catch (e) { return { slashed: false, why: `the evidence is not a payout table: ${e.message}` }; }

  if (hex(payoutTableId(claimed)) !== hex(proof.signedResultId))
    return { slashed: false, why: 'the table attached is not the one this proof names' };
  if (hex(claimed.roundId) !== hex(proof.roundId))
    return { slashed: false, why: 'the table attached is for a different round' };

  // THE INPUTS THE PROOF IS BOUND TO. Without this the accuser recomputes from
  // whatever entries suit them and every honest table is slashable.
  if (!Array.isArray(entries) || !entries.length)
    return { slashed: false, why: 'no published inputs to recompute F from' };
  // ANSWERED, NEVER THROWN. Malformed inputs are a thing an accuser can hand
  // in, so committing to them has to be a refusal like every other check here
  // - a decision function that raises on bad evidence hands its caller an
  // exception where it asked for a verdict, and the caller least able to cope
  // with that is a node acting on somebody else's accusation.
  let inputs;
  try { inputs = payoutInputsId({ roundId: proof.roundId, entries, minScore }); }
  catch (e) { return { slashed: false, why: `those inputs cannot be committed to: ${e.message}` }; }
  if (hex(proof.transcriptHash) !== hex(inputs))
    return {
      slashed: false,
      why: 'the proof is bound to different inputs than the ones handed in',
    };

  let honest;
  try {
    honest = computePayoutTable({ roundId: claimed.roundId, entries, minScore });
  } catch (e) {
    return { slashed: false, why: `F cannot be computed from those inputs: ${e.message}` };
  }

  const wanted = payoutTableId({ roundId: claimed.roundId, table: honest.table });
  if (hex(wanted) === hex(payoutTableId(claimed)))
    return { slashed: false, why: 'the table signed is exactly F of its published inputs' };

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
    offence: TABLE_IS_NOT_F,
    bond: { txid: proof.bondTxid, vout: proof.bondVout },
    commitment: slashCommitment(proof),
    expected: wanted,
    why: 'the table signed is not F of the inputs the node published',
  };
}

/**
 * THE INPUTS, AS ONE HASH, so a proof can be bound to them.
 *
 * §20's offence is about a table against "its published inputs", so a proof
 * that did not name them would be an accusation with a free variable: whoever
 * checks it later could recompute from a different membership and get a
 * different answer. This is the membership and the floor, in the order `F`
 * itself sorts by, so two people who publish the same inputs commit to the
 * same 32 bytes.
 *
 * It rides in the proof's `transcriptHash` field rather than adding one:
 * that field is "the object this offence is measured against", and for the
 * replay row that object is a transcript while for this row it is the inputs.
 * One field, one meaning - what was published that the signature is wrong
 * about - and no widening of a body that is already committed to on chain.
 */
export function payoutInputsId({ roundId, entries, minScore = 0 }) {
  const w = new Writer();
  w.u8(TYPE_PAYOUT_TABLE);
  w.u16(PROTOCOL_VERSION);
  w.bytes32(roundId);
  w.u32(minScore);
  const rows = [...entries].sort((a, b) => {
    for (let i = 0; i < a.pubkey.length && i < b.pubkey.length; i++)
      if (a.pubkey[i] !== b.pubkey[i]) return a.pubkey[i] - b.pubkey[i];
    return 0;
  });
  w.vec(rows, (e, ww) => {
    ww.bytes32(e.pubkey);
    ww.u8(outcomeByte(e.outcome));
    ww.u32(e.score);
    ww.u64(e.stakeMsat);
  });
  return taggedHash(TAG.payoutInputs, w.finish());
}

/**
 * THE SETTLEMENT RECORD, 5A.3 row 4's proof.
 *
 * 23.2's table is the law: DELIVERED cancels on 5-of-7 settlement signatures,
 * FAILED and FORFEIT settle only on a FINAL result with 5 preimage shares and
 * 5-of-7 settlement signatures, and VOID needs nobody to act at all. The
 * record is what a settlement node DID and the conditions it published for
 * having done it - the same shape row 3 uses, where the accusation is measured
 * against what the accused itself put its name to.
 *
 * The spec names no encoding for it, so this fills the type reserved above the
 * way the objection and the payout table did.
 *
 * THE ENTRY IS IN IT. A settlement action is about one player's hold invoice,
 * and a record without the entry would be an action against no particular
 * money - and its signature would carry to any entry of the round.
 */
export function encodeSettlementRecord(r) {
  const w = new Writer();
  w.u8(TYPE_SETTLEMENT_RECORD);
  w.u16(PROTOCOL_VERSION);
  w.bytes32(r.roundId);
  w.bytes32(r.entryId);
  w.bytes32(r.nodePubkey);
  w.u8(actionByte(r.action));

  // WHAT THE NODE SAID IT HAD. Every one of 23.2's conditions, as the node
  // published them: the outcome it acted on, whether that player qualified,
  // how far the result had got, and the two counts.
  w.u8(outcomeByte(r.outcome));
  w.u8(r.qualifies ? 1 : 0);
  w.str(r.state || '');
  w.u16(r.shares | 0);
  w.u16(r.signatures | 0);
  return w.finish();
}

export function decodeSettlementRecord(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== TYPE_SETTLEMENT_RECORD) throw new Error('not a settlement record');
  if (r.u16() !== PROTOCOL_VERSION) throw new Error('unknown protocol version');
  const out = {
    roundId: r.bytes32(),
    entryId: r.bytes32(),
    nodePubkey: r.bytes32(),
    action: actionOf(r.u8()),
    outcome: outcomeOf(r.u8()),
    qualifies: r.u8() === 1,
    state: r.str(),
    shares: r.u16(),
    signatures: r.u16(),
  };
  if (r.at !== bytes.length) throw new Error('trailing bytes after the settlement record');
  return out;
}

export const settlementRecordId = (r) =>
  taggedHash(TAG.settlementRecord, encodeSettlementRecord(r));

/**
 * DID THIS NODE ACT WITHOUT THE AUTHORITY IT NEEDED? 5A.3 row 4.
 *
 * "Settlement action without the required 5-of-7 result and payout signatures.
 * Proof: the settlement record."
 *
 * NOTHING IS INJECTED, as in row 3: `settlementAction` is 23.2's table and it
 * is in this package, so the check recomputes what the record's own published
 * conditions authorised and compares it with what was done. No attester, and
 * so no attester who could slash without cause.
 *
 * TWO WAYS TO BE WRONG, and they are different offences of the same row:
 *   - the action was not authorised at all - the counts the node itself
 *     published do not meet 23.2's requirements
 *   - the action was not the one those conditions call for - settling where
 *     23.2 cancels, or acting at all on a VOID, which "needs nobody to act"
 *
 * AND ONLY MONEY LEAVING IS AN OFFENCE. A node that did LESS than it was
 * entitled to has taken nothing from anybody: 23.2's whole safety property is
 * that "the default path - nobody acting - is always the refund", so inaction
 * cannot be the thing a bond is taken for. NOTHING where a cancel was due
 * leaves the player their money by expiry, and slashing it would invert the
 * one direction the design is built to keep safe.
 */
export function slashHoldsOnSettlement({ proof, signedRecord, advert, committee }) {
  if (!Array.isArray(committee) || !committee.length)
    return { slashed: false, why: 'no committee, so nobody was serving this round' };
  if (!committee.some((k) => hex(k) === hex(proof.nodePubkey)))
    return {
      slashed: false,
      why: `${hex(proof.nodePubkey)} is not on this round's committee, so it settled nothing it owed`,
    };

  if (!(signedRecord instanceof Uint8Array) || !signedRecord.length)
    return { slashed: false, why: 'no settlement record attached to check against 23.2' };
  let record;
  try { record = decodeSettlementRecord(signedRecord); }
  catch (e) { return { slashed: false, why: `the evidence is not a settlement record: ${e.message}` }; }

  if (hex(settlementRecordId(record)) !== hex(proof.signedResultId))
    return { slashed: false, why: 'the record attached is not the one this proof names' };
  if (hex(record.roundId) !== hex(proof.roundId))
    return { slashed: false, why: 'the record attached is for a different round' };
  if (hex(record.nodePubkey) !== hex(proof.nodePubkey))
    return { slashed: false, why: 'the record attached was written by a different node' };

  // AND NO FIELD OF THE PROOF IS LEFT FREE ON THIS ROW.
  //
  // Rows 2 and 3 pin both of these and this one pinned neither, which is a
  // hole in a body whose hash goes on chain: an accuser could vary them at
  // will and produce unboundedly many different valid proofs of one offence,
  // each with a different commitment. Worse for `playerPubkey` - the record
  // names an ENTRY and not a player, so a proof could name somebody who had
  // nothing to do with the settlement and a reader would take them for the
  // victim.
  //
  // `transcriptHash` means "the object this offence is measured against", and
  // for a settlement that is the entry whose hold invoice was acted on. The
  // player is left to the entry rather than repeated: this row names no player
  // directly, so the field is required to be empty instead of plausible.
  if (hex(proof.transcriptHash) !== hex(record.entryId))
    return {
      slashed: false,
      why: 'the proof is measured against a different entry than the record acted on',
    };
  if (hex(proof.playerPubkey) !== hex(EMPTY))
    return {
      slashed: false,
      why: 'this row names no player: the entry does, and a proof naming one '
        + 'would put somebody\'s name on a settlement that is not about them',
    };

  // 23.2, recomputed from the node's OWN published conditions.
  const due = settlementAction({
    outcome: record.outcome,
    qualifies: record.qualifies,
    state: record.state,
    shares: record.shares,
    signatures: record.signatures,
  });

  if (record.action === NOTHING)
    return {
      slashed: false,
      why: 'the node did nothing, and nobody acting is 23.2\'s refund path: '
        + 'a bond is not taken for leaving money where it was',
    };

  if (due.action === record.action && due.authorised)
    return { slashed: false, why: `23.2 authorised ${record.action} on those conditions` };

  const why = due.action !== record.action
    ? `23.2 calls for ${due.action} on those conditions and the node did ${record.action}`
    : `${record.action} needed ${due.missing.join(', ')}`;

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
    offence: SETTLED_WITHOUT_AUTHORITY,
    bond: { txid: proof.bondTxid, vout: proof.bondVout },
    commitment: slashCommitment(proof),
    due: due.action,
    missing: due.missing,
    why,
  };
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
 * THE PUREST OF THE FOUR. Rows 3 and 4 recompute an `F`; this one compares.
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
 */
export function slashHoldsOnDoubleSign({ proof, signedResults, advert, committee }) {
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

  const bodies = [];
  for (const [at, bytes] of signedResults.entries()) {
    try { bodies.push(decodePlayerResult(splitSignedResult(bytes).body)); }
    catch (e) { return { slashed: false, why: `result ${at} is not a signed result: ${e.message}` }; }
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
  }

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
    commitment: slashCommitment(proof),
    ids: { named, other },
    why: 'the node signed two different results for one player of one round',
  };
}

/**
 * WHAT THE ACCUSED SIGNED, WHICHEVER OF THE THREE IT WAS.
 *
 * 5A.13 names all three: "its result signatures, payout-table signatures and
 * settlement participation are invalid". So a conflicted node is slashable for
 * any of them, and the type byte the object already carries says which - no
 * discriminator is invented and no caller has to declare one.
 */
function signedThing(bytes) {
  if (!(bytes instanceof Uint8Array) || !bytes.length) return null;
  try {
    if (bytes[0] === TYPE_RESULT) {
      const body = decodePlayerResult(splitSignedResult(bytes).body);
      return { kind: 'result', roundId: body.roundId, nodePubkey: body.nodePubkey, id: resultId(body) };
    }
    if (bytes[0] === TYPE_PAYOUT_TABLE) {
      const t = decodePayoutTable(bytes);
      // A table carries no signer: it is the round's table and the signature
      // sits beside it, so the node it accuses is the proof's, not the object's.
      return { kind: 'payout table', roundId: t.roundId, nodePubkey: null, id: payoutTableId(t) };
    }
    if (bytes[0] === TYPE_SETTLEMENT_RECORD) {
      const r = decodeSettlementRecord(bytes);
      return { kind: 'settlement record', roundId: r.roundId, nodePubkey: r.nodePubkey, id: settlementRecordId(r) };
    }
  } catch { return null; }
  return null;
}

/**
 * THE OPERATOR A DECLARATION NAMES, or nothing at all.
 *
 * 5A.13: `operator_id` is "a pubkey", and it is also "a self-declaration...
 * not a proof of identity". This package carries it as a STRING for exactly
 * that reason - `advert.js` says so where it encodes one - so reading it as a
 * key is done here and only here: sixty-four lowercase hex characters, the way
 * `toHex` writes one, and anything else declares no key.
 *
 * That is not a weakness of the check, it is 5A.13's own scope: "an attacker
 * who runs nodes and plays simply declares nothing, or declares unrelated ids,
 * and the rule does not fire... this rule is defence in depth, not a Sybil
 * control". A declaration that names no key conflicts with nobody, and the
 * spec says so before this file does.
 */
export function operatorKeyOf(advert) {
  const said = advert && advert.operatorId;
  if (typeof said !== 'string' || !/^[0-9a-f]{64}$/.test(said)) return null;
  const key = new Uint8Array(32);
  for (let i = 0; i < 32; i++) key[i] = parseInt(said.slice(i * 2, i * 2 + 2), 16);
  return key;
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
  if (!Array.isArray(committee) || !committee.length)
    return { slashed: false, why: 'no committee, so nobody was serving this round' };
  if (!committee.some((k) => hex(k) === hex(proof.nodePubkey)))
    return {
      slashed: false,
      why: `${hex(proof.nodePubkey)} is not on this round's committee, so it signed nothing it owed`,
    };

  if (!advert || hex(advert.nodePubkey) !== hex(proof.nodePubkey))
    return { slashed: false, why: 'no advertisement from the accused node to read its operator from' };

  const operator = operatorKeyOf(advert);
  if (!operator)
    return {
      slashed: false,
      why: 'that advertisement declares no operator key, and 5A.13 does not fire '
        + 'on a declaration that names nobody',
    };

  if (!entry || !(entry.roundId instanceof Uint8Array))
    return { slashed: false, why: 'no entry contract to show the operator played' };
  if (hex(entry.roundId) !== hex(proof.roundId))
    return { slashed: false, why: 'the entry attached is for a different round' };
  if (hex(entry.playerPubkey) !== hex(operator))
    return {
      slashed: false,
      why: `the entry was signed by ${hex(entry.playerPubkey)} and the node declared `
        + `operator ${hex(operator)}: 5A.13 fires on a DECLARED conflict and nothing else`,
    };
  if (hex(proof.playerPubkey) !== hex(operator))
    return { slashed: false, why: 'the proof names a different player than the entry does' };
  if (hex(proof.transcriptHash) !== hex(entryId(entry)))
    return { slashed: false, why: 'the proof is measured against a different entry' };

  // AND THE SIGNING, which is the offence itself.
  const thing = signedThing(signedByNode);
  if (!thing)
    return {
      slashed: false,
      why: 'nothing the node signed is attached: being conflicted is not the '
        + 'offence, signing anyway is',
    };
  if (hex(thing.id) !== hex(proof.signedResultId))
    return { slashed: false, why: `the ${thing.kind} attached is not the one this proof names` };
  if (hex(thing.roundId) !== hex(proof.roundId))
    return { slashed: false, why: `the ${thing.kind} attached is for a different round` };
  if (thing.nodePubkey && hex(thing.nodePubkey) !== hex(proof.nodePubkey))
    return { slashed: false, why: `the ${thing.kind} attached was signed by a different node` };

  if (hex(advert.bondTxid) !== hex(proof.bondTxid) || advert.bondVout !== proof.bondVout)
    return {
      slashed: false,
      why: `the proof names bond ${hex(proof.bondTxid)}:${proof.bondVout} and the node `
        + `advertised ${hex(advert.bondTxid)}:${advert.bondVout}`,
    };

  return {
    slashed: true,
    offence: OPERATOR_PLAYED,
    bond: { txid: proof.bondTxid, vout: proof.bondVout },
    commitment: slashCommitment(proof),
    signed: thing.kind,
    operator,
    why: `the node's declared operator has an entry in this round, and it signed a ${thing.kind} anyway`,
  };
}

/**
 * 22A'S TWO OBJECTS: what a node claims, and what it actually did.
 *
 * "Each eligible slot receives 1.00% / 7 of gross volume for its role...
 * A selected node earns its share only if it performed the contract-defined
 * minimum service: for game/verify, the required receipts plus replay and
 * signing; for settlement, participation in the settlement protocol during the
 * settlement window. A conflicted node (5A.13) never qualifies."
 *
 * The claim is one node's demand for one role of one round. The role is in it
 * because 22A pays the two pools separately and "an operator selected for both
 * roles earns both shares, because it performs both services" - a claim that
 * did not say which role would be a claim on either.
 */
export function encodeFeeClaim(c) {
  const w = new Writer();
  w.u8(TYPE_FEE_CLAIM);
  w.u16(PROTOCOL_VERSION);
  w.bytes32(c.roundId);
  w.bytes32(c.nodePubkey);
  w.u8(roleByte(c.role));
  w.u64(c.amountMsat);
  return w.finish();
}

export function decodeFeeClaim(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== TYPE_FEE_CLAIM) throw new Error('not a fee claim');
  if (r.u16() !== PROTOCOL_VERSION) throw new Error('unknown protocol version');
  const c = {
    roundId: r.bytes32(),
    nodePubkey: r.bytes32(),
    role: ROLES[r.u8()],
    amountMsat: r.u64(),
  };
  if (!c.role) throw new Error('unknown role byte in a fee claim');
  if (r.at !== bytes.length) throw new Error('trailing bytes after the fee claim');
  return c;
}

export const feeClaimId = (c) => taggedHash(TAG.feeClaim, encodeFeeClaim(c));

/**
 * WHAT THE NODE ACTUALLY DID, in the unit its own role is measured in.
 *
 * `served` is receipts for game and verify - 22A's "the required receipts" -
 * and settlement participations for settlement. ONE COUNT AND NOT TWO
 * SCHEMES: the roles are measured in different units and the rule over them is
 * the same rule, so the unit belongs to the role and the arithmetic does not
 * fork. What each unit IS stays 22A's sentence and is not redefined here.
 */
export function encodeServiceRecord(r) {
  const w = new Writer();
  w.u8(TYPE_SERVICE_RECORD);
  w.u16(PROTOCOL_VERSION);
  w.bytes32(r.roundId);
  w.bytes32(r.nodePubkey);
  w.u8(roleByte(r.role));
  w.u32(r.served);
  return w.finish();
}

export function decodeServiceRecord(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== TYPE_SERVICE_RECORD) throw new Error('not a service record');
  if (r.u16() !== PROTOCOL_VERSION) throw new Error('unknown protocol version');
  const out = {
    roundId: r.bytes32(),
    nodePubkey: r.bytes32(),
    role: ROLES[r.u8()],
    served: r.u32(),
  };
  if (!out.role) throw new Error('unknown role byte in a service record');
  if (r.at !== bytes.length) throw new Error('trailing bytes after the service record');
  return out;
}

export const serviceRecordId = (r) => taggedHash(TAG.serviceRecord, encodeServiceRecord(r));

/**
 * THE RECORD AND THE MINIMUM, AS ONE HASH, so a proof binds to both.
 *
 * The same discipline row 3 needed: an accusation whose threshold the accuser
 * picks after the fact is an accusation with a free variable, and every honest
 * claim is then slashable by choosing a higher number.
 *
 * THE MINIMUM HAS NO FIELD IN THE ROUND CONTRACT, and that is stated rather
 * than papered over. 22A says "contract-defined minimum service" and
 * `encodeRoundContract` defines no such field - measured, it carries none - so
 * the number is handed in and bound here, exactly as `minScore` is handed to
 * `computePayoutTable` while living in the contract. Adding the field is what
 * would make one minimum canonical for a whole network, and adding a field
 * moves every round id, which is the same blocker the slash distribution has.
 */
export function feeInputsId({ roundId, role, minimumServed, recordId, feeTableId }) {
  const w = new Writer();
  w.u8(TYPE_SERVICE_RECORD);
  w.u16(PROTOCOL_VERSION);
  w.bytes32(roundId);
  w.u8(roleByte(role));
  w.u32(minimumServed);
  w.bytes32(recordId);

  // AND WHICH TABLE THE CLAIM IS MEASURED AGAINST. An over-claim is a
  // comparison with a number, and a number an accuser recomputes from an
  // eligibility set of their choosing makes every honest claim an over-claim.
  // The table has one hash and the proof names it, so a stranger re-deriving
  // the accusation later gets the same answer or none.
  w.bytes32(feeTableId);
  return taggedHash(TAG.feeInputs, w.finish());
}

/**
 * DID THIS NODE CLAIM A FEE SHARE 22A DOES NOT ALLOW? 5A.3 row 6.
 *
 * "Claiming a fee share without meeting the availability rule (22A). Proof:
 * the receipt record."
 *
 * Nothing is injected: two objects, a bound threshold, and comparisons.
 *
 * TWO WAYS TO FAIL 22A, and the spec gives both in one paragraph:
 *   - the node did not perform the minimum service for its role
 *   - the node was CONFLICTED, and "a conflicted node (5A.13) never qualifies"
 *     however much service it performed
 *
 * CLAIMING NOTHING IS NOT AN OFFENCE. 22A's remedy for a share nobody earned
 * is redistribution - "unearned shares are redistributed pro rata among the
 * other eligible nodes in the same role pool, keeping the total at 2%" - so a
 * node that took nothing has cost nobody anything, and its bond is not at
 * stake. A node that served and claimed is doing exactly what the fee is for.
 */
export function slashHoldsOnFeeClaim({
  proof, signedClaim, serviceRecord, contract, advert, committee,
  feeTable = null, entry = null,
}) {
  // THE MINIMUM COMES OFF THE ROUND CONTRACT, not off the accuser.
  //
  // It was an argument until the contract carried it, and a minimum the caller
  // chooses is a minimum the operator chooses - the same fault the objection
  // window was moved into the contract to fix, and worse here, because this
  // number decides whether a bond is taken. The player and every node signed
  // up to it with the rest of the round, and it is covered by the round id.
  if (!contract || !Number.isInteger(contract.slashMinimumServed)
      || contract.slashMinimumServed < 0)
    return { slashed: false, why: 'no round contract to read the minimum service from' };
  const minimumServed = contract.slashMinimumServed;
  if (!Array.isArray(committee) || !committee.length)
    return { slashed: false, why: 'no committee, so nobody was serving this round' };
  if (!committee.some((k) => hex(k) === hex(proof.nodePubkey)))
    return {
      slashed: false,
      why: `${hex(proof.nodePubkey)} is not on this round's committee, so it was owed no share`,
    };

  if (!advert || hex(advert.nodePubkey) !== hex(proof.nodePubkey))
    return { slashed: false, why: 'no advertisement from the accused node to name its bond' };

  let claim;
  try { claim = decodeFeeClaim(signedClaim); }
  catch (e) { return { slashed: false, why: `the evidence is not a fee claim: ${e.message}` }; }
  if (hex(feeClaimId(claim)) !== hex(proof.signedResultId))
    return { slashed: false, why: 'the claim attached is not the one this proof names' };
  if (hex(claim.roundId) !== hex(proof.roundId))
    return { slashed: false, why: 'the claim attached is for a different round' };
  if (hex(claim.nodePubkey) !== hex(proof.nodePubkey))
    return { slashed: false, why: 'the claim attached was made by a different node' };

  // A NODE THAT TOOK NOTHING HAS COST NOBODY ANYTHING. 22A redistributes an
  // unearned share; it does not take a bond for one that was never claimed.
  if (claim.amountMsat <= 0n)
    return {
      slashed: false,
      why: 'that claim is for nothing, and 22A redistributes an unearned share '
        + 'rather than slashing a node that asked for none',
    };

  let record;
  try { record = decodeServiceRecord(serviceRecord); }
  catch (e) { return { slashed: false, why: `the evidence is not a service record: ${e.message}` }; }
  if (hex(record.roundId) !== hex(proof.roundId))
    return { slashed: false, why: 'the record attached is for a different round' };
  if (hex(record.nodePubkey) !== hex(proof.nodePubkey))
    return { slashed: false, why: 'the record attached is about a different node' };
  if (record.role !== claim.role)
    return {
      slashed: false,
      why: `the claim is for ${claim.role} and the record is about ${record.role}: `
        + '22A pays the two pools separately and a share is earned in its own role',
    };

  // THE TABLE 22A OWES FROM. Required, because the offence below is a
  // comparison with what it says: without one there is no owed amount and an
  // over-claim cannot be measured at all.
  if (!feeTable || typeof feeTable.fee !== 'bigint' || !(feeTable.seats instanceof Map))
    return { slashed: false, why: 'no fee table to measure the claim against' };

  const bound = feeInputsId({
    roundId: proof.roundId, role: claim.role, minimumServed,
    recordId: serviceRecordId(record), feeTableId: feeTableId(feeTable),
  });
  if (hex(proof.transcriptHash) !== hex(bound))
    return {
      slashed: false,
      why: 'the proof is bound to a different record, round or minimum than '
        + 'the contract and the record handed in',
    };

  // 22A: A CONFLICTED NODE NEVER QUALIFIES, whatever it served.
  let conflicted = false;
  const operator = operatorKeyOf(advert);
  if (operator && entry && entry.playerPubkey
      && hex(entry.roundId || EMPTY) === hex(proof.roundId)
      && hex(entry.playerPubkey) === hex(operator))
    conflicted = true;

  // AND WHAT 22A ACTUALLY OWES IT. Row 6 decided WHETHER a node qualifies;
  // until the table existed nothing said what the share IS, so a qualifying
  // node could claim any amount and no predicate contradicted it. Claiming
  // more than the table owes is the same offence as claiming without service:
  // both take fee money the round did not earn for it.
  const owed = feeOwed(feeTable, proof.nodePubkey, claim.role);
  const overClaimed = claim.amountMsat > owed;

  if (!conflicted && !overClaimed && record.served >= minimumServed)
    return {
      slashed: false,
      why: `it served ${record.served} of the ${minimumServed} its role required `
        + `and claimed the ${owed} 22A owes it`,
    };

  if (hex(advert.bondTxid) !== hex(proof.bondTxid) || advert.bondVout !== proof.bondVout)
    return {
      slashed: false,
      why: `the proof names bond ${hex(proof.bondTxid)}:${proof.bondVout} and the node `
        + `advertised ${hex(advert.bondTxid)}:${advert.bondVout}`,
    };

  return {
    slashed: true,
    offence: FEE_WITHOUT_SERVICE,
    bond: { txid: proof.bondTxid, vout: proof.bondVout },
    commitment: slashCommitment(proof),
    claimedMsat: claim.amountMsat,
    owedMsat: owed,
    served: record.served,
    required: minimumServed,
    conflicted,
    overClaimed,
    why: conflicted
      ? 'a conflicted node never qualifies for a share, and it claimed one'
      : overClaimed
        ? `it claimed ${claim.amountMsat} where 22A owes it ${owed}`
        : `it claimed a ${claim.role} share having served ${record.served} of ${minimumServed}`,
  };
}

/**
 * WHERE A SLASHED BOND GOES, section 5A.3.
 *
 * "Slashed bonds are distributed: half to the affected players of that round,
 * half burned or to the remaining honest committee members of the round, as
 * fixed by the Round Contract."
 *
 * PURE, AND IT MOVES NOTHING. This says who is owed what out of a bond that
 * has been spent; spending it is 5A.3B steps 3 and 5, an arbitration set with
 * MuSig2 keys, and is not here.
 *
 * THE HALVES ARE THE SPEC'S AND THE DESTINATION IS THE CONTRACT'S. A contract
 * that could move the proportions would let an operator write itself the whole
 * bond, which is the fault a contract field exists to prevent rather than one
 * to import. So `SLASH_TO_PLAYERS_BPS` is a constant and `slashRemainder` is
 * the field - burned, or to the remaining honest committee.
 *
 * THE ACCUSED IS NOT ONE OF THE REMAINING HONEST MEMBERS. "the REMAINING
 * honest committee members" - a node does not collect a share of its own
 * slashing, and neither does any other node slashed in the same round. Pass
 * them in `slashed`; they are filtered out and their share is burned.
 *
 * REMAINDERS the way this repo already does them: floor each share, then hand
 * the leftover out one satoshi at a time in ascending `H(roundId || pubkey)`,
 * the rule 22A names for fees and `payout.js` already uses for the pool. With
 * nobody to pay - no affected players, or a burn - that half is burned, which
 * is the only direction that cannot quietly become somebody's income.
 */
export function slashDistribution({
  bondSats, roundId, contract, affectedPlayers = [], honestCommittee = [],
  slashed = [],
}) {
  if (typeof bondSats !== 'bigint' || bondSats < 0n)
    throw new Error('a bond is BigInt satoshi');
  if (!contract || !SLASH_REMAINDERS.includes(contract.slashRemainder))
    throw new Error('the round contract fixes where the other half goes');

  const toPlayers = (bondSats * BigInt(SLASH_TO_PLAYERS_BPS)) / 10000n;
  const rest = bondSats - toPlayers;

  const shares = new Map();
  let burned = 0n;

  /**
   * Splits `amount` over `who`, and pays only those not in `out`.
   *
   * THE DIVISOR IS THE WHOLE SET, which is the point of the exclusion. Simply
   * removing a slashed member and dividing among the rest pays the survivors
   * MORE the more of their colleagues were caught - measured while writing
   * this: one of two committee members excluded took the other from 25000 to
   * 50000, which is a reward for a round going wrong. The excluded shares are
   * burned instead.
   */
  const hand = (who, amount, out = new Set()) => {
    const paid = who.filter((k) => !out.has(hex(k)));
    if (!who.length || amount <= 0n) { burned += amount > 0n ? amount : 0n; return; }
    const each = amount / BigInt(who.length);
    let left = amount - each * BigInt(who.length);
    for (const k of who) {
      if (out.has(hex(k))) { burned += each; continue; }
      shares.set(hex(k), (shares.get(hex(k)) || 0n) + each);
    }
    // The leftover satoshis follow the same order and skip the same people.
    for (const k of remainderKeys(roundId, paid)) {
      if (left <= 0n) break;
      shares.set(hex(k), (shares.get(hex(k)) || 0n) + 1n);
      left -= 1n;
    }
    burned += left;
  };

  // "THE REMAINING HONEST COMMITTEE MEMBERS" IS A FILTER, NOT A COMMENT.
  //
  // This said so and did not do it: `honestCommittee` was taken as given, so a
  // caller could list the slashed node and hand it back half its own bond -
  // measured at 25000 of 100000 satoshi before this line existed. A documented
  // claim that is not a check is not a check, and this one let an operator
  // write itself the bond by a door the halves constant does not cover.
  //
  // Every node slashed in the round is out, not only the accused: two nodes
  // caught in one round would otherwise each collect from the other's bond,
  // which is the same income by a longer route.
  //
  // AND THEIR SHARE IS BURNED RATHER THAN SPREAD OVER THE REST. Redistributing
  // it would pay the honest members MORE the more of their colleagues were
  // slashed, which is a reward for a round going wrong. Burning is the only
  // direction that cannot become somebody's income.
  const out = new Set(slashed.map(hex));

  hand(affectedPlayers, toPlayers);
  if (contract.slashRemainder === 'COMMITTEE') hand(honestCommittee, rest, out);
  else burned += rest;

  const paid = [...shares.values()].reduce((a, b) => a + b, 0n);
  if (paid + burned !== bondSats)
    throw new Error(`slash distribution broken: ${paid} paid and ${burned} burned of ${bondSats}`);

  return { toPlayers, burned, shares };
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
