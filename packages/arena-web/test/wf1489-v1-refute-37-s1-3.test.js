// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 verify of #1534 (variant 3): ONE SEAT STILL SETS THE WEBSITES' REFERRAL FEES. The same two holes as the reserve: a site
// row repeated 14 times by one seat takes the median, and a site only one seat names keeps its own value and is summed into the total.
// Safe: the total referral fee is what the 13 honest seats agree on (500000 msat for site a.example).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWith } from './wf1489-v1-refute-37-common.mjs';

const honest = { sites: [{ site: 'a.example', msat: '500000', payouts: 1 }], programs: [] };
test('#1534 variant: one seat repeating a site row does not set its referral fee', async () => {
  const bad = { sites: Array.from({ length: 14 }, () => ({ site: 'a.example', msat: '2100000000000000000', payouts: 9 })), programs: [] };
  const { m } = await runWith((seat, path) => (path.endsWith('/referral-fees') ? (seat === 'fed2-7' ? bad : honest) : undefined));
  console.log('  MEASURED referral (repeat):', JSON.stringify(m.referral));
  assert.equal(m.referral.msat, '500000');
});
test('#1534 variant: a site only one seat names does not add to the referral fees', async () => {
  const bad = { sites: [...honest.sites, { site: 'evil.example', msat: '2100000000000000000', payouts: 9 }], programs: [] };
  const { m } = await runWith((seat, path) => (path.endsWith('/referral-fees') ? (seat === 'fed2-7' ? bad : honest) : undefined));
  console.log('  MEASURED referral (made-up site):', JSON.stringify(m.referral));
  assert.equal(m.referral.msat, '500000');
});
