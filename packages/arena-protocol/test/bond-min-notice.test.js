// BOND_MIN CHANGES WITH NOTICE (§27A.3, kanban #300): a fall at once; a rise once it held the whole notice; a rise in two steps in two
// steps; and a node the rise will pass is told at T-30d, T-14d, T-3d and T+0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bondMinInForce, bondMinWarning } from '../src/bond-min-notice.js';

const N = 144;
const h = (...xs) => xs.map(([height, median]) => ({ height, median }));

test('a fall at once; a rise after the notice; two steps in two; a rise undone before its notice never applies', () => {
  assert.equal(bondMinInForce(h([100, 80000n], [150, 60000n]), 150, N).inForce, 60000n, 'a fall applies at once');
  const rise = h([100, 50000n], [200, 80000n], [210, 80000n]);
  const before = bondMinInForce(rise, 250, N);
  assert.equal(before.inForce, 50000n); assert.deepEqual(before.pending, { value: 80000n, crossedAt: 200, effectiveAt: 344 });
  assert.equal(bondMinInForce(rise, 343, N).inForce, 50000n);
  assert.equal(bondMinInForce(rise, 344, N).inForce, 80000n);
  const two = h([100, 50000n], [200, 80000n], [260, 90000n]);
  assert.equal(bondMinInForce(two, 344, N).inForce, 80000n); assert.equal(bondMinInForce(two, 344, N).pending.effectiveAt, 404);
  assert.equal(bondMinInForce(two, 404, N).inForce, 90000n);
  assert.equal(bondMinInForce(h([100, 50000n], [200, 80000n], [250, 40000n]), 400, N).inForce, 40000n, 'undone, and lower: at once');
});

test('the node the rise passes is told at T-30d, T-14d, T-3d and T+0; one whose bond holds it is told nothing', () => {
  const pending = { value: 80000n, crossedAt: 1000, effectiveAt: 1000 + 4320 };          // 30 days of 10-min blocks
  const at = (daysLeft) => bondMinWarning({ pending, ownBondSats: 60000n, nowHeight: pending.effectiveAt - Math.round(daysLeft * 144) });
  assert.equal(at(29).step, 'T-30d'); assert.match(at(29).says, /keeps every round below that floor/);
  assert.equal(at(10).step, 'T-14d'); assert.match(at(10).says, /20000 sat short/);
  assert.equal(at(2).step, 'T-3d'); assert.equal(at(2).urgent, true); assert.match(at(2).says, /last point/);
  assert.equal(at(0).step, 'T+0'); assert.match(at(0).says, /not an eviction/);
  assert.equal(at(40), null, 'beyond 30 days nothing yet');
  assert.equal(bondMinWarning({ pending, ownBondSats: 90000n, nowHeight: 2000 }), null);
});

test('the median history a seat holds: one census per height, its bond-weighted median, ascending; then the floor in force (kanban #300)', async () => {
  const { medianHistory, bondMinInForce, NOTICE_BLOCKS } = await import('../src/bond-min-notice.js');
  const { bondWeightedMedian } = await import('../src/census-median.js');
  const node = (bond, declared) => ({ bondSats: bond, advert: { declares: { bondMinSats: declared } } });
  const rounds = [
    { censusHeight: 300, entries: [node(100000n, 80000n), node(100000n, 80000n), node(50000n, 50000n)] },
    { censusHeight: 100, entries: [node(100000n, 50000n), node(100000n, 50000n)] },
    { censusHeight: 300, entries: [node(1n, 1n)] },
    { censusHeight: 200, entries: [] },
  ];
  const h = medianHistory(rounds, bondWeightedMedian);
  assert.deepEqual(h.map((x) => [x.height, x.median]), [[100, 50000n], [300, 80000n]], 'the first census per height; one with no declarations gives none');
  assert.deepEqual(NOTICE_BLOCKS, { mainnet: 4320, testnet4: 144, testnet: 144, regtest: 10 });
  const f = bondMinInForce(h, 300, NOTICE_BLOCKS.testnet4);
  assert.deepEqual([f.inForce, f.pending.value, f.pending.effectiveAt], [50000n, 80000n, 444]);
});
