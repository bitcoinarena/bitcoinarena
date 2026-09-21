// THE THREE WAYS THE HALT CASE GETS GOT WRONG, EACH HELD DOWN BY A TEST.
//
// the owner 2026-09-21, the law of bc05268f: a slashed bond waits in escrow and never goes straight to
// anybody; on a halt every unspent note is paid at face value BEFORE a node or a developer sees a sat,
// and only what no player claimed is split 75/25; the exposure cap is four of the smallest bond and not
// the sum of ten; and a halt's abandonment proof cannot ask for attestations a halted federation no
// longer has. Each of these fails loudly if the old rule comes back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exposureCap, reserveFits, slashSplit, abandonmentProofNeeds, haltsAt,
  MAINNET_CLOCKS, liquidationSchedule, remainderMaySplit } from '../src/federation-slash.js';

const SAT = 1000n;
/** Ten guardians, 7 of 10, so f = 3. Nine at 1 000 000 sat and one at 400 000: the smallest is what counts. */
const TEN = [...new Array(9).fill(1000000n * SAT), 400000n * SAT];
const F = 3;

test('the cap is four of the SMALLEST bond, not the sum of all ten', () => {
  const said = exposureCap({ bonds: TEN, f: F });
  assert.equal(said.ok, true, said.why);
  assert.equal(said.halts, 4, 'at 7 of 10 it takes four gone to halt');
  assert.equal(said.smallest, 400000n * SAT);
  assert.equal(said.cap, 1600000n * SAT, 'the cap is 4 x the smallest bond');

  // THE OLD RULE, HELD DOWN: summing the ten would be 9 400 000 sat, nearly six times the cover that
  // actually exists if the cheapest four walk out.
  const summed = TEN.reduce((a, b) => a + b, 0n);
  assert.equal(summed, 9400000n * SAT);
  assert.notEqual(said.cap, summed, 'the cap went back to the sum of every bond');
  assert.ok(said.cap * 5n < summed, 'the sum is nearly six times the cap, and it is the wrong number');
});

test('a reserve above four of the smallest bond does not fit, however big the other nine are', () => {
  assert.equal(reserveFits({ reserve: 1600000n * SAT, bonds: TEN, f: F }).fits, true);
  const over = reserveFits({ reserve: 1600001n * SAT, bonds: TEN, f: F });
  assert.equal(over.fits, false, 'one msat over the cap was allowed');
  assert.equal(over.over, 1n * SAT);
  // And a reserve the SUM would have allowed is refused.
  assert.equal(reserveFits({ reserve: 9000000n * SAT, bonds: TEN, f: F }).fits, false,
    'a reserve only the sum-of-all-bonds rule would allow was accepted');
});

test('on a halt every note is paid at face value BEFORE a node or a developer sees a sat', () => {
  const bond = 1000000n * SAT;
  const said = slashSplit({ amountMsat: bond, halted: true, notesOwedMsat: 600000n * SAT });
  assert.equal(said.ok, true, said.why);
  assert.equal(said.notes, 600000n * SAT, 'the notes were not paid at face value first');
  // The order is the rule: only what no player claimed is split, and it is the REMAINDER that is split.
  const rest = bond - said.notes;
  assert.equal(said.nodes, (rest * 75n) / 100n, 'the nodes were not paid out of the remainder');
  assert.equal(said.developers, rest - (rest * 75n) / 100n);
  assert.equal(said.nodes + said.developers, rest, 'the split did not come out of the remainder');
  assert.ok(said.nodes < (bond * 75n) / 100n,
    'the nodes were paid as if the whole bond were theirs - the notes were not taken off first');
  assert.equal(said.notes + said.nodes + said.developers + said.burned, bond, 'the bond did not add up');
});

test('a short escrow goes entirely to the notes, pro rata, and pays nobody else at all', () => {
  const bond = 500000n * SAT;
  const said = slashSplit({ amountMsat: bond, halted: true, notesOwedMsat: 900000n * SAT });
  assert.equal(said.proRata, true);
  assert.equal(said.notes, bond, 'every msat of a short escrow goes to the notes');
  assert.equal(said.nodes, 0n, 'a node was paid while a player was still short');
  assert.equal(said.developers, 0n, 'a developer was paid while a player was still short');
  assert.equal(said.burned, 0n);
});

test('a federation that kept running still pays 75 to the nodes and 25 to the developers', () => {
  const said = slashSplit({ amountMsat: 1000000n * SAT, halted: false });
  assert.equal(said.nodes, 750000n * SAT);
  assert.equal(said.developers, 250000n * SAT);
  assert.equal(said.notes, 0n, 'a running federation pays no notes out of a bond');
  assert.equal(said.burned, 0n);
});

test('a halt proof asks for whoever is left plus the halt, never for 2f + 1', () => {
  const running = abandonmentProofNeeds({ f: F });
  assert.equal(running.attestations, 7, 'a running federation of 10 needs 7');
  assert.equal(running.needsHaltFact, false);

  // A HALTED federation of ten has at most three seated - that is what halted means - so demanding
  // seven is demanding something that cannot exist.
  const halted = abandonmentProofNeeds({ f: F, halted: true, seated: 3 });
  assert.equal(halted.needsHaltFact, true, 'the halt itself is part of the proof');
  assert.equal(halted.attestations, 3, 'a halt proof asked for more attestations than the federation has');
  assert.ok(halted.attestations < 2 * F + 1, 'the halt proof still demands a running federation\'s quorum');

  // And with nobody left it is the halt alone, not an impossibility.
  const none = abandonmentProofNeeds({ f: F, halted: true, seated: 0 });
  assert.equal(none.attestations, 0);
  assert.equal(none.needsHaltFact, true);
});

test('testnet at 2 of 2: f is 0, one leaver halts it, and his one bond pays every note', () => {
  assert.equal(haltsAt(0), 1);
  const two = exposureCap({ bonds: [50000n * SAT, 50000n * SAT], f: 0 });
  assert.equal(two.cap, 50000n * SAT, 'at 2 of 2 the cap is one bond');
});

test('the clocks are the ruled ones, in blocks', () => {
  assert.equal(MAINNET_CLOCKS.claimBlocks, 216, '36 h of claim window');
  assert.equal(MAINNET_CLOCKS.abandonBlocks, 288, '48 h to abandonment');
  assert.equal(MAINNET_CLOCKS.departureNotice, 432, '72 h of notice');
  assert.equal(MAINNET_CLOCKS.foundingWindow, 432, '72 h to finish a DKG');
  assert.equal(MAINNET_CLOCKS.drainBlocks, 2016, 'two weeks of drain, and the late-claim tail');
});

test('a late note is still paid, and the remainder cannot be split before the tail runs out', () => {
  const halt = 900000;
  const when = liquidationSchedule({ haltHeight: halt });
  assert.equal(when.claimWindowCloses, halt + 216);
  assert.equal(when.lateClaimsUntil, halt + 2016, 'late claims run to two weeks after the halt');
  assert.equal(when.remainderSplitsAt, halt + 2016);

  // THE WHOLE POINT: the window closing is NOT when the nodes get paid.
  assert.equal(remainderMaySplit({ haltHeight: halt, atHeight: halt + 216 }).may, false,
    'the remainder was split the moment the claim window closed, with the late tail still running');
  assert.equal(remainderMaySplit({ haltHeight: halt, atHeight: halt + 2015 }).may, false);
  assert.equal(remainderMaySplit({ haltHeight: halt, atHeight: halt + 2016 }).may, true);
});
