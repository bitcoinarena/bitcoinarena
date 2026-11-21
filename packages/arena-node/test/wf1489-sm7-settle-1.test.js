// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 state-machine audit round 7 (settle): A DONATION SEND WHOSE TWO GATEWAYS EACH LET ONE ATTEMPT EXPIRE IS NEVER SENT AGAIN.
// nextGateway (winnings-send.js) excludes every gateway any earlier attempt of the entry used. With the two gateways a paying round's
// federation has (§23.6), attempt 0 through A and attempt 1 through B both expiring unpaid (a recipient wallet offline for two expiry
// windows, a gateway down for one and the other's route failing) leaves attempt 1's contract expired under the committee key, and every
// sweep after that answers "no other live gateway to re-send through" - for good, though both gateways are live and paying again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockPort, TWO_GATEWAYS } from './lock-fixture.js';
import { lockRound, lockAndPlay, closeRound, untilSettled, proposerOf } from './lock-round-fixture.js';
import { LOSER, b32, wait } from './window-fixture.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { lowestLiveGateway } from '../../arena-protocol/src/winnings-send.js';

const WALKER = { ...LOSER, name: 'walker', key: b32(0x21) };

test('wf1489-sm7-settle-1: a donation share whose attempt through each of the two gateways expired unpaid is re-sent once a gateway pays again', async () => {
  const port = lockPort();
  const first = lowestLiveGateway(TWO_GATEWAYS);
  const next = TWO_GATEWAYS.find((g) => g.url !== first.url);
  // GATEWAYS THAT DO NOT PAY: each asked with the committee's auth answers unpaid (the fixture's gatewayDown holds one URL only)
  const down = new Set([first.url, next.url]);
  const send = port.send.bind(port);
  // and no gateway claims a contract past its expiration (LNv2: only the refund key moves it then)
  port.send = async (a) => (a && a.auth && (down.has(a.gateway) || BigInt(a.expiration) <= BigInt(port.height))
    ? { ...(await send({ ...a, auth: null })), sent: false, why: `${a.gateway} did not pay` } : send(a));
  const w = await lockRound({ port, serveOpts: { doorSweepMs: 250, winningsEveryMs: 300, donationSets: [TEST_DONATION_SET_REGTEST] } });
  try {
    await lockAndPlay(w, WALKER, { noMarks: true });
    await closeRound(w);
    const st = await untilSettled(w, 90000);
    assert.equal(st.state, 'ACCEPTED', st.why);
    const sends = () => proposerOf(w).round.sendPlansOf(w.rid).filter((r) => r.donation);
    await wait(2000);
    assert.ok(sends().length && sends().every((r) => r.state !== 'PAID'));

    // attempt 0 (through A) expires; the re-send goes through B - and B does not pay either
    port.height += 1500;
    for (const stop = Date.now() + 60000; Date.now() < stop; await wait(250)) {
      const s = sends();
      if (s.length && s.every((r) => r.attempt === 1 && r.state === 'SENDING')) break;
    }
    const mid = sends();
    console.log('  FACTS (attempt 1 through B, B down):', JSON.stringify(mid.map((r) => [r.attempt, r.state, r.gatewayUrl])));
    assert.ok(mid.every((r) => r.attempt === 1 && r.state === 'SENDING'), 'the first re-send did not go out through B');

    // attempt 1 expires too; now both gateways pay again
    port.height += 1500;
    await wait(3000);
    down.clear();
    let after = [];
    for (const stop = Date.now() + 30000; Date.now() < stop; await wait(250)) {
      after = sends();
      if (after.length && after.every((r) => r.state === 'PAID')) break;
    }
    const why = proposerOf(w).round.sendAttemptsOf(w.rid).filter((r) => r.donation).map((r) => [r.attempt, r.state, r.gatewayUrl.slice(7, 11), r.why.slice(0, 80)]);
    console.log('  FACTS (both live again):', JSON.stringify(why), 'payments', port.gatewayPayments.length);
    assert.ok(after.every((r) => r.state === 'PAID'),
      `a donation share is left in an expired contract under the committee key, never re-sent though both gateways pay: ${JSON.stringify(after.map((r) => [r.attempt, r.state]))}`);
    assert.equal(port.gatewayPayments.length, TEST_DONATION_SET_REGTEST.recipients.length, 'a recipient was paid more or less than once');
  } finally { await w.close(); }
});
