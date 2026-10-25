// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHERE ONE ENTRY'S MONEY STANDS, FOR THE PLAYER'S PENDING LINE (WINDOW-10-SPEC, 2026-10-01, §24): "The winnings,
// or the stake coming back, show as pending the moment the player's result is PROVISIONALLY_FINAL - not when the
// objection window closes and not when the payout table is final - with the amount and what they wait on: the window's
// close in UTC ... While other players' results are still arriving the amount is the payout table computed over the
// results signed so far, and it updates as they arrive; it is marked as such. If the payment becomes invalid - a valid
// objection, a re-run, VOID, FORFEIT - the pending line disappears."
//
// Read-only: each entry's finality as this signer node holds it, the payout table over the entries whose results are
// signed so far (computePayoutTable - the same arithmetic the settlement pays by), and this entry's row. Nothing here
// signs, settles or moves money.
import { stateOf } from './settlement-state.js';
import { computePayoutTable, netStakeMsat, VOID, FORFEIT, ENTRY_VOID } from '../../arena-protocol/src/payout.js';
import { payoutRuleOfRound } from './plugins.js';
import { decodePlayerResult, splitSignedResult } from '../../arena-protocol/src/result.js';
import { roundEndMs } from '../../arena-protocol/src/first-mark.js';
import { OBJECTION_WINDOW_MS, FINAL_TOLERANCE_MS } from '../../arena-protocol/src/window.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { resultFinality } from './finality.js';
import { PROVISIONALLY_FINAL, FINAL } from '../../arena-protocol/src/objection.js';
import { runId } from './verdict.js';

/** The objection window, fixed (WINDOW-10-SPEC): 600 s of wall time from the round's end - the protocol's one constant. */
export { OBJECTION_WINDOW_MS };

// One entry's outcome as far as this node can say: from its threshold of signed results, or a refund/forfeit word.
function outcomeOf(round, roundIdBytes, entryId) {
  if (round.entryVoid && round.entryVoid(entryId)) return { decided: true, outcome: ENTRY_VOID, score: 0, state: ENTRY_VOID };
  const nq = round.noQuorum ? round.noQuorum(entryId) : null;
  if (nq && (nq.outcome === VOID || nq.outcome === FORFEIT)) return { decided: true, outcome: nq.outcome, score: 0, state: nq.outcome };
  let s;
  try { s = resultFinality(round, roundIdBytes, entryId); } catch (e) { return { decided: false, state: null, why: e.message }; }
  if (s.state === VOID || s.state === FORFEIT) return { decided: true, outcome: s.state, score: 0, state: s.state, why: s.why };
  // signed by the threshold - PROVISIONALLY_FINAL or FINAL - and not in a re-run: its agreed result
  if ((s.state === PROVISIONALLY_FINAL || s.state === FINAL) && !s.rerun && s.runId) {
    for (const r of round.results(roundIdBytes, entryId)) {
      let body;
      try { body = decodePlayerResult(splitSignedResult(r.bytes).body); } catch { continue; }
      if (toHex(runId(body)) === s.runId) return { decided: true, outcome: body.outcome, score: body.score, state: s.state, why: s.why };
    }
  }
  return { decided: false, state: s.state || null, why: s.why };
}

/**
 * The standing of `entryIdBytes` in its round: `{ state, pendingMsat, provisional, signedSoFar, entries, windowOpenMs,
 * windowCloseMs, why }`. `pendingMsat` is this entry's row of the payout table over the results signed so far - only
 * while its own result stands (PROVISIONALLY_FINAL or FINAL); null otherwise, so a VOID, a FORFEIT, an upheld objection
 * or a re-run takes the line away.
 */
