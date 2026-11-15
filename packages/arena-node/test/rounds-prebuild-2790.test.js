// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE NEXT LISTING WINDOW IS BUILT BEFORE IT IS ASKED (kanban #2790, after #2783 / feedback #082): the first listing of each 45 s window signed
// every row it named while its asker waited - 30.0 s on fed2-1 and 11.7 s on guardian-4 (live, 2026-11-15) - and any caller could make that
// build once a window. A timer now builds the next window 15 s before it starts, with the rows the running window was asked for; the first
// ask of the new window is served from it, signing nothing.
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

import { schnorr } from '@noble/curves/secp256k1.js';
import { lobbyListingId } from '../../arena-protocol/src/lobby-listing.js';
import { fromHex } from '../../arena-protocol/src/hash.js';
import { HOSTED } from './plugins/hosted.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const pageChecks = (body) => body.rounds.every((x) => schnorr.verify(fromHex(x.sig), lobbyListingId({ roundId: fromHex(x.id),
  nodePubkey: fromHex(body.node), nowMs: BigInt(body.nowMs), phase: x.phase, assignedHere: !!x.assignedHere,
  joined: Number(x.joined), playing: Number(x.playing) }), fromHex(body.node)));

test('#2790 the first full listing of a new window signs nothing: the window was built ahead, and its rows check the page\'s way', async () => {
  const first = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, funded: () => true, now: () => NOW });
  const nodes = [first.round.pubkey];
  await first.close();
  const k0 = seriesIndexAt(NETWORK_ID_REGTEST, NOW) - 1;
  const series = [0, 1, 2, 3].map((j) => seriesTemplate(base(nodes), k0 + j));
  let clock = NOW;
  const s = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, funded: () => true, roundClock: () => clock, series });
  try {
    const at = `http://127.0.0.1:${s.port}`;
    const ask = async (q) => { const t = performance.now(); const body = await (await fetch(`${at}/rounds${q}`)).json(); return { ms: performance.now() - t, body }; };
    const full = await ask('?all=1&probe=a');
    const rows = full.body.rounds.length;
    assert.ok(rows > 2000, `the node lists ${rows} rounds - not a large listing`);
    assert.equal(BigInt(full.body.nowMs), BigInt(NOW));
    // 31 s into the window: inside the 15 s before the next one - the timer builds it
    clock = NOW + 31000;
    const built = () => (typeof s.listingWindowsBuilt === 'function' ? s.listingWindowsBuilt() : 0);
    for (let i = 0; i < 120 && built() < 1; i++) await new Promise((r) => setTimeout(r, 250));
    // the window is not served before its time: the running one still answers
    const early = await ask('?next=1');
    assert.equal(BigInt(early.body.nowMs), BigInt(NOW), 'the window built ahead was served before its time');
    clock = NOW + 45000;
    await new Promise((r) => setTimeout(r, 5100));   // past the 5 s a small listing is kept in real time (server.js /rounds)
    const before = s.listingSignatures();
    const later = await ask('?all=1&probe=b');
    const signedByAsk = s.listingSignatures() - before;
    console.log('  FACTS:', JSON.stringify({ rows, built: built(), firstMs: Math.round(full.ms), newWindowMs: Math.round(later.ms), signedByAsk }));
    assert.equal(BigInt(later.body.nowMs), BigInt(NOW) + 45000n, 'the new window does not carry its own time');
    assert.equal(later.body.rounds.length, rows);
    assert.equal(signedByAsk, 0, `the first full listing of the new window signed ${signedByAsk} rows while its asker waited`);
    assert.ok(later.ms < 1000, `the first full listing of the new window took ${Math.round(later.ms)} ms`);
    assert.ok(pageChecks(later.body), 'a row of the window built ahead does not check the page\'s way');
  } finally { await s.close(); }
});
