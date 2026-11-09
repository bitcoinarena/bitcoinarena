// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1329 part 2 (§0A.7d RULED #1293): "a market on a game is capped at the source round's max_round_pool and its gross counts into the source
// committee's exposure" - two markets on one source round share its pool with the source round's own stakes. sourcePoolLeft is what every seat's
// order book is handed as the market's cap (server.js poolCapFor); the book takes orders in entry-id order while they fit under it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourcePoolLeft } from '../src/order-batch.js';

// the order book's rule (OrderBook intake): in entry-id order, an order is taken while the market's filled volume plus its stake fits the cap
const fill = (capSats, filledSats, orders) => { let f = BigInt(filledSats); const taken = [], refused = [];
  for (const o of orders) { if (f + BigInt(o) > BigInt(capSats)) refused.push(o); else { f += BigInt(o); taken.push(o); } } return { filled: f, taken, refused }; };

test('#1329 two markets on one source round share its pool: B gets what the source\'s stakes and A\'s fills left, and nothing past it', () => {
  const POOL = 64000n, SOURCE = 4000n;
  // market A fills first, under the pool less the source round's own stakes
  const capA = sourcePoolLeft({ poolSats: POOL, sourceStakesSats: SOURCE, othersFilledSats: [] });
  const A = fill(capA, 0n, [20000n, 25000n, 30000n]);
  // market B, asked after: the pool less the source's stakes and A's filled volume
  const capB = sourcePoolLeft({ poolSats: POOL, sourceStakesSats: SOURCE, othersFilledSats: [A.filled] });
  const B = fill(capB, 0n, [10000n, 9000n, 1000n]);
  // and A asked again: B's fills now count against it
  const capA2 = sourcePoolLeft({ poolSats: POOL, sourceStakesSats: SOURCE, othersFilledSats: [B.filled] });
  console.log('  MEASURED #1329:', JSON.stringify({ pool: String(POOL), source: String(SOURCE), capA: String(capA), A: { taken: A.taken.map(String), refused: A.refused.map(String) },
    capB: String(capB), B: { taken: B.taken.map(String), refused: B.refused.map(String) }, capA2: String(capA2), total: String(SOURCE + A.filled + B.filled) }));
  assert.equal(capA, 60000n);
  assert.deepEqual([A.taken, A.refused], [[20000n, 25000n], [30000n]]);
  assert.equal(capB, 15000n);
  assert.deepEqual([B.taken, B.refused], [[10000n, 1000n], [9000n]]);
  assert.equal(capA2, 49000n, 'A\'s cap does not count B');
  assert.ok(SOURCE + A.filled + B.filled <= POOL, 'the source committee holds more than its pool');
  assert.equal(SOURCE + A.filled + B.filled, 60000n);
});

test('#1329 a source already at its pool leaves nothing; over it, still nothing (never below 0)', () => {
  assert.equal(sourcePoolLeft({ poolSats: 64000n, sourceStakesSats: 64000n }), 0n);
  assert.equal(sourcePoolLeft({ poolSats: 64000n, sourceStakesSats: 50000n, othersFilledSats: [20000n] }), 0n);
  assert.deepEqual(fill(0n, 0n, [1n]).taken, []);
});
