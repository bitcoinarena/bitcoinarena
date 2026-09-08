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
import { roundId } from '../src/contracts.js';
import { DELIVERED, FAILED, FORFEIT, VOID } from '../src/payout.js';
import {
  leaderboard, NOT_ON_A_FINAL, SIGNATURES_NOT_VERIFIED,
} from '../src/leaderboard.js';
import { computePayoutTable } from '../src/payout.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const COMMITTEE = [1, 2, 3, 4, 5, 6, 7].map((n) => b32(0xc0 + n));

/**
 * A WHOLE ROUND CONTRACT, because the board now asks it which round it is of
 * and `roundId` hashes the encoded contract - a stub with only `nodes` has no
 * id, and a board that cannot name its round refuses to build.
 */
const contract = {
  networkId: b32(0x4e), configHash: b32(0x43), censusConfirmations: 6,
  gameVerifySlots: 7, settlementSlots: 7, simCoreHash: b32(1),
  startTimeMs: 1000n, entryCloseMs: 2000n, objectionWindowMs: 600000n,
  custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'BURN',
  donationSetId: b32(0xd0), censusHeight: 900000,
  censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n,
  bondMinSats: 50000n, blockTicks: 600, exposureReference: 1000,
  corridorHalfWidth: 40, spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150,
  minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: COMMITTEE,
};
const ROUND = roundId(contract);

