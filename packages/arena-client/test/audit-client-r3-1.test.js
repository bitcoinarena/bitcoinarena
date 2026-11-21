// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// audit 2026-11-19 client r3 #1 (gap in the #2721 fix): the page's price block votes on a sample by its priceCents ALONE and keeps the
// FIRST voter's object - its sigs and readings - for the tick. One seat listed before the honest ones serves the honest price with junk
// signatures/readings: the vote stands (the honest seats agree on the price), but the junk attestation is what the page hands
// submitAttestedSample, so it goes into the player's signed batch and every feed seat refuses that batch (checkBatchPrices).
// The same holds for the tape (voted by its prices, the first voter's sigs/readings kept).
// Safe: the attestation signed into the batch is one the honest seats served, never one seat's junk copy of the agreed price.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageFunction } from './page-script.js';
import { centsToTapeUnits } from '../../arena-protocol/src/price-sample.js';

const PAGE = new URL('../../../src/arena-ui/index.html', import.meta.url);
const HTML = readFileSync(PAGE, 'utf8');
const from = '    (function () {\n      var P = window.ARENA_PRICES';
const at = HTML.indexOf(from); assert.ok(at > 0);
const BLOCK = HTML.slice(at, HTML.indexOf('\n    })();\n', at) + '\n    })();\n'.length);

const PRICE = 8297193;
const good = { key: '01'.repeat(32), signature: '02'.repeat(64) };
const junk = { key: '01'.repeat(32), signature: '00'.repeat(64) };
const goodReadings = [{ key: '01'.repeat(32), priceCents: PRICE, signature: '03'.repeat(64) }];
const junkReadings = [{ key: '01'.repeat(32), priceCents: PRICE, signature: '00'.repeat(64) }];
const settle = () => new Promise((r) => setTimeout(r, 10));
const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');

function rig(answerOf) {
  const client = { offered: 0, got: [], submitAttestedSample: (x) => { client.got.push(x); return true; }, submitAttestedTape: () => true };
  const core = { step: () => { client.offered++; }, submitSample: () => true, submitTape: () => true };
  const window = { ARENA_CORES: { a: core }, unityInstance: { Module: { blwpNet: { inWorld: true, client } } } };
  const fetch = async (u) => { const a = answerOf(String(u)); return { ok: a.status === 200, status: a.status, json: async () => a.body }; };
  pageFunction(PAGE, ['window', 'ARENACLIENT', 'fetch', 'setInterval', 'clearInterval', 'console', 'AbortSignal'], BLOCK)(
    window, { centsToTapeUnits }, fetch, () => 1, () => {}, { log: () => {} }, { timeout: () => undefined });
  return { P: window.ARENA_PRICES, core, client };
}

test('audit-client-r3-1: a first-listed seat\'s junk signatures on the agreed price are not what the player\'s batch carries', async () => {
  const honest = { feed: true, samples: [{ tick: 2, priceCents: PRICE, sigs: [good, good, good, good, good], readings: goodReadings }] };
  const evil = { feed: true, samples: [{ tick: 2, priceCents: PRICE, sigs: [junk], readings: junkReadings }] };
  const { P, core, client } = rig((u) => ({ status: 200, body: u.startsWith('http://evil') ? evil : honest }));
  P.watch('ab'.repeat(32), ['http://evil', 'http://seat-2', 'http://seat-3']); await settle();
  for (let i = 0; i < 4; i++) core.step({});
  assert.equal(client.got.length, 1, 'the agreed sample is applied once');
  const s = client.got[0];
  const sigHex = s.sigs.map(([, sg]) => hex(sg));
  const readHex = s.readings.map(([, , sg]) => hex(sg));
  console.log(`FACTS: batch carries ${s.sigs.length} sig(s) ${JSON.stringify(sigHex.map((h) => h.slice(0, 8)))}, readings ${JSON.stringify(readHex.map((h) => h.slice(0, 8)))}`);
  assert.ok(!readHex.includes('00'.repeat(64)), 'one seat\'s junk readings went into the player\'s signed batch (the feed seats refuse it)');
  assert.ok(!sigHex.includes('00'.repeat(64)), 'one seat\'s junk signatures went into the player\'s signed batch');
});

