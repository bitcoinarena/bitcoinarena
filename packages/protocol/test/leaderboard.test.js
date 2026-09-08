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
