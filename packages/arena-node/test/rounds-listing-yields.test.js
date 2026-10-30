// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SEAT KEEPS ANSWERING WHILE IT LISTS ROUNDS (2026-10-04 07:15: "One listing held seat 1's loop 7.1 s. Cut that.").
// Measured live before the cut: seat 7, one uncached GET /rounds of 1709 rounds held the loop 6368 ms and /identity waited
// 6383 ms. Here a node holding four series (every round of the next 72 h) is asked for its whole listing while /identity
// is asked every 10 ms: no /identity may wait behind the listing, and two listings asked together are one build, one answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH } from '../../nextblock/plugin/nextblock.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { seriesTemplate, seriesIndexAt } from '../../arena-protocol/src/series.js';
import { HOSTED } from './plugins/hosted.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const NOW = 1790600000000;
const base = (nodes) => ({
  networkId: NETWORK_ID_REGTEST, configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 1,
  gameVerifySlots: 7, settlementSlots: 7, gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH,
  committeeTimeMs: 0n, randomnessRule: 'bitcoin-block-hash', startTimeMs: 0n, entryCloseMs: 0n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT',
  federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'],
  donationSetId: donationSetId(TEST_DONATION_SET_REGTEST.recipients),
  censusHeight: 900000, censusRoot: b32(2), stakeMsat: 0n, bondMinSats: 50000n, blockTicks: 4920,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150,
  minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes,
});

test('a whole /rounds listing does not hold the loop: /identity answers every 10 ms while it is built, and two asks share one build', async () => {
  const first = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, funded: () => true, now: () => NOW });
  const nodes = [first.round.pubkey];
  await first.close();
  const k0 = seriesIndexAt(NETWORK_ID_REGTEST, NOW) - 1;
  const series = [0, 1, 2, 3].map((j) => seriesTemplate(base(nodes), k0 + j));
  const s = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, funded: () => true, roundClock: () => NOW, series });
  try {
    const at = `http://127.0.0.1:${s.port}`;
    // THE SERIES WRITTEN FIRST: the writer writes a series' rounds in steps (444, then 617, then 343 more ...), so 30 ms after the
    // start the store held 266 - the large listing this test is about exists only once they are in (up to 60 s)
    const stored = () => s.round.db.prepare('SELECT count(*) AS n FROM rounds').get().n;
    for (let i = 0; i < 600 && stored() <= 2000; i++) await new Promise((r) => setTimeout(r, 100));
    const waits = [];
    let listing = true;
    const pinger = (async () => {
      while (listing) {
        const t = performance.now();
        await (await fetch(`${at}/identity`)).arrayBuffer();
        waits.push(performance.now() - t);
        await new Promise((r) => setTimeout(r, 10));
      }
    })();
    await new Promise((r) => setTimeout(r, 30));
    const t0 = performance.now();
    const [a, b] = await Promise.all([fetch(`${at}/rounds?ahead=72h`).then((r) => r.text()), fetch(`${at}/rounds?ahead=72h`).then((r) => r.text())]);
    const listMs = performance.now() - t0;
    listing = false; await pinger;
    const rows = JSON.parse(a).rounds.length;
    const worst = Math.max(...waits);
    console.log('  FACTS:', JSON.stringify({ rows, listMs: Math.round(listMs), identityAsks: waits.length, identityWorstMs: Math.round(worst) }));
    assert.ok(rows > 2000, `the node lists ${rows} rounds - not a large listing`);
    assert.equal(a, b, 'two listings asked together answered differently');
    assert.ok(waits.length >= 3, `/identity was answered ${waits.length} times while ${rows} rounds were listed in ${Math.round(listMs)} ms`);
    assert.ok(worst < 250, `/identity waited ${Math.round(worst)} ms behind a listing of ${rows} rounds (${Math.round(listMs)} ms)`);
  } finally { await s.close(); }
});
