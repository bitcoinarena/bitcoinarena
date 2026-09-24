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
import { objectionHolds, FINAL, SUSPENDED, PROVISIONALLY_FINAL } from '../../protocol/src/objection.js';
import { rerunIsAgreed, runOf, decodeRerunResult, splitSignedRerun } from '../../protocol/src/rerun.js';
import { noQuorumOutcome, VOID } from '../../protocol/src/payout.js';
import { decodeRoundContract } from '../../protocol/src/contracts.js';
import { medianTimePast, beaconFromChain } from '../../protocol/src/beacon.js';
import { roundEndMs } from '../../protocol/src/first-mark.js';
import { blockHashOf } from '../../protocol/src/chain.js';
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
  const signedResultId = agreeing[0].run;
  const W = Number(contract.objectionWindowMs);
  const verify = (s, m, k) => schnorr.verify(s, m, k);
  const base = { runId: seen.runId, signers: agreeing.length };

  // THE WINDOWS ARE BLOCKS AT BOTH ENDS (§13A, RULED the owner 2026-09-24): each opens at the block its opening filing names
  // and ends at the first later block whose median time past is at or after open + objection_window_ms; a filing is
  // inside only if the block it names is in this chain, at or after the open, and strictly before the end block. No
  // receive time and no clock decides a window - this node's chain does, and a node without the block it needs decides
  // nothing: no FINAL, VOID, slash or claim. Two holders with the same blocks through the end block answer alike.
  const chain = chainIndex(round, roundIdBytes, contract);
  if (!chain.ok) return { ...base, state: PROVISIONALLY_FINAL, blockPending: true, why: `no window of this run can open or end: ${chain.why}` };

  // THE FIRST WINDOW OPENS AT THE POSTING THAT COMPLETES THE THRESHOLD (v4.6.2 §13A, P2; RULED 2026-09-24): the joint
  // moment - the transcript posted and the signed results' threshold held - is the block the posting records name, the
  // threshold's one by the chain's own order. No threshold of postings, no open.
  const published = transcriptIsPublished({
    roundId: roundIdBytes, playerPubkey: agreeing[0].playerPubkey, transcriptHash: agreeing[0].transcriptHash,
    postings: round.postings(roundIdBytes, entryIdBytes), signerNodes: committee,
    settlementSlots: contract.settlementSlots, verify,
  });
  const unpostable = !(contract.publicationRelays || []).length;
  if (unpostable)
    return { ...base, state: PROVISIONALLY_FINAL, published: false, posted: 0,
      why: 'the round contract names no publication relay, so no result of it can become final: the objection window opens only when its transcript is posted' };
  if (!published.ok)
    return { ...base, state: PROVISIONALLY_FINAL, published: false, posted: published.posted || 0,
      why: `${published.why}: the objection window opens only when its transcript is posted` };
  const first = openAt(chain, published.blocks, published.needed, W);
  if (!first.ok)
    return { ...base, state: PROVISIONALLY_FINAL, published: true, posted: published.posted, blockPending: true, why: first.why };
  const windows = { first: first.window };
  const provisionalAtMs = first.window.open.mtp;
  const closesAtMs = BigInt(first.window.end ? first.window.end.mtp : provisionalAtMs + W);

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

  // THE OBJECTION, BY THE BLOCK IT NAMES, and valid as ever: the committee's receipts, and this node's replay differing.
  const filedBlock = typeof round.objectedBlock === 'function' ? round.objectedBlock(roundIdBytes, entryIdBytes) : null;
  let objection = null;
  let where = null;
  if (filedBlock) {
    objection = objectionHolds({
      objection: { roundId: roundIdBytes, signedResultId, atMs: 0n },
      receipts: receiptsHeld(), committee, roundId: roundIdBytes, signedResultId,
      replayDiffers: mine !== null && hex(mine) !== seen.runId,
    });
    where = place(chain, first.window, filedBlock, W);
  }
  const common = { ...base, published: true, posted: published.posted, provisionalAtMs, closesAtMs, windows, objection: objection && objection.why };
  if (objection && objection.holds && where === 'pending')
    return { ...common, state: PROVISIONALLY_FINAL, blockPending: true,
      why: `an objection names block ${hex(filedBlock).slice(0, 16)}, which this node cannot place in the window yet: it decides nothing` };
  if (!(objection && objection.holds && where === 'inside')) {
    if (!first.window.end)
      return { ...common, state: PROVISIONALLY_FINAL, blockPending: true,
        why: `the objection window opened at block ${first.window.open.height} (${first.window.open.mtp}) and its end block - the first at or after ${first.window.open.mtp + W} - is not in this chain yet` };
    return { ...common, state: FINAL,
      why: `the objection window [${first.window.open.height}, ${first.window.end.height}) closed with no valid objection inside it` };
  }

  // A SUSPENDED RESULT IS DECIDED BY THE COMMITTEE'S RE-RUN (v4.6.2 §13A), INSIDE THE RE-RUN WINDOW: one window from the
  // objection's own block. A re-run counts by the block it names. No threshold by the window's end block is §13C's rule -
  // FORFEIT if the player's equivocation is proven (§13B), VOID otherwise; before that block, nothing is decided.
  const filedHeight = chain.heightOf(filedBlock);
  const rerunWindow = { open: { height: filedHeight, mtp: chain.mtpAt(filedHeight) } };
  rerunWindow.end = windowEnd(chain, rerunWindow.open, W);
  windows.rerun = rerunWindow;
  const filedAtMs = rerunWindow.open.mtp;
  const records = round.reruns(roundIdBytes, entryIdBytes).map((r) => {
    let x = null;
    try { x = decodeRerunResult(splitSignedRerun(r.bytes).body); } catch { x = null; }
    return { ...r, block: x ? x.blockHash : null, where: x ? place(chain, rerunWindow, x.blockHash, W) : 'outside' };
  });
  const inside = records.filter((r) => r.where === 'inside');
  const agreedOn = (recs) => rerunIsAgreed({
    roundId: roundIdBytes, playerPubkey: agreeing[0].playerPubkey, contradictedRunId: agreeing[0].run,
    records: recs, signerNodes: committee, slots: contract.gameVerifySlots, verify,
  });
  const rerun = agreedOn(inside);
  const said = { agreed: rerun.agreed || 0, needed: rerun.needed };
  const suspended = { ...common, state: SUSPENDED, rerun: said, filedAtMs, closesAtMs };
  if (!rerun.ok) {
    if (!rerunWindow.end)
      return { ...suspended, blockPending: true,
        why: `a valid objection suspends finality: the committee re-runs the canonical transcript, and 13C applies only if that re-run cannot reach five of seven; re-run so far: ${rerun.why}; the re-run window's end block - the first at or after ${filedAtMs + W} - is not in this chain yet` };
    const proven = typeof round.provenTwoFirstMarks === 'function' && round.provenTwoFirstMarks(roundIdBytes, entryIdBytes) === true;
    const d = noQuorumOutcome({ signatures: rerun.agreed || 0, needed: rerun.needed || seen.needed, equivocationProven: proven, state: SUSPENDED });
    if (d.outcome)
      return { ...base, state: d.outcome, noQuorum: true, rerun: said, filedAtMs, windows, provisionalAtMs,
        rerunWindowClosedAtMs: rerunWindow.end.mtp, objection: objection && objection.why,
        why: `${d.why} - the re-run window [${rerunWindow.open.height}, ${rerunWindow.end.height}) closed with ${rerun.agreed || 0} of `
          + `${rerun.needed || seen.needed} re-runs on one outcome (§13A, §13C)` };
    return { ...suspended, why: `the re-run window closed: ${d.why}` };
  }

  // THE RE-RUN'S OWN OBJECTION WINDOW (§13A): it opens at the block where the agreed re-run first sits at threshold - by
  // the chain's order of the blocks its records name - and ends as every window does.
  const byChain = [...inside].sort((a, b) => chain.orderOf(a.block) - chain.orderOf(b.block));
  let openRec = byChain[byChain.length - 1];
  for (let k = 1; k <= byChain.length; k++) if (agreedOn(byChain.slice(0, k)).ok) { openRec = byChain[k - 1]; break; }
  const ownHeight = chain.heightOf(openRec.block);
  const own = { open: { height: ownHeight, mtp: chain.mtpAt(ownHeight) } };
  own.end = windowEnd(chain, own.open, W);
  windows.own = own;
  const agreedAtMs = own.open.mtp;
  const agreedCommon = { ...base, rerun: { ...said, runId: hex(rerun.runId) }, provisionalAtMs, filedAtMs, agreedAtMs, windows,
    runId: hex(rerun.runId), contradictedRunId: seen.runId, objection: objection && objection.why };

  // A SECOND VALID OBJECTION INSIDE THAT WINDOW VOIDS THE ENTRY AT ONCE (§13A, slice C2b): by the block it names.
  const secondBlock = typeof round.rerunObjectedBlock === 'function' ? round.rerunObjectedBlock(roundIdBytes, entryIdBytes) : null;
  if (secondBlock) {
    const mineRec = round.reruns(roundIdBytes, entryIdBytes).find((r) => hex(r.signerNodePubkey) === hex(round.pubkey));
    let ownRun = null;
    try { ownRun = mineRec ? runOf(decodeRerunResult(splitSignedRerun(mineRec.bytes).body).result) : null; } catch { ownRun = null; }
    const second = objectionHolds({
      objection: { roundId: roundIdBytes, signedResultId: rerun.runId, atMs: 0n },
      receipts: receiptsHeld(), committee, roundId: roundIdBytes, signedResultId: rerun.runId,
      replayDiffers: ownRun !== null && hex(ownRun) !== hex(rerun.runId),
    });
    const at2 = place(chain, own, secondBlock, W);
    if (second.holds && at2 === 'pending')
      return { ...agreedCommon, state: PROVISIONALLY_FINAL, blockPending: true, closesAtMs: BigInt(agreedAtMs + W),
        why: `a second objection names block ${hex(secondBlock).slice(0, 16)}, which this node cannot place in the re-run's window yet: it decides nothing` };
    if (second.holds && at2 === 'inside')
      return { ...agreedCommon, state: VOID, secondObjection: true, objection: second.why,
        why: `a second valid objection, in block ${chain.heightOf(secondBlock)} inside the agreed re-run's own objection window `
          + `[${own.open.height}, ${own.end ? own.end.height : '...'}), contradicts the re-run too: two contradicted quorums in one entry - VOID, no third run (13A)` };
  }
  if (!own.end)
    return { ...agreedCommon, state: PROVISIONALLY_FINAL, closesAtMs: BigInt(agreedAtMs + W), blockPending: true,
      why: `re-run by ${rerun.agreed} of ${committee.length} committee signer nodes at block ${own.open.height} (${agreedAtMs}): its own `
        + `objection window's end block - the first at or after ${agreedAtMs + W} - is not in this chain yet (13A)` };
  const posted = transcriptIsPublished({
    roundId: roundIdBytes, playerPubkey: agreeing[0].playerPubkey, transcriptHash: rerun.result.transcriptHash,
    postings: round.postings(roundIdBytes, entryIdBytes), signerNodes: committee,
    settlementSlots: contract.settlementSlots, verify,
  });
  if (posted.ok)
    return { ...agreedCommon, state: FINAL, published: true, posted: posted.posted, closesAtMs: BigInt(own.end.mtp),
      why: `re-run by ${rerun.agreed} of ${committee.length} committee signer nodes: the replay outcome is authoritative (13A)` };
  return { ...agreedCommon, state: SUSPENDED, published: false, posted: posted.posted || 0,
    why: `the re-run agreed, and its transcript is not posted: ${posted.why}` };
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

