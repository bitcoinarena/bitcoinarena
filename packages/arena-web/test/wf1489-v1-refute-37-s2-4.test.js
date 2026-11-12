// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 verify of #1534 (skeptic 2, variant 4): ONE SEAT STILL WRITES THE REFERRAL TABLE'S NAMES AND ROWS. The fees are by quorum
// now, but each program's name is "the newest any seat holds" by the seat's own unchecked atMs, and every site any one seat names in
// programs gets a row. fed2-7 renames a.example (atMs 9e15) and adds a made-up site to the public Metrics page. Safe: the name the honest
// seats hold ('A'), no row for a site no majority lists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { store, runOn } from './wf1489-v1-refute-37-s2-common.mjs';

test('#1534 variant: one seat does not rename a site or add one to the referral table', async () => {
  const env = store();
  const honest = { sites: [{ site: 'a.example', msat: '500000', payouts: 1 }], programs: [{ site: 'a.example', name: 'A', atMs: 1 }] };
  const bad = { sites: [{ site: 'a.example', msat: '500000', payouts: 1 }],
    programs: [{ site: 'a.example', name: 'Arena payouts moved: evil.example', atMs: 9e15 }, { site: 'evil.example', name: 'Official Arena', atMs: 9e15 }] };
  const m = await runOn(env, (seat, path) => (path.endsWith('/referral-fees') ? (seat === 'fed2-7' ? bad : honest) : undefined));
  console.log('  MEASURED referral:', JSON.stringify(m.referral));
  assert.equal(m.referral.sites.find((s) => s.site === 'a.example').name, 'A');
  assert.equal(m.referral.sites.some((s) => s.site === 'evil.example'), false);
});
