// THE BOARD AFTER A ROUND, AND IT DECIDES NOTHING.
//
// 0.11: "Derived from signed final protocol results... THE LEADERBOARD IS
// PRESENTATION, NOT AUTHORITY."
//
// Two things have to hold. It must not become a second scoring path - section
// 20 makes `computePayoutTable` the authority, and a board that produced
// amounts would be a second one. And every node must show the SAME board:
// "identical inputs produce identical results on every machine" covers the
// screen two players compare, and an order that depended on which results
// arrived first would let a node put whoever it liked at the top without
// forging anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toHex } from '../src/hash.js';
import { resultId, RESULTS_FOR_FINAL } from '../src/result.js';
import { DELIVERED, FAILED, FORFEIT, VOID } from '../src/payout.js';
import { leaderboard, NOT_ON_A_FINAL } from '../src/leaderboard.js';
import { computePayoutTable } from '../src/payout.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const COMMITTEE = [1, 2, 3, 4, 5, 6, 7].map((n) => b32(0xc0 + n));
const contract = { nodes: COMMITTEE };

const resultFor = (player, score, outcome = DELIVERED) => ({
  roundId: b32(1), playerPubkey: b32(player), outcome, score,
  transcriptHash: b32(3), simCoreHash: b32(4), nodePubkey: COMMITTEE[0],
});

/** A row whose result `signers` committee members have signed. */
const row = (player, score, outcome = DELIVERED, signers = RESULTS_FOR_FINAL) => {
  const result = resultFor(player, score, outcome);
  const id = resultId(result);
  return {
    result,
    signedBy: COMMITTEE.slice(0, signers).map((nodePubkey) => ({ resultId: id, nodePubkey })),
  };
};

/**
 * THE SAME BOARD, WHATEVER ORDER THE RESULTS ARRIVED IN.
 */
test('every node builds the same rows in the same order', () => {
  const rows = [row(0x21, 500), row(0x22, 900), row(0x23, 700), row(0x24, 100)];

  const board = leaderboard(rows, { contract });
  assert.equal(board.ok, true, board.why);
  assert.deepEqual(board.rows.map((r) => r.score), [900, 700, 500, 100]);
  assert.deepEqual(board.rows.map((r) => r.rank), [1, 2, 3, 4]);
  assert.deepEqual(board.rows.map((r) => r.playerPubkey[0]), [0x22, 0x23, 0x21, 0x24]);

  for (const order of [[...rows].reverse(), [rows[2], rows[0], rows[3], rows[1]],
                       [rows[3], rows[2], rows[1], rows[0]]]) {
    const again = leaderboard(order, { contract });
    assert.deepEqual(again.rows.map((r) => toHex(r.playerPubkey)),
      board.rows.map((r) => toHex(r.playerPubkey)),
      'the order the results arrived in changed the board');
    assert.deepEqual(again.rows.map((r) => r.rank), board.rows.map((r) => r.rank));
  }
});

/**
 * AND A TIE IS BROKEN BY THE KEY, not by which result was handed over first.
 * A stable sort keeps the INPUT order, and the input order is exactly what
 * must not decide a rank.
 */
test('two players on the same score are ordered by their keys, not by arrival', () => {
  const tied = [row(0x99, 700), row(0x33, 700), row(0x66, 700)];

  const one = leaderboard(tied, { contract }).rows.map((r) => r.playerPubkey[0]);
  const two = leaderboard([...tied].reverse(), { contract }).rows.map((r) => r.playerPubkey[0]);

  assert.deepEqual(one, [0x33, 0x66, 0x99], 'a tie was not broken by the key');
  assert.deepEqual(one, two, 'three players on one score were ranked by luck');
});

/**
 * A RESULT THE COMMITTEE HAS NOT MADE FINAL DOES NOT APPEAR. 13's threshold is
 * what makes a result a result; showing the others would put a node's opinion
 * beside a committee's decision as though they were the same kind of thing.
 */
