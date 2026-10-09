// "BITCOIN UP OR DOWN - 15 MINUTES", the Polymarket rule (kanban #278): Up if the window's TWAP >= the price at its start.
import test from 'node:test';
import assert from 'node:assert/strict';
import { upDownWindow, upDownPrices, upDownOutcome, UP, DOWN, UP_DOWN_OUTCOMES } from '../src/up-down.js';

const T = 1791598500000n;   // 2026-10-10T02:15:00Z, the start of polymarket.com/event/btc-updown-15m-1791598500
const MIN = 60000n;
const at = (m, price) => ({ atMs: T + BigInt(m) * MIN, price: BigInt(price) });

test('the window is the quarter hour; Up when the TWAP is at or above the price to beat - a tie is Up', () => {
  assert.deepEqual(upDownWindow(T + 7n * MIN), { startMs: T, endMs: T + 15n * MIN });
  assert.deepEqual(UP_DOWN_OUTCOMES, ['Up', 'Down']);
  const w = upDownWindow(T);
  // price to beat 7399900 (cents: $73,999.00); 1 min at it, 10 min at +$1.00, 4 min at -$2.50 -> TWAP $73,999.00 exactly: a tie, Up
  const tie = upDownOutcome([at(-1, 7399900), at(0, 7399900), at(1, 7400000), at(11, 7399650)], w);
  console.log('  TIE:', JSON.stringify({ beat: String(tie.priceToBeat), twap: String(tie.twap), label: tie.label }));
  assert.equal(tie.priceToBeat, 7399900n);
  assert.equal(tie.twap, 7399900n);
  assert.equal(tie.outcome, UP);
  // one cent less in the last 5 minutes: Down
  assert.equal(upDownOutcome([at(0, 7399900), at(1, 7400000), at(11, 7399649)], w).outcome, DOWN);
  // the reading in force at the start is the price to beat (a reading before it), and order of samples does not matter
  const shuffled = upDownPrices([at(5, 7500000), at(-3, 7000000)], w);
  assert.equal(shuffled.priceToBeat, 7000000n);
  assert.equal(shuffled.twap, (7000000n * 5n + 7500000n * 10n) / 15n);
  // a reading after the window does not count; no reading at the start decides nothing
  assert.equal(upDownPrices([at(0, 100), at(15, 1)], w).twap, 100n);
  assert.match(upDownOutcome([at(1, 7400000)], w).why, /price to beat is not known/);
});
