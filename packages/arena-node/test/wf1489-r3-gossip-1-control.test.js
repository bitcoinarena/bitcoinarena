// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 round 3 (gossip): ONE PEER'S /series-template LINE CUTS A SERIES IT HANDS ON. A pulled line is believed when it hashes to
// the series id - but `cut=N` (series-line.js) is beside the id, not in it (series.js withoutSeries). One census peer answers the real,
// published template with ` cut=0` appended: the node takes it (its publication is on its own chain), holds the series, and its writer
// skips every round from index 0 (series-writer.js). The node never pulls it again (held), a later honest push answers `held: true`, the
// cut line goes to its grid file and is what its own GET /series-template hands on. A node drawn on those rounds cannot list, seat, sign
// PRESENT for or settle any of them.
// Safe behaviour: a peer's line for a series id writes that series' rounds; a cut is not taken on one peer's word.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { createServer } from 'node:http';
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


test('one peer appending cut=0 to a published series line does not stop the node from writing its rounds', async () => {
  const t = gridOf();
  const sid = toHex(seriesId(t));
  const view = { firstHeight: 100, blocks: [block(seriesId(t))] };
  const line = `${seriesLineOf(t, encodeRoundContract)}`;
  const evil = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/series') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ series: [{ series: sid, ahead: 225, startTimeMs: String(START) }] })); }
    if (u.pathname === '/series-template' && u.searchParams.get('id') === sid) { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(line); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => evil.listen(0, '127.0.0.1', r));
  const was = { first: process.env.ARENA_SERIES_PULL_FIRST_MS, every: process.env.ARENA_SERIES_PULL_MS };
  process.env.ARENA_SERIES_PULL_FIRST_MS = '100'; process.env.ARENA_SERIES_PULL_MS = '300';
  let node = null;
  try {
    node = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, funded: () => false, roundClock: () => NOW, chainFor: async () => view, peers: [`http://127.0.0.1:${evil.address().port}`] });
    const url = `http://127.0.0.1:${node.port}`;
    const mine = async () => (await (await fetch(`${url}/series`)).json()).series.find((x) => x.series === sid) || null;
    const got = await until(mine);
    assert.ok(got, 'the node pulled the published series');
    // the honest poster's own push comes too: it must not leave the node holding a series it writes nothing of
    const pushed = await fetch(`${url}/series`, { method: 'POST', body: seriesLineOf(t, encodeRoundContract) });
    const after = await mine();
    const served = await (await fetch(`${url}/series-template?id=${sid}`)).text();
    console.log(`  pulled from one peer with cut=0: written ${after.written}, ahead ${after.ahead}; honest push ${pushed.status} ${await pushed.text()}; it now hands on: ...${served.slice(-12)}`);
    assert.ok(after.written > 0, `one peer's cut=0 left the node holding series ${sid.slice(0, 16)} with ${after.written} of its ${t.seriesCount} rounds written, and the honest push did not mend it`);
  } finally {
    if (node) await node.close();
    await new Promise((r) => evil.close(r));
    for (const [k, v] of [['ARENA_SERIES_PULL_FIRST_MS', was.first], ['ARENA_SERIES_PULL_MS', was.every]]) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});
