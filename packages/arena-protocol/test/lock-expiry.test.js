// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A MARKET ROUND'S LOCKS OUTLIVE ITS WHOLE LIFE: the lock span sized from its times and terms, at its chain's
// fastest block time; a game keeps the ruled 144; the market's own clock puts its closes on its period's UTC grid.
import test from 'node:test';
import assert from 'node:assert/strict';
import { stakeExpiryFits, marketExpiryBlocks, marketSettledByMs, fastestBlockMsOf, LOCK_EXPIRY_MARGIN_MS } from '../src/lock-expiry.js';
import { marketWindowOf } from '../src/attested.js';
import { NETWORK_ID_REGTEST, NETWORK_ID_TESTNET4 } from '../src/genesis-ids.js';

const TERMS = { resolveAfterCloseMs: 0n, deadlineAfterResolveMs: 600000n };
const MARKET = { resultType: 2, gameName: 'btc-updown-15m', roundPeriodMs: 900000n, marketTerms: { ...TERMS } };
const Q = 1791598500000n;                         // 2026-10-10T02:15:00Z, a quarter hour
// a round of the window [Q, Q + 15 min), opened 15 min before it (its committee time)
const round = (over = {}) => ({ networkId: NETWORK_ID_REGTEST, committeeTimeMs: Q - 900000n, entryCloseMs: Q + 900000n, objectionWindowMs: 600000n, stakeExpiryBlocks: 144, ...over });

test('a market round\'s locks last from its committee time to window end + void deadline + objection window + 30 min, at its chain\'s fastest block; 144 is refused', () => {
  const c = round();
  // settled by: window end + 0 + 10 min + 10 min; span from the committee time: 15 + 15 + 20 + 30 min = 80 min
  assert.equal(marketSettledByMs(c, TERMS), Q + 900000n + 600000n + 600000n);
  const need = marketExpiryBlocks(c, TERMS);
  assert.equal(need.spanMs, 80n * 60000n);
  assert.equal(need.blocks, 480);                                 // 80 min at 10 s a block on the demo's regtest
  assert.equal(marketExpiryBlocks({ ...c, networkId: NETWORK_ID_TESTNET4 }, TERMS).blocks, 80);   // at one a minute on testnet4
  assert.equal(fastestBlockMsOf(NETWORK_ID_REGTEST), 10000n);
  assert.equal(LOCK_EXPIRY_MARGIN_MS, 1800000n);
  // THE ROUND NAMES IT: 144 refused for the market, its own span taken, more taken
  assert.match(stakeExpiryFits(c, { manifest: MARKET }).why, /names stake_expiry_blocks 144, and its locks must last 480 blocks/);
  assert.equal(stakeExpiryFits(round({ stakeExpiryBlocks: 480 }), { manifest: MARKET }).ok, true);
  assert.equal(stakeExpiryFits(round({ stakeExpiryBlocks: 600 }), { manifest: MARKET }).ok, true);
  // A GAME (or a market with no terms) keeps the ruled 144, exactly
  assert.equal(stakeExpiryFits(c, { manifest: { resultType: 1 } }).ok, true);
  assert.match(stakeExpiryFits(round({ stakeExpiryBlocks: 480 }), { manifest: null }).why, /where §23\.1 rules 144/);
  // A NETWORK WITH NO MARKET CLOCK holds no market round
  assert.match(stakeExpiryFits(round({ networkId: new Uint8Array(32), stakeExpiryBlocks: 999 }), { manifest: MARKET }).why, /names no fastest block time/);
});

test('the market\'s own clock: a round closes at the end of a period on the UTC grid; its window is the period before', () => {
  const w = marketWindowOf(round(), MARKET);
  assert.deepEqual(w, { ok: true, window: { startMs: Q, endMs: Q + 900000n, periodMs: 900000n } });
  assert.match(marketWindowOf(round({ entryCloseMs: Q + 900001n }), MARKET).why, /runs one round per 900000 ms on the UTC grid/);
  assert.deepEqual(marketWindowOf(round({ entryCloseMs: Q + 1n }), { ...MARKET, roundPeriodMs: 0n }), { ok: true, window: null });
});