test('an under-signed or unsigned result is not on the board, and is named', () => {
  const rows = [row(0x21, 900), row(0x22, 800, DELIVERED, 4), row(0x23, 700, DELIVERED, 0)];

  const board = leaderboard(rows, { contract });
  assert.deepEqual(board.rows.map((r) => r.playerPubkey[0]), [0x21]);
  assert.equal(board.excluded.length, 2);
  assert.match(board.excluded[0].why, /has not made that result final: 4 of 5/);
  assert.match(board.excluded[1].why, /nobody has signed a result/);

  // four is not five, and five is
  assert.equal(leaderboard([row(0x21, 900, DELIVERED, 4)], { contract }).rows.length, 0);
  assert.equal(leaderboard([row(0x21, 900, DELIVERED, 5)], { contract }).rows.length, 1);

  // A SIGNATURE FROM OFF THE COMMITTEE IS NOT A SIGNATURE. Five strangers are
  // not five seats, however many of them there are.
  const stranger = row(0x24, 600);
  stranger.signedBy = [1, 2, 3, 4, 5].map((n) => ({
    resultId: stranger.signedBy[0].resultId, nodePubkey: b32(0xf0 + n),
  }));
  const outside = leaderboard([stranger], { contract });
  assert.equal(outside.rows.length, 0, 'five signatures from off the committee made a result final');
  assert.match(outside.excluded[0].why, /came from elsewhere/);

  // and the committee is the ROUND's: a caller cannot bring one
  assert.match(leaderboard(rows, { contract: {} }).why, /names no committee/);
  assert.match(leaderboard(rows, {}).why, /names no committee/);
});

/**
 * A REFUND IS NOT A PLACE. Section 18: "VOID and ENTRY_VOID entries neither
 * contribute to nor draw from the pool", so ranking one last would put a
 * refunded player below one who lost and the board would say something the
 * money does not.
 *
 * FORFEIT ranks: `isRefund` covers VOID and ENTRY_VOID and not FORFEIT, and
 * the payout table puts a forfeit's stake into the loser pool. It played and
 * lost, which is a place.
 */
test('a void run is shown without a rank, and a forfeit keeps one', () => {
  const rows = [row(0x21, 900), row(0x22, 800, VOID), row(0x23, 700, FORFEIT),
                row(0x24, 600, FAILED)];

  const board = leaderboard(rows, { contract });
  const by = (n) => board.rows.find((r) => r.playerPubkey[0] === n);

  assert.equal(by(0x21).rank, 1);
  assert.equal(by(0x23).rank, 2, 'a forfeit lost its place');
  assert.equal(by(0x24).rank, 3);
  assert.equal(by(0x22).rank, null, 'a refunded run was given a place');
  assert.equal(board.ranked, 3);

  // the unranked come after the ranked, and among themselves by key
  const twoVoid = leaderboard([row(0x99, 100, VOID), row(0x21, 900), row(0x33, 200, VOID)],
    { contract });
  assert.deepEqual(twoVoid.rows.map((r) => r.rank), [1, null, null]);
  assert.deepEqual(twoVoid.rows.slice(1).map((r) => r.playerPubkey[0]), [0x33, 0x99]);
});

/**
 * THE BOARD DECIDES NOTHING. No amount, no payout, no field that could be
 * mistaken for one - section 20's table is the authority and a second thing
 * producing numbers would be a second scoring path.
 */
