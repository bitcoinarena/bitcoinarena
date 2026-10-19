// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// HEAD-TO-HEAD ROUNDS (2026-10-09: "Head-to-head in engine"). A replayed round runs each entry alone, so
// no entry's result can depend on another player's move; a head-to-head round is decided over all of them at once.
//
//   1. COMMIT. At entry each player names commit = H(round_id || entry_key || move || salt) - the move hidden until it is
//      revealed, bound to this round and this entry so nobody can copy another's commitment and its reveal.
//   2. REVEAL. After entry close, and before entry close + the game's reveal window, each player hands its (move, salt) to
//      the round's nodes; a reveal stands only if it hashes to that entry's commitment and names a move the game offers.
//   3. DECIDE. After the window every node hands the stood reveals to the game's decide adapter (a plugin, named in the
//      manifest's cores[] by hash) and maps its verdict onto the engine's own payout rule, so settlement is unchanged:
//        WIN  -> DELIVERED, score 2 (a qualifier: min_score is 2)       net stake back + the pool
//        DRAW -> DELIVERED, score 1 (below min_score: keeps its stake)   net stake back
//        LOSS -> FAILED                                                   net stake into the pool
//        no stood reveal -> FORFEIT                                       net stake into the pool
//      A lone revealer wins; with no reveal at all every entry forfeits.
//      FEWER ENTRIES THAN THE GAME'S PLAYERS (2026-10-09: "refuse 1 game rounds since there is only 1 player - there
//      must be 2 before the game starts"): nobody was played against, so the round is not played - every entry VOID, its
//      stake back, no result for anyone. Every node decides the same from the same reveals,
//      so their results agree the way two replays of one transcript agree.
import { Writer } from './encode.js';
import { taggedHash, toHex } from './hash.js';
import { TAG } from './constants.js';
import { H2H_WIN_SCORE, H2H_DRAW_SCORE } from './manifest.js';
import { DELIVERED, FAILED, FORFEIT, VOID } from './payout.js';

export const SALT_BYTES = 32;
export const VERDICT = Object.freeze({ WIN: 'WIN', DRAW: 'DRAW', LOSS: 'LOSS' });

const h2hIs32 = (b) => b instanceof Uint8Array && b.length === 32;
const h2hSame = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/** The commitment a player names at entry. */
export function headToHeadCommit({ roundId, entryKey, move, salt }) {
  if (!h2hIs32(roundId)) throw new Error('a commitment names its 32-byte round');
  if (!h2hIs32(entryKey)) throw new Error('a commitment names its 32-byte entry key');
  if (!Number.isInteger(move) || move < 0 || move > 255) throw new Error('a move is a byte');
  if (!(salt instanceof Uint8Array) || salt.length !== SALT_BYTES) throw new Error(`a salt is ${SALT_BYTES} bytes`);
  const w = new Writer();
  w.bytes32(roundId); w.bytes32(entryKey); w.u8(move); w.bytes(salt);
  return taggedHash(TAG.headToHeadCommit, w.finish());
}

/** Does this reveal stand for that entry: in the window, a move the game offers, and the commitment it named? */
export function revealStands({ roundId, entryKey, commit, move, salt, moveCount, atMs, entryCloseMs, revealWindowMs }) {
  if (!h2hIs32(commit)) return { ok: false, why: 'that entry named no 32-byte commitment' };
  if (typeof atMs !== 'bigint' || typeof entryCloseMs !== 'bigint' || typeof revealWindowMs !== 'bigint')
    return { ok: false, why: 'a reveal is judged against the round\'s clock' };
  if (atMs < entryCloseMs) return { ok: false, why: 'a move is revealed only after entry close: before it, the others could still answer it' };
  if (atMs > entryCloseMs + revealWindowMs) return { ok: false, why: `the reveal window closed at ${entryCloseMs + revealWindowMs}` };
  if (!Number.isInteger(move) || move < 0 || move >= moveCount) return { ok: false, why: `move ${move} is not one of the game's ${moveCount}` };
  let h;
  try { h = headToHeadCommit({ roundId, entryKey, move, salt }); } catch (e) { return { ok: false, why: e.message }; }
  if (!h2hSame(h, commit)) return { ok: false, why: 'that move and salt are not what this entry committed to' };
  return { ok: true };
}

/**
 * EVERY ENTRY'S RESULT, from the stood reveals. `entries` is [{ key (hex), move (an integer, or null for no stood
 * reveal) }]; `decide(moves, config)` is the game's adapter: it gets [{ key, move }] of the revealers only and answers
 * { [key]: 'WIN' | 'DRAW' | 'LOSS' } for each of them. Answers { [key]: { outcome, score } } for every entry.
 */
export function headToHeadResults(entries, decide, config, { players = 2 } = {}) {
  const out = {};
  if (entries.length < players) {
    for (const e of entries) out[e.key] = { outcome: VOID, score: 0 };
    return out;
  }
  const revealed = entries.filter((e) => Number.isInteger(e.move));
  for (const e of entries) if (!Number.isInteger(e.move)) out[e.key] = { outcome: FORFEIT, score: 0 };
  if (revealed.length === 1) out[revealed[0].key] = { outcome: DELIVERED, score: H2H_WIN_SCORE };
  if (revealed.length >= 2) {
    const verdict = decide(revealed.map((e) => ({ key: e.key, move: e.move })), config);
    for (const e of revealed) {
      const v = verdict && verdict[e.key];
      if (v === VERDICT.WIN) out[e.key] = { outcome: DELIVERED, score: H2H_WIN_SCORE };
      else if (v === VERDICT.DRAW) out[e.key] = { outcome: DELIVERED, score: H2H_DRAW_SCORE };
      else if (v === VERDICT.LOSS) out[e.key] = { outcome: FAILED, score: 0 };
      else throw new Error(`the game's decide gave entry ${e.key.slice(0, 16)} no verdict (${v})`);
    }
  }
  return out;
}

export const commitHex = (c) => toHex(c);
