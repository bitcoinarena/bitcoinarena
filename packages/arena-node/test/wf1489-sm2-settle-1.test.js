// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 wf1489-sm2-settle-1: TWO SEATS PROPOSING ONE RE-SEND AT ONCE NEVER MEET (the #1241 convergence is dead at the door).
// #1241 gave attempt N+1 attempt 0's rule: a seat-signed re-send with a lower payment hash replaces a kept PLANNED attempt N+1, so
// seats that each kept their own proposal meet on the lowest hash. But checkResend reaches the replace only after its gateway checks,
// and those count the kept attempt N+1's own gateway as "used" (nextGateway / the `others` list read sendAttemptsOf, which holds the
// kept row): the competing offer, through the same next gateway, is refused ("no other live gateway" with two gateways, "the plan
// names gateway X and the lowest live key is Y" with more). Both seats keep their own hash, each refuses the other's, no re-send
// reaches the threshold: the expired share stays under the committee key for good. Safe: both seats end on one attempt 1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockPort, TWO_GATEWAYS } from './lock-fixture.js';
import { lockRound, lockAndPlay, closeRound, untilSettled, proposerOf } from './lock-round-fixture.js';
import { LOSER, b32, wait } from './window-fixture.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { lowestLiveGateway } from '../../arena-protocol/src/winnings-send.js';

const WALKER = { ...LOSER, name: 'walker', key: b32(0x21) };

test('wf1489 sm2-settle-1: two seats that propose attempt 1 of one expired send at once end on the same attempt 1', async () => {
  const port = lockPort();
  const first = lowestLiveGateway(TWO_GATEWAYS);
  port.gatewayDown = first.url;
  const w = await lockRound({ port, serveOpts: { doorSweepMs: 250, winningsEveryMs: 300, donationSets: [TEST_DONATION_SET_REGTEST] } });
  try {
    await lockAndPlay(w, WALKER, { noMarks: true });
    await closeRound(w);
    const st = await untilSettled(w, 90000);
    assert.equal(st.state, 'ACCEPTED', st.why);
    const p = proposerOf(w);
    // attempt 0 of every donation share went to the gateway that is down: SENDING, unpaid
    for (const stop = Date.now() + 30000; Date.now() < stop; await wait(250))
      if (p.round.sendPlansOf(w.rid).filter((r) => r.donation && r.state === 'SENDING').length === TEST_DONATION_SET_REGTEST.recipients.length) break;
    // the sweeps stop here: the two proposals below are the ones each seat's sweep makes once both are on turn
    for (const d of [w.a, w.b]) d.winnings.sendAll = async () => [];
    await wait(1000);
    const sends0 = p.round.sendPlansOf(w.rid).filter((r) => r.donation);
    assert.ok(sends0.length && sends0.every((r) => r.attempt === 0 && r.state === 'SENDING'), JSON.stringify(sends0.map((r) => [r.attempt, r.state])));
    const entryHex = toHex(sends0[0].entryId);
    for (const d of [w.a, w.b]) assert.ok(d.winnings.rowOf(w.rid, entryHex, 0), 'a seat holds no attempt 0 of that share');

    // PAST THE CONTRACT'S EXPIRATION, both seats on turn: each fetches its own invoice at the same moment (their sweeps run every 60 s)
    port.height += 1500;
    let arrived = 0, release; const both = new Promise((r) => { release = r; });
    for (const d of [w.a, w.b]) {
      const orig = d.winnings.invoiceFor.bind(d.winnings);
      let armed = true;
      d.winnings.invoiceFor = async (...args) => {
        const got = await orig(...args);
        if (armed) { armed = false; if (++arrived === 2) release(); await both; }
        return got;
      };
    }
    const [ra, rb] = await Promise.all([w.a, w.b].map(async (d) => {
      const built = await d.settlements.message(w.rid);
      assert.ok(built.ok, built.why);
      return d.winnings.proposeResend(w.rid, d.winnings.rowOf(w.rid, entryHex, 0), built);
    }));
    // and each offers again on its next pass (sendAll's offerResend before signing), as often as it likes
    for (let i = 0; i < 2; i++) for (const d of [w.a, w.b]) await d.winnings.offerResend(w.rid, { ...d.winnings.rowOf(w.rid, entryHex, 1), roundId: w.rid });
    const ha = w.a.winnings.rowOf(w.rid, entryHex, 1), hb = w.b.winnings.rowOf(w.rid, entryHex, 1);
    const facts = { a: ra.ok ? 'ok' : ra.why, b: rb.ok ? 'ok' : rb.why, aHash: ha && ha.paymentHash.slice(0, 8), bHash: hb && hb.paymentHash.slice(0, 8),
      aState: ha && ha.state, bState: hb && hb.state };
    console.log('  MEASURED wf1489-sm2-settle-1:', JSON.stringify(facts));
    assert.ok(ha && hb, 'a seat keeps no attempt 1');
    assert.equal(ha.paymentHash, hb.paymentHash, 'the two seats keep different attempts 1 and each refuses the other\'s: the re-send never reaches the threshold');
  } finally { await w.close(); }
});
