// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #2694: THE COMMITTEE'S STRIKES IN THE PAGE. In a run whose seats say it takes attested liquidations (GET /liquidation-strikes
// `on`), the page's price block (index.html ARENA_PRICES) hands its core each strike the seats serve - at its own tick, after that
// tick's sample, as the seats' replay applies them - and puts it with its signatures into the player's batch
// (client.submitAttestedLiquidation); Unity's own liquidations reach no core. A strike is one seat's word only when no other serves it.
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
const settle = () => new Promise((r) => setTimeout(r, 10));
const sig = (n) => ({ key: String(n).padStart(2, '0').repeat(32), signature: '02'.repeat(64) });
const SIZE = 655360;

function rig(answerOf) {
  const calls = [];
  const client = { offered: 0, got: [], submitAttestedSample: (x) => { client.got.push(['sample', x.tick, x.priceCents]); return true; },
    submitAttestedTape: () => true, submitAttestedLiquidation: (x) => { client.got.push(['strike', x.tick, x.size, x.sigs.length]); return true; } };
  const core = { step: () => { calls.push(['step', client.offered]); client.offered++; },
    submitSample: (st, p) => { calls.push(['sample', client.offered, p]); return true; },
    submitTape: () => true,
    submitLiquidation: (st, size) => { calls.push(['strike', client.offered, size]); return true; } };
  const window = { ARENA_CORES: { a: core }, unityInstance: { Module: { blwpNet: { inWorld: true, client } } } };
  const fetch = async (u) => { const a = answerOf(String(u)); return { ok: a.status === 200, status: a.status, json: async () => a.body }; };
  pageFunction(PAGE, ['window', 'ARENACLIENT', 'fetch', 'setInterval', 'clearInterval', 'console', 'AbortSignal'], BLOCK)(
    window, { centsToTapeUnits }, fetch, () => 1, () => {}, { log: () => {} }, { timeout: () => undefined });
  return { P: window.ARENA_PRICES, core, client, calls };
}
const prices = { status: 200, body: { feed: true, samples: [{ tick: 2, priceCents: 8297193, sigs: [sig(1), sig(2)] }] } };
const strikes = (list, on = true) => ({ status: 200, body: { on, liquidations: list } });
const honest = [[2, SIZE, [[sig(1).key, sig(1).signature], [sig(2).key, sig(2).signature]]], [3, 2 * SIZE, [[sig(3).key, sig(3).signature]]]];

test('#2694 the seats\' strikes reach the core at their ticks, after the sample, and go into the batch; Unity\'s own do not', async () => {
  const { P, core, client, calls } = rig((u) => (u.includes('/liquidation-strikes') ? strikes(honest) : prices));
  P.watch('ab'.repeat(32), ['http://s1', 'http://s2', 'http://s3']); await settle();
  assert.equal(core.submitLiquidation({}, 999), false, 'Unity\'s own liquidation reached the core in a run that takes attested strikes');
  for (let i = 0; i < 5; i++) core.step({});
  const atTwo = calls.filter((c) => c[1] === 2).map((c) => c[0]);
  assert.deepEqual(atTwo, ['sample', 'strike', 'step'], 'tick 2: the sample, then the strike, then the step - the replay\'s order');
  assert.deepEqual(calls.filter((c) => c[0] === 'strike'), [['strike', 2, SIZE], ['strike', 3, 2 * SIZE]]);
  assert.deepEqual(client.got.filter((g) => g[0] === 'strike'), [['strike', 2, SIZE, 2], ['strike', 3, 2 * SIZE, 1]]);
});

test('#2694 one seat\'s made-up strike is not played; a round the seats say takes none leaves Unity\'s liquidations as they were', async () => {
  const one = rig((u) => (u.includes('/liquidation-strikes') ? (u.startsWith('http://evil') ? strikes([[1, 2147418112, [[sig(9).key, sig(9).signature]]]]) : strikes([])) : prices));
  one.P.watch('ab'.repeat(32), ['http://evil', 'http://s2', 'http://s3']); await settle();
  for (let i = 0; i < 4; i++) one.core.step({});
  assert.deepEqual(one.calls.filter((c) => c[0] === 'strike'), [], 'one seat\'s strike reached the core');
  const off = rig((u) => (u.includes('/liquidation-strikes') ? strikes([], false) : prices));
  off.P.watch('ab'.repeat(32), ['http://s1', 'http://s2', 'http://s3']); await settle();
  assert.equal(off.core.submitLiquidation({}, 999), true, 'a run that takes no attested strikes plays as before');
});
