// WHEN A RESULT THIS NODE HOLDS MAY MOVE MONEY (M3.3-32; §13A, WINDOW-10-SPEC, RULED the owner 2026-10-01).
//
// A run the committee's threshold signed is PROVISIONALLY_FINAL. The objection window is exactly 600 s of wall time from
// the round's end as its contract fixes it (protocol window.js), the same instant on every node; a seat signs FINAL
// once its own clock reads close + 5 s, it holds the run PROVISIONALLY_FINAL, its transcript is posted and it holds no
// valid objection received in time; and the run is FINAL only when the round's threshold of seats (5 of 7, 2 of 2) have
// signed FINAL with times inside the 5 s tolerance of this seat's clock (protocol final-sig.js). No block decides any
// of it: blocks are where randomness comes from, not when a window ends.
//
// A VALID OBJECTION is what `objectionHolds` says it is: the committee's receipts, and a replay that contradicts the
// signed result (the replay a daemon holds is its OWN). It counts by when it reached THIS seat, on this seat's clock:
// before this seat's close + 5 s it suspends the run here - this seat never signs FINAL on it, and since FINAL needs the
// threshold, three seats that saw it in time block it. After that it suspends nothing: it is kept, flagged
// `lateObjection`, as evidence against the signers. Filing costs nothing, which is why a filing alone suspends nothing.
//
// A SUSPENDED RUN is decided by the committee's re-run, chained from the same close (RULED 2026-10-01): the re-run
// window is [end + 600 s, end + 1200 s); a re-run counts if it was signed after the objection was held here, arrived
// before this seat's end + 1205 s, and its signed time is within the tolerance. No threshold by then is §13C. With one,
// the re-run's own window is [end + 1200 s, end + 1800 s), FINAL is signed on the re-run after end + 1805 s, and a valid
// objection to the re-run received before that makes the entry VOID at once.
import { objectionHolds, FINAL, SUSPENDED, PROVISIONALLY_FINAL } from '../../protocol/src/objection.js';
import { rerunIsAgreed, runOf, decodeRerunResult, splitSignedRerun } from '../../protocol/src/rerun.js';
import { noQuorumOutcome, VOID } from '../../protocol/src/payout.js';
import { decodeRoundContract } from '../../protocol/src/contracts.js';
import { medianTimePast } from '../../protocol/src/beacon.js';
import { blockHashOf } from '../../protocol/src/chain.js';
import { splitSignedResult, decodePlayerResult, resultId } from '../../protocol/src/result.js';
import {
  splitSignedReceipt, decodeCheckpointReceipt, SIGNED_RECEIPT_BYTES,
} from '../../protocol/src/receipt.js';
import { windowsOf, withinTolerance, FINAL_TOLERANCE_MS } from '../../protocol/src/window.js';
import { finalSigned, signFinalSig } from '../../protocol/src/final-sig.js';
import { verifiedFinal, runId } from './verdict.js';
import { transcriptIsPublished } from '../../protocol/src/posting.js';
import { verifyKept } from './verify-kept.js';

const hex = (b) => [...b].map((v) => v.toString(16).padStart(2, '0')).join('');
const utc = (ms) => new Date(Number(ms)).toISOString();

/**
 * Where one run stands on this node, now: `state` is null (no threshold yet), PROVISIONALLY_FINAL, FINAL or SUSPENDED
 * (or §13C's VOID/FORFEIT), with `why`, `closesAtMs`, and - when this seat may sign FINAL now - `signable`
 * ({ runId, finalAfterMs }). `nextAtMs`: the next instant at which the clock alone changes the answer, if any.
 */
