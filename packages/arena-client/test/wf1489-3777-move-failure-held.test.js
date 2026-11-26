// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3777 (feedback #502): a Move answered "Nothing was moved: the payment from the other federation ended Failure", yet the paying
// wallet's balance had fallen 3,113 -> 3,100 (10 sat + ~3 fee). LNv2's send Failure is a funding transaction the federation rejected (the
// lock client's `why`, e.g. a note already spent): the notes handed in leave the balance at once and come back only by the mint client's
// refund, later or - a note spent elsewhere - never. The move now waits a bounded time for that refund and says what it saw: back, or the
// sats still held, with the federation's reason - never "nothing was moved" while the balance is short.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { swapForRound } from '../src/page-lock.js';

function pair({ refundAfter }) {
  const from = { balance: 3113000n, reads: 0 };
  from.balanceMsat = async () => { from.reads++; if (from.failed && from.reads >= refundAfter) from.balance = 3113000n; return String(from.balance); };
  from.withdraw = async () => { from.balance -= 13000n; from.failed = true; from.reads = 0; return JSON.stringify({ state: 'Failure', why: 'invalid input: 2-The note is already spent' }); };
  const to = { balanceMsat: async () => '0', receive: async (m) => JSON.stringify({ invoice: `lnbcrt-${m}`, operation: 'op1' }), awaitReceive: async () => 'Claimed' };
  // 2.0: a swap goes only through gateways at or under each federation's fee cap (§23A.9, kanban #1324) - one listed at the reference fee
  for (const w of [from, to]) { w.gateways = async () => JSON.stringify(['https://gw-a.test']); w.gatewayFees = async () => JSON.stringify({ send: { ppm: 1000, baseMsat: 1000 }, receive: { ppm: 1000, baseMsat: 0 } }); }
  return { from, to };
}

test('#3777 a failed Move whose refund lands says the money is back', async () => {
  const { from, to } = pair({ refundAfter: 3 });
  const r = await swapForRound({ from, to, amountMsat: 10000n, refundWaitMs: 1000, refundPollMs: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.heldMsat, 0n);
  assert.match(r.why, /ended Failure/);
  assert.match(r.why, /already spent/, 'the federation\'s reason is shown');
  assert.match(r.why, /money is back/);
});

test('#3777 a failed Move whose refund does not land names the sats still held, not "nothing moved"', async () => {
  const { from, to } = pair({ refundAfter: Infinity });
  const r = await swapForRound({ from, to, amountMsat: 10000n, refundWaitMs: 30, refundPollMs: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.heldMsat, 13000n);
  assert.match(r.why, /13 sat/);
  assert.match(r.why, /already spent/);
});