/** The end of a window opened at `open`: the first later block whose median time past is at or after open + W, or null. */
export function windowEnd(chain, open, W) {
  if (open.mtp === null) return null;
  for (let h = open.height + 1; h <= chain.tip; h++) {
    const m = chain.mtpAt(h);
    if (m !== null && m >= open.mtp + W) return { height: h, mtp: m };
  }
  return null;
}

/**
 * WHERE A FILING'S BLOCK FALLS IN A WINDOW (RULED 2026-09-24): 'inside' if it is in this chain, its median time past at or
 * after the open and it is before the end block; 'outside' if it is the end block or later, before the open, or - once the
 * end block is here - not in this chain at all; 'pending' while the end block is not here and the named block is not
 * either. A block present before any end block exists is inside: the end, when it comes, is later.
 */
export function place(chain, win, hash, W) {
  const h = chain.heightOf(hash);
  if (h === null) return win.end ? 'outside' : 'pending';
  if (win.end && h >= win.end.height) return 'outside';
  const m = chain.mtpAt(h);
  if (m === null || m < win.open.mtp) return 'outside';
  if (win.end) return 'inside';
  return m < win.open.mtp + W ? 'inside' : 'pending';
}

/** The first window's open: the block of the posting that completes the threshold, by the chain's order, and its end. */
function openAt(chain, blocks, needed, W) {
  const heights = (blocks || []).map((b) => chain.heightOf(b));
  if (heights.some((h) => h === null))
    return { ok: false, why: 'a posting names a block this node does not hold yet, so the objection window\'s open is not decided here: it decides nothing' };
  const sorted = [...heights].sort((a, b) => a - b);
  const h = sorted[needed - 1];
  const open = { height: h, mtp: chain.mtpAt(h) };
  if (open.mtp === null) return { ok: false, why: 'the posting\'s block has no median time past in this node\'s view' };
  return { ok: true, window: { open, end: windowEnd(chain, open, W) } };
}

