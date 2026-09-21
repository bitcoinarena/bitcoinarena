// A HOLD THAT CANNOT LAST UNTIL THE RESULT IS FINAL.
//
// Measured on the Daily before this rule existed: a paid round was driven to DELIVERED, its loser's stake
// was due to settle into the pool, and `lncli settleinvoice` came back "invoice already canceled". The
// HTLC had been accepted at height 93748 with expiry 93895 and lnd let it go at 93878 - seventeen blocks
// early - which was 730 s of hold against 830 s from acceptance to the window closing. No pool formed and
// no sat moved between the two players.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { holdCoversRound, cltvBlocksFor, finalSeconds, SETTLE_SAFETY_BLOCKS, CLOSE_SECONDS, HOLD_MARGIN,
  askableCltvBlocks, ROUTE_CLTV_BLOCKS, MAX_PAYABLE_CLTV_BLOCKS }
  from '../src/hold-window.js';
import { STAKE_EXPIRY_BLOCKS } from '../src/constants.js';
// The run length a round names, not the core's - this file is the protocol's, and the protocol names no game.
const BLOCK_TICKS = 10800;

const DAILY = { blockTicks: BLOCK_TICKS, objectionWindowMs: 600000n };

test('the round that lost is refused at the door, with its own numbers in the refusal', () => {
  // 144 blocks on the chain as it was running: the hold that was actually issued.
  const got = holdCoversRound({ secondsPerBlock: 730 / (144 - SETTLE_SAFETY_BLOCKS), cltvBlocks: 144, ...DAILY });
  assert.equal(got.ok, false);
  assert.equal(Math.round(got.holdSeconds), 730, 'the measured hold is not what the rule computes');
  assert.match(got.why, /lasts 730 s/);
  assert.match(got.why, /not final for \d+ s/);
  assert.match(got.why, /is not opened/);
});

test('a hold long enough passes, and says how long it is', () => {
  const secondsPerBlock = 1.74;
  const blocks = cltvBlocksFor({ secondsPerBlock, ...DAILY, floorBlocks: STAKE_EXPIRY_BLOCKS });
  const got = holdCoversRound({ secondsPerBlock, cltvBlocks: blocks, ...DAILY });
  assert.equal(got.ok, true, got.why);
  assert.ok(got.holdSeconds >= got.finalSeconds * HOLD_MARGIN * 0.99,
    `a hold sized by the rule should carry the margin: ${got.holdSeconds} against ${got.finalSeconds}`);
});

test('FINAL is the run, the close and the objection window - not one of them', () => {
  const s = finalSeconds(DAILY);
  assert.equal(s, BLOCK_TICKS / 60 + CLOSE_SECONDS + 600);
  assert.ok(s > 600, 'the window alone is not the whole wait');
});

test('a chain nobody has timed is a refusal, not a pass', () => {
  for (const bad of [undefined, 0, -1, NaN]) {
    const got = holdCoversRound({ secondsPerBlock: bad, cltvBlocks: 1000, ...DAILY });
    assert.equal(got.ok, false, String(bad));
    assert.match(got.why, /does not know how fast blocks are coming/);
  }
});

test('a hold no longer than what Lightning keeps back is refused before any arithmetic', () => {
  const got = holdCoversRound({ secondsPerBlock: 600, cltvBlocks: SETTLE_SAFETY_BLOCKS, ...DAILY });
  assert.equal(got.ok, false);
  assert.match(got.why, /is not longer than the 17 Lightning keeps back/);
});

test('on a chain with real blocks the protocol\'s own floor is what a hold gets', () => {
  // Ten-minute blocks: the arithmetic asks for a handful, and 144 is what keeps a mainnet hold a day long.
  const blocks = cltvBlocksFor({ secondsPerBlock: 600, ...DAILY, floorBlocks: STAKE_EXPIRY_BLOCKS });
  assert.equal(blocks, STAKE_EXPIRY_BLOCKS);
  assert.equal(holdCoversRound({ secondsPerBlock: 600, cltvBlocks: blocks, ...DAILY }).ok, true);
});

test('on a rehearsal chain the floor is nowhere near enough, and the arithmetic wins', () => {
  const blocks = cltvBlocksFor({ secondsPerBlock: 1.74, ...DAILY, floorBlocks: STAKE_EXPIRY_BLOCKS });
  assert.ok(blocks > STAKE_EXPIRY_BLOCKS * 5, `${blocks} blocks is not sized for a chain this fast`);
  console.log(`  1.74 s/block: FINAL needs ${Math.round(finalSeconds(DAILY))} s, so the hold is ${blocks} blocks`);
});

test('a faster chain needs more blocks, never fewer', () => {
  const slow = cltvBlocksFor({ secondsPerBlock: 4, ...DAILY, floorBlocks: STAKE_EXPIRY_BLOCKS });
  const fast = cltvBlocksFor({ secondsPerBlock: 1.74, ...DAILY, floorBlocks: STAKE_EXPIRY_BLOCKS });
  assert.ok(fast > slow, `${fast} against ${slow}: a chain going faster must be given more blocks`);
});

test('a longer objection window needs a longer hold', () => {
  const short = cltvBlocksFor({ secondsPerBlock: 2, blockTicks: BLOCK_TICKS, objectionWindowMs: 1000n, floorBlocks: STAKE_EXPIRY_BLOCKS });
  const long = cltvBlocksFor({ secondsPerBlock: 2, ...DAILY, floorBlocks: STAKE_EXPIRY_BLOCKS });
  assert.ok(long > short, `${long} against ${short}`);
});

// AND LIGHTNING'S OWN CEILING. Measured on the Daily the first time a hold was sized from the chain's pace:
// the node asked for 2044 blocks and alice would not pay it - "cltv limit 2016 should be greater than
// 2047" - so the stake was never held at all. An invoice nobody can pay is not a longer hold.
test('the ask never goes past what a payer will pay', () => {
  const blocks = cltvBlocksFor({ secondsPerBlock: 0.1, ...DAILY, floorBlocks: STAKE_EXPIRY_BLOCKS });
  assert.equal(blocks, askableCltvBlocks());
  assert.ok(blocks + ROUTE_CLTV_BLOCKS <= MAX_PAYABLE_CLTV_BLOCKS,
    'the ask plus the route must stay under the ceiling a payer enforces');
});

test('a chain too fast for any payable hold is refused at the door, not sold a hold that cannot be paid', () => {
  // 0.1 s a block: the ceiling buys 1976 * 0.1 = 198 s, and this round is not final for 1020.
  const blocks = cltvBlocksFor({ secondsPerBlock: 0.1, ...DAILY, floorBlocks: STAKE_EXPIRY_BLOCKS });
  const got = holdCoversRound({ secondsPerBlock: 0.1, cltvBlocks: blocks, ...DAILY });
  assert.equal(got.ok, false);
  assert.match(got.why, /is not opened/);
});

test('the Daily as it was measured: 0.755 s a block fits under the ceiling', () => {
  const secondsPerBlock = 0.755;
  const blocks = cltvBlocksFor({ secondsPerBlock, ...DAILY, floorBlocks: STAKE_EXPIRY_BLOCKS });
  const got = holdCoversRound({ secondsPerBlock, cltvBlocks: blocks, ...DAILY });
  console.log(`  0.755 s a block: ${blocks} blocks = ${Math.round(got.holdSeconds)} s of hold against ${Math.round(got.finalSeconds)} s to FINAL`);
  assert.equal(got.ok, true, got.why);
});
