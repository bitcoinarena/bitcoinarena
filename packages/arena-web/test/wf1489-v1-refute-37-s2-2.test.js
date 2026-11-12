// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 verify of #1534 (skeptic 2, variant 2): ONE HISTORY SEAT STILL MOVES THE RESERVE HISTORY'S START. readReserveHistory adds
// every day any seat of a kept federation names to perDay, even when that day's median is 0, and the history then runs from the earliest
// such day to today. One of the three history seats (fed2-1) listing a 1 msat payment on 1900-01-01 makes the public history start in 1900:
// ~46,000 zero days on the graph (and a far earlier date - Date.parse accepts year -271821 - is ~1e8 days: the read never finishes).
// Safe: the history starts on the honest seats' first day.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { store, runOn, FED } from './wf1489-v1-refute-37-s2-common.mjs';

test('#1534 variant: one history seat cannot start the reserve history in 1900', async () => {
  const env = store();
  const day = new Date(Date.now() - 2 * 86400000).toISOString();
  const honest = { federations: [{ federationId: FED, heldMsat: '1000000', paidIn: [{ at: day, amountMsat: '1000000' }] }] };
  const bad = { federations: [{ federationId: FED, heldMsat: '1000000', paidIn: [{ at: day, amountMsat: '1000000' }, { at: '1900-01-01T00:00:00Z', amountMsat: '1' }] }] };
  const m = await runOn(env, (seat, path, u) => (path.endsWith('/reserves') && u.searchParams.get('all') === '1' ? (seat === 'fed2-1' ? bad : honest) : undefined), 7);
  const h = m.reserveHistory;
  console.log('  MEASURED history: first day', h.days[0].day, 'days', h.days.length, 'last', JSON.stringify(h.days[h.days.length - 1]));
  assert.equal(h.days[0].day, day.slice(0, 10));
});
