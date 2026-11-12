// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 verify of #1534: the honest paths the fix touches - a reserve read with a stale (lower) seat, seats that are down, a fee
// with payouts, numeric heldMsat, and the reserve history from three agreeing seats.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWith, FED } from './wf1489-v1-refute-37-common.mjs';

test('#1534 honest: a stale seat and two silent seats leave the honest reserve and fee', async () => {
  const { m } = await runWith((seat, path) => {
    if (seat === 'guardian-3' || seat === 'guardian-4') return null;
    if (path.endsWith('/reserves')) return { federations: [{ federationId: FED, heldMsat: seat === 'fed2-1' ? 400000 : '1000000', paidIn: [] }] };
    if (path.endsWith('/referral-fees')) return { sites: [{ site: 'a.example', msat: '500000', payouts: 3 }], programs: [{ site: 'a.example', name: 'A', atMs: 1 }] };
    return undefined;
  });
  console.log('  MEASURED:', JSON.stringify({ reserve: m.reserve, referral: m.referral }));
  assert.equal(m.reserve.msat, '1000000');
  assert.equal(m.referral.msat, '500000');
  assert.equal(m.referral.sites[0].payouts, 3);
  assert.equal(m.referral.sites[0].name, 'A');
});
test('#1534 honest: the reserve history from three agreeing seats', async () => {
  const day = new Date(Date.now() - 2 * 86400000).toISOString();
  const { m } = await runWith((seat, path, u) => (path.endsWith('/reserves') && u.searchParams.get('all') === '1'
    ? { federations: [{ federationId: FED, heldMsat: '1500000', paidIn: [{ at: day, amountMsat: '1000000' }, { at: day, amountMsat: 500000 }] }] } : undefined));
  const h = m.reserveHistory;
  console.log('  MEASURED history:', JSON.stringify(h.days.slice(-1)));
  assert.equal(h.days[h.days.length - 1].heldMsat, '1500000');
});
