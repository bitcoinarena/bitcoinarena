// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { b32, LOSER } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { testAttestedGame } from './plugins/sign.js';
import { TEST_DONATION_SET_KEYS_REGTEST } from '../../arena-protocol/src/test-donation-set-keys-regtest.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { marketExpiryBlocks } from '../../arena-protocol/src/lock-expiry.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { cancelId } from '../../arena-protocol/src/order-book.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { MARKET } from './plugins/market/index.js';

const NETWORK = TEST_DONATION_SET_KEYS_REGTEST.recipients;
const STAKE = 1_000_000n;
const player = (n) => ({ ...LOSER, name: `p${n}`, key: b32(0x40 + n), worldSecret: b32(0) });
const signCancel = (w, e) => ed25519.sign(cancelId({ roundId: w.rid, entryId: e.eid }), e.session);

// The player (not a seat) posts the forged hand-on mark himself; ONE colluding seat only holds the cancel in its store.
async function lateCancel({ game, stakeExpiryFor = null, afterCloseMs }) {
  const round = { gameId: game.registration.gameId, simCoreHash: b32(0), configHash: b32(0), donationSetId: donationSetId(NETWORK), entryCloseMs: 60000n };
  const w = await lockRound({ stakeMsat: STAKE, round, endMs: testNow() + 900000, ...(stakeExpiryFor ? { stakeExpiryFor } : {}),
    serveOpts: { plugins: [NEXTBLOCK, game.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST] } });
  skipTo(Number(w.c.committeeTimeMs) + 100);
  try {
    const played = [await lockAndPlay(w, player(50), { noMarks: true, pick: 0 }), await lockAndPlay(w, player(51), { noMarks: true, pick: 1 })];
    skipTo(Number(w.c.entryCloseMs) + afterCloseMs);
    const sig = signCancel(w, played[1]);
    const ownDoor = await fetch(`http://127.0.0.1:${w.a.port}/cancel?entry=${toHex(played[1].eid)}`, { method: 'POST', body: sig }).then((r) => r.status);
    w.a.round.putCancel({ roundId: w.rid, entryId: played[1].eid, signature: sig, receivedMs: testNow() });   // the colluding seat's store
    const atHonest = await fetch(`http://127.0.0.1:${w.b.port}/cancel?entry=${toHex(played[1].eid)}`,
      { method: 'POST', body: sig, headers: { 'x-arena-relayed': '1' } }).then((r) => r.status);
    return { ownDoor, atHonest, cancelledAtHonest: !!w.b.round.cancelled(played[1].eid) };
  } finally { await w.close(); }
}

// kanban #1489 v1-refute-33 s2 (after #1702): THE SHORT GRACE IS STILL A WINDOW AFTER THE OUTCOME. A market with no terms is attested at
// its close (attestationTimely takes observedAt >= close) and a grid market's outcome is the price at the close - out the instant the close
// passes. #1702 cut the colluding-seat window to 500 ms, but in those 500 ms the outcome is already known: a loser who sees the close price
// at close + 200 ms has one colluding seat list his cancel and posts it himself, marked, to every honest seat - and each takes it.
// Safe behaviour: an honest seat refuses a cancel that no seat took before the close, however soon after it.
test('a cancel a colluding seat wrote 200 ms after the close (outcome out at the close) is not taken by an honest seat', async () => {
  const got = await lateCancel({ game: MARKET, afterCloseMs: 200 });
  console.log('  v1-refute-33-s2-1 a:', JSON.stringify(got));
  assert.equal(got.ownDoor, 409);
  assert.equal(got.atHonest, 409, 'an honest seat took a loser\'s cancel 200 ms after the close, the outcome already out, on one seat\'s word');
  assert.equal(got.cancelledAtHonest, false);
});

// AND THE LONG GRACE ENDS AT THE RESOLUTION: a market resolving 5 s after its close (resolveAfterCloseMs 5000, the boundary #1702 gives the
// long grace) has the price at close + 5 s as its outcome, and the colluding-seat window runs to close + 4.999 s - 1 ms before it.
const TERMS = { nodeFeeBps: 50, donationBps: 50, question: 'Where is BTC/USD 5 s after the close?', resolveAfterCloseMs: 5000n,
  deadlineAfterResolveMs: 60000n, sourceRule: 'median of three test feeds' };
const FIVE_S = testAttestedGame({ name: 'btc-5s', outcomes: ['above 100k', 'between', 'below 90k'], marketTerms: TERMS });
test('a market resolving 5 s after its close: a cancel a colluding seat wrote 4.9 s after the close is not taken', async () => {
  const got = await lateCancel({ game: FIVE_S, afterCloseMs: 4900, stakeExpiryFor: (c) => marketExpiryBlocks(c, TERMS).blocks });
  console.log('  v1-refute-33-s2-1 b:', JSON.stringify(got));
  assert.equal(got.ownDoor, 409);
  assert.equal(got.atHonest, 409, 'an honest seat took a cancel 100 ms before the outcome\'s observation, on one seat\'s word');
  assert.equal(got.cancelledAtHonest, false);
});
