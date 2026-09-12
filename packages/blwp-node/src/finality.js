// WHEN A RESULT THIS NODE HOLDS MAY MOVE MONEY (M3.3-32).
//
// Section 13A, through `protocol/src/objection.js`'s own `finality()`: a run
// the committee's threshold signed is PROVISIONALLY_FINAL, and it is FINAL
// when the round contract's objection window has closed with no valid
// objection. "Taking a player's stake requires a final result, an elapsed
// objection window, and a threshold quorum." Measured before this file: the
// daemon took the quorum as final and settled, cancelled and handed out shares
// 586-977 ms after the close of a round whose contract named a 3000 ms window.
//
// THE WINDOW OPENS when THIS node first held the threshold: the `seen_ms` of
// the agreeing record that completed it, off the store - so a restart does not
// open it again, and no message can open it earlier. Two seats see the
// threshold at slightly different moments and close the window at slightly
// different moments; neither closes it sooner than the contract's full length
// after it could itself see the quorum.
//
// A VALID OBJECTION is what `objectionHolds` says it is: the committee's
// receipts, and a replay that contradicts the signed result. The replay a
// daemon holds is its OWN, so an objection filed at `/objection` against a run
// holds on a node that signed a different run than the threshold did, and on
// no other. Filing costs nothing, which is why a filing alone suspends
// nothing: it would let anybody hold every stake past its window and hand it
// back to its player.
import { schnorr } from '@noble/curves/secp256k1.js';
import { finality, objectionHolds, FINAL, SUSPENDED } from '../../protocol/src/objection.js';
import { rerunIsAgreed } from '../../protocol/src/rerun.js';
import { decodeRoundContract } from '../../protocol/src/contracts.js';
import { splitSignedResult, decodePlayerResult, resultId } from '../../protocol/src/result.js';
import {
  splitSignedReceipt, decodeCheckpointReceipt, SIGNED_RECEIPT_BYTES,
} from '../../protocol/src/receipt.js';
import { verifiedFinal, runId } from './verdict.js';
import { transcriptIsPublished } from '../../protocol/src/posting.js';

const hex = (b) => [...b].map((v) => v.toString(16).padStart(2, '0')).join('');

/**
 * Where one run stands on this node, now: `state` is null (no threshold yet),
 * PROVISIONALLY_FINAL, FINAL or SUSPENDED, with `why` and `closesAtMs`.
 */
