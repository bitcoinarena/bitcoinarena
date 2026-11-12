// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 verify of #1534 (skeptic 2): honest re-reads - a later 5-minute read with two silent seats and a newer honest reserve, and
// the hourly history re-read, each replace the kept figures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { store, runOn, FED } from './wf1489-v1-refute-37-s2-common.mjs';

test('#1534 honest: re-reads update the reserve and its history', async () => {
  const env = store();
  assert.equal((await runOn(env, () => undefined, 0)).reserve.msat, '1000000');
  const m = await runOn(env, (seat, path) => (path.endsWith('/reserves') ? (seat === 'guardian-1' || seat === 'fed2-2' ? null
    : { federations: [{ federationId: FED, heldMsat: '1200000', paidIn: [] }] }) : undefined), 5);
  console.log('  MEASURED re-read:', m.reserve.msat);
  assert.equal(m.reserve.msat, '1200000');
  const day = new Date(Date.now() - 86400000).toISOString();
  const h = (await runOn(env, (seat, path, u) => (path.endsWith('/reserves') && u.searchParams.get('all') === '1'
    ? { federations: [{ federationId: FED, heldMsat: '1200000', paidIn: [{ at: day, amountMsat: '1200000' }] }] } : undefined), 7)).reserveHistory;
  console.log('  MEASURED history:', JSON.stringify(h.days.slice(-1)));
  assert.equal(h.days[h.days.length - 1].heldMsat, '1200000');
});