export function resultFinality(round, roundIdBytes, entryIdBytes, { now = round.now() } = {}) {
  const row = round.get(roundIdBytes);
  if (!row) return { state: null, why: 'no such round' };
  const contract = decodeRoundContract(new Uint8Array(row.contract));
  const committee = round.signerNodes(roundIdBytes);
  const held = round.results(roundIdBytes, entryIdBytes);
  const seen = verifiedFinal(held.map((r) => r.bytes), { contract, signerNodes: committee });
  let win = null;
  try { win = windowsOf(contract); } catch { win = null; }
  if (!seen.ok || !seen.final) {
    // §13C'S NO-QUORUM OUTCOME (M3.3-34), on this signer node's own record once the
    // result window passed with no result at the threshold: VOID - or FORFEIT,
    // proven equivocation. Only where no quorum is: §14, reachable only from
    // PROVISIONAL.
    const nq = typeof round.noQuorum === 'function' ? round.noQuorum(entryIdBytes) : null;
    if (nq) return { state: nq.outcome, why: nq.why, noQuorum: true };
    return { state: null, why: seen.why || 'not final', nextAtMs: win ? win.finalAfterMs : null };
  }
  if (!win) return { state: PROVISIONALLY_FINAL, runId: seen.runId, why: 'the round\'s end cannot be computed from its contract, so no window can open or close' };

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
    ok = verifyKept(signature, resultId(result), result.nodePubkey);
    if (!ok) continue;
    const run = runId(result);
    if (who === hex(round.pubkey)) mine = run;
    if (hex(run) === seen.runId)
      agreeing.push({ run, nodePubkey: result.nodePubkey, seenMs: r.seenMs,
        playerPubkey: result.playerPubkey, transcriptHash: result.transcriptHash });
  }
  const signedResultId = agreeing[0].run;
  const verify = (s, m, k) => verifyKept(s, m, k);
  const nowMs = BigInt(now);
  const base = { runId: seen.runId, signers: agreeing.length, provisionalAtMs: Number(win.openMs),
    windowOpenMs: win.openMs, windowCloseMs: win.closeMs, finalAfterMs: win.finalAfterMs };
  const finalSigs = (run, finalAfterMs) => finalSigned({
    roundId: roundIdBytes, entryId: entryIdBytes, runId: run, records: round.finalSigs(roundIdBytes, entryIdBytes, run),
    committee, slots: contract.settlementSlots, finalAfterMs, verify,
  });
  const postedFor = (transcriptHash) => transcriptIsPublished({
    roundId: roundIdBytes, playerPubkey: agreeing[0].playerPubkey, transcriptHash,
    postings: round.postings(roundIdBytes, entryIdBytes), signerNodes: committee,
    settlementSlots: contract.settlementSlots, verify,
  });
  const receiptsHeld = () => {
    const { bytes } = round.receipts(roundIdBytes, entryIdBytes);
    const out = [];
    for (let at = 0; at + SIGNED_RECEIPT_BYTES <= bytes.length; at += SIGNED_RECEIPT_BYTES) {
      try {
        out.push(decodeCheckpointReceipt(splitSignedReceipt(bytes.subarray(at, at + SIGNED_RECEIPT_BYTES)).body));
      } catch { /* a record that does not decode backs nothing */ }
    }
    return out;
  };

  // THE OBJECTION, BY WHEN IT REACHED THIS SEAT (its own clock), and valid as ever: the committee's receipts, and this
  // node's replay differing.
  const filedAt = typeof round.objectedAt === 'function' ? round.objectedAt(roundIdBytes, entryIdBytes) : null;
  let objection = null;
  if (filedAt !== null && filedAt !== undefined)
    objection = objectionHolds({
      objection: { roundId: roundIdBytes, signedResultId, atMs: 0n },
      receipts: receiptsHeld(), committee, roundId: roundIdBytes, signedResultId,
      replayDiffers: mine !== null && hex(mine) !== seen.runId,
    });
  const inTime = objection && objection.holds && BigInt(filedAt) < win.finalAfterMs;
  const lateObjection = !!(objection && objection.holds && !inTime);

  if (!inTime) {
    const common = { ...base, closesAtMs: win.closeMs, objection: objection && objection.why, lateObjection,
      ...(lateObjection ? { lateObjectionAtMs: filedAt } : {}) };
    const fin = finalSigs(signedResultId, win.finalAfterMs);
    const said = { signed: fin.signed, needed: fin.needed };
    if (fin.ok)
      return { ...common, state: FINAL, published: true, finalSigs: said,
        why: `signed FINAL by ${fin.signed} of ${committee.length} seats after the objection window closed at ${utc(win.closeMs)} with no valid objection in time` };
    const published = postedFor(agreeing[0].transcriptHash);
    if (!(contract.publicationRelays || []).length)
      return { ...common, state: PROVISIONALLY_FINAL, published: false, posted: 0, finalSigs: said,
        why: 'the round contract names no publication relay, so no result of it can become final: a seat signs FINAL only once its transcript is posted' };
    if (nowMs < win.finalAfterMs)
      return { ...common, state: PROVISIONALLY_FINAL, published: published.ok, posted: published.posted || 0, finalSigs: said, nextAtMs: win.finalAfterMs,
        why: `the objection window closes at ${utc(win.closeMs)} (the round's end + 600 s); FINAL is signed from ${utc(win.finalAfterMs)}` };
    if (!published.ok)
      return { ...common, state: PROVISIONALLY_FINAL, published: false, posted: published.posted || 0, finalSigs: said,
        why: `${published.why}: a seat signs FINAL only once the transcript is posted` };
    return { ...common, state: PROVISIONALLY_FINAL, published: true, posted: published.posted, finalSigs: said,
      signable: { runId: signedResultId, finalAfterMs: win.finalAfterMs },
      why: `the objection window closed at ${utc(win.closeMs)} with no valid objection in time; ${fin.why}` };
  }

  // A SUSPENDED RESULT IS DECIDED BY THE COMMITTEE'S RE-RUN (§13A), INSIDE THE RE-RUN WINDOW chained from the first
  // window's close: [end + 600 s, end + 1200 s). A re-run counts if signed after the objection was held here (less the
  // tolerance), arrived before this seat's end + 1205 s, and signed within the tolerance of this seat's clock at arrival.
  // No threshold by end + 1205 s is §13C's rule - FORFEIT if the player's equivocation is proven (§13B), VOID otherwise.
  const filedAtMs = Number(filedAt);
  const records = round.reruns(roundIdBytes, entryIdBytes).map((r) => {
    let x = null;
    try { x = decodeRerunResult(splitSignedRerun(r.bytes).body); } catch { x = null; }
    const counts = !!x && x.signedAtMs + FINAL_TOLERANCE_MS >= BigInt(filedAt) && withinTolerance(x.signedAtMs, r.seenMs)
      && BigInt(r.seenMs) < win.rerunDeadlineMs;
    return { ...r, counts };
  });
  const inside = records.filter((r) => r.counts);
  const agreedOn = (recs) => rerunIsAgreed({
    roundId: roundIdBytes, playerPubkey: agreeing[0].playerPubkey, contradictedRunId: agreeing[0].run,
    records: recs, signerNodes: committee, slots: contract.gameVerifySlots, verify,
  });
  const rerun = agreedOn(inside);
  const said = { agreed: rerun.agreed || 0, needed: rerun.needed };
  const common = { ...base, objection: objection && objection.why, filedAtMs, rerunWindowOpenMs: win.rerunOpenMs, rerunWindowCloseMs: win.rerunCloseMs };
  const suspended = { ...common, state: SUSPENDED, rerun: said, closesAtMs: win.rerunCloseMs };
  if (!rerun.ok) {
    // DECIDED ONCE (§13C): a §13C outcome this seat already wrote for the entry stands - evidence that reaches it later
    // does not turn a VOID into a FORFEIT.
    const had = typeof round.noQuorum === 'function' ? round.noQuorum(entryIdBytes) : null;
    if (had && nowMs >= win.rerunDeadlineMs)
      return { ...common, state: had.outcome, noQuorum: true, rerun: said, rerunWindowClosedAtMs: Number(win.rerunCloseMs), why: had.why };
    if (nowMs < win.rerunDeadlineMs)
      return { ...suspended, nextAtMs: win.rerunDeadlineMs,
        why: `a valid objection reached this seat at ${utc(filedAt)}, before ${utc(win.finalAfterMs)}: finality is suspended and the committee re-runs the canonical transcript until the re-run window closes at ${utc(win.rerunCloseMs)}; re-run so far: ${rerun.why}` };
    // §13C'S EVIDENCE: every pair this seat holds by the time it decides.
    const proven = typeof round.provenTwoFirstMarks === 'function'
      && round.provenTwoFirstMarks(roundIdBytes, entryIdBytes, evidenceWindow(round, roundIdBytes, contract, win.rerunDeadlineMs)) === true;
    const d = noQuorumOutcome({ signatures: rerun.agreed || 0, needed: rerun.needed || seen.needed, equivocationProven: proven, state: SUSPENDED });
    if (d.outcome) {
      const why = `${d.why} - the re-run window closed at ${utc(win.rerunCloseMs)} with ${rerun.agreed || 0} of `
        + `${rerun.needed || seen.needed} re-runs on one outcome (§13A, §13C)`;
      return { ...common, state: d.outcome, noQuorum: true, rerun: said, rerunWindowClosedAtMs: Number(win.rerunCloseMs), why };
    }
    return { ...suspended, why: `the re-run window closed: ${d.why}` };
  }

  // THE RE-RUN'S OWN OBJECTION WINDOW (§13A): [end + 1200 s, end + 1800 s), FINAL on the re-run from end + 1805 s.
  const bySeen = [...inside].sort((a, b) => a.seenMs - b.seenMs);
  let agreedAtMs = bySeen.length ? bySeen[bySeen.length - 1].seenMs : null;
  for (let k = 1; k <= bySeen.length; k++) if (agreedOn(bySeen.slice(0, k)).ok) { agreedAtMs = bySeen[k - 1].seenMs; break; }
  const agreedCommon = { ...common, rerun: { ...said, runId: hex(rerun.runId) }, agreedAtMs, closesAtMs: win.ownCloseMs,
    ownWindowOpenMs: win.ownOpenMs, ownWindowCloseMs: win.ownCloseMs, finalAfterMs: win.ownFinalAfterMs,
    runId: hex(rerun.runId), contradictedRunId: seen.runId };

  // A SECOND VALID OBJECTION, RECEIVED HERE BEFORE end + 1805 s, VOIDS THE ENTRY AT ONCE (§13A, slice C2b).
  const secondAt = typeof round.rerunObjectedAt === 'function' ? round.rerunObjectedAt(roundIdBytes, entryIdBytes) : null;
  let lateSecond = false;
  if (secondAt !== null && secondAt !== undefined) {
    const mineRec = round.reruns(roundIdBytes, entryIdBytes).find((r) => hex(r.signerNodePubkey) === hex(round.pubkey));
    let ownRun = null;
    try { ownRun = mineRec ? runOf(decodeRerunResult(splitSignedRerun(mineRec.bytes).body).result) : null; } catch { ownRun = null; }
    const second = objectionHolds({
      objection: { roundId: roundIdBytes, signedResultId: rerun.runId, atMs: 0n },
      receipts: receiptsHeld(), committee, roundId: roundIdBytes, signedResultId: rerun.runId,
      replayDiffers: ownRun !== null && hex(ownRun) !== hex(rerun.runId),
    });
    if (second.holds && BigInt(secondAt) < win.ownFinalAfterMs)
      return { ...agreedCommon, state: VOID, secondObjection: true, objection: second.why,
        why: `a second valid objection, received here at ${utc(secondAt)} before ${utc(win.ownFinalAfterMs)}, contradicts the agreed re-run too: `
          + 'two contradicted quorums in one entry - VOID, no third run (13A)' };
    lateSecond = second.holds;
  }
  const fin = finalSigs(rerun.runId, win.ownFinalAfterMs);
  const finSaid = { signed: fin.signed, needed: fin.needed };
  if (fin.ok)
    return { ...agreedCommon, state: FINAL, published: true, finalSigs: finSaid, lateObjection: lateSecond,
      why: `re-run by ${rerun.agreed} of ${committee.length} committee signer nodes, signed FINAL by ${fin.signed} seats after its own window closed at ${utc(win.ownCloseMs)}: the replay outcome is authoritative (13A)` };
  if (nowMs < win.ownFinalAfterMs)
    return { ...agreedCommon, state: PROVISIONALLY_FINAL, finalSigs: finSaid, nextAtMs: win.ownFinalAfterMs,
      why: `re-run by ${rerun.agreed} of ${committee.length} committee signer nodes: its own objection window closes at ${utc(win.ownCloseMs)}; FINAL is signed from ${utc(win.ownFinalAfterMs)} (13A)` };
  const posted = postedFor(rerun.result.transcriptHash);
  if (!posted.ok)
    return { ...agreedCommon, state: SUSPENDED, published: false, posted: posted.posted || 0, finalSigs: finSaid,
      why: `the re-run agreed, and its transcript is not posted: ${posted.why}` };
  return { ...agreedCommon, state: PROVISIONALLY_FINAL, published: true, posted: posted.posted, finalSigs: finSaid, lateObjection: lateSecond,
    signable: { runId: rerun.runId, finalAfterMs: win.ownFinalAfterMs },
    why: `re-run agreed; its own window closed at ${utc(win.ownCloseMs)} with no valid objection in time; ${fin.why}` };
}

