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
  PROTOCOL_VERSION, TYPE_SLASH_PROOF, TYPE_PAYOUT_TABLE, TYPE_SETTLEMENT_RECORD, TAG,
} from './constants.js';
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

// In 5A.3's own document order, which is the order they are being written in.
export const OFFENCES = [
  TWO_RESULTS, REPLAY_CONTRADICTS, TABLE_IS_NOT_F, SETTLED_WITHOUT_AUTHORITY,
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
  proof, signedTable, advert, committee, entries, minScore = 0,
}) {
  if (!Array.isArray(committee) || !committee.length)
    return { slashed: false, why: 'no committee, so nobody was serving this round' };
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
