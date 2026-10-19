// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A TAKEOVER WHOSE COLLECT FAILS NO LONGER SAYS "HELD" ((a), 2026-10-07): measured on 0.0.2842 (comment 695),
// tab B kept "a2a2a2a2 held by another tab" for 24 s after tab A closed, beside the red failed line - the catch path set
// BLWP_COLLECT_FAILED but left BLWP_COLLECT_HELD. index.html's own lookThePayout, lifted, with fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageFunction } from './page-script.js';

const PAGE = new URL('../../../unity-proto/Assets/WebGLTemplates/NextBlock/index.html', import.meta.url);
const HTML = readFileSync(PAGE, 'utf8');
const cut = (from, end) => { const a = HTML.indexOf(from); assert.ok(a > 0); const b = HTML.indexOf(end, a); return HTML.slice(a, b + end.length); };
const PAYOUT = cut('    let payoutAskingSince = 0;', '\n      payoutAsking = false; payoutAskingSince = 0;\n      paintWallet();\n    }\n');

function page(records, lookRound) {
  const collectFailed = new Map(), collectHeld = new Set();
  const window = { sessionStorage: { getItem: () => null } };
  const BLWPCLIENT = { savedCollects: () => records, roundLocks: () => true, owedToLine: () => 'line', toHex: () => 'ab'.repeat(32), markCollectDone: () => {}, collectIntoPlayerWallet: async () => ({ collected: false }) };
  const vault = () => ({ length: 0, key: () => null, getItem: () => null, setItem: () => {}, removeItem: () => {} });
  const fns = pageFunction(PAGE, ['window', 'document', 'vault', 'BLWPCLIENT', 'lookRound', 'roundAsk', 'newestKept', 'collectSeed', 'collectNote', 'lookSaid',
    'paintWallet', 'paintHistory', 'paintMoney', 'payoutAsking', 'fetch', 'keptRecords', 'withRecordPhrase', 'collectFailed', 'collectHeld'], [PAYOUT], 'return { lookThePayout };')(
    window, { getElementById: () => null }, vault, BLWPCLIENT, lookRound, () => ({}), () => records[records.length - 1], () => 'seed', () => {}, () => '', () => {}, () => {}, () => {}, false,
    async () => { throw new Error('no fetch'); }, () => ({ collectable: records, uncollectable: [] }), (r, fn) => fn(), collectFailed, collectHeld);
  return { ...fns, collectFailed, collectHeld };
}

test('newest record of another phrase, taken over after its tab closed, collect throws: failed, and no longer held', async () => {
  const R = 'a2'.repeat(32);
  const p = page([{ roundIdHex: R, round: {}, done: null, own: false, seed: new Uint8Array(32) }], async () => { throw new Error('parsing failed'); });
  p.collectHeld.add(R);                                   // the last pass found it held by tab A
  await p.lookThePayout();
  assert.equal(p.collectFailed.get(R), 'parsing failed');
  assert.equal(p.collectHeld.has(R), false, 'the record still says held by another tab after this tab took it over');
});

test('an older record of another phrase, the same', async () => {
  const R1 = 'b1'.repeat(32), R2 = 'b2'.repeat(32);
  const p = page([{ roundIdHex: R1, round: {}, done: null, own: false, seed: new Uint8Array(32) }, { roundIdHex: R2, round: {}, done: null, own: true, seed: new Uint8Array(32) }],
    async (r) => { if (r.roundIdHex === R1) throw new Error('no answer'); return { look: null, held: true, LockClient: null }; });
  p.collectHeld.add(R1);
  await p.lookThePayout();
  assert.equal(p.collectFailed.get(R1), 'no answer');
  assert.equal(p.collectHeld.has(R1), false);
});
