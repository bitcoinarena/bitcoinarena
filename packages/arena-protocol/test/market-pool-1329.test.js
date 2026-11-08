// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1329 (§0A.7b RULED 2026-11-07, #1293): "a seat refuses an order once the round's filled volume plus the order would exceed max_round_pool of
// its census ... Before this a book round could hold a thousand 100,000-sat orders under a committee bonded for a 1,000-sat bracket."
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maxRoundPoolSats, orderWithinPool, MAX_PLAYERS_PER_ROUND } from '../src/census-health.js';
import { NETWORK_ID_TESTNET4 } from '../src/genesis-ids.js';

// 30 nodes in both roles, 6,400,000 sat bonded each role: the 1,000-sat row (25 nodes, 100 x 1,000 x 64 = 6,400,000)
const entries = Array.from({ length: 30 }, () => ({ roles: ['game', 'settlement'], bondSats: 213334n }));
test('#1329 orders past max_round_pool are refused; a test network shows the ceiling and refuses nothing', () => {
  const pool = maxRoundPoolSats({ entries, stakeSats: 100000n });
  const filled = 1000n * 63n;
  const got = { pool: String(pool), next1000: orderWithinPool({ filledSats: filled, orderSats: 1000n, poolSats: pool }),
    next100000: orderWithinPool({ filledSats: filled, orderSats: 100000n, poolSats: pool }),
    thousandOrders: orderWithinPool({ filledSats: 999n * 100000n, orderSats: 100000n, poolSats: pool }),
    testnet: maxRoundPoolSats({ entries, stakeSats: 100000n, networkId: NETWORK_ID_TESTNET4 }) };
  console.log('  MEASURED #1329:', JSON.stringify(got));
  assert.equal(pool, 1000n * MAX_PLAYERS_PER_ROUND, 'the pool is the bracket times the players a round holds');
  assert.equal(got.next1000, true);
  assert.equal(got.next100000, false, 'an order past the pool was taken');
  assert.equal(got.thousandOrders, false);
  assert.equal(got.testnet, null);
});
