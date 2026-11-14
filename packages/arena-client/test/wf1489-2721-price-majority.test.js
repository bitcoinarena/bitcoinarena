// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 round 5 (client): THE COMMITTEE'S PRICE IS NOT ONE SEAT'S WORD. The page's price block (index.html ARENA_PRICES) polls
// GET /price-samples of the round's seats IN LIST ORDER and stops at the FIRST seat that answers: that seat alone decides whether the
// round runs a feed (feed:false / 404 -> Unity's own price is applied), and which price every tick plays - its samples are handed to
// the core and, with their signatures, into the player's signed batches, unchecked (first tick wins; a later honest sample never
// replaces it). The seats that run the feed refuse a batch carrying a price they did not attest, so ONE seat at the head of the list
// (one of 7) makes every honest player's run in a feed round be refused - the stake lost - by serving a made-up sample, or by answering 404.
// Safe: a price reaches the core only when it is not one seat's word - the honest majority's sample / feed decision stands.
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

const HONEST = 8297193, FORGED = 100;
const sig = { key: '01'.repeat(32), signature: '02'.repeat(64) };
const settle = () => new Promise((r) => setTimeout(r, 10));

function rig(answerOf) {
  const calls = [];
  const client = { offered: 0, got: [], submitAttestedSample: (x) => { client.got.push(['sample', x.tick, x.priceCents]); return true; },
    submitAttestedTape: () => true };
  const core = { step: () => { calls.push(['step', client.offered]); client.offered++; },
    submitSample: (st, p) => { calls.push(['sample', client.offered, p]); return true; },
    submitTape: (st, ps) => { calls.push(['tape', client.offered, ps.length]); return true; } };
  const window = { ARENA_CORES: { a: core }, unityInstance: { Module: { blwpNet: { inWorld: true, client } } } };
  const fetch = async (u) => { const a = answerOf(String(u)); return { ok: a.status === 200, status: a.status, json: async () => a.body }; };
  pageFunction(PAGE, ['window', 'ARENACLIENT', 'fetch', 'setInterval', 'clearInterval', 'console', 'AbortSignal'], BLOCK)(
    window, { centsToTapeUnits }, fetch, () => 1, () => {}, { log: () => {} }, { timeout: () => undefined });
  return { P: window.ARENA_PRICES, core, client, calls };
}
const honestBody = { feed: true, samples: [{ tick: 2, priceCents: HONEST, sigs: [sig, sig, sig, sig, sig] }] };

test('wf1489-r5-client-1a: the first-listed seat serving a made-up sample does not set the price the player\'s run plays and signs', async () => {
  const { P, core, client, calls } = rig((u) => (u.startsWith('http://evil') ? { status: 200, body: { feed: true, samples: [{ tick: 2, priceCents: FORGED, sigs: [sig] }] } }
    : { status: 200, body: honestBody }));
  P.watch('ab'.repeat(32), ['http://evil', 'http://seat-2', 'http://seat-3']); await settle();
  for (let i = 0; i < 4; i++) core.step({});
  const applied = calls.filter((c) => c[0] === 'sample').map((c) => c[2]);
  console.log(`FACTS: core got ${JSON.stringify(applied)}; signed into the batch ${JSON.stringify(client.got)}`);
  assert.ok(!applied.includes(centsToTapeUnits(FORGED)), 'one seat\'s made-up price reached the core');
  assert.ok(!client.got.some((g) => g[2] === FORGED), 'one seat\'s made-up price went into the player\'s batch');
});

test('wf1489-r5-client-1b: the first-listed seat answering 404 does not turn the feed off while the other seats run it', async () => {
  const { P, core, calls } = rig((u) => (u.startsWith('http://evil') ? { status: 404, body: {} } : { status: 200, body: honestBody }));
  P.watch('ab'.repeat(32), ['http://evil', 'http://seat-2', 'http://seat-3']);
  core.submitSample({}, 555);                // Unity's own price, held until the seats are heard
  await settle();
  console.log(`FACTS: heard=${P.heard} feed=${P.feed} active=${P.active}; core calls ${JSON.stringify(calls)}`);
  assert.equal(P.active, true, 'two of three seats run the feed: the run plays attested samples only');
  assert.ok(!calls.some((c) => c[0] === 'sample' && c[2] === 555), 'Unity\'s unattested price reached the core (the feed seats refuse that batch)');
});
