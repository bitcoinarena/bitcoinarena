// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2627 (feedback #052, a gap in #2602): THE PAYOUT GATEWAY'S expiration_delta_minimum WAS NOT BOUNDED.
// gatewayTermsWithinLimits bounded the fee and expiration_delta_default, not the minimum. lowestLiveGateway then picked a gateway whose
// minimum is above its default (or names none - stake-lock-port turns a missing one into null): the proposer names height + default, every
// seat's sendPlanStands needs height + minimum at least (BigInt(null) throws), and every send plan through it is refused for good.
// The report: the lowest key 02 00..00, fee 0, default 1440, minimum 1441, beside the two fixture gateways; a walk-away round's donation shares.
// Safe: a gateway whose minimum is missing or above its default is not a payout gateway; the next lowest key is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockPort, TWO_GATEWAYS } from './lock-fixture.js';
import { lockRound, lockAndPlay, closeRound, untilSettled, proposerOf } from './lock-round-fixture.js';
import { LOSER, b32, wait } from './window-fixture.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { lowestLiveGateway, gatewayTermsWithinLimits } from '../../arena-protocol/src/winnings-send.js';

const WALKER = { ...LOSER, name: 'walker', key: b32(0x21) };
const STUCK = { url: 'http://gw-stuck.example/', live: true, lightningPublicKey: '02' + '00'.repeat(32), modulePublicKey: '02' + 'ee'.repeat(32),
  sendFeeDefault: { baseMsat: 0n, ppm: 0n }, expirationDeltaDefault: 1440, expirationDeltaMinimum: 1441 };
const NO_MINIMUM = { ...STUCK, expirationDeltaMinimum: null };

test('#2627 a gateway whose minimum is missing or above its default is not within the limits', () => {
  console.log('  MEASURED #2627 terms:', JSON.stringify({ stuck: gatewayTermsWithinLimits(STUCK), noMinimum: gatewayTermsWithinLimits(NO_MINIMUM),
    picked: [lowestLiveGateway([STUCK, ...TWO_GATEWAYS]).url, lowestLiveGateway([NO_MINIMUM, ...TWO_GATEWAYS]).url] }));
  assert.equal(gatewayTermsWithinLimits(STUCK), false);
  assert.equal(gatewayTermsWithinLimits(NO_MINIMUM), false);
  assert.equal(gatewayTermsWithinLimits({ ...STUCK, expirationDeltaMinimum: 1440 }), true, 'minimum equal to the default stands');
  assert.equal(lowestLiveGateway([STUCK, ...TWO_GATEWAYS]).url, lowestLiveGateway(TWO_GATEWAYS).url);
});

for (const [name, bad] of [['minimum 1441 over default 1440', STUCK], ['no minimum (null)', NO_MINIMUM]]) {
  test(`#2627 a walk-away's donation shares with the lowest-key gateway's ${name}: paid through the next gateway`, async () => {
    const port = lockPort({ gateways: [bad, ...TWO_GATEWAYS] });
    const next = lowestLiveGateway(TWO_GATEWAYS);
    const w = await lockRound({ port, serveOpts: { doorSweepMs: 250, winningsEveryMs: 300, donationSets: [TEST_DONATION_SET_REGTEST] } });
    try {
      await lockAndPlay(w, WALKER, { noMarks: true });
      await closeRound(w);
      const st = await untilSettled(w, 90000);
      const sends = () => proposerOf(w).round.sendPlansOf(w.rid).filter((r) => r.donation);
      let got = [];
      for (const stop = Date.now() + 30000; Date.now() < stop; await wait(250)) {
        got = sends();
        if (got.length && got.every((r) => r.state === 'PAID')) break;
      }
      console.log(`  MEASURED #2627 ${name}:`, JSON.stringify({ settled: st.state, why: st.why || null, sends: got.map((r) => [r.state, r.why || null]),
        payments: port.gatewayPayments.map((x) => x.gateway) }));
      assert.equal(st.state, 'ACCEPTED', st.why);
      assert.equal(got.length, TEST_DONATION_SET_REGTEST.recipients.length);
      assert.ok(got.every((r) => r.state === 'PAID'), `not every donation share was paid: ${JSON.stringify(got.map((r) => r.state))}`);
      assert.ok(port.gatewayPayments.every((x) => x.gateway === next.url), 'a share went through the gateway whose window no seat accepts');
    } finally { await w.close(); }
  });
}
