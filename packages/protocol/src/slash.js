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
import { PROTOCOL_VERSION, TYPE_SLASH_PROOF, TAG } from './constants.js';
import { decodePlayerResult, resultId, splitSignedResult } from './result.js';

const hex = (b) => toHex(b);

/**
 * The offences of 5A.3, by the name this file uses for them.
 *
 * One is implemented. The other five are listed rather than stubbed, because
 * a name in an array that answers nothing is worse than an absence: it reads
 * as coverage.
 */
export const REPLAY_CONTRADICTS = 'REPLAY_CONTRADICTS';
export const OFFENCES = [REPLAY_CONTRADICTS];

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