export function standingOf(round, roundIdBytes, entryIdBytes, contract) {
  let openMs = null;
  try { openMs = roundEndMs(contract); } catch { openMs = null; }
  const base = { windowOpenMs: openMs === null ? null : String(openMs),
    windowCloseMs: openMs === null ? null : String(openMs + OBJECTION_WINDOW_MS) };
  const all = round.entriesOf(roundIdBytes);
  const entries = [];
  let mine = null;
  for (const { entryId, entry } of all) {
    // a stake no seat saw committed is not in the round (§23.1 step 5)
    if (round.stakeSeen && !round.stakeSeen(entryId)) continue;
    const o = outcomeOf(round, roundIdBytes, entryId);
    if (toHex(entryId) === toHex(entryIdBytes)) mine = { ...o, pubkey: entry.playerPubkey };
    if (!o.decided) continue;
    entries.push({ entryId, pubkey: entry.playerPubkey, stakeMsat: entry.stakeMsat, feeMsat: entry.feeMsat,
      donationMsat: entry.donationMsat, outcome: o.outcome, score: o.score });
  }
  if (!mine) return { ...base, state: null, pendingMsat: null, why: 'this signer node holds no such entry in the round' };
  const counted = all.filter(({ entryId }) => !round.stakeSeen || round.stakeSeen(entryId)).length;
  const standsOn = mine.decided && (mine.state === PROVISIONALLY_FINAL || mine.state === FINAL);
  let pendingMsat = null;
  let kind = null;
  // A VOID (or never-activated) entry is refunded: its stake coming back is what is pending (§23.2, §24)
  if (mine.decided && (mine.state === VOID || mine.state === ENTRY_VOID)) {
    const e = all.find(({ entryId }) => toHex(entryId) === toHex(entryIdBytes));
    try { pendingMsat = String(netStakeMsat(e.entry)); kind = 'refund'; } catch { pendingMsat = null; }
  }
  // SETTLED WITHOUT FINAL (2026-10-01, WINDOW-10-SPEC follow-up): "The line appears at once when money is owed. It
  // disappears when the payment is no longer owed." A result still PROVISIONALLY_FINAL past this seat's end + 605 s, in a
  // round whose settlement this seat holds ACCEPTED by the federation, and that settlement pays this entry's share - its
  // player among the paid shares, or its stake lock among the claimed - owes nothing more: no pending amount. The record
  // stays PROVISIONALLY_FINAL and nothing signs a FINAL for it (rounds settled before the FINAL signature existed, whose
  // census the seats' chain view no longer reaches).
  if (mine.decided && mine.state === PROVISIONALLY_FINAL && openMs !== null
    && BigInt(round.now()) >= openMs + OBJECTION_WINDOW_MS + FINAL_TOLERANCE_MS) {
    const settled = settledFor(round, roundIdBytes, entryIdBytes, mine.pubkey);
    if (settled)
      return { ...base, state: mine.state, outcome: mine.outcome, pendingMsat: null, kind: null, settled: settled.txid,
        provisional: false, signedSoFar: entries.length, entries: counted,
        why: `the round's settlement ${settled.txid} is ACCEPTED by the federation and pays this entry's share: nothing is pending` };
  }
  if (standsOn) {
    // by the game's own payout rule, as the settlement pays: a split game's line is its split's row
    const rule = payoutRuleOfRound(contract, round.plugins);
    if (!rule.ok) return { ...base, state: mine.state, outcome: mine.outcome, pendingMsat: null, kind: null,
      provisional: entries.length < counted, signedSoFar: entries.length, entries: counted, why: rule.why };
    kind = 'payout';
    const { table } = computePayoutTable({ roundId: roundIdBytes, entries, minScore: contract.minScore, payoutShares: rule.payoutShares });
    const row = table.find((t) => toHex(t.pubkey) === toHex(mine.pubkey));
    pendingMsat = row ? String(row.amountMsat) : '0';
  }
  return { ...base, state: mine.state, outcome: mine.decided ? mine.outcome : null, pendingMsat, kind,
    provisional: entries.length < counted, signedSoFar: entries.length, entries: counted, why: mine.why || null };
}

