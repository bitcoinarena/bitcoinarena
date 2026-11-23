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

test('refute #3033 variant: one committee seat splits the honest seats 3/3 and denies the page the tick\'s price', async () => {
  const nodes = ['http://evil', 'http://a1', 'http://a2', 'http://a3', 'http://b1', 'http://b2', 'http://b3'];
  // evil's reading (id 6) reached a1..a3 before they served, b1..b3 served after SERVE_AFTER_MS without it; evil serves junk on the agreed price
  const junk = { feed: true, samples: [{ tick: 2, priceCents: PRICE, readings: readingsOf([0, 1, 2, 3, 4, 5]).map((r) => ({ ...r, signature: '00'.repeat(64) })) }] };
  const { P, core, client } = rig((u) => ({ status: 200, body: u.startsWith('http://evil') ? junk : u.startsWith('http://a') ? served([0, 1, 2, 3, 4, 5, 6]) : served([0, 1, 2, 3, 4, 5]) }));
  P.watch('ab'.repeat(32), nodes); await settle();
  for (let i = 0; i < 4; i++) core.step({});
  console.log(`FACTS: samples held ${P.samples.size}, applied ${client.got.length}`);
  assert.equal(client.got.length, 1, 'six honest seats serve the agreed price with valid readings, one seat\'s junk copy denies the tick');
});
