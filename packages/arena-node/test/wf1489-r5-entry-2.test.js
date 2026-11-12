// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 r5 entry 2: ONE STRANGER'S POST /batch-void HOLDS A MARKET SEAT'S EVENT LOOP FOR SECONDS.
// OrderBook.applyVoid (order-batch.js) runs a BIP-340 verify for EVERY element of body.declines whose `seat` is one of the round's seats -
// with no cap on the list, no stop once a seat counted (or failed), and synchronously. The door answers anyone. A stranger who knows a
// market round id (public) and its seat keys (public) posts one body of up to the 8 MiB read limit: ~38,000 declines naming the round's
// seats, each with a different made-up signature (so the verify cache never answers), and the seat verifies them all before it answers -
// every other door, every batch, every settlement waits behind it. Repeated, the seat is stalled for good.
// SAFE: a void's declines are checked at most once per seat (a list longer than the round's seats is refused), so one such request is answered fast.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { lockRound } from './lock-round-fixture.js';
import { b32 } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { testAttestedGame } from './plugins/sign.js';
import { TEST_DONATION_SET_KEYS_REGTEST } from '../../arena-protocol/src/test-donation-set-keys-regtest.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { UP_DOWN_OUTCOMES } from '../../arena-protocol/src/up-down.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const UPDOWN = testAttestedGame({ name: 'btc-updown-15m-wf1489-r5e2', outcomes: [...UP_DOWN_OUTCOMES] });
const NETWORK = TEST_DONATION_SET_KEYS_REGTEST.recipients;
const ROUND = { gameId: UPDOWN.registration.gameId, simCoreHash: b32(0), configHash: b32(0), donationSetId: donationSetId(NETWORK), entryCloseMs: 900000n };
const N = 20000;

test('wf1489 r5 entry 2: a stranger\'s padded POST /batch-void is answered fast', { timeout: 170000 }, async () => {
  const w = await lockRound({ n: 7, stakeMsat: 10_000n, round: ROUND, endMs: testNow() + 1800000,
    serveOpts: { plugins: [NEXTBLOCK, UPDOWN.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST], orderBatchTimer: false } });
  skipTo(Number(w.c.committeeTimeMs) + 100);
  const rid = toHex(w.rid);
  try {
    const seats = w.c.nodes.map((k) => toHex(k));
    const declines = [];
    for (let i = 0; i < N; i++) declines.push({ seat: seats[i % seats.length], signature: toHex(new Uint8Array(randomBytes(64))) });
    const body = JSON.stringify({ k: '5', declines });
    const d = w.nodes[0];
    // a tick timer on the seat's own process: how long its event loop was held
    let gap = 0, last = Date.now();
    const tick = setInterval(() => { const n = Date.now(); gap = Math.max(gap, n - last); last = n; }, 10);
    const t0 = Date.now();
    const r = await fetch(`http://127.0.0.1:${d.port}/batch-void?round=${rid}`, { method: 'POST', body });
    const said = (await r.text()).slice(0, 120);
    const ms = Date.now() - t0;
    clearInterval(tick);
    console.log('MEASURED', JSON.stringify({ declines: N, bodyBytes: body.length, status: r.status, said, answerMs: ms, loopHeldMs: gap }));
    assert.ok(gap < 1000, `one stranger's POST /batch-void held the seat's event loop ${gap} ms (${N} junk declines verified one by one)`);
  } finally { await w.close?.(); }
});