/** This seat's ACCEPTED settlement of the round, if it pays this entry's share - its player paid, or its stake lock claimed. */
function settledFor(round, roundIdBytes, entryIdBytes, playerPubkey) {
  if (stateOf(round, roundIdBytes) !== 'ACCEPTED') return null;
  const s = (typeof round.lockSettlement === 'function' && round.lockSettlement(roundIdBytes)) || { state: 'ACCEPTED', txid: 'federations' };
  const shares = typeof round.lockSettlementShares === 'function' ? round.lockSettlementShares(roundIdBytes) || [] : [];
  if (shares.some((x) => toHex(x.pubkey) === toHex(playerPubkey) && x.msat > 0n)) return s;
  const moves = typeof round.lockSettlementMoves === 'function' ? round.lockSettlementMoves(roundIdBytes) : null;
  const lock = typeof round.stakeLock === 'function' ? round.stakeLock(entryIdBytes) : null;
  if (moves && lock && moves.claims.includes(lock.outpoint)) return s;
  return null;
}

/**
 * WHERE ONE ORDER'S MONEY STANDS IN AN ATTESTED MARKET (2026-10-20, live UI 269: "The pending balance doesn't appear in the
 * wallet but does in the prediction market" - measured: the market showed "Up won · +99 sats · pending · final in 8:44" while
 * every committee seat's /standing answered that entry as a replay game, "0 of 5 agree on any one run", pendingMsat null, so the
 * wallet's Pending read 0 sat). A market round is decided by its attestation, not by signed runs: from the round's outcome
 * (GET /outcome's answer, its table) and, for an order book, this entry's line of the book's settlement table.
 *   `out`: the seat's outcome of the round (state, outcome, final, finalAtMs, entryCloseMs, table); `bookRow`: for an order book,
 *   this entry's claimed row of bookSettlement ({ outMsat }) or null when it has no fill; `book`: whether the round is a book.
 * Answers the fields standingOf answers: a winning or a book's claimed line is kind 'payout' with its msat, provisional until the
 * outcome is final (windowCloseMs = when it becomes final); a loser's line is '0'; an order with no fill and a VOID market are
 * kind 'refund' with no figure - their locks come back whole by the return door, which the page counts as a stake owed back.
 */
export function marketStandingOf({ out, entryIdHex, book = false, bookRow = null }) {
  const base = { windowOpenMs: out && out.entryCloseMs ? String(out.entryCloseMs) : null, windowCloseMs: out && out.finalAtMs ? String(out.finalAtMs) : null, market: true };
  if (!out) return { ...base, state: null, outcome: null, pendingMsat: null, kind: null, provisional: true, why: 'that round has no outcome at this seat' };
  if (out.state === 'VOID') return { ...base, state: 'VOID', outcome: null, pendingMsat: null, kind: 'refund', provisional: false, why: out.why || 'the market is VOID: every lock comes back whole' };
  if (out.state !== 'ATTESTED') return { ...base, state: out.state || null, outcome: null, pendingMsat: null, kind: null, provisional: true,
    why: out.state === 'DISPUTED' ? 'the attestors named different outcomes' : 'the outcome is not attested yet' };
  const decided = { ...base, state: 'ATTESTED', outcome: out.outcome, provisional: !out.final };
  if (book) {
    if (!bookRow) return { ...decided, pendingMsat: null, kind: 'refund', why: 'this order has no fill: its locks come back whole by the return door' };
    return { ...decided, pendingMsat: String(bookRow.outMsat), kind: 'payout', why: null };
  }
  const t = out.table;
  if (!t) return { ...decided, pendingMsat: null, kind: null, why: 'no table for that round at this seat' };
  if (t.refunded) return { ...decided, pendingMsat: null, kind: 'refund', why: 'the round is refunded: every stake comes back' };
  const row = (t.rows || []).find((r) => String(r.entryId) === String(entryIdHex));
  if (!row) return { ...decided, pendingMsat: null, kind: null, why: 'this entry\'s stake is not counted at this seat' };
  return { ...decided, pendingMsat: String(row.payoutMsat || '0'), kind: 'payout', why: null };
}
