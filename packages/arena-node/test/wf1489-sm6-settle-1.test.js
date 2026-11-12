// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// STATE-MACHINE AUDIT ROUND 6, settle (kanban #1489): A SEAT HANDED THE SIGNATURE NEVER REACHES ACCEPTED ONCE THE PAYOUTS ARE REDEEMED.
//
// The asker hands the combined signature to the other seat (take -> SUBMITTING) BEFORE it submits; that seat then learns whether the
// settlement went in only from federationSaw: "in" needs a payout contract of the txid still STORED. A payout is the winner's (and the
// seats', the website's) to redeem the moment the asker answers ACCEPTED - the page redeems on one seat's ACCEPTED that pays it. When every
// payout is redeemed before the other seat's first look after landing (its 2 s confirmSoon tick, a slow status read over many locks, a seat
// that restarts in between), it reads "0 payout(s) stored, every claimed lock gone": 'mixed', "neither in nor out", and keeps SUBMITTING on
// every later pass, retry and restart. Two seats hold opposite states of one landed settlement for good; the round never reaches the
// settlement threshold of ACCEPTED answers the page's settlementOf asks for, and everything gated on ACCEPTED at that seat (late losers,
// the nobody-won and attested returns) is refused there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockPort } from './lock-fixture.js';
import { lockRound, lockAndPlay, closeRound, untilSettled, proposerOf } from './lock-round-fixture.js';
import { WINNER, LOSER, wait } from './window-fixture.js';

test('a landed settlement whose payouts were redeemed before the other seat looked: that seat still holds it SUBMITTING, never ACCEPTED', async () => {
  const port = lockPort();
  // THE WINNER REDEEMS AT ONCE: as soon as the guardians took the signed settlement (the asker's recordSubmit has already read its payouts
  // stored), every payout contract of that txid is spent by its owner - as the page does on the asker's ACCEPTED
  const real = port.settle;
  let landed = null;
  port.settle = async (args) => {
    const r = await real(args);
    if (args.signature && r.accepted && !landed) {
      landed = r.txid;
      for (const k of [...port.locks.keys()]) if (k.startsWith(`${r.txid}:`)) port.locks.delete(k);
    }
    return r;
  };
  const w = await lockRound({ port });
  try {
    await lockAndPlay(w, WINNER);
    await lockAndPlay(w, LOSER);
    await closeRound(w);
    const asker = proposerOf(w);
    const other = asker === w.a ? w.b : w.a;
    const st = await untilSettled({ ...w, a: asker }, 90000);
    assert.equal(st.state, 'ACCEPTED', st.why);
    assert.ok(landed, 'no signed settlement went in');
    // the other seat holds the signature it was handed; give it its confirmSoon ticks, and a pass of its own as recover/retry run
    let row = null;
    for (const stop = Date.now() + 20000; Date.now() < stop; await wait(250)) {
      row = other.round.lockSettlement(w.rid);
      if (row && row.state === 'ACCEPTED') break;
    }
    await other.settlements.settle(w.rid).catch(() => null);
    await other.settlements.recover().catch(() => null);
    row = other.round.lockSettlement(w.rid);
    console.log('  FACTS:', JSON.stringify({ asker: asker.round.lockSettlement(w.rid).state, other: row && { state: row.state, txid: row.txid.slice(0, 12), why: String(row.why).slice(0, 200) },
      landed: landed.slice(0, 12), lockGone: true }));
    assert.equal(row && row.txid, landed, 'the other seat was not handed the landed settlement');
    assert.equal(row.state, 'ACCEPTED', `the settlement landed and the asker holds it ACCEPTED, but the other seat holds ${row.state} for good: ${row.why}`);
  } finally { await w.close(); }
});
