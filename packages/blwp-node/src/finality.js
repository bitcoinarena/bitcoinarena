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
// open it again, and no message can open it earlier. Two signer nodes see the
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
import { finality, objectionHolds, FINAL, SUSPENDED, PROVISIONALLY_FINAL } from '../../protocol/src/objection.js';
import { rerunIsAgreed } from '../../protocol/src/rerun.js';
import { noQuorumOutcome } from '../../protocol/src/payout.js';
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
  const committee = round.signerNodes(roundIdBytes);
  const held = round.results(roundIdBytes, entryIdBytes);
  const seen = verifiedFinal(held.map((r) => r.bytes), { contract, signerNodes: committee });
  if (!seen.ok || !seen.final) {
    // §13C'S NO-QUORUM OUTCOME (M3.3-34), on this signer node's own record once the
    // result window passed with no result at the threshold: VOID - or FORFEIT,
    // proven equivocation. Only where no quorum is: §14, reachable only from
    // PROVISIONAL.
    const nq = typeof round.noQuorum === 'function' ? round.noQuorum(entryIdBytes) : null;
    if (nq) return { state: nq.outcome, why: nq.why, noQuorum: true };
    return { state: null, why: seen.why || 'not final' };
  }

  // WHO SIGNED THE AGREED RUN, and when this node held each of them. The
  // same checks `verifiedFinal` counted under: a signer node, and a signature that
  // verifies. The store keeps one record per signer node.
  const signerNodes = new Set(committee.map(hex));
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
    if (!signerNodes.has(who)) continue;
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
  // round's threshold of settlement signer nodes. Until then the window has not
  // opened and nothing moves; W counts from when that threshold was held here.
  const published = transcriptIsPublished({
    roundId: roundIdBytes, playerPubkey: agreeing[0].playerPubkey, transcriptHash: agreeing[0].transcriptHash,
    postings: round.postings(roundIdBytes, entryIdBytes), signerNodes: committee,
    settlementSlots: contract.settlementSlots, verify: (s, m, k) => schnorr.verify(s, m, k),
  });
  const unpostable = !(contract.publicationRelays || []).length;

  const f = finality({
    signedBy: agreeing.map((a) => ({ resultId: a.run, nodePubkey: a.nodePubkey })),
    committee, contract, provisionalAtMs, publishedAtMs: published.ok && !unpostable ? published.atMs : null,
    now, objections, needed: seen.needed,
  });
  // A SUSPENDED RESULT IS DECIDED BY THE COMMITTEE'S RE-RUN (v4.6.2 §13A): once
  // the round's threshold of signer nodes have re-run the contradicted result to one
  // outcome, that outcome is authoritative - FINAL, once its transcript is
  // posted (P2).
  //
  // AND ONLY INSIDE THE RE-RUN WINDOW (§13A, RULED the owner 2026-09-24): the valid objection opens a re-run
  // window of one result window - the contract's objection_window_ms, the same field - counted from when the
  // objection was filed. A re-run this node took after that counts for nothing, so the answer at the window's
  // end is the answer from then on. No threshold by then is §13C's no-quorum rule, as at the end of an ordinary
  // result window: FORFEIT if the player's equivocation is proven (§13B), VOID otherwise - never a SUSPENDED
  // that outlives its window. (Filed is this node's seen_ms, not a block timestamp: a gap flagged, not fixed.)
  if (f.state === SUSPENDED) {
    const verify = (s, m, k) => schnorr.verify(s, m, k);
    const rerunEndsAtMs = filedMs + Number(contract.objectionWindowMs);
    const inWindow = round.reruns(roundIdBytes, entryIdBytes).filter((r) => r.seenMs < rerunEndsAtMs);
    const agreedOn = (records) => rerunIsAgreed({
      roundId: roundIdBytes, playerPubkey: agreeing[0].playerPubkey, contradictedRunId: agreeing[0].run,
      records, signerNodes: committee, slots: contract.gameVerifySlots, verify,
    });
    const rerun = agreedOn(inWindow);
    if (!rerun.ok && Number(now) >= rerunEndsAtMs) {
      const proven = typeof round.provenTwoFirstMarks === 'function' && round.provenTwoFirstMarks(roundIdBytes, entryIdBytes) === true;
      const d = noQuorumOutcome({ signatures: rerun.agreed || 0, needed: rerun.needed || seen.needed,
        equivocationProven: proven, state: SUSPENDED });
      if (d.outcome)
        return {
          state: d.outcome, noQuorum: true, rerunWindowClosedAtMs: rerunEndsAtMs,
          rerun: { agreed: rerun.agreed || 0, needed: rerun.needed },
          why: `${d.why} - the re-run window closed at ${rerunEndsAtMs} (the objection filed at ${filedMs} plus `
            + `objection_window_ms ${contract.objectionWindowMs}) with ${rerun.agreed || 0} of ${rerun.needed || seen.needed} `
            + 're-runs on one outcome (§13A, §13C)',
          provisionalAtMs, runId: seen.runId, objection: objection && objection.why,
        };
    }
    const said = { agreed: rerun.agreed || 0, needed: rerun.needed };
    if (rerun.ok) {
      // THE RE-RUN'S OWN OBJECTION WINDOW (§13A, RULED the owner 2026-09-24, slice C2a): a re-run at the threshold is
      // provisionally final and gets one objection window of its own, opened when this node held it at threshold -
      // the seenMs of the record that first made the count - and objection_window_ms long. That start is inside the
      // re-run window, so it closes before filed + 2W and before P + 3W. FINAL after it, and only once posted (P2),
      // as before; a transcript still unposted at the close stays not-FINAL (an open edge, not a rule).
      const bySeen = [...inWindow].sort((x, y) => x.seenMs - y.seenMs);
      let agreedAtMs = bySeen[bySeen.length - 1].seenMs;
      for (let k = 1; k <= bySeen.length; k++)
        if (agreedOn(bySeen.slice(0, k)).ok) { agreedAtMs = bySeen[k - 1].seenMs; break; }
      const rerunClosesAtMs = agreedAtMs + Number(contract.objectionWindowMs);
      if (Number(now) < rerunClosesAtMs)
        return {
          state: PROVISIONALLY_FINAL, rerun: { ...said, runId: hex(rerun.runId) }, closesAtMs: BigInt(rerunClosesAtMs),
          why: `re-run by ${rerun.agreed} of ${committee.length} committee signer nodes at ${agreedAtMs}: its own objection `
            + `window closes at ${rerunClosesAtMs} and it is ${now} (13A)`,
          provisionalAtMs, runId: hex(rerun.runId), contradictedRunId: seen.runId, objection: objection && objection.why,
        };
      const posted = transcriptIsPublished({
        roundId: roundIdBytes, playerPubkey: agreeing[0].playerPubkey, transcriptHash: rerun.result.transcriptHash,
        postings: round.postings(roundIdBytes, entryIdBytes), signerNodes: committee,
        settlementSlots: contract.settlementSlots, verify,
      });
      if (posted.ok && !unpostable)
        return {
          state: FINAL, rerun: { ...said, runId: hex(rerun.runId) }, published: true, posted: posted.posted,
          why: `re-run by ${rerun.agreed} of ${committee.length} committee signer nodes: the replay outcome is authoritative (13A)`,
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
