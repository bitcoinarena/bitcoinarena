// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r3-find-entry 2: A PLAYER FORGES THE HAND-ON MARK ON HIS OWN CANCEL WELL BEFORE THE CLOSE AND LEAVES IT AT THE SEATS HE CHOOSES.
// POST /cancel hands a cancel on to the round's other seats only when the request does NOT carry `x-arena-relayed: 1` (server.js: `!relayed`),
// and the "held" check that a round seat already holds a relayed cancel (aSeatHoldsCancel, #1520) runs only in the last
// CANCEL_PLAYER_DOOR_MARGIN_MS. In the 'open' part of the door a relayed-marked cancel is taken as it is, and never handed on; the other seats
// pull /cancels only in settlement.js #carryCancels, which does nothing from the entry close on (a market settles after it). So a player
// (or anyone holding his signed cancel) posts it with the header to 3 of 7 seats: those 3 drop the pick from the round's table, the other 4
// count it. With 5 of 7 needed for every settlement and forfeit, neither table reaches a threshold: every honest picker's payout and refund
// stalls until the locks expire, for the price of one minimum pick.
// Safe: a cancel taken at any seat before the close is held by every responsive seat (or by none).
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

test('wf1489-r3-entry-2: a cancel forged as handed-on, posted to some seats only, does not split the market\'s table', async () => {
  const round = { gameId: MARKET.registration.gameId, simCoreHash: b32(0), configHash: b32(0), donationSetId: donationSetId(NETWORK), entryCloseMs: 60000n };
  const w = await lockRound({ n: 7, stakeMsat: 1_000_000n, round, endMs: testNow() + 900000,
    serveOpts: { plugins: [NEXTBLOCK, MARKET.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST] } });
  skipTo(Number(w.c.committeeTimeMs) + 100);
  try {
    const e = await lockAndPlay(w, player(80), { noMarks: true, pick: 1 });
    await lockAndPlay(w, player(81), { noMarks: true, pick: 0 });
    const close = Number(w.c.entryCloseMs);
    skipTo(close - 20000);   // well inside the open door
    const sig = ed25519.sign(cancelId({ roundId: w.rid, entryId: e.eid }), e.session);
    const status = [];
    for (const d of w.nodes.slice(0, 3))
      status.push(await fetch(`http://127.0.0.1:${d.port}/cancel?entry=${toHex(e.eid)}`, { method: 'POST', body: sig, headers: { 'x-arena-relayed': '1' } }).then((r) => r.status));
    await wait(1500);   // many hand-on retry periods (CANCEL_HANDON_RETRY_MS 250)
    skipTo(close + 1000);
    await wait(500);
    const heldAt = w.nodes.map((d) => !!d.round.cancelled(e.eid));
    console.log('  wf1489-r3-entry-2:', JSON.stringify({ status, heldAt }));
    // kanban #2682: the first seat hands the cancel on at once, so the next two may already hold it (200) - taken either way
    assert.ok(status.every((x) => x === 200 || x === 201), JSON.stringify(status));
    assert.ok(heldAt.every((x) => x === heldAt[0]),
      `the seats disagree on the round's table after the close: cancel held at ${heldAt.filter(Boolean).length} of 7 seats (${JSON.stringify(heldAt)})`);
  } finally { await w.close(); }
});
