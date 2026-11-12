// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { b32, LOSER, wait } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { TEST_DONATION_SET_KEYS_REGTEST } from '../../arena-protocol/src/test-donation-set-keys-regtest.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { cancelId } from '../../arena-protocol/src/order-book.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { MARKET } from './plugins/market/index.js';

const NETWORK = TEST_DONATION_SET_KEYS_REGTEST.recipients;
const player = (n) => ({ ...LOSER, name: `p${n}`, key: b32(0x40 + n), worldSecret: b32(0) });

// kanban #1489 v1-refute-33 s2 (honest path after #1702): AN HONEST CANCEL TAKEN 1 s BEFORE THE CLOSE IS HANDED ON AT close - 300 ms
// (handCancelOn), and on a market whose outcome is out at the close the other seat now takes it only until close + 500 ms on ITS clock. A hand-on
// that lands at close + 600 ms there (a slow link, a seat clock 0.6 s ahead, one retry) is refused, and the round keeps two tables - the #1520
// split, which the 5 s grace had covered. Safe behaviour: a cancel one seat took in time reaches every seat's table.
test('a cancel taken 1 s before the close and handed on, landing at close + 600 ms, is taken by the other seat', async () => {
  const round = { gameId: MARKET.registration.gameId, simCoreHash: b32(0), configHash: b32(0), donationSetId: donationSetId(NETWORK), entryCloseMs: 60000n };
  const w = await lockRound({ stakeMsat: 1_000_000n, round, endMs: testNow() + 900000,
    serveOpts: { plugins: [NEXTBLOCK, MARKET.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST] } });
  skipTo(Number(w.c.committeeTimeMs) + 100);
  try {
    const e = await lockAndPlay(w, player(60), { noMarks: true, pick: 1 });
    await lockAndPlay(w, player(61), { noMarks: true, pick: 0 });
    skipTo(Number(w.c.entryCloseMs) - 1000);
    const sig = ed25519.sign(cancelId({ roundId: w.rid, entryId: e.eid }), e.session);
    const atA = await fetch(`http://127.0.0.1:${w.a.port}/cancel?entry=${toHex(e.eid)}`, { method: 'POST', body: sig }).then((r) => r.status);
    skipTo(Number(w.c.entryCloseMs) + 600);   // where the hand-on lands on the other seat's clock
    await wait(2500);                         // handCancelOn fires 700 ms after the take
    const got = { atA, atAHeld: !!w.a.round.cancelled(e.eid), atBHeld: !!w.b.round.cancelled(e.eid) };
    console.log('  v1-refute-33-s2-2:', JSON.stringify(got));
    assert.equal(atA, 201);
    assert.equal(got.atBHeld, true, 'the two seats hold different tables: a cancel taken in time was refused at the other seat');
  } finally { await w.close(); }
});
