// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// ONE RECORD THAT NEVER ANSWERS HOLDS ONLY ITSELF (kanban #2785, playtest #1481 2026-11-11, round 30da9cec): the page's collect pass awaited each
// kept record's look and collect with no bound; one step that never returned ("Failed to download client config", then "collect loop: still on its
// last look ... a step has not returned" every minute) held the pass for the tab's life, and no other record - no expired lock's refund - was looked
// at again. index.html's own lookThePayout, lifted: three kept records, the first never answers; the other two are still looked at and collected,
// and the pass ends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageFunction } from './page-script.js';
import * as PL from '../src/page-lock.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PAGE = process.env.PAGE_2785 ? new URL(`file://${process.env.PAGE_2785}`) : new URL('../../../src/arena-ui/index.html', import.meta.url);
const START = '    const orderClear = async () =>';
const END = '    // RESCAN FOR MISSING MONEY';

function lift() {
  const src = readFileSync(fileURLToPath(PAGE), 'utf8');
  const at = src.indexOf(START), end = src.indexOf(END);
  return pageFunction(PAGE, ['ARENACLIENT', 'window', 'performance', 'keptRecords', 'newestKept', 'backKey', 'withRecordPhrase', 'lookRound',
    'collectHeld', 'collectFailed', 'collectNote', 'lookSaid', 'noteStakeBack', 'roundAsk', 'stakeBack', 'vault', 'paintHistory', 'paintWallet',
    'roundFeedbackOnce', 'rescanWanted'],
  [src.slice(at, end)], 'return { lookThePayout, asking: () => payoutAsking };', 'let payoutAsking = false, payoutAskingSince = 0;');
}

test('a kept record whose look never returns: the records after it are still looked at and collected, and the pass ends', async () => {
  const rec = (id) => ({ roundIdHex: id.repeat(64).slice(0, 64), round: { federationId: new Uint8Array(32) }, done: null, seed: new Uint8Array(32), order: 0, own: true });
  const stuck = rec('a'), owed = rec('b'), newest = rec('c');
  const looked = [], collected = [], notes = [];
  const look = { owedMsat: 100000n, final: false, inTabMsat: 0n };
  const ARENACLIENT = {
    savedCollects: true, roundLocks: () => true, reopenUncheckedDone: null,
    collectWithin: PL.collectWithin, COLLECT_RECORD_MS: 200,
    collectIntoPlayerWallet: async ({ look: l }) => { collected.push(l.id); return { collected: true, creditedMsat: 100000n }; },
    markCollectDone: () => true, owedToLine: () => 'owed', collectState: () => ({ why: '' }), toHex: (b) => Buffer.from(b).toString('hex'),
  };
  const window = { ARENA_ORDER_AT: 0 };
  const lookRound = (r) => {
    looked.push(r.roundIdHex.slice(0, 1));
    if (r === stuck) return new Promise(() => {});   // the round wallet's join that never answers
    return Promise.resolve({ look: { ...look, id: r.roundIdHex.slice(0, 1) }, held: true, LockClient: null });
  };
  const { lookThePayout, asking } = lift()(ARENACLIENT, window, { now: () => 60000 },
    () => ({ collectable: [stuck, owed, newest], uncollectable: [] }), () => newest, (r) => r.roundIdHex + ':0',
    (r, fn) => fn(), lookRound, new Set(), new Map(), (k, t) => notes.push(`${k} ${t}`), () => 'look', () => {}, (r, L) => ({}),
    new Map(), () => ({ getItem: () => null, setItem: () => {}, removeItem: () => {} }), () => {}, () => {}, () => {}, false);
  const pass = lookThePayout();
  const ended = await Promise.race([pass.then(() => 'ended'), new Promise((r) => setTimeout(() => r('still running after 3 s'), 3000))]);
  assert.equal(ended, 'ended', 'the pass ends although one record never answers');
  assert.deepEqual(looked, ['a', 'b', 'c'], 'the records after the silent one are looked at');
  assert.deepEqual(collected, ['b', 'c'], 'and what they owe is collected');
  assert.equal(asking(), false, 'the next pass may start');
  assert.ok(notes.some((n) => /no answer in/.test(n)), 'the silent record is named');
});

test('collectWithin: the work\'s own answer, or late after the bound', async () => {
  assert.equal(await PL.collectWithin(async () => 7, 1000), 7);
  await assert.rejects(PL.collectWithin(() => new Promise(() => {}), 30, 'round abcd'), (e) => e.late === true && /round abcd: no answer in 0 s/.test(e.message));
  await assert.rejects(PL.collectWithin(async () => { throw new Error('refused'); }, 1000), /refused/);
});
