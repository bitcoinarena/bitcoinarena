// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A NODE NO OPERATOR OF THE SERIES RUNS GETS THE DAY'S SERIES (kanban #757, 2026-10-28): the owner's installed node b36828fa was drawn in
// 67 of the day's rounds and held none - the poster pushed to its stale advert address, and a push that did reach it was refused 402
// (nobody named it funded there). Now a node takes a paying grid series whose publication its own chain confirms: pulled from a seat that
// holds it (series-pull.js), or pushed to POST /series. Not before the publication is on its chain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { seriesLineOf } from '../src/series-line.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH, NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { encodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { seriesId, seriesPublicationOutput, GRID_SERIES_LEAD_MIN_MS } from '../../arena-protocol/src/series.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { HOSTED } from './plugins/hosted.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const NOW = 1790600000000;
const START = BigInt(NOW) + 3600000n + 123n;
const gridOf = (over = {}) => ({
  networkId: NETWORK_ID_REGTEST, configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 1, gameVerifySlots: 2, settlementSlots: 2,
  gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH, committeeTimeMs: START - GRID_SERIES_LEAD_MIN_MS, randomnessRule: 'bitcoin-block-hash',
  startTimeMs: START, entryCloseMs: START + 80000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT',
  federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'],
  donationSetId: donationSetId(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000, censusRoot: b32(2), stakeMsat: 100000n,
  bondMinSats: 50000n, blockTicks: 4920, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: [b32(7), b32(8)],
  seriesGrid: true, seriesPeriodMs: 8000n, seriesCount: 225, ...over,
});
function rawTx(outputs) {
  const b = [];
  const u32 = (n) => b.push(n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255);
  u32(2); b.push(1, ...b32(1)); u32(0); b.push(0); u32(0xffffffff);
  b.push(outputs.length);
  for (const [sats, script] of outputs) { let v = BigInt(sats); for (let i = 0; i < 8; i++) { b.push(Number(v & 255n)); v >>= 8n; } b.push(script.length, ...script); }
  u32(0);
  return Uint8Array.from(b);
}
const block = (sid) => ({ header: new Uint8Array(80), transactions: [rawTx([[0, [...seriesPublicationOutput(sid).script]], [1000, [0x00, 0x14, ...new Array(20).fill(7)]]])] });
const until = async (f, ms = 15000) => { const end = Date.now() + ms; for (;;) { const v = await f(); if (v || Date.now() > end) return v; await new Promise((r) => setTimeout(r, 200)); } };

test('a node nobody named a series funded at takes it once its own chain confirms the publication: pulled from a seat, or pushed', async () => {
  const pulled = gridOf(), pushed = gridOf({ committeeTimeMs: START - GRID_SERIES_LEAD_MIN_MS - 7n });
  const viewA = { firstHeight: 100, blocks: [block(seriesId(pulled))] };
  // THE INSTALLED NODE'S CHAIN: the pulled series' publication confirmed, the pushed one's not yet
  const viewB = { firstHeight: 100, blocks: [block(seriesId(pulled))] };
  const was = { first: process.env.ARENA_SERIES_PULL_FIRST_MS, every: process.env.ARENA_SERIES_PULL_MS };
  process.env.ARENA_SERIES_PULL_FIRST_MS = '100'; process.env.ARENA_SERIES_PULL_MS = '300';
  const seat = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, funded: () => true, roundClock: () => NOW, chainFor: async () => viewA });
  let node = null;
  try {
    const seatUrl = `http://127.0.0.1:${seat.port}`;
    assert.equal((await fetch(`${seatUrl}/series`, { method: 'POST', body: seriesLineOf(pulled, encodeRoundContract) })).status, 200, 'the seat holds it');
    node = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, funded: () => false, roundClock: () => NOW, chainFor: async () => viewB, peers: [seatUrl] });
    const url = `http://127.0.0.1:${node.port}`;
    const held = async () => (await (await fetch(`${url}/series`)).json()).series.map((x) => x.series);
    // PULLED: the seat lists it, its line hashes to its id, the node's chain confirms its publication
    const got = await until(async () => (await held()).includes(toHex(seriesId(pulled))));
    console.log(`  pulled from the seat: ${got ? 'held' : 'NOT held'}`);
    assert.ok(got, 'the node pulled the series it was never pushed');
    // PUSHED BEFORE ITS PUBLICATION IS ON THIS NODE'S CHAIN: 402 as before; after, taken
    const before = await fetch(`${url}/series`, { method: 'POST', body: seriesLineOf(pushed, encodeRoundContract) });
    assert.equal(before.status, 402, await before.clone().text());
    viewB.blocks.push(block(seriesId(pushed)));
    const after = await fetch(`${url}/series`, { method: 'POST', body: seriesLineOf(pushed, encodeRoundContract) });
    console.log(`  pushed: before its publication ${before.status}, after ${after.status}`);
    assert.equal(after.status, 200, await after.clone().text());
    assert.deepEqual((await held()).sort(), [toHex(seriesId(pulled)), toHex(seriesId(pushed))].sort());
  } finally {
    if (node) await node.close();
    await seat.close();
    for (const [k, v] of [['ARENA_SERIES_PULL_FIRST_MS', was.first], ['ARENA_SERIES_PULL_MS', was.every]]) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

test('a free series is not taken on its publication alone', async () => {
  const free = gridOf({ stakeMsat: 0n });
  const view = { firstHeight: 100, blocks: [block(seriesId(free))] };
  const node = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, funded: () => false, roundClock: () => NOW, chainFor: async () => view });
  try {
    const r = await fetch(`http://127.0.0.1:${node.port}/series`, { method: 'POST', body: seriesLineOf(free, encodeRoundContract) });
    assert.equal(r.status, 402);
  } finally { await node.close(); }
});
