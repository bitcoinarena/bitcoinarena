// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SCORE ACROSS ROUNDS (2026-10-09: "The protocol must support a score across rounds, when the same two
// players stay in the game. I win: 1:0. Opponent wins: 1:1. It keeps counting until one player or both leave. The protocol
// counts it up, attests it, and shows it in the results").
//
// A round's player key is derived per round (player-key.js) - rounds cannot be linked by it, on purpose. A player who wants
// its rounds counted together names its IDENTITY key (the tab's, identitySecretFor - the key its name is generated from) on
// each head-to-head entry, signed by that identity key over (round, entry): a seat holds it with the reveal. Two identities
// that play a head-to-head round together continue a MATCH when the last round either of them played in that game was one
// they played together, ended at most MATCH_CONTINUE_MS earlier - so a player who sits a round out, or plays someone else,
// ends it, and the next meeting starts at 0:0. A win adds 1 to the winner; a draw adds nothing; a round not played (one of
// them alone, VOID) ends the match. Each seat computes the score from its own signed results and signs the match record.
import { Writer } from './encode.js';
import { taggedHash, toHex } from './hash.js';
import { TAG } from './constants.js';

// 60 s: rounds of 10 s run back to back and a result lands ~20 s after its entry close (the reveal window), so a player
// waiting for a verdict sits one or two rounds out between moves - that is staying, not leaving
export const MATCH_CONTINUE_MS = 60000n;

const mIs32 = (b) => b instanceof Uint8Array && b.length === 32;

/** The bytes an identity key signs to name its head-to-head entry: round, entry, identity key. */
export function matchProofId({ roundId, entryId, identityKey }) {
  if (!mIs32(roundId) || !mIs32(entryId) || !mIs32(identityKey)) throw new Error('a match proof names a 32-byte round, entry and identity key');
  const w = new Writer();
  w.bytes32(roundId); w.bytes32(entryId); w.bytes32(identityKey);
  return taggedHash(TAG.matchProof, w.finish());
}

// WHO IS AT THE TABLE (2026-10-09 playtest: two tabs at one table, both read "You are alone in this
// round" until one picked): a tab at a head-to-head round's table says so to the round's seats with its identity key, signed
// over (round, key), every PRESENCE_EVERY_MS; a seat counts it as there for PRESENCE_MS after the last one. Presence decides
// nothing - it is what the table shows before a move is in.
export const PRESENCE_EVERY_MS = 2000;
export const PRESENCE_MS = 6000;

/** The bytes an identity key signs to say it is at a round's table: round, identity key. */
export function presenceId({ roundId, identityKey }) {
  if (!mIs32(roundId) || !mIs32(identityKey)) throw new Error('a presence names a 32-byte round and identity key');
  const w = new Writer();
  w.bytes32(roundId); w.bytes32(identityKey);
  return taggedHash(TAG.presence, w.finish());
}

/** A head-to-head result as the match counts it: 'win', 'draw', 'loss', or null (not played - VOID, or no result). */
export function matchResultOf(outcome, score) {
  if (outcome === 'DELIVERED') return score >= 2 ? 'win' : 'draw';
  if (outcome === 'FAILED' || outcome === 'FORFEIT') return 'loss';
  return null;
}

/**
 * THE NEXT SCORE: `prev` { identities: [hexA, hexB] (sorted), score: [a, b] } or null (a new match), and this round's two
 * results by identity ({ [hex]: 'win' | 'draw' | 'loss' | null }). Answers { identities, score, played } - played false (a
 * round not played) ends the match: its score is the previous one, and nothing continues from it.
 */
export function matchStep(prev, results) {
  const identities = Object.keys(results).sort();
  if (identities.length !== 2) throw new Error('a match is two identities');
  const base = prev && prev.identities.join() === identities.join() ? [...prev.score] : [0, 0];
  const r = identities.map((k) => results[k]);
  if (r.some((x) => x === null)) return { identities, score: base, played: false };
  if (r[0] === 'win' && r[1] !== 'win') base[0] += 1;
  else if (r[1] === 'win' && r[0] !== 'win') base[1] += 1;
  return { identities, score: base, played: true };
}

/** The bytes a seat signs for a round's match record: game, round, the two identities, their score, the round before. */
export function matchRecordId({ gameId, roundId, identities, score, previousRoundId = null }) {
  if (!mIs32(gameId) || !mIs32(roundId)) throw new Error('a match record names its 32-byte game and round');
  const w = new Writer();
  w.bytes32(gameId); w.bytes32(roundId);
  for (const k of identities) w.bytes32(typeof k === 'string' ? Uint8Array.from(k.match(/../g).map((x) => parseInt(x, 16))) : k);
  w.u32(score[0]); w.u32(score[1]);
  w.bytes32(previousRoundId || new Uint8Array(32));
  return taggedHash(TAG.matchRecord, w.finish());
}

export const matchHex = toHex;
