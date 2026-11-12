// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 verify of #1534 (variant 4): ONE OF THE THREE HISTORY SEATS STILL ADDS 21M BTC TO THE RESERVE HISTORY. readReserveHistory
// takes per federation the median over the seats that report that federation: a federation id only one history seat (guardian-1) names
// has that seat's paidIn as its median, and it is summed into every day's held reserve. Safe: the held reserve is the honest 1000000.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWith, FED } from './wf1489-v1-refute-37-common.mjs';

const day = new Date(Date.now() - 2 * 86400000).toISOString();
const honest = { federations: [{ federationId: FED, heldMsat: '1000000', paidIn: [{ at: day, amountMsat: '1000000' }] }] };
test('#1534 variant: a federation only one history seat names does not enter the reserve history', async () => {
  const bad = { federations: [...honest.federations, { federationId: 'ab'.repeat(32), heldMsat: '0', paidIn: [{ at: day, amountMsat: '2100000000000000000' }] }] };
  const { m } = await runWith((seat, path, u) => (path.endsWith('/reserves') && u.searchParams.get('all') === '1' ? (seat === 'guardian-1' ? bad : honest) : undefined));
  const h = m.reserveHistory;
  console.log('  MEASURED history:', JSON.stringify(h));
  assert.equal(h.days[h.days.length - 1].heldMsat, '1000000', 'the reserve history is not one seat\'s 21M BTC');
});