/**
 * THIS SEAT'S FINAL SIGNATURE ON A RUN, NOW, or null when it would not sign: only a run `resultFinality` calls
 * `signable` (its window's close + 5 s passed on this seat's clock, the transcript posted, no valid objection received
 * in time) or already FINAL here. Signed fresh, at this seat's clock, every time it is asked - a signature counts only
 * within 5 s of the receiver's clock, so an old one is worth nothing. `sign(digest)` signs with this seat's key.
 */
export function finalSignatureNow(round, roundIdBytes, entryIdBytes, sign, { now = round.now() } = {}) {
  const f = resultFinality(round, roundIdBytes, entryIdBytes, { now });
  let run = null;
  if (f.signable) run = f.signable.runId;
  else if (f.state === FINAL && f.runId) run = typeof f.runId === 'string' ? Uint8Array.from(Buffer.from(f.runId, 'hex')) : f.runId;
  if (!run) return null;
  return signFinalSig({ roundId: roundIdBytes, entryId: entryIdBytes, runId: run, signerPubkey: round.pubkey, signedAtMs: BigInt(now) }, sign);
}

// THE CHAIN AS THIS NODE HOLDS IT, indexed once per view: a block's height by its hash, and its median time past (ms).
const indexOfView = new WeakMap();
export function chainIndex(round, roundIdBytes, contract) {
  if (typeof round.chainView !== 'function') return { ok: false, why: 'this signer node reads no chain' };
  let view = null;
  try { view = round.chainView(roundIdBytes, contract); } catch { view = null; }
  if (!view || view.pending || !Array.isArray(view.blocks) || !view.blocks.length)
    return { ok: false, why: 'this signer node has no chain view for that round yet' };
  let idx = indexOfView.get(view);
  if (!idx || idx.n !== view.blocks.length) {
    const headers = view.blocks.map((b) => b.header);
    const byHash = new Map();
    headers.forEach((h, i) => byHash.set(hex(blockHashOf(h)), view.firstHeight + i));
    const mtps = new Map();
    const mtpAt = (h) => {
      if (!mtps.has(h)) { const m = medianTimePast(headers, view.firstHeight, h); mtps.set(h, m === null ? null : m * 1000); }
      return mtps.get(h);
    };
    idx = { n: view.blocks.length, tip: view.firstHeight + headers.length - 1, firstHeight: view.firstHeight, mtpAt, headers,
      heightOf: (hash) => (hash ? byHash.get(hex(hash)) ?? null : null),
      tipHash: () => blockHashOf(headers[headers.length - 1]) };
    idx.orderOf = (hash) => { const h = idx.heightOf(hash); return h === null ? Infinity : h; };
    indexOfView.set(view, idx);
  }
  return { ok: true, ...idx };
}

