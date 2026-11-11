// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// SIGNED SEASON ACCOUNTS (kanban #1153, critical): what a leaderboard payout and a weekly board badge count a round on. A round counts
// only with its contract checked by id and its account signed by the threshold of the round's own draw (5 of 7) - never because three
// seats handed in the same unsigned bytes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { mergeSeasonAccounts, mergeSignedSeasonAccounts, seasonAccountOf, seasonContractOf, evidenceAnswers, SEASON_NETWORK_AGREE } from '../src/season.js';
import { leaderboardWinners } from '../src/leaderboard-winners.js';
import { DELIVERED, FAILED } from '../src/payout.js';
import { contractRound, roundContract, seatAnswer, seatKey, seatSecret, drawOf } from '../../arena-node/test/signed-season-fixture.js';

const verify = (s, m, k) => schnorr.verify(s, m, k);
const h = (n) => n.toString(16).padStart(2, '0').repeat(32);
const GAME = h(0x9a);
const T0 = Date.UTC(2026, 9, 10);
const S = 100000n;
const en = (player, payoutMsat, roundKey) => ({ player, roundKey, name: null, stakeMsat: S, payoutMsat, outcome: payoutMsat > S ? DELIVERED : FAILED, score: 1 });
// identities (an entry's round key is not the player) A, B, C, D; X the colluders' invented winner
const [A, B, C, D, X] = [0x0a, 0x0b, 0x0c, 0x0d, 0x0e].map(h);
const R1 = contractRound({ gameId: GAME, startMs: T0 + 3600000, n: 1, entries: [en(A, 3n * S, h(0xa1)), en(B, 0n, h(0xb1)), en(C, 0n, h(0xc1))] });
const R2 = contractRound({ gameId: GAME, startMs: T0 + 7200000, n: 2, entries: [en(C, 2n * S, h(0xc2)), en(D, 0n, h(0xd2))] });
// THE INVENTED ROUND: a contract the colluders made up, and an account none of the round's honest seats holds
const FAKE = contractRound({ gameId: GAME, startMs: T0 + 9000000, n: 3, entries: [en(X, 900n * S, h(0xe1)), en(D, 0n, h(0xd3))] });
// the draws as THIS seat computes them: R1 and R2 drawn on seats 1-9, the invented round on the three colluders 11, 12, 13 and six others
const DRAW = drawOf(new Map([[R1.roundId, [1, 2, 3, 4, 5, 6, 7, 8, 9]], [R2.roundId, [1, 2, 3, 4, 5, 6, 7, 8, 9]], [FAKE.roundId, [11, 12, 13, 1, 2, 3, 4, 5, 6]]]));
const WINDOW = { games: [GAME], fromMs: T0, toMs: T0 + 7 * 86400000, top: 3, amountMsat: 3000000n };
const honest = (n) => seatAnswer(n, [R1, R2]);
const colluder = (n) => seatAnswer(n, [R1, R2, FAKE]);

test('the scenario: three colluding seats hand in byte-identical invented rounds - the old merge pays them, the signed merge does not', () => {
  // THE OLD RULE: SEASON_NETWORK_AGREE (3) byte-identical accounts, no check of who the round's seats are or whether it exists
  const unsigned = (rounds) => rounds.map(({ contract, sigs, ...r }) => r);
  const old = mergeSeasonAccounts(new Map([['c11', unsigned(colluder(11))], ['c12', unsigned(colluder(12))], ['c13', unsigned(colluder(13))], ['me', unsigned(honest(1))]]),
    { agree: SEASON_NETWORK_AGREE, keys: true });
  const oldWin = leaderboardWinners({ ...WINDOW, rounds: old.rounds });
  assert.equal(oldWin.winners[0].player, X, 'the old rule pays the invented winner first');
  // THE SIGNED RULE: the same three colluders, this seat and four honest seats of R1's and R2's draw
  const answers = new Map([['c11', colluder(11)], ['c12', colluder(12)], ['c13', colluder(13)], ...[1, 2, 3, 4, 5].map((n) => [`s${n}`, honest(n)])]);
  const m = mergeSignedSeasonAccounts(answers, { seatsOf: DRAW, verify });
  assert.equal(m.ok, true, m.why);
  assert.deepEqual(m.rounds.map((r) => r.roundId), [R1.roundId, R2.roundId].sort(), 'only the rounds the threshold of their draw signed');
  assert.ok(m.excluded.some((x) => x.round === FAKE.roundId && /signed by enough of its seats \(3 at most\)/.test(x.why)), JSON.stringify(m.excluded));
  const w = leaderboardWinners({ ...WINDOW, rounds: m.rounds });
  // A +2S, C 0, B and D -S each (sharing place 3): the honest board
  assert.deepEqual(w.winners.map((x) => [x.player, x.places]), [[A, '1'], [C, '2'], [B, '3-3 shared by 2'], [D, '3-3 shared by 2']]);
  assert.ok(!w.winners.some((x) => x.player === X), 'X is paid nothing');
});

