// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1270 (audit 4 #1257 PLAYER-4): a market round is a book or a pool, and the seat decided which from every entry it held - also one no lock
// was ever made for. One free plain pick made a seat refuse every order of an Up/Down round (and a lockless order a pool's picks). Now only an entry
// whose stake this seat has seen decides it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { b32, LOSER } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { testAttestedGame } from './plugins/sign.js';
import { TEST_DONATION_SET_KEYS_REGTEST } from '../../arena-protocol/src/test-donation-set-keys-regtest.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { YES, NO } from '../../arena-protocol/src/order-book.js';
import { UP_DOWN_OUTCOMES } from '../../arena-protocol/src/up-down.js';

const UPDOWN = testAttestedGame({ name: 'btc-updown-15m', outcomes: [...UP_DOWN_OUTCOMES] });
const ROUND = { gameId: UPDOWN.registration.gameId, simCoreHash: b32(0), configHash: b32(0), donationSetId: donationSetId(TEST_DONATION_SET_KEYS_REGTEST.recipients), entryCloseMs: 900000n };
const player = (n) => ({ ...LOSER, name: `p${n}`, key: b32(0x70 + n), worldSecret: b32(0) });
const market = () => lockRound({ n: 2, stakeMsat: 10_000n, round: ROUND, endMs: testNow() + 1800000,
  serveOpts: { plugins: [NEXTBLOCK, UPDOWN.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST], orderBatchTimer: false } });
const took = (p) => p.then(() => 'taken', (e) => String(e.message).slice(0, 120));

test('#1270 a plain pick no lock was made for does not turn the round into a pool: a locked order is taken; and the reverse', async () => {
  const w = await market();
  let bookCase, poolCase;
  try {
    skipTo(Number(w.c.committeeTimeMs) + 100);
    const pick = await took(lockAndPlay(w, player(1), { noMarks: true, pick: YES, only: [] }));            // entry at both seats, no lock anywhere
    const order = await took(lockAndPlay(w, player(2), { noMarks: true, pick: NO, order: { price: 55_000n } }));
    bookCase = { lockless: pick, lockedOrderAfter: order, isBook: w.nodes.map((d) => d.orderBook.isBook(w.rid)) };
  } finally { await w.close(); }
  const v = await market();
  try {
    skipTo(Number(v.c.committeeTimeMs) + 100);
    const order = await took(lockAndPlay(v, player(3), { noMarks: true, pick: NO, order: { price: 55_000n }, only: [] }));
    const pick = await took(lockAndPlay(v, player(4), { noMarks: true, pick: YES }));
    poolCase = { lockless: order, lockedPickAfter: pick, isBook: v.nodes.map((d) => d.orderBook.isBook(v.rid)) };
  } finally { await v.close(); }
  console.log('  FACTS #1270:', JSON.stringify({ bookCase, poolCase }));
  assert.equal(bookCase.lockless, 'taken', 'the fixture: an entry is taken before any lock');
  assert.equal(bookCase.lockedOrderAfter, 'taken', `a locked order was refused after a lockless pick: ${bookCase.lockedOrderAfter}`);
  assert.equal(poolCase.lockedPickAfter, 'taken', `a locked pick was refused after a lockless order: ${poolCase.lockedPickAfter}`);
  assert.deepEqual(poolCase.isBook, [false, false], 'a lockless order made the round a book at a seat');
});
