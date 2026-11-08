// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1282 (§5A.10 RULED 2026-11-07, #1280): "max_round_pool <= income_seat (the lower of this and the table wins)"; no season behind it: the lowest bracket.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { incomeSeatSats, ceilingWithIncome, stakeWithinCeiling, maxRoundPoolSats, LOWEST_BRACKET_SATS } from '../src/census-health.js';

// a census the table puts at the 1,000 sat bracket: 25 nodes in both roles, bonded 100 x 1,000 x 64
const census = Array.from({ length: 25 }, () => ({ roles: ['game', 'settlement'], bondSats: 260000n }));
const rounds = (n, stakeSats) => Array.from({ length: n }, () => ({ entries: [{ stakeMsat: BigInt(stakeSats) * 1000n }, { stakeMsat: BigInt(stakeSats) * 1000n }] }));

test('#1282 income_seat from a season with known fees; the bracket is the lower of the table and the income term; a young network plays 10 sat', () => {
  // 2,000 rounds of two 1,000 sat stakes: 4,000,000 sat staked, 5 % node fee = 200,000 sat, over 25 seats = 8,000 sat a seat
  const income = incomeSeatSats({ rounds: rounds(2000, 1000), censusSize: 25 });
  const voidRound = incomeSeatSats({ rounds: [{ void: true, entries: [{ stakeMsat: 1000000000n }] }], censusSize: 25 });
  const table = stakeWithinCeiling({ entries: census, stakeSats: 1000 });
  const bounded = stakeWithinCeiling({ entries: census, stakeSats: 1000, incomeSats: income });
  const young = stakeWithinCeiling({ entries: census, stakeSats: 10, incomeSats: 0n });
  const youngOver = stakeWithinCeiling({ entries: census, stakeSats: 11, incomeSats: 0n });
  const rich = ceilingWithIncome({ ceilingSats: 1000n, incomeSats: 10_000_000n });
  const pool = maxRoundPoolSats({ entries: census, stakeSats: 100, incomeSats: income });
  const got = { income: String(income), voidRound: String(voidRound), table: String(table.ceilingSats), bounded: [String(bounded.ceilingSats), bounded.ok], young: [young.ok, String(young.ceilingSats)], youngOver: youngOver.ok, rich: String(rich), pool: String(pool) };
  console.log('  MEASURED #1282:', JSON.stringify(got));
  assert.equal(income, 8000n);
  assert.equal(voidRound, 0n, 'a VOID round refunds every stake: no fee');
  assert.equal(table.ceilingSats, 1000n);
  assert.equal(bounded.ceilingSats, 125n, '8,000 sat a seat over 64 players: 125 sat a stake');
  assert.equal(bounded.ok, false, 'a 1,000 sat round is over it');
  assert.deepEqual([young.ok, young.ceilingSats], [true, LOWEST_BRACKET_SATS]);
  assert.equal(youngOver.ok, false);
  assert.equal(rich, 1000n, 'a large income leaves the table\'s bracket');
  assert.equal(pool, 125n * 64n);
  assert.equal(stakeWithinCeiling({ entries: census, stakeSats: 1000 }).ceilingSats, 1000n, 'no income given: the table alone, as before');
});