/**
 * §13C'S RESULT WINDOW ON THE WALL CLOCK (§13A, WINDOW-10-SPEC, RULED the owner 2026-10-01): "A result reaches
 * PROVISIONALLY_FINAL inside the window ... one that has not by window_close falls to §13C's no-quorum rule." The same
 * window as the objection window - the round's end to + 600 s - and this seat decides once its own clock reads the
 * close + 5 s, as it would sign FINAL. `window`: the evidence this seat holds by then (evidenceWindow), or null.
 */
export function resultWindow(round, roundIdBytes, contract) {
  let win;
  try { win = windowsOf(contract); } catch (e) { return { ok: false, why: e.message }; }
  const nowMs = BigInt(round.now());
  if (nowMs < win.finalAfterMs)
    return { ok: false, closesAtMs: win.closeMs, why: `the result window closes at ${utc(win.closeMs)} (the round's end + 600 s); nothing is decided before ${utc(win.finalAfterMs)}` };
  return { ok: true, openMs: win.openMs, closesAtMs: win.closeMs, window: evidenceWindow(round, roundIdBytes, contract, win.finalAfterMs) };
}

/**
 * THE EVIDENCE OF A WINDOW (§13C, WINDOW-10-SPEC): every record of a mark made before `untilMs` - the window's close + 5 s,
 * the instant a seat decides it - this seat's own by when it made it, a peer's by when that peer made it; whatever block
 * it names. A mark recorded later is a late mark, and counts in no decision; and the decision is written once
 * (no_quorum), so nothing that arrives after it changes it. (Round.markCounts reads `end.untilMs`.)
 */
export function evidenceWindow(round, roundIdBytes, contract, untilMs) {
  return { chain: null, end: { untilMs: BigInt(untilMs) } };
}
