// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 verify of #1534 (variant 1): ONE SEAT STILL SETS THE RESERVE BY REPEATING ITS ROW. readMetrics pushes every row of every
// seat's /reserves into the federation's list with no "one value per seat", so one seat that lists the same federation 14 times with
// 21M BTC outnumbers the 13 honest seats and the median is its value. Safe: one seat counts once per federation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWith, FED } from './wf1489-v1-refute-37-common.mjs';

test('#1534 variant: one seat repeating its federation row does not set the reserve', async () => {
  const bad = { federations: Array.from({ length: 14 }, () => ({ federationId: FED, heldMsat: '2100000000000000000', paidIn: [] })) };
  const { m } = await runWith((seat, path) => (seat === 'fed2-7' && path.endsWith('/reserves') ? bad : undefined));
  console.log('  MEASURED reserve:', JSON.stringify(m.reserve));
  assert.equal(m.reserve.msat, '1000000', 'the reserve 13 seats agree on, not one seat\'s 21M BTC repeated 14 times');
});