test('a signature counts only from a seat of the round\'s own draw, once, and only when it verifies over that account', () => {
  const a = seatAnswer(1, [R1]);
  const forged = [{ ...a[0], sigs: [{ node: seatKey(2), sig: a[0].sigs[0].sig }] }];          // seat 1's signature named as seat 2's
  const stranger = seatAnswer(20, [R1]);                                                      // a bonded seat, not of R1's draw
  const m = mergeSignedSeasonAccounts([a, a, a, a, a, forged, stranger, seatAnswer(3, [R1]), seatAnswer(4, [R1])], { seatsOf: DRAW, verify });
  assert.deepEqual(m.rounds, [], 'seats 1, 3, 4 only: 3 of 5 (seat 1 five times is seat 1 once)');
  assert.ok(m.excluded.some((x) => x.seat === seatKey(2) && /does not verify/.test(x.why)));
  assert.ok(m.excluded.some((x) => x.seat === seatKey(20) && /not of that round's draw/.test(x.why)));
  const five = mergeSignedSeasonAccounts([1, 3, 4, 5, 6].map((n) => seatAnswer(n, [R1])), { seatsOf: DRAW, verify });
  assert.deepEqual(five.rounds.map((r) => r.roundId), [R1.roundId]);
  assert.equal(five.evidence[0].sigs.length, 5);
});

test('the contract by id: another round\'s contract, another game or start than it names, or none at all - refused', () => {
  const other = roundContract({ gameId: GAME, startMs: T0, n: 9 });
  assert.match(seasonContractOf({ ...R1, contract: other.contract }).why, /another round/);
  assert.match(seasonContractOf({ ...R1, gameId: h(0x9b) }).why, /another game/);
  assert.match(seasonContractOf({ ...R1, startMs: R1.startMs + 1n }).why, /another time/);
  assert.match(seasonContractOf({ ...R1, contract: undefined }).why, /no contract/);
  // a contract its signers signed cannot be swapped: the account names the contract
  const k = seasonContractOf(R1);
  assert.equal(k.ok, true);
  const m = mergeSignedSeasonAccounts([1, 2, 3, 4, 5].map((n) => seatAnswer(n, [{ ...R1, startMs: R1.startMs + 1n }])), { seatsOf: DRAW, verify });
  assert.deepEqual(m.rounds, []);
});

test('an account is signed only once every entry is settled; names are not in it, round keys are', () => {
  const k = seasonContractOf(R1);
  assert.match(seasonAccountOf({ ...R1, entries: [en(A, null, h(0xa1))] }, k.body).why, /not settled/);
  const named = seasonAccountOf({ ...R1, entries: R1.entries.map((e) => ({ ...e, name: 'zed' })) }, k.body);
  assert.equal(Buffer.from(named.id).toString('hex'), Buffer.from(seasonAccountOf(R1, k.body).id).toString('hex'), 'a name changes nothing');
  const rekeyed = seasonAccountOf({ ...R1, entries: R1.entries.map((e) => (e.player === B ? { ...e, roundKey: B } : e)) }, k.body);
  assert.notEqual(Buffer.from(rekeyed.id).toString('hex'), Buffer.from(seasonAccountOf(R1, k.body).id).toString('hex'), 'a round key does');
  assert.equal(seatAnswer(1, [{ ...R1, entries: [en(A, null, h(0xa1))] }])[0].sigs.length, 0, 'a seat does not sign an unsettled round');
});

test('two accounts of one round each signed by the threshold: the round is left out, both kept as evidence; the evidence reads back the same', () => {
  const alt = { ...R1, entries: R1.entries.map((e) => (e.player === B ? { ...e, payoutMsat: S } : e)) };
  const m = mergeSignedSeasonAccounts([...[1, 2, 3, 4, 5].map((n) => seatAnswer(n, [R1])), ...[5, 6, 7, 8, 9].map((n) => seatAnswer(n, [alt]))], { seatsOf: DRAW, verify });
  assert.deepEqual(m.rounds, []);
  assert.equal(m.evidence.length, 2);
  assert.ok(m.excluded.some((x) => /signed two accounts/.test(x.why)));
  const ok = mergeSignedSeasonAccounts([1, 2, 3, 4, 5, 6].map((n) => seatAnswer(n, [R1, R2])), { seatsOf: DRAW, verify });
  const again = mergeSignedSeasonAccounts(evidenceAnswers(ok.evidence), { seatsOf: DRAW, verify });
  assert.deepEqual(again.rounds, ok.rounds);
  assert.deepEqual(again.pairs, ok.pairs);
  // a draw this seat cannot compute yet is pending, not refused
  const p = mergeSignedSeasonAccounts([seatAnswer(1, [R1])], { seatsOf: () => ({ ok: false, pending: true, why: 'still reading' }), verify });
  assert.deepEqual(p.pending, [R1.roundId]);
  assert.equal(seatSecret(1).length, 32);
});
