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

// kanban #1489 v1-refute-33 s3 (after 504098fd6): THE HELD DOOR'S PEER ASK (aSeatHoldsCancel) STILL HAS #1520's 2 s BOUND AND WAITS FOR EVERY
// PEER (Promise.all), but the held door is now only the last 800 ms before the close and the clock is re-read after the ask. One hung seat of the
// round (SIGSTOP, overloaded, or a colluding one that just does not answer GET /cancels) makes every held-door take wait 2 s, past the close, and
// refuse - though seat A, which took the cancel at its player door in time, answers "I hold it" at once. A hand-on that lands 50 ms into the margin
// (a normal tunnel round trip) is lost at every seat, the retries too, and the round keeps two tables: the #1520 split again.
// Safe behaviour: a cancel one seat took in time reaches every responsive seat's table, whatever a third seat does.
test('one hung seat does not keep a cancel taken in time from the other seats (held door)', async () => {
  const round = { gameId: MARKET.registration.gameId, simCoreHash: b32(0), configHash: b32(0), donationSetId: donationSetId(NETWORK), entryCloseMs: 60000n };
  const w = await lockRound({ n: 7, stakeMsat: 1_000_000n, round, endMs: testNow() + 900000,
    serveOpts: { plugins: [NEXTBLOCK, MARKET.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST] } });
  skipTo(Number(w.c.committeeTimeMs) + 100);
  const realFetch = globalThis.fetch;
  try {
    const e = await lockAndPlay(w, player(70), { noMarks: true, pick: 1 });
    await lockAndPlay(w, player(71), { noMarks: true, pick: 0 });
    const close = Number(w.c.entryCloseMs);
    const hung = w.nodes[6].port, bPort = w.b.port;
    globalThis.fetch = (url, init = {}) => {
      const u = String(url);
      // seat 7 is stopped: it takes the connection and never answers
      if (u.includes(`:${hung}/`)) return new Promise((_, rej) => { if (init.signal) init.signal.addEventListener('abort', () => rej(new Error('aborted')), { once: true }); });
      // A's hand-on to B takes a normal tunnel round trip: it lands 50 ms into the last margin on B's clock
      if (u.includes(`:${bPort}/cancel?`) && init.headers && init.headers['x-arena-relayed'] === '1') {
        const until = close - 750;
        return (async () => { while (testNow() < until) await new Promise((r) => setTimeout(r, 5)); return realFetch(url, init); })();
      }
      return realFetch(url, init);
    };
    skipTo(close - 850);
    const sig = ed25519.sign(cancelId({ roundId: w.rid, entryId: e.eid }), e.session);
    const atA = await realFetch(`http://127.0.0.1:${w.a.port}/cancel?entry=${toHex(e.eid)}`, { method: 'POST', body: sig }).then((r) => r.status);
    const left = close - testNow();
    await wait(Math.max(0, left) + 2600);   // every retry until the close, and the last ask's bound
    const got = { atA, takenAtMsBeforeClose: left, atAHeld: !!w.a.round.cancelled(e.eid), atBHeld: !!w.b.round.cancelled(e.eid),
      heldAt: w.nodes.map((d) => !!d.round.cancelled(e.eid)) };
    console.log('  v1-refute-33-s3-1:', JSON.stringify(got));
    assert.equal(atA, 201);
    assert.equal(got.atAHeld, true);
    assert.equal(got.atBHeld, true, 'seat B never took a cancel seat A took in time: one hung seat split the tables');
  } finally { globalThis.fetch = realFetch; await w.close(); }
});
