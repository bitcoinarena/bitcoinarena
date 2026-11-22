// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3268 (feedback #383, live UI 724 2026-11-22): Rock Paper Scissors said "The next round opens in a moment" for hours.
// #3041 made the page's fetchRound check a series round against its series' template, and join.js imported
// `seriesId as seriesIdOf`. The bundler strips imports, and series.js has a private top-level `seriesIdOf(template, periodMs, count)`,
// so in the page `seriesIdOf(t)` called that one with no period: BigInt(undefined) threw, every template read was "the next seat",
// every series round was refused at every seat (6,157 GET /series-template per seat in 3 min, measured in Chrome), no contract, no row.
// Every node test was green: the modules bind the alias right. This runs the BUILT bundle of this source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { seriesRound } from '../../arena-protocol/src/series.js';
import { seriesLineOf } from '../../arena-protocol/src/series-line.js';
import { encodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';

const ROOT = new URL('../../../', import.meta.url).pathname;
const b32 = (n) => new Uint8Array(32).fill(n);
const PERIOD = 8000n;
const G = 1788201000000n - (1788201000000n % PERIOD);
const TEMPLATE = {
  networkId: b32(0x4e), configHash: new Uint8Array(32), censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, gameId: b32(0x71), simCoreHash: b32(0x5c),
  startTimeMs: G, entryCloseMs: G, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
  slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: b32(0xd0),
  censusHeight: 964900, censusRoot: b32(2), committeeTimeMs: G - 3600000n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 0n, bondMinSats: 100000n,
  blockTicks: 9000, exposureReference: 12451840, corridorHalfWidth: 3014656, spawnFreeRadius: 1441792, timeFloor: 16384, timeCeil: 98304,
  minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: [], protocolVersion: 3, seriesGrid: true, seriesPeriodMs: PERIOD, seriesCount: 10800,
};

test('the page bundle built from this source takes an honest series round its seats serve (an RPS grid round)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'blwp-3268-'));
  execFileSync(process.execPath, [ROOT + 'packages/arena-client/tools/bundle.js'], { env: { ...process.env, ARENA_BUNDLE_OUT: dir }, stdio: 'pipe' });
  const bundled = createRequire(import.meta.url)(join(dir, 'arena-client.js'));
  const round = seriesRound(TEMPLATE, 2539);
  const id = toHex(roundId(round));
  const asked = [];
  const fetcher = async (url) => {
    const u = new URL(url); asked.push(u.pathname);
    if (u.pathname === '/round') return new Response(encodeRoundContract(round));
    if (u.pathname === '/series-template') return new Response(seriesLineOf(TEMPLATE));
    return new Response('no', { status: 404 });
  };
  let got = null, why = '';
  try { got = await bundled.fetchRound(id, ['https://seat-1.example', 'https://seat-2.example'], { fetcher }); } catch (e) { why = e.message; }
  assert.ok(got && got.contract, `the bundle refused an honest series round: ${why}`);
  assert.equal(got.contract.entryCloseMs, round.entryCloseMs);
  assert.equal(asked.filter((p) => p === '/series-template').length, 1, `one template read for one series, not ${asked.join(' ')}`);
});
