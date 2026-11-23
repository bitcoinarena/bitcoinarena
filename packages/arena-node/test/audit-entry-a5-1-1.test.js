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

// audit entry a5-1-1: A CANCEL TAKEN AT TWO SEATS' PLAYER DOORS IN TIME IS NEVER TAKEN BY THE OTHER FIVE (gap in #2843's fix vs #1950's design).
// The player's door is open until close - 800 ms and every take is handed on at once "so every honest hand-on lands while the peer doors are
// still open" (server.js CANCEL_PLAYER_DOOR_MARGIN_MS). But a hand-on that lands inside the margin meets the HELD door, and since #2843 that door
// takes it only when f + 1 = 3 other seats list it in GET /cancels. A cancel the player door took at 1 or 2 seats (a page whose posts reached two
// seats in time, or a player who posts it to two seats only) is listed by at most 2: every other seat refuses the hand-on, for good.
// Safe behaviour: a cancel taken at a seat's own player door before the margin ends with the same table at every seat.
test('a cancel two seats took at their player door before the margin reaches every seat of a 7-seat market', async () => {
  const round = { gameId: MARKET.registration.gameId, simCoreHash: b32(0), configHash: b32(0), donationSetId: donationSetId(NETWORK), entryCloseMs: 60000n };
  const w = await lockRound({ n: 7, stakeMsat: 1_000_000n, round, endMs: testNow() + 900000,
    serveOpts: { plugins: [NEXTBLOCK, MARKET.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST] } });
  skipTo(Number(w.c.committeeTimeMs) + 100);
  const realFetch = globalThis.fetch;
  try {
    const e = await lockAndPlay(w, player(90), { noMarks: true, pick: 1 });
    await lockAndPlay(w, player(91), { noMarks: true, pick: 0 });
    const close = Number(w.c.entryCloseMs), hex = toHex(e.eid);
    // a seat's hand-on POST /cancel takes one normal tunnel round trip (60 ms; the code budgets 50-100 ms for it)
    globalThis.fetch = (url, init = {}) => {
      const u = String(url);
      if (/\/cancel\?entry=/.test(u)) return new Promise((r) => setTimeout(r, 60)).then(() => realFetch(url, init));
      return realFetch(url, init);
    };
    skipTo(close - 830);   // the player's own door is open (it shuts at close - 800 ms)
    const sig = ed25519.sign(cancelId({ roundId: w.rid, entryId: e.eid }), e.session);
    const said = await Promise.all([0, 1].map((i) => realFetch(`http://127.0.0.1:${w.nodes[i].port}/cancel?entry=${hex}`,
      { method: 'POST', body: sig }).then((r) => r.status)));
    await wait(Math.max(0, close - testNow()) + 2600);
    const heldAt = w.nodes.map((d) => !!d.round.cancelled(e.eid));
    console.log('  audit-entry-a5-1-1:', JSON.stringify({ said, heldAt }));
    assert.deepEqual(said, [201, 201], 'the player door before the margin takes the cancel');
    assert.equal(new Set(heldAt).size, 1, `the seats hold different tables: ${JSON.stringify(heldAt)}`);
  } finally { globalThis.fetch = realFetch; await w.close(); }
});