export function resultFinality(round, roundIdBytes, entryIdBytes, { now = round.now() } = {}) {
  const row = round.get(roundIdBytes);
  if (!row) return { state: null, why: 'no such round' };
  const contract = decodeRoundContract(new Uint8Array(row.contract));
  const committee = round.seats(roundIdBytes);
  const held = round.results(roundIdBytes, entryIdBytes);
  const seen = verifiedFinal(held.map((r) => r.bytes), { contract, seats: committee });
  if (!seen.ok || !seen.final) {
    // §13C'S NO-QUORUM OUTCOME (M3.3-34), on this seat's own record once the
    // result window passed with no result at the threshold: VOID - or FORFEIT,
    // proven equivocation. Only where no quorum is: §14, reachable only from
    // PROVISIONAL.
    const nq = typeof round.noQuorum === 'function' ? round.noQuorum(entryIdBytes) : null;
    if (nq) return { state: nq.outcome, why: nq.why, noQuorum: true };
    return { state: null, why: seen.why || 'not final' };
  }

  // WHO SIGNED THE AGREED RUN, and when this node held each of them. The
  // same checks `verifiedFinal` counted under: a seat, and a signature that
  // verifies. The store keeps one record per seat.
  const seats = new Set(committee.map(hex));
  const agreeing = [];
  let mine = null;
  for (const r of held) {
    let result, signature;
    try {
      const split = splitSignedResult(r.bytes);
      signature = split.signature;
      result = decodePlayerResult(split.body);
    } catch { continue; }
    const who = hex(result.nodePubkey);
    if (!seats.has(who)) continue;
    let ok = false;
    try { ok = schnorr.verify(signature, resultId(result), result.nodePubkey); } catch { ok = false; }
    if (!ok) continue;
    const run = runId(result);
    if (who === hex(round.pubkey)) mine = run;
    if (hex(run) === seen.runId)
      agreeing.push({ run, nodePubkey: result.nodePubkey, seenMs: r.seenMs,
        playerPubkey: result.playerPubkey, transcriptHash: result.transcriptHash });
  }
  const provisionalAtMs = agreeing.map((a) => a.seenMs).sort((x, y) => x - y)[seen.needed - 1];
  const signedResultId = agreeing[0].run;

  const objections = [];
  let objection = null;
  const filedMs = round.objectedAt(roundIdBytes, entryIdBytes);
  if (filedMs !== null) {
    const { bytes } = round.receipts(roundIdBytes, entryIdBytes);
    const receipts = [];
    for (let at = 0; at + SIGNED_RECEIPT_BYTES <= bytes.length; at += SIGNED_RECEIPT_BYTES) {
      try {
        receipts.push(decodeCheckpointReceipt(splitSignedReceipt(bytes.subarray(at, at + SIGNED_RECEIPT_BYTES)).body));
      } catch { /* a record that does not decode backs nothing */ }
    }
    objection = objectionHolds({
      objection: { roundId: roundIdBytes, signedResultId, atMs: BigInt(filedMs) },
      receipts, committee, roundId: roundIdBytes, signedResultId,
      replayDiffers: mine !== null && hex(mine) !== seen.runId,
    });
    objections.push(objection);
  }

  // AND WHETHER ANYONE CAN REPLAY IT (v4.6.2 §13A, P2): the transcript the
  // agreed run names must have been posted to the contract's relays by the
  // round's threshold of settlement seats. Until then the window has not
  // opened and nothing moves; W counts from when that threshold was held here.
  const published = transcriptIsPublished({
    roundId: roundIdBytes, playerPubkey: agreeing[0].playerPubkey, transcriptHash: agreeing[0].transcriptHash,
    postings: round.postings(roundIdBytes, entryIdBytes), seats: committee,
    settlementSlots: contract.settlementSlots, verify: (s, m, k) => schnorr.verify(s, m, k),
  });
  const unpostable = !(contract.publicationRelays || []).length;

  const f = finality({
    signedBy: agreeing.map((a) => ({ resultId: a.run, nodePubkey: a.nodePubkey })),
    committee, contract, provisionalAtMs, publishedAtMs: published.ok && !unpostable ? published.atMs : null,
    now, objections, needed: seen.needed,
  });
  // A SUSPENDED RESULT IS DECIDED BY THE COMMITTEE'S RE-RUN (v4.6.2 §13A): once
  // the round's threshold of seats have re-run the contradicted result to one
  // outcome, that outcome is authoritative - FINAL, once its transcript is
  // posted (P2). Short of the threshold it stays SUSPENDED: what 13C does then
  // is timed from the result window, which the contract does not carry yet.
  if (f.state === SUSPENDED) {
    const verify = (s, m, k) => schnorr.verify(s, m, k);
    const rerun = rerunIsAgreed({
      roundId: roundIdBytes, playerPubkey: agreeing[0].playerPubkey, contradictedRunId: agreeing[0].run,
      records: round.reruns(roundIdBytes, entryIdBytes), seats: committee, slots: contract.gameVerifySlots, verify,
    });
    const said = { agreed: rerun.agreed || 0, needed: rerun.needed };
    if (rerun.ok) {
      const posted = transcriptIsPublished({
        roundId: roundIdBytes, playerPubkey: agreeing[0].playerPubkey, transcriptHash: rerun.result.transcriptHash,
        postings: round.postings(roundIdBytes, entryIdBytes), seats: committee,
        settlementSlots: contract.settlementSlots, verify,
      });
      if (posted.ok && !unpostable)
        return {
          state: FINAL, rerun: { ...said, runId: hex(rerun.runId) }, published: true, posted: posted.posted,
          why: `re-run by ${rerun.agreed} of ${committee.length} committee seats: the replay outcome is authoritative (13A)`,
          provisionalAtMs, runId: hex(rerun.runId), contradictedRunId: seen.runId, objection: objection && objection.why,
        };
      return { ...f, rerun: said, published: false, posted: posted.posted || 0,
        why: `${f.why}; the re-run agreed, and its transcript is not posted: ${unpostable ? 'the round names no relay' : posted.why}`,
        provisionalAtMs, runId: seen.runId, objection: objection && objection.why };
    }
    return { ...f, rerun: said, published: published.ok, posted: published.posted || 0,
      why: `${f.why}; re-run so far: ${rerun.why}`,
      provisionalAtMs, runId: seen.runId, objection: objection && objection.why };
  }

  const why = f.published === false
    ? `${unpostable ? 'the round contract names no publication relay, so no result of it can become final' : published.why}`
      + ': the objection window opens only when its transcript is posted'
    : f.why;
  return { ...f, why, published: published.ok, posted: published.posted || 0,
    provisionalAtMs, runId: seen.runId, objection: objection && objection.why };
}
