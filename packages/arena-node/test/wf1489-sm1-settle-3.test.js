// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 wf1489-sm1-settle-3: A SIGNED RESERVE PAYOUT EXPIRED AT ITS CUTOFF KEEPS ITS INPUTS LOCKED.
// (fixture: reserve-payout-fixture.js, the path of reserve-payout-planned-1159's #1229 test)
// reserve-payout.js has two ways into EXPIRED. expireIfDue (PLANNED -> EXPIRED) frees the plan's inputs (`release: true`); submit()'s cutoff (#1229:
// SUBMITTING, its output 0 not in the federation, every input still unspent there, past PLAN_EXPIRY_BLOCKS - SUBMIT_CUTOFF_BLOCKS) writes
// SUBMITTING -> EXPIRED WITHOUT it. The coordinator whose hand-in was lost (the tool timed out before the federation took it) then holds an EXPIRED
// record that still owns its outpoints in reserve_payout_inputs: they read spent in every figure of this seat (GET /reserves, reserveHeldSats), no
// other payout here may plan them, and the proposal's own next attempt at this seat finds "the reserves cannot pay it now" - it plans from
// unspent(), which leaves out every outpoint any proposal holds, its own expired one too. Safe: an EXPIRED record holds no input, whichever way it
// got there, and the turn's guardian plans the next attempt from the freed reserves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as rp from '../src/reserve-payout.js';
import { world, PROPOSAL } from './reserve-payout-fixture.js';

const { PAYOUT } = rp;

test('wf1489 sm1-settle-3: SUBMITTING expired at its cutoff frees its inputs, as PLANNED expired does', async () => {
  const w = world();
  const total = w.reserveRows.reduce((t, r) => t + BigInt(r.amountMsat), 0n);
  const { settle } = w.port;
  let fail = true;
  // the coordinator's one hand-in is lost before the federation takes it (as #1229's test)
  w.port.settle = async (a) => { if (a.signature && fail) { fail = false; throw new Error('the tool timed out before the federation took it'); } return settle(a); };
  try { await w.seats[0].api.round({ height: 500 }); } catch { /* the hand-in failed */ }
  const signed = w.seats[0].api.stateOf(PROPOSAL);
  assert.equal(signed.state, PAYOUT.SUBMITTING);
  const inputs = signed.plan.refunds.map((x) => x.outpoint);
  // back at 510: past PLAN_EXPIRY_BLOCKS - SUBMIT_CUTOFF_BLOCKS, its output 0 not in the federation, every input unspent there -> EXPIRED (#1229)
  try { await w.seats[0].api.round({ height: 510 }); } catch { /* a pass that throws */ }
  const expired = w.seats[0].api.stateOf(PROPOSAL);
  assert.equal(expired.state, PAYOUT.EXPIRED);
  assert.equal(w.fed.submits.length, 0, 'nothing went into the federation');
  const stillHeld = inputs.filter((o) => w.seats[0].api.spent().has(o));
  const heldAtExpiry = w.held(0); // read before the next attempt pays from these reserves
  console.log(`  FACTS: EXPIRED at the cutoff; ${stillHeld.length} of ${inputs.length} input(s) still held by it; this seat reads ${heldAtExpiry} of ${total} msat unspent`);
  // the proposal's own next attempt, on this seat's next turn (seat 0 of 7, two blocks each: 514)
  let next; try { [next] = await w.seats[0].api.round({ height: 514 }); } catch (e) { next = { why: `threw: ${e.message}` }; }
  const after = w.seats[0].api.stateOf(PROPOSAL);
  console.log(`  FACTS: its turn at 514: ${after.state} attempt ${after.plan && after.plan.attempt || 0} - ${next && (next.why || next.state)}`);
  assert.deepEqual(stillHeld, [], 'an EXPIRED payout still holds its inputs: the reserves read spent and no plan may use them');
  assert.equal(heldAtExpiry, total, 'the seat reads its reserves short by an attempt that never went in');
  assert.notEqual(after.state, PAYOUT.EXPIRED, `the turn's guardian did not plan the next attempt: ${next && next.why}`);
});
