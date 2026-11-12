// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 v1 refute 41 (#1526 fix 7936d0767): THE SELL FLOOD STILL STALLS EVERY SEAT, ONE BATCH AT A TIME.
// The fix bounds the sells of one order WAITING for a batch at a seat (MAX_UNBATCHED_SELLS = 16) and asks that the order is tradable.
// It does not bound the sells that REST in the book: an order that filled once (a real but small lock) posts 16 tiny sells (1 msat,
// price 0.99 - nothing crosses them) at each of the 7 seats every batch (BATCH_MS 500 ms). Each batch carries them, the ledger keeps
// them resting, the waiting count drops to 0 and the next 16 are taken. bookLedger - which every seat replays from batch 0 on every
// ledger() call (each POST /sell through #sellBacked, each lead(), each accept/#check, each settlement) - sums `offered` over ALL
// resting sells for every new sell (O(S^2)) and clears every batch over all resting sells. Two minutes of that, one lock:
import test from 'node:test';
import assert from 'node:assert/strict';
import { bookLedger } from '../src/book-ledger.js';
import { YES, NO, BATCH_MS } from '../src/order-book.js';

const id = (s) => s.padStart(64, '0');
const o = (name, outcome, cents, sat) => ({ id: id(name), outcome, price: BigInt(cents) * 1000n, stakeMsat: BigInt(sat) * 1000n, feeMsat: BigInt(sat) * 10n, expiryMs: 0n });

test('wf1489 v1 refute 41-1: resting tiny sells, 16 per seat per batch (what the fixed door takes), make one ledger replay stall', () => {
  const SEATS = 7, PER = 16;                       // MAX_UNBATCHED_SELLS at each seat, all batched each interval
  const MINUTES = 2, NB = Math.floor((MINUTES * 60000) / Number(BATCH_MS));
  const batches = [{ k: 0, cutoffMs: 0n, orders: [o('a', YES, 60, 200), o('b', NO, 45, 200)] }];   // A fills once
  let n = 0;
  for (let k = 1; k <= NB; k++) {
    const sells = [];
    for (let i = 0; i < SEATS * PER; i++, n++) sells.push({ id: id('5e11' + n.toString(16)), entry: id('a'), outcome: YES, price: 99000n, sharesMsat: 1n });
    batches.push({ k, cutoffMs: BigInt(k) * BATCH_MS, sells });
  }
  const t0 = Date.now();
  const L = bookLedger({ batches, feeBps: 100 });
  const ms = Date.now() - t0;
  console.log('MEASURED', JSON.stringify({ batches: NB, sellsPosted: n, resting: L.resting.sells.length, refused: L.refused.length, ledgerMs: ms }));
  assert.ok(L.resting.sells.length > 20000, 'the sells did not rest (the setup is wrong)');
  // one ledger() replay is synchronous on the seat's event loop and runs per POST /sell, per lead(), per accept
  assert.ok(ms < 1000, `one bookLedger replay over ${L.resting.sells.length} resting sells took ${ms} ms`);
});
