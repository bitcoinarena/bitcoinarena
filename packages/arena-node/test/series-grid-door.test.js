// POST /series (kanban #293, the owner 2026-10-12: "Replace the 450 round posts with one post per table"): a seat takes a grid
// series line - funded by its series id, held to the grid rule - writes its rounds as any series', keeps the line beside its
// store and holds it again after a restart. Not a day series, not a grid short of its 45 min lead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { seriesLineOf, parseSeriesLine } from '../src/series-line.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH, NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { encodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { seriesId, seriesRound, GRID_SERIES_LEAD_MIN_MS } from '../../arena-protocol/src/series.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { HOSTED } from './plugins/hosted.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const NOW = 1790600000000;
const START = BigInt(NOW) + 3600000n + 123n;
const gridOf = (nodes, over = {}) => ({
  networkId: NETWORK_ID_REGTEST, configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 1, gameVerifySlots: 2, settlementSlots: 2,
  gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH, committeeTimeMs: START - GRID_SERIES_LEAD_MIN_MS, randomnessRule: 'bitcoin-block-hash',
  startTimeMs: START, entryCloseMs: START + 80000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT',
  federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'],
  donationSetId: donationSetId(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000, censusRoot: b32(2), stakeMsat: 100000n,
  bondMinSats: 50000n, blockTicks: 4920, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes,
  seriesGrid: true, seriesPeriodMs: 8000n, seriesCount: 225, ...over,
});

test('a grid series line is taken once per table, funded by its id, written, kept and held again after a restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'grid-door-'));
  const db = join(dir, 'node.db'), gridFile = join(dir, 'node.db.grid-series');
  const named = new Set();
  const funded = ({ kind, contract }) => (kind === 'series' ? named.has(toHex(contract.seriesIdBytes)) : true);
  const probe = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, funded: () => true });
  const nodes = [probe.round.pubkey, b32(8)]; await probe.close();
  const t = gridOf(nodes), line = seriesLineOf(t, encodeRoundContract);
  assert.match(line, / grid period=8000 count=225$/);
  assert.equal(toHex(seriesId(parseSeriesLine(line))), toHex(seriesId(t)), 'the line reads back as the same series');
  const s = await serve(openStore(db), { plugins: HOSTED, port: 0, funded, roundClock: () => NOW, gridSeriesFile: gridFile });
  try {
    const url = `http://127.0.0.1:${s.port}`;
    const post = (body) => fetch(`${url}/series`, { method: 'POST', body });
    // NOT FUNDED: nobody named its id
    const r0 = await post(line);
    assert.equal(r0.status, 402);
    assert.match(await r0.text(), /series nobody has funded/);
    named.add(toHex(seriesId(t)));
    const r1 = await post(line);
    assert.equal(r1.status, 200);
    assert.deepEqual(await r1.json(), { ok: true, series: toHex(seriesId(t)), rounds: 225, held: false });
    const r2 = await post(line);
    assert.equal((await r2.json()).held, true, 'the same line again: held, not taken twice');
    // NOT A DAY SERIES, NOT A GRID SHORT OF ITS LEAD, NOT A LINE
    const day = await post(seriesLineOf({ ...t, seriesGrid: undefined }, encodeRoundContract));
    assert.equal(day.status, 400);
    const short = gridOf(nodes, { committeeTimeMs: START - GRID_SERIES_LEAD_MIN_MS + 1n });
    named.add(toHex(seriesId(short)));
    const r3 = await post(seriesLineOf(short, encodeRoundContract));
    assert.equal(r3.status, 409);
    assert.match(await r3.text(), /a grid needs 2700000 ms \(45 min\)/);
    assert.equal((await post('zz')).status, 400);
    // ITS ROUNDS ARE WRITTEN BY THE SERIES WRITER: the derived ids, listed
    await new Promise((r) => setTimeout(r, 300));
    const listed = new Set((await (await fetch(`${url}/rounds?ahead=${2 * 3600000}`)).json()).rounds.map((r) => r.id));
    assert.ok(listed.has(toHex(roundId(seriesRound(t, 0)))), 'round 0 listed');
    assert.ok(listed.has(toHex(roundId(seriesRound(t, 224)))), 'round 224 listed');
    // AND A POSTED ROUND OF IT PASSES THE SERIES CHECK AS DERIVED (this seat reaches no federation, so a paying round stops
    // there - after the series check), and is refused by it moved
    const ok = await fetch(`${url}/round`, { method: 'POST', body: encodeRoundContract(seriesRound(t, 3)) });
    assert.doesNotMatch(await ok.text(), /series round refused/);
    const moved = await fetch(`${url}/round`, { method: 'POST', body: encodeRoundContract({ ...seriesRound(t, 3), entryCloseMs: seriesRound(t, 3).entryCloseMs + 1n }) });
    assert.equal(moved.status, 409);
    assert.match(await moved.text(), /series round refused: round 3 of series .* opens and closes its entry/);
    assert.equal(readFileSync(gridFile, 'utf8'), line + '\n', 'kept once beside the store');
  } finally { await s.close(); }
  // A RESTART HOLDS IT AGAIN from the grid file
  const again = await serve(openStore(db), { plugins: HOSTED, port: 0, funded, roundClock: () => NOW, gridSeriesFile: gridFile });
  try {
    const held = (await (await fetch(`http://127.0.0.1:${again.port}/series`)).json()).series.map((x) => x.series);
    assert.deepEqual(held, [toHex(seriesId(t))]);
  } finally { await again.close(); }
});
