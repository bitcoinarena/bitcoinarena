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

// kanban #2076 (#1489 v1-refute-33 s3, the hand-on side): one hung seat of the round held back the RETRIES of every hand-on - the retry timer
// waited for every peer's try (Promise.all, each bounded by up to 2 s) before it started the next round of tries, so a seat that refused the
// first tries (overloaded, restarting) was asked again only after the hung seat's try timed out, and the hand-on missed the player margin.
// Safe behaviour: each peer's try runs on its own, so a seat that comes back is handed the cancel within a retry or two, while the player
// door is still open - without needing the held door at all.
test('one hung seat does not hold back the hand-on retries to the other seats', async () => {
  const round = { gameId: MARKET.registration.gameId, simCoreHash: b32(0), configHash: b32(0), donationSetId: donationSetId(NETWORK), entryCloseMs: 60000n };
  const w = await lockRound({ n: 7, stakeMsat: 1_000_000n, round, endMs: testNow() + 900000,
    serveOpts: { plugins: [NEXTBLOCK, MARKET.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST] } });
  skipTo(Number(w.c.committeeTimeMs) + 100);
  const realFetch = globalThis.fetch;
  try {
    const e = await lockAndPlay(w, player(72), { noMarks: true, pick: 1 });
    await lockAndPlay(w, player(73), { noMarks: true, pick: 0 });
    const close = Number(w.c.entryCloseMs);
    const hung = w.nodes[6].port, bPort = w.b.port;
    const busyUntil = close - 2500;
    globalThis.fetch = (url, init = {}) => {
      const u = String(url);
      if (u.includes(`:${hung}/`)) return new Promise((_, rej) => { if (init.signal) init.signal.addEventListener('abort', () => rej(new Error('aborted')), { once: true }); });
      // seat B is overloaded for the first 2.5 s of the hand-on and refuses it
      if (u.includes(`:${bPort}/cancel?`) && init.headers && init.headers['x-arena-relayed'] === '1' && testNow() < busyUntil)
        return Promise.resolve(new Response('busy', { status: 503 }));
      return realFetch(url, init);
    };
    skipTo(close - 5000);
    const sig = ed25519.sign(cancelId({ roundId: w.rid, entryId: e.eid }), e.session);
    const atA = await realFetch(`http://127.0.0.1:${w.a.port}/cancel?entry=${toHex(e.eid)}`, { method: 'POST', body: sig }).then((r) => r.status);
    while (testNow() < close - 850) await wait(20);
    const got = { atA, atBHeldBeforeMargin: !!w.b.round.cancelled(e.eid), heldAt: w.nodes.map((d) => !!d.round.cancelled(e.eid)) };
    console.log('  v1-refute-33-s3-2:', JSON.stringify(got));
    assert.equal(atA, 201);
    assert.equal(got.atBHeldBeforeMargin, true, 'seat B was not handed the cancel before the player margin: a hung seat held back the retries');
  } finally { globalThis.fetch = realFetch; await w.close(); }
});
