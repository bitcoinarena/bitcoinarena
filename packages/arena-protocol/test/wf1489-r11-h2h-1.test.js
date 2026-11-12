// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WF1489 r11 h2h-1: A HEAD-TO-HEAD ROUND'S MIN_SCORE IS THE GAME'S, NOT MORE. A head-to-head manifest must name min_score 2 exactly
// (a WIN scores 2, a DRAW 1), but roundFitsManifest only asks a round for `minScore >= m.minScore` - the replayed games' "a round may ask more
// of its runs". One seat that opens rounds (role b) publishes a Rock Paper Scissors round with min_score 3: every seat takes it as a fit,
// players stake and pay the fee, and a WIN (DELIVERED, score 2) is no qualifier - the winner is paid nothing of the loser's stake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { manifestBodyId, roundFitsManifest, gameIdOf, RESULT_TYPE, PAYOUT_RULE, NO_PARENT, H2H_WIN_SCORE } from '../src/manifest.js';
import { headToHeadResults, VERDICT } from '../src/head-to-head.js';
import { computePayoutTable } from '../src/payout.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const pub = new Uint8Array(publicKey.export({ type: 'spki', format: 'der' }).subarray(-32));
const body = {
  gameName: 'rock-paper-scissors', gameDevPubkey: pub, version: 1, parentManifestId: NO_PARENT, resultType: RESULT_TYPE.HEAD_TO_HEAD,
  cores: [{ hash: b32(0x21), configs: [b32(0x22)] }], runTicksMax: 0, roundPeriodMs: 0n, payoutRule: PAYOUT_RULE.RANK_CURVE,
  rankNumerator: 3, rankDenominator: 4, minScore: H2H_WIN_SCORE, clients: [b32(0xc1)], gameDonationSetId: b32(0xd0),
  players: 2, moveCount: 3, revealWindowMs: 60000n,
};
const m = { ...body, signature: new Uint8Array(sign(null, Buffer.from(manifestBodyId(body)), privateKey)) };
const rps = ([a, b]) => {
  if (a.move === b.move) return { [a.key]: VERDICT.DRAW, [b.key]: VERDICT.DRAW };
  const aWins = (a.move - b.move + 3) % 3 === 1;
  return { [a.key]: aWins ? VERDICT.WIN : VERDICT.LOSS, [b.key]: aWins ? VERDICT.LOSS : VERDICT.WIN };
};

test('a head-to-head round naming a min_score above the game\'s 2 is refused: a win must be able to win', () => {
  const round = { gameId: gameIdOf(m), simCoreHash: b32(0x21), configHash: b32(0x22), blockTicks: 1, rankNumerator: 3, rankDenominator: 4, minScore: 2 };
  assert.equal(roundFitsManifest(round, m).ok, true, 'the game\'s own min_score fits');
  // what the raised min_score does: rock beats scissors, and the winner is paid only its own net stake back
  const r = headToHeadResults([{ key: 'aa', move: 0 }, { key: 'bb', move: 2 }], rps, {}, { players: 2 });
  const entries = [{ pubkey: b32(0xaa), stakeMsat: 1000000n, feeMsat: 20000n, donationMsat: 0n, ...r.aa },
    { pubkey: b32(0xbb), stakeMsat: 1000000n, feeMsat: 20000n, donationMsat: 0n, ...r.bb }];
  const paidAt = (minScore) => computePayoutTable({ roundId: b32(9), entries, minScore }).table.map((x) => x.amountMsat);
  assert.deepEqual(paidAt(2), [1960000n, 0n], 'at the game\'s min_score the winner takes the loser\'s net stake');
  const raised = paidAt(3);
  assert.equal(raised[0], 0n, 'under min_score 3 the WIN is no qualifier: nothing is paid to the winner');
  // the safe behaviour: the door never takes such a round
  const got = roundFitsManifest({ ...round, minScore: 3 }, m);
  assert.equal(got.ok, false, `a head-to-head round with min_score 3 was taken as a fit (${JSON.stringify(got)}): its winner can never be paid`);
  assert.equal(roundFitsManifest({ ...round, minScore: 0xffffffff }, m).ok, false, 'nor any min_score above the game\'s');
});
