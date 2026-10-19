// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE COMMITTEE'S PRICE, APPLIED AT ITS TICK (§11, kanban #311): the page's own block (page-script.js) on a fake core,
// client and seat. Measured: before any attested sample nothing changes; once the seats serve them, Unity's own price reaches
// no core and no batch, and each attested sample (and the tape at tick 0) is handed to the core just before its tick, in the
// tape's unit, and to the client with its signatures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageFunction } from './page-script.js';
import { centsToTapeUnits } from '../../arena-protocol/src/price-sample.js';

const PAGE = new URL('../../../unity-proto/Assets/WebGLTemplates/NextBlock/index.html', import.meta.url);
const HTML = readFileSync(PAGE, 'utf8');
const from = '    (function () {\n      var P = window.ARENA_PRICES';
const at = HTML.indexOf(from); assert.ok(at > 0);
const BLOCK = HTML.slice(at, HTML.indexOf('\n    })();\n', at) + '\n    })();\n'.length);

function rig({ samples = [], tape = null, feed, status = 200, gate = null } = {}) {
  const calls = [];
  const core = { step: (st, ...w) => { calls.push(['step', client.offered]); client.offered++; },
    submitSample: (st, p) => { calls.push(['sample', client.offered, p]); return true; },
    submitTape: (st, ps) => { calls.push(['tape', client.offered, ps.length]); return true; } };
  const client = { offered: 0, got: [], submitAttestedSample: (x) => { client.got.push(['sample', x.tick, x.priceCents, x.sigs.length]); return true; },
    submitAttestedTape: (x) => { client.got.push(['tape', x.tick, x.prices.length, x.sigs.length]); return true; } };
  const window = { BLWP_CORES: { a: core }, unityInstance: { Module: { blwpNet: { inWorld: true, client } } } };
  const fetch = async () => { if (gate) await gate; return { ok: status === 200, status, json: async () => ({ samples, tape, ...(feed === undefined ? {} : { feed }) }) }; };
  pageFunction(PAGE, ['window', 'BLWPCLIENT', 'fetch', 'setInterval', 'clearInterval', 'console', 'AbortSignal'], BLOCK)(
    window, { centsToTapeUnits }, fetch, () => 1, () => {}, { log: () => {} }, { timeout: () => undefined });
  return { P: window.ARENA_PRICES, core, client, calls };
}
const sig = { key: '01'.repeat(32), signature: '02'.repeat(64) };
const settle = () => new Promise((r) => setTimeout(r, 5));

test('with no attested sample nothing changes: Unity\'s price reaches the core', async () => {
  const { P, core, calls } = rig();
  P.watch('ab'.repeat(32), ['http://seat']); await settle();
  assert.equal(P.active, false);
  assert.equal(core.submitSample({}, 123), true);
  core.step({});
  assert.deepEqual(calls, [['sample', 0, 123], ['step', 0]]);
});

test('once the seats serve attested samples, only they reach the core - each just before its tick - and the client with the signatures', async () => {
  const tape = { tick: 0, prices: Array.from({ length: 64 }, (_, i) => 8290000 + i), sigs: [sig, sig] };
  const { P, core, client, calls } = rig({ samples: [{ tick: 2, priceCents: 8297193, sigs: [sig] }], tape });
  P.watch('ab'.repeat(32), ['http://seat']); await settle();
  assert.equal(P.active, true);
  assert.equal(core.submitSample({}, 999), false, 'Unity\'s own price reaches no core');
  assert.equal(core.submitTape({}, []), false);
  for (let i = 0; i < 4; i++) core.step({});
  assert.deepEqual(calls, [['tape', 0, 64], ['step', 0], ['step', 1], ['sample', 2, centsToTapeUnits(8297193)], ['step', 2], ['step', 3]]);
  assert.deepEqual(client.got, [['tape', 0, 64, 2], ['sample', 2, 8297193, 1]]);
});

// SLICE 3 (enforced): a seat running the feed refuses a bare price, so the page holds Unity's price until the seats answer
test('seats that run the feed: from their first answer Unity\'s price never reaches the core, even before any attested sample (SIM)', async () => {
  let open; const gate = new Promise((r) => { open = r; });
  const { P, core, calls } = rig({ feed: true, gate });
  P.watch('ab'.repeat(32), ['http://seat']);
  assert.equal(core.submitSample({}, 555), true, 'held while the seats are not heard');
  open(); await settle();
  assert.equal(P.active, true);
  assert.equal(core.submitSample({}, 777), false);
  core.step({});
  assert.deepEqual(calls, [['step', 0]], 'neither the held price nor a later one reached the core');
});

test('seats with no feed (feed false, or no door): the price held before their answer is applied, and later ones as before', async () => {
  for (const opts of [{ feed: false }, { status: 404 }]) {
    let open; const gate = new Promise((r) => { open = r; });
    const { P, core, calls } = rig({ ...opts, gate });
    P.watch('ab'.repeat(32), ['http://seat']);
    core.submitSample({}, 111); core.submitSample({}, 222);
    assert.deepEqual(calls, [], 'held');
    open(); await settle();
    assert.equal(P.active, false); assert.equal(P.heard, true);
    assert.deepEqual(calls, [['sample', 0, 222]], 'the latest held price, once');
    core.submitSample({}, 333);
    assert.deepEqual(calls.at(-1), ['sample', 0, 333]);
  }
});
