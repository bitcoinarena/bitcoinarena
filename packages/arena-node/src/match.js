// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SCORE ACROSS ROUNDS AT A SEAT (arena-protocol/src/match.js). For a decided head-to-head round whose two
// entries both named an identity: the round before in the match - the last round of this game either identity played,
// if that was a round the two played together, ended at most MATCH_CONTINUE_MS before this one's entry close - its score,
// and this round's results (the result most of the round's seats signed, as /api/round-result reads it). The record -
// game, round, the two identities, their score, the round it continued - is signed with this seat's key and kept, so the
// score is counted once per round and every round after continues from the same number.
import { schnorr } from '@noble/curves/secp256k1.js';
import { decodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { decodePlayerResult, splitSignedResult } from '../../arena-protocol/src/result.js';
import { matchStep, matchRecordId, matchResultOf, MATCH_CONTINUE_MS } from '../../arena-protocol/src/match.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { pluginForRound } from './plugins.js';
import { OPEN } from './store.js';

// A ROUND NOT YET DECIDED HERE (kanban #1748): held, its two entries named, and a result still missing while the round is open or closed
// less than this long ago (its close waiting on its members, a slow peer's /reveals, a restart resuming closes one at a time). A later
// round of the match is not kept while it is: kept now it would start a new match at 0:0 for good (INSERT OR IGNORE), and this seat would
// sign another score than the seats that decided the two rounds in order. Past this a round with no result is taken as never decided.
const UNDECIDED_GRACE_MS = 60 * 60 * 1000;
const UNDECIDED = Symbol('undecided');

/** The result most of a round's seats signed for one entry: { outcome, score } or null. */
function agreedResult(round, rid, eid) {
  const tally = new Map();
  for (const r of round.results(rid, eid)) {
    try { const x = decodePlayerResult(splitSignedResult(r.bytes).body); const k = `${x.outcome}:${x.score}`; tally.set(k, { outcome: x.outcome, score: x.score, n: ((tally.get(k) || {}).n || 0) + 1 }); }
    catch { /* not a result */ }
  }
  return [...tally.values()].sort((a, b) => b.n - a.n)[0] || null;
}

/**
 * A ROUND'S MATCH RECORD at this seat: { round, game, identities [hex, hex], score [a, b], played, previousRound | null,
 * seat, signature } - kept once counted; null when the round is not a decided head-to-head round of two named identities.
 */
export function matchOf(round, plugins, roundIdBytes) {
  const m = matchAt(round, plugins, roundIdBytes, 0);
  return m === UNDECIDED ? null : m;
}

// matchOf, or UNDECIDED: this round, or the round before it in the match, is not decided here yet - nothing is kept (kanban #1748)
function matchAt(round, plugins, roundIdBytes, depth) {
  const rid = Buffer.from(roundIdBytes);
  const kept = round.db.prepare('SELECT record, sig FROM match_records WHERE round_id = ?').get(rid);
  if (kept) return { ...JSON.parse(kept.record), signature: kept.sig };
  if (depth > 400) return null;
  const row = round.get(roundIdBytes);
  if (!row) return null;
  const c = decodeRoundContract(new Uint8Array(row.contract));
  const found = pluginForRound(c, plugins);
  if (!found.ok || !found.headToHead) return null;
  // the round's seated players: in a paying round only the entries backed by a lock (kanban #1437, audit 8 R3) - its stake seen, the ones played (kanban #1544)
  const entries = typeof round.seatedEntriesOf === 'function' ? round.seatedEntriesOf(roundIdBytes, c.stakeMsat, { played: true }) : round.entriesOf(roundIdBytes);
  // A PAYING ROUND WHOSE LOCKS HAVE NOT ALL REACHED THIS SEAT YET (kanban #2404, refutes #1748 + #2167, #1489 a44-refute-59-s2): its entries are
  // held here but their locks crossed to another seat (the client handed them there, or the network was slow), and this seat pulls them only at
  // its own close (server.js takeEntryParts). Until then fewer than two entries are seated-and-played here, and answering null ('not a
  // head-to-head round') let the next round of the match be kept as a new match for good while the other seats continued it. Such a round is
  // UNDECIDED while it is open, or closed less than UNDECIDED_GRACE_MS ago with nothing signed by this seat for any of its entries yet.
  if (entries.length !== 2) {
    const all = round.entriesOf(roundIdBytes);
    if (all.length >= 2 && entries.length < all.length) {
      const pending = (e) => !(typeof round.hasResult === 'function' && round.hasResult(roundIdBytes, e.entryId, round.pubkey))
        && !(typeof round.entryVoid === 'function' && round.entryVoid(e.entryId));
      if (row.state === OPEN && all.some(pending)) return UNDECIDED;
      const recentClose = row.closed_ms != null && Number(round.now()) - Number(row.closed_ms) < UNDECIDED_GRACE_MS;
      if (recentClose && all.every(pending)) return UNDECIDED;
    }
    return null;
  }
  // EACH SIDE'S IDENTITY: its reveal's, else the one its consented name record names (audit 5 #1401) - a loser who left the identity off his reveal, or
  // forfeited, broke the chain and the next round's score started at 0-0; the consent is fixed at the join, before anything is known
  const idOf = ({ entryId, entry }) => round.identityOf(entryId)
    || (typeof round.consentedIdentityOf === 'function' && entry ? ((h) => (h ? { identity: Uint8Array.from(Buffer.from(h, 'hex')) } : null))(round.consentedIdentityOf(roundIdBytes, entry.playerPubkey)) : null);
  const named = entries.map((e) => ({ entryId: e.entryId, id: idOf(e), result: agreedResult(round, roundIdBytes, e.entryId) }));
  if (named.some((x) => !x.id)) return null;
  if (named.some((x) => !x.result)) {                                 // not decided yet: counted once it is
    const recent = row.state === OPEN || (row.closed_ms != null && Number(round.now()) - Number(row.closed_ms) < UNDECIDED_GRACE_MS);
    return recent ? UNDECIDED : null;
  }
  const ids = named.map((x) => toHex(x.id.identity));
  if (ids[0] === ids[1]) return null;                                  // one player on both sides counts nothing
  // THE ROUND BEFORE IN THE MATCH: the last earlier round of this game either identity played; continued only if both
  // played it together and it closed at most MATCH_CONTINUE_MS before this one
  const close = c.entryCloseMs;
  let previous = null;
  for (const idHex of ids) {
    // kanban #2280: the rounds it is a side of by its consented name record count too (a forfeit against a third player ends the match), the
    // same two ways its sides are named above - h2h_identities alone holds only the rounds it revealed in
    const consented = typeof round.roundsOfConsentedIdentity === 'function' ? round.roundsOfConsentedIdentity(fromHex(idHex)) : [];
    for (const r of [...round.roundsOfIdentity(fromHex(idHex)), ...consented]) {
      if (toHex(r.roundId) === toHex(roundIdBytes)) continue;
      const pr = round.get(r.roundId);
      if (!pr) continue;
      const pc = decodeRoundContract(new Uint8Array(pr.contract));
      if (toHex(pc.gameId) !== toHex(c.gameId) || pc.entryCloseMs >= close) continue;
      if (!previous || pc.entryCloseMs > previous.closeMs) previous = { roundId: r.roundId, closeMs: pc.entryCloseMs };
    }
  }
  // A ROUND BEFORE THAT IS NOT YET DECIDED HERE AND NAMED ONLY BY ITS CONSENTED NAME RECORDS (kanban #2167, refutes #1748): its reveals - and with them
  // its h2h_identities rows - reach a slow seat only at its own close (a peer's /reveals), so roundsOfIdentity does not list it yet. A later
  // round of this game within the continue time, newer than the round before found above, that is still UNDECIDED keeps nothing here either;
  // one that is decided or not head-to-head is ignored, so the round before is chosen exactly as before.
  if (typeof round.roundsNamingIdentity === 'function') {
    const seen = new Set();
    for (const idHex of ids) {
      for (const r of round.roundsNamingIdentity(fromHex(idHex))) {
        const h = toHex(r.roundId);
        if (h === toHex(roundIdBytes) || seen.has(h)) continue;
        seen.add(h);
        const pr = round.get(r.roundId);
        if (!pr) continue;
        const pc = decodeRoundContract(new Uint8Array(pr.contract));
        if (toHex(pc.gameId) !== toHex(c.gameId) || pc.entryCloseMs >= close || close - pc.entryCloseMs > MATCH_CONTINUE_MS) continue;
        if (previous && pc.entryCloseMs <= previous.closeMs) continue;
        if (matchAt(round, plugins, r.roundId, depth + 1) === UNDECIDED) return UNDECIDED;
      }
    }
  }
  let prev = null;
  if (previous && close - previous.closeMs <= MATCH_CONTINUE_MS) {
    const pm = matchAt(round, plugins, previous.roundId, depth + 1);
    if (pm === UNDECIDED) return UNDECIDED;                            // the round before is still being decided here: keep nothing yet (kanban #1748)
    if (pm && pm.played && [...pm.identities].sort().join() === [...ids].sort().join()) prev = pm;
  }
  const results = Object.fromEntries(named.map((x, i) => [ids[i], matchResultOf(x.result.outcome, x.result.score)]));
  const step = matchStep(prev ? { identities: prev.identities, score: prev.score } : null, results);
  const record = { round: toHex(roundIdBytes), game: toHex(c.gameId), identities: step.identities, score: step.score, played: step.played,
    previousRound: prev ? prev.round : null, seat: toHex(round.pubkey) };
  const id = matchRecordId({ gameId: c.gameId, roundId: roundIdBytes, identities: step.identities, score: step.score, previousRoundId: prev ? fromHex(prev.round) : null });
  const signature = toHex(schnorr.sign(id, round.identity.secret));
  round.db.prepare('INSERT OR IGNORE INTO match_records (round_id, record, sig) VALUES (?, ?, ?)').run(rid, JSON.stringify(record), signature);
  return { ...record, signature };
}
