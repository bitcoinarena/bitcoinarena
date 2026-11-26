// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Audit faucet a8-2-1 (kanban #3744, gap in #1534/#1821/#2059): byQuorum takes the median msat over all seats, but the row it serves is the FIRST
// seat's row whose msat equals that median - so its `payouts` is that one seat's word. guardian-1 (SEATS[0]) sends the honest msat with payouts
// 987654 and the Metrics page shows it for the site. Safe: the payouts shown are what the honest seats say (1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWith } from './wf1489-v1-refute-37-common.mjs';

const honest = { sites: [{ site: 'a.example', msat: '500000', payouts: 1 }], programs: [] };
test('a8-2-1: one seat that copies a site fee does not set its payouts count', async () => {
  const bad = { sites: [{ site: 'a.example', msat: '500000', payouts: 987654 }], programs: [] };
  const { m } = await runWith((seat, path) => (path.endsWith('/referral-fees') ? (seat === 'guardian-1' ? bad : honest) : undefined));
  console.log('  MEASURED referral:', JSON.stringify(m.referral));
  assert.equal(m.referral.msat, '500000');
  assert.equal(m.referral.sites[0].payouts, 1);
});
