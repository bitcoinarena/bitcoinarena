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
export function matchOf(round, plugins, roundIdBytes, depth = 0) {
  const rid = Buffer.from(roundIdBytes);
  const kept = round.db.prepare('SELECT record, sig FROM match_records WHERE round_id = ?').get(rid);
  if (kept) return { ...JSON.parse(kept.record), signature: kept.sig };
  if (depth > 400) return null;
  const row = round.get(roundIdBytes);
  if (!row) return null;
  const c = decodeRoundContract(new Uint8Array(row.contract));
  const found = pluginForRound(c, plugins);
  if (!found.ok || !found.headToHead) return null;
  const entries = round.entriesOf(roundIdBytes);
  if (entries.length !== 2) return null;
  const named = entries.map(({ entryId }) => ({ entryId, id: round.identityOf(entryId), result: agreedResult(round, roundIdBytes, entryId) }));
  if (named.some((x) => !x.id)) return null;
  if (named.some((x) => !x.result)) return null;                      // not decided yet: counted once it is
  const ids = named.map((x) => toHex(x.id.identity));
  if (ids[0] === ids[1]) return null;                                  // one player on both sides counts nothing
  // THE ROUND BEFORE IN THE MATCH: the last earlier round of this game either identity played; continued only if both
  // played it together and it closed at most MATCH_CONTINUE_MS before this one
  const close = c.entryCloseMs;
  let previous = null;
  for (const idHex of ids) {
    for (const r of round.roundsOfIdentity(fromHex(idHex))) {
      if (toHex(r.roundId) === toHex(roundIdBytes)) continue;
      const pr = round.get(r.roundId);
      if (!pr) continue;
      const pc = decodeRoundContract(new Uint8Array(pr.contract));
      if (toHex(pc.gameId) !== toHex(c.gameId) || pc.entryCloseMs >= close) continue;
      if (!previous || pc.entryCloseMs > previous.closeMs) previous = { roundId: r.roundId, closeMs: pc.entryCloseMs };
    }
  }
  let prev = null;
  if (previous && close - previous.closeMs <= MATCH_CONTINUE_MS) {
    const pm = matchOf(round, plugins, previous.roundId, depth + 1);
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
