// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE COLLECT'S LINES FOR THE LOBBY (2026-10-07): the page owns the words, Unity draws them. collectLines
// builds at most three - another kept seed's record, a failed collect, an uncollectable record - only those that apply, in the
// words the plan accepted (comment 691); nothing when nothing applies. And the page's lobby view hands them to Unity.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { collectLines } from '../src/page-lock.js';

const R1 = '5718b249' + '0'.repeat(56), R2 = 'a2a2a2a2' + '0'.repeat(56), R3 = 'c3c3c3c3' + '0'.repeat(56);
const own = { round: 'ffff0000' + '0'.repeat(56), seed: '1111111111111111', own: true, state: 'open' };

test('nothing applies: no line', () => {
  assert.deepEqual(collectLines([]), []);
  assert.deepEqual(collectLines([own]), [], 'the tab\'s own open record says nothing here');
});

test('another kept seed\'s record: open, done, held - the plan\'s words', () => {
  const r = { round: R1, seed: '839b67a6aaaabbbb', own: false, state: 'open' };
  assert.deepEqual(collectLines([own, r]), [{ kind: 'other', text: 'Other kept seed 839b67a6: round 5718b249 open, collected too' }]);
  assert.deepEqual(collectLines([{ ...r, state: 'done' }]), [{ kind: 'other', text: 'Other kept seed 839b67a6: round 5718b249 done, collected too' }]);
  assert.deepEqual(collectLines([r], { held: new Set([R1]) }), [{ kind: 'other', text: 'Other kept seed 839b67a6: round 5718b249 held by another tab' }]);
});

test('a failed collect: the round and the first 60 characters of the error, tried again', () => {
  const why = 'the federation did not answer within 20 s, asked at guardian-3 and guardian-5 and more';
  const lines = collectLines([{ ...own, round: R1 }], { failed: new Map([[R1, why]]) });
  assert.deepEqual(lines, [{ kind: 'failed', text: `Collect failed for round 5718b249: ${why.slice(0, 60)} - tried again` }]);
});

test('an uncollectable record: its round and seed, and why', () => {
  assert.deepEqual(collectLines([{ round: R1, seed: '4f5c6976aaaabbbb', own: false, state: 'uncollectable' }]),
    [{ kind: 'uncollectable', text: 'Uncollectable: round 5718b249 (seed 4f5c6976) - its seed is not kept in this browser: no key is left to collect it' }]);
});

test('all three at once, in order; several records of one kind share one line', () => {
  const recs = [
    { round: R1, seed: '839b67a6aaaabbbb', own: false, state: 'open' },
    { round: R2, seed: '839b67a6aaaabbbb', own: false, state: 'done' },
    { round: R3, seed: '4f5c6976aaaabbbb', own: false, state: 'uncollectable' },
    { round: 'dddd0000' + '0'.repeat(56), seed: '9e9e9e9e00000000', own: false, state: 'uncollectable' },
  ];
  const lines = collectLines(recs, { failed: new Map([[R1, 'no answer']]) });
  assert.equal(lines.length, 3);
  assert.deepEqual(lines.map((l) => l.kind), ['other', 'failed', 'uncollectable']);
  assert.equal(lines[0].text, 'Other kept seed 839b67a6: rounds 5718b249 open, a2a2a2a2 done, collected too');
  assert.equal(lines[1].text, 'Collect failed for round 5718b249: no answer - tried again');
  assert.equal(lines[2].text, 'Uncollectable: rounds c3c3c3c3 (seed 4f5c6976), dddd0000 (seed 9e9e9e9e) - their seeds are not kept in this browser: no key is left to collect them');
});

test('the page hands the lines to Unity in its lobby view, from its records and its failed and held sets', () => {
  const html = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
  // the view is Tick Tock's page part (kanban #521)
  const unity = readFileSync(new URL('../../nextblock/page/unity-page.js', import.meta.url), 'utf8');
  const view = unity.slice(unity.indexOf('function unityLobbyView('));
  assert.match(view, /collect: BLWPCLIENT\.collectLines \? BLWPCLIENT\.collectLines\(window\.ARENA_RECORDS \|\| \[\], \{ failed: window\.ARENA_COLLECT_FAILED/);
  assert.match(html, /const collectFailed = window\.ARENA_COLLECT_FAILED = new Map\(\);/);
  assert.match(html, /collectFailed\.set\(older\.roundIdHex, e\.message\)/);
});
