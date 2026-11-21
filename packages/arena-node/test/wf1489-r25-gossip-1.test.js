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

// kanban #1489 r25-gossip-1: THE HELD DOOR TAKES A LATE CANCEL ON ONE SEAT'S UNCHECKED WORD (aSeatHoldsCancel, "the first seat that lists it is
// enough"). In the last CANCEL_PLAYER_DOOR_MARGIN_MS the player's own door is shut and a cancel marked x-arena-relayed is taken only if "a seat
// of the round holds it" - read from each peer's GET /cancels, where ONE colluding seat lists any entry id it likes. So a player with one seat
// posts his marked cancel in the margin to some honest seats only: each asks, the colluder says yes at once, each takes it. Their hand-ons land
// (a normal 50 ms tunnel round trip) past the ask budget at the other honest seats, which refuse: two tables, 3 honest seats each - neither
// reaches 5 of 7 without the colluder, who picks a side or none (the #1520 split, every payout of the market waits for the lock expiry).
// Safe behaviour: a cancel that no honest seat took at its player door is not taken in the held window on one seat's listing; every honest
// seat ends with the same table.
test('one colluding seat listing a cancel in GET /cancels does not open the held door', async () => {
  const round = { gameId: MARKET.registration.gameId, simCoreHash: b32(0), configHash: b32(0), donationSetId: donationSetId(NETWORK), entryCloseMs: 60000n };
  const w = await lockRound({ n: 7, stakeMsat: 1_000_000n, round, endMs: testNow() + 900000,
    serveOpts: { plugins: [NEXTBLOCK, MARKET.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST] } });
  skipTo(Number(w.c.committeeTimeMs) + 100);
  const realFetch = globalThis.fetch;
  try {
    const e = await lockAndPlay(w, player(80), { noMarks: true, pick: 1 });
    await lockAndPlay(w, player(81), { noMarks: true, pick: 0 });
    const close = Number(w.c.entryCloseMs), hex = toHex(e.eid);
    const colluder = w.nodes[6].port;
    const far = new Set([3, 4, 5].map((i) => w.nodes[i].port));
    globalThis.fetch = (url, init = {}) => {
      const u = String(url);
      // the colluding seat lists the cancel in its GET /cancels, holding nothing
      if (u.includes(`:${colluder}/cancels?`)) return Promise.resolve(new Response(JSON.stringify({ round: toHex(w.rid), cancels: [{ entry: hex, signature: '00'.repeat(64) }] }), { status: 200, headers: { 'content-type': 'application/json' } }));
      // a seat's hand-on to seats 4-6 takes a slow tunnel round trip (120 ms)
      const port = Number((u.match(/:(\d+)\/cancel\?/) || [])[1]);
      if (far.has(port)) return new Promise((r) => setTimeout(r, 120)).then(() => realFetch(url, init));
      return realFetch(url, init);
    };
    skipTo(close - 150);   // inside the margin: the player's own door is shut
    const sig = ed25519.sign(cancelId({ roundId: w.rid, entryId: e.eid }), e.session);
    const said = await Promise.all([0, 1, 2].map((i) => realFetch(`http://127.0.0.1:${w.nodes[i].port}/cancel?entry=${hex}`,
      { method: 'POST', body: sig, headers: { 'x-arena-relayed': '1' } }).then((r) => r.status)));
    await wait(Math.max(0, close - testNow()) + 2600);
    const heldAt = w.nodes.slice(0, 6).map((d) => !!d.round.cancelled(e.eid));
    console.log('  r25-gossip-1:', JSON.stringify({ said, heldAt }));
    assert.deepEqual(said.map((s) => s === 201), [false, false, false], 'an honest seat took a late cancel on one colluding seat\'s listing');
    assert.equal(new Set(heldAt).size, 1, 'the honest seats hold different tables: no table reaches the threshold without the colluder');
  } finally { globalThis.fetch = realFetch; await w.close(); }
});
