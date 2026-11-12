// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 verify of #1534 (variant 2): ONE SEAT STILL ADDS 21M BTC TO THE RESERVE UNDER A FEDERATION ONLY IT NAMES. The median is
// taken over "the seats that report it", so a federation id one seat makes up has a median of that seat's own value, and the shown
// reserve is the sum over all federations. Safe: a federation fewer than a quorum of seats report adds nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWith, FED } from './wf1489-v1-refute-37-common.mjs';

test('#1534 variant: a federation only one seat names does not add to the reserve', async () => {
  const bad = { federations: [{ federationId: FED, heldMsat: '1000000', paidIn: [] }, { federationId: 'ab'.repeat(32), heldMsat: '2100000000000000000', paidIn: [] }] };
  const { m } = await runWith((seat, path) => (seat === 'fed2-7' && path.endsWith('/reserves') ? bad : undefined));
  console.log('  MEASURED reserve:', JSON.stringify(m.reserve));
  assert.equal(m.reserve.msat, '1000000', 'one seat\'s made-up federation is not summed into the reserve');
});