const resultFor = (player, score, outcome = DELIVERED) => ({
  roundId: ROUND, playerPubkey: b32(player), outcome, score,
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

  assert.deepEqual(board.unchecked, [SIGNATURES_NOT_VERIFIED, ...NOT_ON_A_FINAL]);
  assert.equal(board.unchecked.length, 4);
  assert.match(board.unchecked[0], /committee signatures/);
  assert.match(board.unchecked[1], /pseudonym/);
  assert.match(board.unchecked[2], /cargo statistics/);
  assert.match(board.unchecked[3], /live run status/);

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

/**
 * THE ONE THING THAT DECIDES WHETHER A ROW APPEARS, NAMED AS UNCHECKED.
 *
 * `provisionallyFinal` counts `{ resultId, nodePubkey }` pairs against the
 * round's committee; it does not verify a signature, because this package
 * carries no curve. That boundary is right. What was wrong is that the board
 * did not SAY so: five entries in an array were counted as five committee
 * signatures and the answer came back looking exactly like a verified one,
 * while every other door here names its curve boundary.
 */
test('the board says it counted signatures rather than verifying them', () => {
  const rows = [row(0x21, 900), row(0x22, 800)];
  const board = leaderboard(rows, { contract });

  assert.equal(board.unchecked[0], SIGNATURES_NOT_VERIFIED);
  assert.match(board.unchecked[0], /counted against the round's committee, not verified/);
  assert.match(board.unchecked[0], /no curve in this package/);

  // A CALLER THAT HAS CHECKED CAN SAY SO, and it changes the report and
  // nothing else: the claim is about the caller's own work, not about the
  // data, so the rows, the order and the amounts are byte for byte the same.
  const checked = leaderboard(rows, { contract, signaturesVerified: true });
  assert.deepEqual(checked.unchecked, NOT_ON_A_FINAL);
  assert.equal(checked.unchecked.length, 3);
  assert.equal(checked.unchecked.some((u) => /committee signatures/.test(u)), false);

  assert.deepEqual(checked.rows, board.rows, 'the claim moved a row');
  assert.equal(checked.ranked, board.ranked);
  assert.deepEqual(checked.excluded, board.excluded);

  // and with payouts in play it is still only the report that moves
  const entries = [
    { pubkey: b32(0x21), stakeMsat: 100000n, outcome: DELIVERED, score: 900 },
    { pubkey: b32(0x22), stakeMsat: 100000n, outcome: DELIVERED, score: 800 },
  ];
  const paid = leaderboard(rows, { contract, payout: { entries, minScore: 1 } });
  const paidChecked = leaderboard(rows,
    { contract, payout: { entries, minScore: 1 }, signaturesVerified: true });
  assert.deepEqual(paidChecked.rows, paid.rows, 'the claim moved a payout');
  assert.equal(paid.unchecked.length, 4);
  assert.equal(paidChecked.unchecked.length, 3);
});

/**
 * THE THREE FIELDS A FINAL CANNOT SUPPLY: nobody can slip one in, and the
 * board says what would fill each and what stands in the way.
 *
 * A reason alone is half an answer. "Not on a final" tells a caller not to
 * expect the column; it does not say whether anyone is coming for it, which is
 * the difference between a decision somebody owes and a task somebody forgot.
 */
test('pseudonym, cargo and live status cannot be injected, and each names its blocker', () => {
  // a result and a row dressed with all three, plus a caller's own guesses
  const dressed = {
    ...resultFor(0x21, 900),
    pseudonym: 'brave-otter-4711', cargoDelivered: 99, liveStatus: 'driving',
  };
  const id = resultId(dressed);
  const rows = [{
    result: dressed,
    signedBy: COMMITTEE.slice(0, RESULTS_FOR_FINAL).map((nodePubkey) => ({ resultId: id, nodePubkey })),
    pseudonym: 'injected', cargoDelivered: 1, liveStatus: 'winning',
  }];

  // A SECOND RUNNER, ONE THE CARGO WOULD OVERTAKE. 900 is behind 950, and
  // 900 + 99 cargo is ahead of it: if any of the three fields reached the
  // ordering, these two would swap.
  rows.push(row(0x22, 950));

  const board = leaderboard(rows, { contract });
  assert.equal(board.ok, true, board.why);
  assert.deepEqual(Object.keys(board.rows[1]).sort(),
    ['outcome', 'playerPubkey', 'rank', 'score', 'signers'],
    'the board grew a column from something a caller wrote');
  for (const k of ['pseudonym', 'cargoDelivered', 'liveStatus'])
    assert.equal(k in board.rows[1], false, `${k} leaked onto the row`);

  // and the dressing moved nothing: same rows, same order, same ranks, as the
  // two plain results
  const plain = leaderboard([row(0x21, 900), row(0x22, 950)], { contract });
  assert.deepEqual(board.rows, plain.rows, 'a field a final cannot carry moved a row');
  assert.deepEqual(board.rows.map((r) => [toHex(r.playerPubkey).slice(0, 2), r.rank]),
    [['22', 1], ['21', 2]], 'the cargo count overtook a higher score');

  // EACH NOTICE NAMES A SOURCE AND A BLOCKER
  const [pseudonym, cargo, live] = NOT_ON_A_FINAL;
  assert.match(pseudonym, /the player key on the row/);
  assert.match(pseudonym, /custom name is local browser storage/);
  assert.match(cargo, /comes from REPLAYING the transcript/);
  assert.match(cargo, /M2\.3/);
  assert.match(live, /marks and ghosts/);
  assert.match(live, /BLOCKED ON 22/);

  // they are reported in the same shape as the committee-signature notice
  assert.equal(board.unchecked.length, 4);
  assert.equal(board.unchecked[0], SIGNATURES_NOT_VERIFIED);
  assert.deepEqual(board.unchecked.slice(1), NOT_ON_A_FINAL);
  for (const u of board.unchecked) assert.equal(typeof u, 'string');
});

/**
 * A BOARD IS OF ONE ROUND.
 *
 * Section 1: "All accepted players belong to the SAME logical round and payout
 * pool." Two rounds' finals are both perfectly well signed - by two different
 * committees - so the finality check has nothing to object to. Interleaved,
 * they would give a player who came third of four a rank of seventh of eight,
 * with no signature forged anywhere.
 */
test("a final from another round is not on this round's board, and is named", () => {
  // the same committee, a different round: one field moves, so the id moves.
  // It used to be `committeeSeed` - a field that no longer exists, since the
  // seed is derived from the beacon - so the round moves by its committee time
  // instead, which is a field section 6 actually names.
  const other = { ...contract, committeeTimeMs: contract.committeeTimeMs + 1n };
  const OTHER = roundId(other);
  assert.notDeepEqual(OTHER, ROUND, 'the two contracts hashed the same');

  const foreign = (player, score) => {
    const result = { ...resultFor(player, score), roundId: OTHER };
    const rid = resultId(result);
    return {
      result,
      signedBy: COMMITTEE.slice(0, RESULTS_FOR_FINAL).map((nodePubkey) => ({ resultId: rid, nodePubkey })),
    };
  };

  const mine = [row(0x21, 900), row(0x22, 700), row(0x23, 500)];
  const mixed = leaderboard([...mine, foreign(0x30, 800), foreign(0x31, 100)], { contract });

  assert.equal(mixed.ok, true, mixed.why);
  assert.deepEqual(mixed.rows.map((r) => r.playerPubkey[0]), [0x21, 0x22, 0x23],
    'a foreign round was ranked beside this one');
  assert.deepEqual(mixed.rows.map((r) => r.rank), [1, 2, 3]);

  // identical to the board this round's finals produce on their own
  assert.deepEqual(mixed.rows, leaderboard(mine, { contract }).rows,
    "another round's finals moved this round's ranks");

  // and both are named, not silently dropped
  assert.equal(mixed.excluded.length, 2);
  for (const e of mixed.excluded)
    assert.match(e.why, /final for a different round than this contract/);

  // THE ROUND IS COMPUTED, NOT CLAIMED: a result cannot carry a round id it
  // likes, and there is no argument through which a caller names the round.
  const lying = row(0x24, 950);
  lying.result = { ...lying.result, roundId: b32(0xaa) };
  assert.equal(leaderboard([lying], { contract }).rows.length, 0);

  // AND THE FOREIGN PLAYER IS ABSENT, NOT PAID NOTHING. A pool that counts
  // them is refused outright: they have no final in this round, so there is
  // nobody to check the entry against.
  const stake = { stakeMsat: 100000n, outcome: DELIVERED };
  const ours = [0x21, 0x22, 0x23].map((n, i) => ({ pubkey: b32(n), ...stake, score: [900, 700, 500][i] }));
  const paid = leaderboard([...mine, foreign(0x30, 800)], { contract, payout: { entries: ours, minScore: 1 } });
  assert.equal(paid.ok, true, paid.why);
  assert.equal(paid.rows.length, 3);
  assert.equal(paid.rows.every((r) => typeof r.payoutMsat === 'bigint'), true);
  assert.equal(paid.rows.some((r) => r.playerPubkey[0] === 0x30), false);

  const counted = { entries: [...ours, { pubkey: b32(0x30), ...stake, score: 800 }], minScore: 1 };
  assert.match(leaderboard([...mine, foreign(0x30, 800)], { contract, payout: counted }).why,
    /counts a player the committee has made no result final for/);

  // A ROUND ID WRITTEN ON THE CONTRACT OBJECT IS NOT THE CONTRACT'S ROUND.
  // The id comes from the bytes; an attacker who could name it would name the
  // foreign round and merge the two boards after all.
  const claimed = leaderboard([...mine, foreign(0x30, 800)], { contract: { ...contract, roundId: OTHER } });
  assert.deepEqual(claimed.rows.map((r) => r.playerPubkey[0]), [0x21, 0x22, 0x23],
    'a roundId field on the contract chose which round the board was of');

  // a contract with a committee but no round to hash refuses to build a board
  const stub = leaderboard(mine, { contract: { nodes: COMMITTEE } });
  assert.equal(stub.ok, false);
  assert.match(stub.why, /cannot be hashed, so there is no round/);
});

/**
 * AND A PLAYER APPEARS ONCE.
 *
 * The same final twice is a repeat. Two different finals for one player is a
 * committee contradicting itself, which section 14 settles and a board does
 * not: showing the better of the two would let whoever collected a second
 * signature set choose a rank.
 */
test('one final per player: a repeat is dropped, and two contradicting finals show neither', () => {
  const base = [row(0x21, 900), row(0x22, 800), row(0x23, 700)];
  const plain = leaderboard(base, { contract });
  assert.deepEqual(plain.rows.map((r) => [r.playerPubkey[0], r.rank]),
    [[0x21, 1], [0x22, 2], [0x23, 3]]);

  // THE SAME FINAL TWICE: one row, and the ranks below it do not move
  const twice = leaderboard([base[0], base[1], base[0], base[2]], { contract });
  assert.equal(twice.rows.length, 3, 'one player took two rows');
  assert.deepEqual(twice.rows, plain.rows, 'a repeat moved a rank');
  assert.equal(twice.rows[2].rank, 3, 'the third key was pushed to fourth by a repeat');
  assert.equal(twice.excluded.length, 1);
  assert.match(twice.excluded[0].why, /handed in more than once/);

  // TWO DIFFERENT FINALS FOR ONE KEY: neither is shown, and the board says why
  const conflict = leaderboard([...base, row(0x21, 950)], { contract });
  assert.deepEqual(conflict.rows.map((r) => r.playerPubkey[0]), [0x22, 0x23],
    'the board picked between two finals for one player');
  assert.equal(conflict.excluded.length, 1);
  assert.match(conflict.excluded[0].why, /two different results are final for that player/);

  // A CONTRADICTED REFUND COMES OFF TOO. VOID rows are shown without a rank,
  // which is a different list, and a player contradicted there is no more
  // decidable than one contradicted in the ranks.
  const voided = leaderboard([...base,
    row(0x24, 300, VOID), row(0x24, 400, VOID)], { contract });
  assert.equal(voided.rows.some((r) => r.playerPubkey[0] === 0x24), false,
    'a contradicted refund stayed on the board');
  assert.equal(voided.excluded.filter((e) => /two different results/.test(e.why)).length, 1);

  // TWO CONTRADICTED PLAYERS ARE NAMED IN KEY ORDER, not arrival order: two
  // nodes handed the same rows differently shuffled report the same list, and
  // not merely the same rows.
  const pairA = [row(0x22, 850), row(0x21, 950), ...base];
  const pairB = [...base, row(0x21, 950), row(0x22, 850)];
  const namesOf = (b) => b.excluded.filter((e) => /two different results/.test(e.why))
    .map((e) => e.playerPubkey[0]);
  assert.deepEqual(namesOf(leaderboard(pairA, { contract })), [0x21, 0x22]);
  assert.deepEqual(namesOf(leaderboard(pairB, { contract })), [0x21, 0x22]);

  // and it does not matter which order the two arrived in
  const reversed = leaderboard([row(0x21, 950), ...base], { contract });
  assert.deepEqual(reversed.rows, conflict.rows, 'arrival order chose between two finals');
  assert.deepEqual(reversed.excluded.map((e) => e.why), conflict.excluded.map((e) => e.why));
});
