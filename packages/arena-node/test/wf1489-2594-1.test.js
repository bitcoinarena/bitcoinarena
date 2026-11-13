// kanban #2594 (#1489 market audit): ONE DUST SELL MUST NOT KEEP A SCALAR BOOK FROM SETTLING.
// bookSettlement split a scalar book's pool into two FLOORED parts per entry: an entry holding a complete set (1 LONG + 1 SHORT
// share, worth ~1 msat together) got floor(lr) + floor(sr) = 0 at any value between the bounds. An entry that bought the
// other side with a sell at a high limit owes its sell debt out of that set, so its out went below zero, the table threw,
// #bookPlan claimed no lock and every filled order - the honest winners' too - waited for its lock's expiry: a 2 msat trade
// turns a losing book into a refund for everyone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bookLedger, bookSettlement } from '../../arena-protocol/src/book-ledger.js';

const id = (c) => c.repeat(64);
const A = id('a'), B = id('b'), C = id('c'), X = id('f'), XS = id('e');

function ledger() {
  const order = (oid, outcome, price, stakeMsat) => ({ id: oid, outcome, price, stakeMsat, feeMsat: 0n, expiryMs: 0n });
  return bookLedger({ feeBps: 0, batches: [
    // honest A (LONG) and B (SHORT) trade 100 / 102 sets at 50c; the attacker X buys 2 LONG shares for 1 msat
    { k: 1, cutoffMs: 1n, orders: [order(A, 0, 50000n, 50n), order(B, 1, 50000n, 51n), order(X, 0, 50000n, 1n)], cancels: [], sells: [] },
    // X sells its 2 LONG at 1c (buys 2 SHORT at 99c); C (the attacker's other key, or anyone) buys them at 1c
    { k: 2, cutoffMs: 2n, orders: [order(C, 0, 1000n, 1n)], cancels: [], sells: [{ id: XS, entry: X, outcome: 0, price: 1000n, sharesMsat: 2n }] },
  ] });
}

test('#2594 a scalar book with a dust sell settles at a value between its bounds, every out >= 0, balanced', () => {
  const L = ledger();
  assert.deepEqual(L.refused, []);
  assert.deepEqual(L.positions.get(X).shares, [2n, 2n]);
  assert.equal(L.positions.get(X).sellDebt, 2n);
  const scalar = { value: 4n, bounds: { low: 0n, high: 10n } };
  let t;
  assert.doesNotThrow(() => { t = bookSettlement({ positions: L.positions, outcome: null, scalar }); });
  assert.equal(t.claimed.length, 4);
  for (const r of t.claimed) assert.ok(r.outMsat >= 0n, `${r.entry.slice(0, 4)} out ${r.outMsat}`);
  assert.equal(t.claimed.reduce((s, r) => s + r.outMsat, 0n) + t.feesDueMsat, t.claimed.reduce((s, r) => s + r.stakeMsat + r.feeMsat, 0n));
  // B (SHORT, 60 % of the way down) is paid more than it staked
  assert.ok(t.claimed.find((r) => r.entry === B).outMsat > 51n);
});

test('#2594 every value from low to high settles that book, and no entry is paid more than the pool', () => {
  const L = ledger();
  for (let v = -2n; v <= 12n; v++) {
    const t = bookSettlement({ positions: L.positions, outcome: null, scalar: { value: v, bounds: { low: 0n, high: 10n } } });
    for (const r of t.claimed) assert.ok(r.outMsat >= 0n && r.winMsat <= t.poolMsat, `value ${v}: ${r.entry.slice(0, 4)} out ${r.outMsat}`);
  }
});