test('the board carries no money and names what a final cannot tell it', () => {
  const board = leaderboard([row(0x21, 900), row(0x22, 800)], { contract });

  for (const r of board.rows) {
    assert.deepEqual(Object.keys(r).sort(),
      ['outcome', 'playerPubkey', 'rank', 'score', 'signers'],
      'the board grew a column');
    for (const key of Object.keys(r))
      assert.equal(/payout|amount|msat|sat|prize|winnings/i.test(key), false,
        `the board carries ${key}, which reads like money`);
  }

  assert.deepEqual(board.unchecked, NOT_ON_A_FINAL);
  assert.equal(board.unchecked.length, 3);
  assert.match(board.unchecked[0], /pseudonym/);
  assert.match(board.unchecked[1], /cargo statistics/);
  assert.match(board.unchecked[2], /live run status/);

  // an empty round is a board with no rows, not a refusal
  assert.deepEqual(leaderboard([], { contract }).rows, []);
  assert.match(leaderboard(undefined, { contract }).why, /no results/);
  assert.equal(leaderboard([{}, { result: null }], { contract }).excluded.length, 2);
});

/**
 * WHAT EACH PLAYER WAS PAID, AND THE BOARD DID NOT WORK IT OUT.
 *
 * Section 20 makes the table F(contract, membership, results). The board is
 * not handed a table - there is no argument for one - it is handed the INPUTS
 * and calls the one implementation, so a forged table cannot be passed at all.
 * That is the same shape as the core's missing ghost parameter: the guarantee
 * is the absence.
 */
test('the board shows each player\'s payout from the round\'s own table', () => {
  const rows = [row(0x21, 900), row(0x22, 800), row(0x23, 700, FAILED)];
  const entries = [
    { pubkey: b32(0x21), stakeMsat: 100000n, outcome: DELIVERED, score: 900 },
    { pubkey: b32(0x22), stakeMsat: 100000n, outcome: DELIVERED, score: 800 },
    { pubkey: b32(0x23), stakeMsat: 100000n, outcome: FAILED, score: 700 },
  ];

  const board = leaderboard(rows, { contract, payout: { entries, minScore: 1 } });
  assert.equal(board.ok, true, board.why);

  // the amounts are the table's, key for key
  const table = computePayoutTable({ entries, minScore: 1 });
  const owed = new Map(table.table.map((r) => [r.pubkey[0], r.amountMsat]));
  for (const r of board.rows)
    assert.equal(r.payoutMsat, owed.get(r.playerPubkey[0]),
      `the board paid ${r.playerPubkey[0].toString(16)} something the table did not`);

  // AND ZERO IS A PAID AMOUNT. The loser is in the table at 0n, and that must
  // read differently from a player the table does not list at all.
  const loser = board.rows.find((r) => r.playerPubkey[0] === 0x23);
  assert.equal(loser.payoutMsat, 0n, 'the loser is not shown as paid nothing');
  assert.equal('payoutMsat' in loser, true);

  // shuffled input: same rows, same amounts
  const again = leaderboard([...rows].reverse(), { contract, payout: { entries, minScore: 1 } });
  assert.deepEqual(again.rows.map((r) => [r.playerPubkey[0], r.rank, r.payoutMsat]),
    board.rows.map((r) => [r.playerPubkey[0], r.rank, r.payoutMsat]));

  // and payout is a COLUMN, not a sort key: the order is the same with and
  // without it
  const noMoney = leaderboard(rows, { contract });
  assert.deepEqual(noMoney.rows.map((r) => r.playerPubkey[0]),
    board.rows.map((r) => r.playerPubkey[0]), 'money moved somebody');
  assert.equal('payoutMsat' in noMoney.rows[0], false,
    'a board with no payout inputs invented a column');

  // A FIXTURE WHERE THE TWO ORDERS DISAGREE, because one where they agree
  // measures nothing: a FAILED run with the HIGHEST score is ranked first and
  // paid nothing, while a lower-scoring delivery is ranked second and paid.
  const crossed = [row(0x31, 900, FAILED), row(0x32, 500)];
  const crossedEntries = [
    { pubkey: b32(0x31), stakeMsat: 100000n, outcome: FAILED, score: 900 },
    { pubkey: b32(0x32), stakeMsat: 100000n, outcome: DELIVERED, score: 500 },
  ];
  const mixed = leaderboard(crossed, { contract, payout: { entries: crossedEntries, minScore: 1 } });

  assert.deepEqual(mixed.rows.map((r) => r.playerPubkey[0]), [0x31, 0x32],
    'the board was ordered by money rather than by score');
  assert.equal(mixed.rows[0].payoutMsat, 0n, 'the top of the board was paid');
  assert.ok(mixed.rows[1].payoutMsat > 0n, 'the paid player is not paid');
});

