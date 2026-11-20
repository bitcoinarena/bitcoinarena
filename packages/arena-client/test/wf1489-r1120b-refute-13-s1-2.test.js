// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute of #3033 (r1120b item 13). The #3033 fix votes the attestation by attKey = JSON of (sigs, readings) ONLY,
// inside a price group keyed by String(priceCents), and keeps the FIRST voter's whole object of the winning attestation group.
//  1. A first-listed seat copies the honest readings and serves priceCents as the STRING "8297193" (String() equals the number's
//     key, attKey equals the honest attestation's): its object is the one kept, the string goes into the player's batch, and the
//     batch encoder (i32) throws / the seats refuse it - the same effect #3033 closed, by another field of the same object.
//  2. Honest seats that agree on the price but hold different (all valid) subsets of the committee's readings - normal after
//     SERVE_AFTER_MS when one reading is late - split the attestation vote into a tie: the page keeps NO sample for that tick
//     (before #3033 it kept a valid one), and once a later tick is held `since` passes it, so it is lost for good.
//  3. One committee seat can engineer that split (its reading delivered to half the honest seats just before SERVE_AFTER_MS)
//     and deny the page every tick's price wherever it stands in the list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageFunction } from './page-script.js';
import { centsToTapeUnits } from '../../arena-protocol/src/price-sample.js';
import { encodeInputBatch } from '../../arena-protocol/src/batch.js';

const PAGE = new URL('../../../src/arena-ui/index.html', import.meta.url);
const HTML = readFileSync(PAGE, 'utf8');
const from = '    (function () {\n      var P = window.ARENA_PRICES';
const at = HTML.indexOf(from); assert.ok(at > 0);
const BLOCK = HTML.slice(at, HTML.indexOf('\n    })();\n', at) + '\n    })();\n'.length);

const PRICE = 8297193;
const settle = () => new Promise((r) => setTimeout(r, 10));
const key = (i) => (i + 1).toString(16).padStart(2, '0').repeat(32);
const reading = (i) => ({ key: key(i), priceCents: PRICE, signature: (0x10 + i).toString(16).padStart(2, '0').repeat(64) });
const readingsOf = (ids) => ids.map(reading);

function rig(answerOf) {
  const client = { offered: 0, got: [], submitAttestedSample: (x) => { client.got.push(x); return true; }, submitAttestedTape: () => true };
  const core = { step: () => { client.offered++; }, submitSample: () => true, submitTape: () => true };
  const window = { ARENA_CORES: { a: core }, unityInstance: { Module: { blwpNet: { inWorld: true, client } } } };
  const fetch = async (u) => { const a = answerOf(String(u)); return { ok: a.status === 200, status: a.status, json: async () => a.body }; };
  pageFunction(PAGE, ['window', 'ARENACLIENT', 'fetch', 'setInterval', 'clearInterval', 'console', 'AbortSignal'], BLOCK)(
    window, { centsToTapeUnits }, fetch, () => 1, () => {}, { log: () => {} }, { timeout: () => undefined });
  return { P: window.ARENA_PRICES, core, client };
}
const served = (ids, priceCents = PRICE) => ({ feed: true, samples: [{ tick: 2, priceCents, readings: readingsOf(ids) }] });

test('refute #3033 honest path: three honest seats on the same price with different valid reading subsets - the page keeps no sample', async () => {
  const subsets = { 'http://seat-1': [0, 1, 2, 3, 4, 5, 6], 'http://seat-2': [0, 1, 2, 3, 4, 5], 'http://seat-3': [0, 1, 2, 3, 4, 6] };
  const { P, core, client } = rig((u) => ({ status: 200, body: served(subsets[Object.keys(subsets).find((b) => u.startsWith(b))]) }));
  P.watch('ab'.repeat(32), Object.keys(subsets)); await settle();
  for (let i = 0; i < 4; i++) core.step({});
  console.log(`FACTS: samples held ${P.samples.size}, applied ${client.got.length}`);
  assert.equal(client.got.length, 1, 'three honest seats agree on the price, each serving a valid attestation (>= 5 committee readings), yet no sample is played');
});

// kanban #3159: the tape the same way - honest seats with different valid subsets of the committee's signed tapes, plus one seat's
// junk copy and one seat's tape with a string price, still give the page ONE tape, built from the merged tapes (their medians)
test('#3159 tape: split subsets of the signed tapes and a junk copy still give the page the agreed tape', async () => {
  const prices = Array.from({ length: 64 }, (_, i) => 8290000 + i);
  const t = (i) => ({ key: key(i), prices: prices.slice(), signature: (0x10 + i).toString(16).padStart(2, '0').repeat(64) });
  const tapeOf = (ids) => ({ tick: 0, prices: prices.slice(), readings: ids.map(t) });
  const bodies = { 'http://evil': { feed: true, samples: [], tape: { tick: 0, prices: prices.slice(), readings: [0, 1, 2, 3, 4].map((i) => ({ ...t(i), signature: '00'.repeat(64) })) } },
    'http://str': { feed: true, samples: [], tape: { tick: 0, prices: prices.map(String), readings: [0, 1, 2, 3, 4, 5, 6].map(t) } },
    'http://a1': { feed: true, samples: [], tape: tapeOf([0, 1, 2, 3, 4, 5, 6]) }, 'http://a2': { feed: true, samples: [], tape: tapeOf([0, 1, 2, 3, 4, 5, 6]) },
    'http://b1': { feed: true, samples: [], tape: tapeOf([0, 1, 2, 3, 4, 5]) }, 'http://b2': { feed: true, samples: [], tape: tapeOf([0, 1, 2, 3, 4, 5]) } };
  let got = null;
  const { P, core, client } = rig((u) => ({ status: 200, body: bodies[Object.keys(bodies).find((b) => u.startsWith(b))] }));
  client.submitAttestedTape = (x) => { got = x; return true; };
  P.watch('ab'.repeat(32), Object.keys(bodies)); await settle();
  core.step({});
  assert.ok(got, 'the agreed tape is applied');
  assert.ok(got.prices.every((p, i) => p === prices[i] && Number.isInteger(p)));
  assert.equal(got.readings.length, 7, 'the union of the agreeing seats\' tapes, one a key');
  assert.ok(!got.readings.some(([, , sg]) => sg.every((b) => b === 0)), 'no junk tape');
});
