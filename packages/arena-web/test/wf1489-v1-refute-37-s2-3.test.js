// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 verify of #1534 (skeptic 2, variant 3, the re-read path): THE STRICT MAJORITY IS OF THE SEATS THAT ANSWERED, WITH NO FLOOR.
// /reserves takes over 20 s on a loaded seat (kanban #927) and READ_MS is 20 s; a seat that answers fast while the others time out is the
// whole quorum, and its figures replace the good stored ones on the 5-minute re-read (statePut('metrics') with whatever came back). Same
// for the reserve history: 3 history seats, 45 s each; two slow ones leave fed2-1 alone (it sets every day), one slow one leaves the
// lower median of two (fed2-1 sends 0 and the history reads 0). Safe: a read that fewer than a majority of all seats answered does not
// replace the kept figures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { store, runOn, FED } from './wf1489-v1-refute-37-s2-common.mjs';

const BIG = '2100000000000000000';
test('#1534 variant: the one seat that answered a re-read does not replace the reserve', async () => {
  const env = store();
  const first = await runOn(env, () => undefined, 0);
  console.log('  MEASURED first read reserve:', first.reserve.msat);
  assert.equal(first.reserve.msat, '1000000');
  const m = await runOn(env, (seat, path) => (path.endsWith('/reserves') ? (seat === 'fed2-7'
    ? { federations: [{ federationId: FED, heldMsat: BIG, paidIn: [] }, { federationId: 'ab'.repeat(32), heldMsat: BIG, paidIn: [] }] } : null) : undefined), 5);
  console.log('  MEASURED re-read reserve:', JSON.stringify(m.reserve), 'seats', JSON.stringify(m.seats));
  assert.equal(m.reserve.msat, '1000000');
});
test('#1534 variant: with one history seat slow, the other bad one does not zero the reserve history', async () => {
  const env = store();
  const day = new Date(Date.now() - 2 * 86400000).toISOString();
  const honest = { federations: [{ federationId: FED, heldMsat: '1000000', paidIn: [{ at: day, amountMsat: '1000000' }] }] };
  const bad = { federations: [{ federationId: FED, heldMsat: '0', paidIn: [] }] };
  const m = await runOn(env, (seat, path, u) => (path.endsWith('/reserves') && u.searchParams.get('all') === '1'
    ? (seat === 'fed2-1' ? bad : seat === 'guardian-2' ? null : honest) : undefined), 7);
  const h = m.reserveHistory;
  console.log('  MEASURED history (one slow):', JSON.stringify(h && h.days.slice(-1)));
  assert.equal(h.days[h.days.length - 1].heldMsat, '1000000');
});
