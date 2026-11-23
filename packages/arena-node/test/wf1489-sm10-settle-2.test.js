// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WF1489 SM10 SETTLE 2: a leaderboard payout is written SHORT - terminal, broadcast, agreed by every seat's shortStands - on the reserves a
// funding payout still in flight holds. A PLANNED plan marks its inputs spent the moment it is written (reserve_payout_inputs), so while it waits
// for its signatures (a guardian down, a slow LNURL) unspent() leaves out the WHOLE inputs, not the amount it pays: the leaderboard's 10 % cap is
// read against half the reserves and the payout is SHORT for good. When the funding payout lands its change comes back, the reserves cover the
// leaderboard payout again - and nothing ever plans it (SHORT goes nowhere; heldBeforeOwnPayment puts back only a payment's OWN inputs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PAYOUT } from '../src/reserve-payout.js';
import { world, FED, PROPOSAL } from './reserve-payout-fixture.js';

const LB = 'cc'.repeat(32);
// the winners book is never reached before the cap (leaderboardRound reads the cap first); a book that answers one winner if it is
const winners = { freeze: async () => ({ ok: true }), union: async () => ({ ok: true, winners: [{ player: 'p', payoutPk: '02' + '77'.repeat(32), msat: '80000000' }], pairs: [], winnersId: 'w', evidence: [] }),
  check: async () => ({ ok: true, bind: {} }), plan: () => ({ ok: true }) };

test('wf1489-sm10-settle-2: a leaderboard payout is not SHORT for good because a funding payout in flight holds the inputs it will mostly give back', async () => {
  // the federation's reserves: two outputs of 500 000 sat; a funding payout of 90 000 sat (under 10 % of 1 000 000) and a leaderboard payout of
  // 80 000 sat (under 10 % too) - both payable, one after the other
  const w = world({ rows: [500000000n, 500000000n], amountSats: 90000n, down: [1, 2, 3],
    more: () => ({ leaderboards: () => [{ id: LB, federation: FED, amountSats: 80000n, paymentHeight: 502, decidableAt: 500 }], winners }) });
  // height 500: the funding payout's turn - planned (its first input, 500 000 sat, held), 4 of the 5 signatures: it waits
  const [a] = (await w.seats[0].api.round({ height: 500 })).filter((x) => x.id === PROPOSAL);
  assert.equal(a.ok, false); assert.match(String(a.why), /4 of 5/);
  assert.equal(w.seats[0].api.stateOf(PROPOSAL).state, PAYOUT.PLANNED);
  // height 502: the leaderboard payout's payment height, seat 0's turn
  await w.seats[0].api.round({ height: 502 });
  const lbAt502 = w.seats[0].api.stateOf(LB);
  // the three seats come back: the funding payout is signed, sent and paid; its change returns under the reserve key
  for (const s of w.seats) s.down = false;
  for (let h = 504; h <= 560; h += 2) { for (const s of w.seats) { try { await s.api.round({ height: h }); } catch { /* next pass */ } } await w.deliver(); }
  assert.equal(w.seats[0].api.stateOf(PROPOSAL).state, PAYOUT.PAID, 'the funding payout paid');
  const heldSats = w.held(0) / 1000n;
  assert.ok(heldSats * 10n >= 80000n, `the reserves after it (${heldSats} sat) cover the leaderboard payout's 10 % cap`);
  const lb = w.seats[0].api.stateOf(LB);
  assert.notEqual(lb && lb.state, PAYOUT.SHORT,
    `the leaderboard payout is SHORT for good (decided at 502 as ${lbAt502 && lbAt502.state}: ${lbAt502 && lbAt502.why}); the reserves now hold ${heldSats} sat`);
});
