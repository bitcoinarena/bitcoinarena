// "BITCOIN UP OR DOWN - 15 MINUTES", the Polymarket rule (kanban #278, #236): Up if the 60 s average at the window's end is
// at or above the 60 s average at its start (Chainlink's "TWAP 60 s" stream, read at both ends).
import test from 'node:test';
import assert from 'node:assert/strict';
import { upDownWindow, upDownPrices, upDownOutcome, UP, DOWN, UP_DOWN_OUTCOMES } from '../src/up-down.js';

const T = 1791598500000n;   // 2026-10-10T02:15:00Z, the start of polymarket.com/event/btc-updown-15m-1791598500
const S = 1000n;
const at = (sec, price) => ({ atMs: T + BigInt(sec) * S, price: BigInt(price) });

test('the window is the quarter hour; Up when the end price is at or above the price to beat - a tie is Up', () => {
  assert.deepEqual(upDownWindow(T + 420n * S), { startMs: T, endMs: T + 900n * S });
  assert.deepEqual(UP_DOWN_OUTCOMES, ['Up', 'Down']);
  const w = upDownWindow(T);
  // the minute before the start: 30 s at $73,999.00 and 30 s at $74,001.00 -> price to beat $74,000.00
  const startMinute = [at(-60, 7399900), at(-30, 7400100)];
  // the minute before the end averages exactly $74,000.00 -> a tie, Up
  const tie = upDownOutcome([...startMinute, at(100, 9000000), at(840, 7399800), at(870, 7400200)], w);
  assert.equal(tie.priceToBeat, 7400000n);
  assert.equal(tie.endPrice, 7400000n);
  assert.equal(tie.outcome, UP);
  // one cent less at the end: Down - however high the window stood in between
  assert.equal(upDownOutcome([...startMinute, at(100, 9000000), at(840, 7399800), at(870, 7400199)], w).outcome, DOWN);
});

test('end versus start, not the window\'s average: the two live windows the whole-window average got wrong (comment 1154)', () => {
  const w = upDownWindow(T);
  // a late rise: the window averages below its start, the end is above it -> Up (Polymarket 16:00-16:15: Up)
  const lateRise = [at(-60, 8280748), at(0, 8277000), at(820, 8285589)];
  assert.equal(upDownOutcome(lateRise, w).label, 'Up');
  // a window that averages above its start and closes $6.12 below it -> Down (Polymarket 16:30-16:45: Down)
  const closesBelow = [at(-60, 8265419), at(10, 8272000), at(840, 8264807)];
  assert.equal(upDownOutcome(closesBelow, w).label, 'Down');
});

test('order does not matter; a reading after the end does not count; no reading before a moment decides nothing', () => {
  const w = upDownWindow(T);
  const shuffled = upDownPrices([at(870, 7500000), at(-90, 7000000)], w);
  assert.equal(shuffled.priceToBeat, 7000000n);
  assert.equal(shuffled.endPrice, (7000000n * 30n + 7500000n * 30n) / 60n);
  assert.equal(upDownPrices([at(-60, 100), at(900, 1)], w).endPrice, 100n);
  assert.match(upDownOutcome([at(-10, 7400000)], w).why, /price to beat is not known/);
});
