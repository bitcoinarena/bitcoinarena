// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A REFUSED SETTLE IS OFFERED AGAIN, BUT IT DOES NOT SPIN (2026-10-07 08:35): on code-seat29 a plan no
// peer could take ("this signer node knows no peer to hand the send plan to yet") was offered again every second, 120
// times per round, each offer a whole settle pass - every seat near one core. The first offers stay quick (a peer not yet
// final becomes final within seconds, which is why the retry exists); later ones wait longer, up to a minute.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { LockSettlement } from '../src/settlement.js';

function refusingSeat() {
  const seat = { planRetries: new Map(), retryTimers: new Set(), offers: [] };
  seat.retryPlan = LockSettlement.prototype.retryPlan.bind(seat);
  // what settle() does with a plan no peer takes: refuses, and asks for it to be offered again
  seat.settle = async (rid) => { seat.offers.push(Date.now()); seat.retryPlan(rid); return { ok: false, why: 'this signer node knows no peer to hand the send plan to yet, so nothing is settled', peerRefused: true }; };
  return seat;
}

test('a plan no peer takes is offered again within a second at first, and at most 8 times in its first two minutes', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const seat = refusingSeat(), rid = new Uint8Array(32).fill(7);
    seat.retryPlan(rid);
    const tick = async (ms) => { for (let t = 0; t < ms; t += 250) { mock.timers.tick(250); await new Promise((r) => setImmediate(r)); } };
    await tick(1000);
    assert.equal(seat.offers.length, 1, 'the first offer again is a second later');
    await tick(119000);
    assert.ok(seat.offers.length <= 8, `offered again ${seat.offers.length} times in 120 s`);
    const gaps = seat.offers.slice(1).map((t, i) => t - seat.offers[i]);
    assert.ok(gaps.every((g, i) => i === 0 || g >= gaps[i - 1]), `the waits never shrink: ${gaps}`);
    assert.ok(Math.max(...gaps) <= 60000, `no wait above a minute: ${gaps}`);
  } finally { mock.timers.reset(); }
});

test('a round still refused keeps being offered, a minute apart, until its bound', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const seat = refusingSeat(), rid = new Uint8Array(32).fill(9);
    seat.retryPlan(rid);
    for (let t = 0; t < 3 * 3600 * 1000; t += 1000) { mock.timers.tick(1000); await new Promise((r) => setImmediate(r)); }
    assert.equal(seat.offers.length, 120, 'the bound of 120 offers is kept');
    assert.ok(seat.offers[119] - seat.offers[0] > 3600 * 1000, 'spread over more than an hour, not two minutes');
  } finally { mock.timers.reset(); }
});