/**
 * A PLAYER THE TABLE DOES NOT LIST HAS NO AMOUNT FIELD - not zero. A refunded
 * run is not in the table at all (section 18: it neither contributes nor
 * draws), and "not in the table" must stay distinguishable from "paid
 * nothing".
 */
test('a refunded player has no amount, while a player paid nothing has zero', () => {
  const rows = [row(0x21, 900), row(0x22, 800, VOID), row(0x23, 700, FAILED)];
  const entries = [
    { pubkey: b32(0x21), stakeMsat: 100000n, outcome: DELIVERED, score: 900 },
    { pubkey: b32(0x22), stakeMsat: 100000n, outcome: VOID, score: 800 },
    { pubkey: b32(0x23), stakeMsat: 100000n, outcome: FAILED, score: 700 },
  ];

  const board = leaderboard(rows, { contract, payout: { entries, minScore: 1 } });
  const by = (n) => board.rows.find((r) => r.playerPubkey[0] === n);

  assert.equal('payoutMsat' in by(0x22), false, 'a refunded run was given an amount');
  assert.equal(by(0x22).rank, null);
  assert.equal(by(0x23).payoutMsat, 0n);
  assert.equal('payoutMsat' in by(0x23), true, 'paid nothing was shown as not in the table');
});

/**
 * THE INPUTS HAVE TO BE THIS ROUND'S. An entry claiming a better outcome or
 * score than the committee made final would pay somebody for a run they did
 * not have - and a caller cannot pass a table instead, because there is no
 * argument for one.
 */
test('a payout input that disagrees with the final results is refused', () => {
  const rows = [row(0x21, 900), row(0x22, 800, FAILED)];
  const honest = [
    { pubkey: b32(0x21), stakeMsat: 100000n, outcome: DELIVERED, score: 900 },
    { pubkey: b32(0x22), stakeMsat: 100000n, outcome: FAILED, score: 800 },
  ];
  assert.equal(leaderboard(rows, { contract, payout: { entries: honest, minScore: 1 } }).ok, true);

  const promoted = honest.map((e, i) => (i === 1 ? { ...e, outcome: DELIVERED } : e));
  assert.match(leaderboard(rows, { contract, payout: { entries: promoted, minScore: 1 } }).why,
    /says DELIVERED for a player whose final result is FAILED/);

  const inflated = honest.map((e, i) => (i === 1 ? { ...e, score: 9999 } : e));
  assert.match(leaderboard(rows, { contract, payout: { entries: inflated, minScore: 1 } }).why,
    /scores a player 9999 where the final says 800/);

  const stranger = [...honest, { pubkey: b32(0x99), stakeMsat: 100000n, outcome: DELIVERED, score: 999 }];
  assert.match(leaderboard(rows, { contract, payout: { entries: stranger, minScore: 1 } }).why,
    /counts a player the committee has made no result final for/);

  // AN AMOUNT WRITTEN ON THE CALLER'S OWN OBJECTS IS IGNORED, the same way an
  // injected rank is: the board reads the table it computed, not the object.
  const lied = honest.map((e) => ({ ...e, amountMsat: 999999999n, payoutMsat: 999999999n }));
  const board = leaderboard(rows, { contract, payout: { entries: lied, minScore: 1 } });
  assert.equal(board.ok, true, board.why);
  for (const r of board.rows)
    assert.notEqual(r.payoutMsat, 999999999n, 'an amount written on the input reached the board');

  assert.match(leaderboard(rows, { contract, payout: {} }).why, /names no entries/);
  assert.match(leaderboard(rows, { contract, payout: { entries: [{}] } }).why, /names no player/);
});
