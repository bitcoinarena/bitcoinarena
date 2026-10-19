// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SCORE ACROSS ROUNDS: the step rule - a win adds one, a draw nothing, a round not played ends the match -
// and the bytes a proof and a record are signed over.
import test from 'node:test';
import assert from 'node:assert/strict';
import { matchStep, matchResultOf, matchProofId, matchRecordId, MATCH_CONTINUE_MS } from '../src/match.js';

test('I win 1:0, the opponent wins 1:1, a draw keeps it; a round not played ends the match; a new pair starts at 0:0', () => {
  const A = 'aa'.repeat(32), B = 'bb'.repeat(32), C = 'cc'.repeat(32);
  let m = null;
  const seq = [];
  for (const [a, b] of [['win', 'loss'], ['loss', 'win'], ['draw', 'draw'], ['win', 'loss']]) { m = matchStep(m, { [A]: a, [B]: b }); seq.push(m.score.join(':')); }
  assert.deepEqual(seq, ['1:0', '1:1', '1:1', '2:1']);
  const unplayed = matchStep(m, { [A]: 'win', [B]: null });
  assert.equal(unplayed.played, false);
  assert.deepEqual(unplayed.score, [2, 1]);
  assert.deepEqual(matchStep(m, { [A]: 'win', [C]: 'loss' }).score, [1, 0], 'another pair continued this match');
  assert.equal(matchResultOf('DELIVERED', 2), 'win');
  assert.equal(matchResultOf('DELIVERED', 1), 'draw');
  assert.equal(matchResultOf('FORFEIT', 0), 'loss');
  assert.equal(matchResultOf('VOID', 0), null);
  assert.equal(MATCH_CONTINUE_MS, 60000n);
  const r = new Uint8Array(32).fill(1), e = new Uint8Array(32).fill(2), k = new Uint8Array(32).fill(3);
  assert.notDeepEqual(matchProofId({ roundId: r, entryId: e, identityKey: k }), matchProofId({ roundId: r, entryId: k, identityKey: e }));
  const rec = { gameId: r, roundId: e, identities: [A, B], score: [1, 1] };
  assert.notDeepEqual(matchRecordId(rec), matchRecordId({ ...rec, score: [1, 0] }));
});
