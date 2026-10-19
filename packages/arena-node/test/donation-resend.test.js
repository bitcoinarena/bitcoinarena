// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A DONATION SEND WHOSE GATEWAY NEVER PAYS (2026-10-01: "test fee payments and donations properly"). Since
// WINNINGS-AUTO no winner is paid by a Lightning send; the send machinery carries a walk-away round's 25% to the
// donation set (each recipient by its Lightning-address send). The re-send it keeps for a gateway that never pays was
// tested on a winner's send, which is gone - so it is tested here on the donation shares:
//   the lowest-key gateway is down when the shares are sent: nothing is paid; past each contract's expiration the
//   contract returns to the committee's key and is re-sent through the next live gateway - every recipient PAID once,
//   the seats' 75% untouched by it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockPort, TWO_GATEWAYS } from './lock-fixture.js';
import { lockRound, lockAndPlay, closeRound, untilSettled, proposerOf } from './lock-round-fixture.js';
import { LOSER, b32, wait } from './window-fixture.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { lowestLiveGateway } from '../../arena-protocol/src/winnings-send.js';

const WALKER = { ...LOSER, name: 'walker', key: b32(0x21) };

test('a walk-away\'s donation shares, their gateway down: unpaid, then past expiry refunded to the committee and re-sent through the next live gateway - each recipient paid once', async () => {
  const port = lockPort();
  const first = lowestLiveGateway(TWO_GATEWAYS);
  port.gatewayDown = first.url;
  const w = await lockRound({ port, serveOpts: { doorSweepMs: 250, winningsEveryMs: 300, donationSets: [TEST_DONATION_SET_REGTEST] } });
  try {
    await lockAndPlay(w, WALKER, { noMarks: true });
    await closeRound(w);
    const st = await untilSettled(w, 90000);
    assert.equal(st.state, 'ACCEPTED', st.why);
    const donationSends = () => proposerOf(w).round.sendPlansOf(w.rid).filter((r) => r.donation);
    await wait(2000);
    const before = donationSends();
    console.log('  FACTS (gateway down):', JSON.stringify({ sends: before.map((r) => [r.address.slice(0, 20), r.state]), gatewayPayments: port.gatewayPayments.length }));
    assert.equal(before.length, TEST_DONATION_SET_REGTEST.recipients.length, 'not one send per donation recipient');
    assert.ok(before.every((r) => r.state !== 'PAID'), 'a donation share was paid through a gateway that does not pay');
    assert.equal(port.gatewayPayments.length, 0);

    // PAST THE CONTRACTS' EXPIRATION: the federation's height moves on, and the sweep re-sends.
    port.height += 1500;
    let after = [];
    for (const stop = Date.now() + 60000; Date.now() < stop; await wait(250)) {
      after = donationSends();
      if (after.length && after.every((r) => r.state === 'PAID')) break;
    }
    const resends = port.settlements.filter((x) => x.refunds && x.refunds.length);
    const resend = resends[0];
    const next = TWO_GATEWAYS.find((g) => g.url !== first.url);
    console.log('  FACTS (re-sent):', JSON.stringify({ sends: after.map((r) => [r.address.slice(0, 20), r.state, r.attempt]),
      refunds: resends.map((x) => x.refunds.length), payments: port.gatewayPayments.map((x) => x.gateway) }));
    assert.ok(resend, 'no expired donation contract was refunded into a re-send');
    // each expired share refunded once, in one re-send transaction or several
    assert.equal(resends.reduce((t, x) => t + x.refunds.length, 0), TEST_DONATION_SET_REGTEST.recipients.length, 'not every expired share was refunded once');
    for (const p of resends.flatMap((x) => x.payouts.filter((y) => y.sent))) {
      assert.equal(toHex(p.payoutPk), toHex(w.claimPk), 'a re-sent share refunds to someone other than the committee');
      assert.equal(p.sent.gatewayPk, next.modulePublicKey.toLowerCase(), 'a re-send is not through the next live gateway');
    }
    assert.ok(after.every((r) => r.state === 'PAID'), `not every donation recipient was paid: ${JSON.stringify(after.map((r) => r.state))}`);
    assert.equal(port.gatewayPayments.length, TEST_DONATION_SET_REGTEST.recipients.length, 'a recipient was paid more or less than once');
    assert.ok(port.gatewayPayments.every((x) => x.gateway === next.url), 'a share was paid through the gateway that was down');
    // AND SETTLING AGAIN PAYS NOTHING MORE
    const again = { settlements: port.settlements.length, payments: port.gatewayPayments.length };
    await wait(1500);
    for (const d of [w.a, w.b]) await d.settlements.settle(w.rid);
    assert.deepEqual({ settlements: port.settlements.length, payments: port.gatewayPayments.length }, again, 'a paid donation was sent again');
  } finally { await w.close(); }
});
