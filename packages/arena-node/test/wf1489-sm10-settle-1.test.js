// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WF1489 SM10 SETTLE 1: a guardian seat that missed the coordinator's one SENT / PAID broadcast (down for those 15 s, a dropped POST) holds the
// reserve payout PLANNED for good. Records are pushed once (server.js broadcast, fire-and-forget) and never pulled; expireIfDue reads the plan's
// output 0 (the gateway's contract, claimed once the gateway paid) as not held and its inputs as spent, so it "waits for the record of that
// spend" - a record nobody sends again. The seat never keeps the change row, counts the spent inputs as still held (heldBeforeOwnPayment), and
// on its own turn drives the dead plan: every co-signer refuses ("that payout is PAID here").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PAYOUT } from '../src/reserve-payout.js';
import { world, PROPOSAL } from './reserve-payout-fixture.js';

test('wf1489-sm10-settle-1: a guardian that missed the SENT/PAID records reaches PAID (and keeps the change) from the federation', async () => {
  const w = world();
  const [a] = await w.seats[0].api.round({ height: 500 });
  assert.equal(a.state, PAYOUT.PAID, a.why);
  assert.equal(w.fed.payments.length, 1, 'the gateway paid once');
  // seat 6 was down while the SENT and PAID records went round: it learned only the PLANNED one (it committed to nothing)
  const planned = w.seats[6].inbox.find((x) => x.state === PAYOUT.PLANNED);
  w.seats[6].inbox.length = 0;
  assert.equal((await w.seats[6].api.learn(planned)).ok, true);
  for (const s of w.seats.slice(1, 6)) await (async () => { while (s.inbox.length) await s.api.learn(s.inbox.shift()); })();
  // the chain runs on for a day of passes: every seat passes, records delivered as they are said
  for (let h = 502; h <= 800; h += 2) {
    for (const s of w.seats) { try { await s.api.round({ height: h }); } catch { /* next pass */ } }
    await w.deliver();
  }
  const r6 = w.seats[6].api.stateOf(PROPOSAL);
  const r0 = w.seats[0].api.stateOf(PROPOSAL);
  assert.equal(r0.state, PAYOUT.PAID);
  const change = `${r0.txid}:1`;
  const keptChange = w.state.kept.some((k) => k.seat === 6 && k.row.outpoint === change);
  assert.equal(r6.state, PAYOUT.PAID, `seat 6 holds the paid payout ${r6.state} for good (why: ${r6.why}); change row kept: ${keptChange}`);
  assert.ok(keptChange, 'seat 6 keeps the payout\'s change under the reserve key');
});
