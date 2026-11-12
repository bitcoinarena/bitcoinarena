// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2086 (after #1526/#1933/#1969): the kept BookLedgerState - grown one certified batch at a time, with batches tried on top and
// undone in between - answers what bookLedger over the same batches answers, to the msat and in the same order (positions, every
// batch's fills, the refused, what rests and the levels), on random books with buys, sells (partly filled, too large, twice), cancels
// and expiries; a batch on top that throws leaves the kept state as it was.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bookLedger, BookLedgerState } from '../src/book-ledger.js';
import { YES, NO, PRICE_SCALE } from '../src/order-book.js';

const show = (L) => JSON.stringify({ positions: [...L.positions], batches: L.batches, refused: L.refused, ...('resting' in L ? { resting: L.resting, levels: L.levels } : {}) },
  (k, v) => (typeof v === 'bigint' ? `${v}n` : v));
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function randomBook(r, { nb, ticks }) {
  const id = (p, n) => (p + n.toString(16)).padStart(64, '0');
  const price = () => (ticks ? BigInt(1 + Math.floor(r() * 99)) * 1000n : BigInt(1 + Math.floor(r() * Number(PRICE_SCALE - 1n))));
  const entries = [];
  let ns = 0;
  const batches = [];
  for (let k = 0; k < nb; k++) {
    const orders = [], sells = [], cancels = [];
    const no = Math.floor(r() * 4);
    for (let i = 0; i < no; i++) {
      const e = id('a', entries.length); entries.push(e);
      const sat = BigInt(1 + Math.floor(r() * 500));
      orders.push({ id: e, outcome: r() < 0.5 ? YES : NO, price: price(), stakeMsat: sat * 1000n, feeMsat: r() < 0.1 ? 0n : sat * 10n,
        expiryMs: r() < 0.2 ? BigInt(k + 1 + Math.floor(r() * 5)) * 500n : 0n });
    }
    if (entries.length && r() < 0.1) orders.push({ id: entries[Math.floor(r() * entries.length)], outcome: YES, price: 50000n, stakeMsat: 1000n, feeMsat: 0n, expiryMs: 0n });
    const nsell = Math.floor(r() * 12);
    for (let i = 0; i < nsell && entries.length; i++) {
      const e = entries[Math.floor(r() * entries.length)];
      const sid = r() < 0.05 && ns ? id('5e', Math.floor(r() * ns)) : id('5e', ns++);
      sells.push({ id: sid, entry: r() < 0.05 ? id('ff', i) : e, outcome: r() < 0.5 ? YES : NO, price: price(), sharesMsat: BigInt(1 + Math.floor(r() * (r() < 0.5 ? 50 : 400000))) });
    }
    if (entries.length && r() < 0.15) cancels.push(entries[Math.floor(r() * entries.length)]);
    if (r() < 0.03) cancels.push(id('cc', k));
    batches.push({ k, cutoffMs: BigInt(k + 1) * 500n, orders, cancels, sells });
  }
  return batches;
}

test('kanban #2086: the kept ledger, grown and tried on top, is bookLedger over the same batches, on 300 random books', () => {
  let tried = 0, fills = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const r = rng(seed + 7000);
    const batches = randomBook(r, { nb: 5 + Math.floor(r() * 30), ticks: seed % 3 !== 0 });
    const feeBps = [0, 100, 250][seed % 3];
    const st = new BookLedgerState({ feeBps });
    for (let i = 0; i < batches.length; i++) {
      let want, wantErr = null;
      try { want = bookLedger({ batches: batches.slice(0, i + 1), feeBps }); } catch (e) { wantErr = e.message; }
      const before = show(st.result());
      // a batch on top, twice, and a random other batch on top: none of it stays
      for (let t = 0; t < 2; t++) {
        let got, gotErr = null;
        try { got = st.onTop(batches[i]); } catch (e) { gotErr = e.message; }
        assert.equal(gotErr, wantErr, `seed ${seed} batch ${i}: the error on top`);
        if (want) assert.equal(show(got), show({ positions: want.positions, batches: want.batches, refused: want.refused }), `seed ${seed} batch ${i}: on top`);
        assert.equal(show(st.result()), before, `seed ${seed} batch ${i}: on top left the kept state as it was`);
        tried++;
      }
      try { st.onTop(batches[Math.floor(r() * batches.length)]); } catch { /* a throw is undone too */ }
      assert.equal(show(st.result()), before, `seed ${seed} batch ${i}: another batch on top left the kept state as it was`);
      if (wantErr) break;
      st.apply(batches[i]);
      assert.equal(show(st.result()), show(want), `seed ${seed} batch ${i}: kept`);
      fills += want.batches[i].fills.length;
    }
  }
  console.log('COVERED', JSON.stringify({ tried, fills }));
  assert.ok(fills > 500);
});

test('kanban #2086: a batch on top costs its own work, not the resting history (200,000 resting sells)', () => {
  const id = (p, n) => (p + n.toString(16)).padStart(64, '0');
  const st = new BookLedgerState({ feeBps: 100 });
  st.apply({ k: 0, cutoffMs: 500n, orders: [{ id: id('a', 0), outcome: YES, price: 60000n, stakeMsat: 100_000_000n, feeMsat: 1_000_000n, expiryMs: 0n },
    { id: id('a', 1), outcome: NO, price: 50000n, stakeMsat: 100_000_000n, feeMsat: 1_000_000n, expiryMs: 0n }], cancels: [], sells: [] });
  let n = 0;
  for (let k = 1; k <= 200; k++) {
    const sells = [];
    for (let i = 0; i < 1000; i++) sells.push({ id: id('5e', n++), entry: id('a', 0), outcome: YES, price: 99000n, sharesMsat: 1n });
    st.apply({ k, cutoffMs: BigInt(k + 1) * 500n, orders: [], cancels: [], sells });
  }
  assert.equal(st.result().resting.sells.length, 200000);
  const extra = { k: 201, cutoffMs: 201n * 500n, orders: [], cancels: [], sells: [{ id: id('5e', n++), entry: id('a', 0), outcome: YES, price: 99000n, sharesMsat: 1n }] };
  let t0 = performance.now();
  for (let i = 0; i < 10; i++) assert.equal(st.onTop(extra).refused.length, 0);
  const onTop = (performance.now() - t0) / 10;
  t0 = performance.now(); st.apply(extra); const grow = performance.now() - t0;
  console.log('MEASURED', JSON.stringify({ resting: st.result().resting.sells.length, onTopMs: onTop, growMs: grow }));
  assert.ok(onTop + grow < 50, `a batch costs ${onTop + grow} ms over 200,000 resting sells`);
});