/**
 * §13C'S RESULT WINDOW ON THE CHAIN (RULED the owner 2026-09-24): it opens at the first block at or after the round's contract
 * end - protocol `roundEndMs`: entry close, two start deadlines and the run length, the instant every run on the contract
 * has ended, the same at every holder and not this node's close - asked of the chain exactly as the beacon block is
 * (`beaconFromChain`), and it ends at the first later block whose median time past is at or after open + W, as every §13A
 * window does. `ok: true` only once this node holds that end block: a node without it decides no §13C outcome, and a
 * holder that closed earlier or later does not move either end.
 */
export function resultWindow(round, roundIdBytes, contract) {
  const chain = chainIndex(round, roundIdBytes, contract);
  if (!chain.ok) return { ok: false, why: `the result window cannot open or end: ${chain.why}` };
  let endOfRound;
  try { endOfRound = roundEndMs(contract); } catch (e) { return { ok: false, why: e.message }; }
  const picked = beaconFromChain({ committeeTimeMs: endOfRound - 1n, censusConfirmations: contract.censusConfirmations },
    { headers: chain.headers, firstHeight: chain.firstHeight });
  if (!picked.ok) return { ok: false, why: `the result window has not opened in this node's chain (the first block at or after the round's end ${endOfRound}): ${picked.why}` };
  const open = { height: picked.height, mtp: Number(picked.timeMs) };
  const W = Number(contract.objectionWindowMs);
  const end = windowEnd(chain, open, W);
  if (!end) return { ok: false, open, why: `the result window opened at block ${open.height} (${open.mtp}) and its end block - the first at or after ${open.mtp + W} - is not in this node's chain yet` };
  return { ok: true, open, end };
}
