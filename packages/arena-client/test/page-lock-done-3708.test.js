// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3708 (feedback #468): after an Up/Down order's refund the wallet panel kept "stake locked in the round's federation: 99000 msat at
// b1f0f668…:0 · back to your key from federation block 165386 if nobody settles it" for hours, on every page. The panel's lock line is now
// painted only while the lock's collect record in this browser is not done. It runs as the page has it (src/arena-ui/index.html).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { lockLine } from '../src/page-lock.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const HTML = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
const a = HTML.indexOf('window.ARENA_LOCK_DONE = '), b = HTML.indexOf('// </lock-done-3708>', a);
const ARENACLIENT = { lockLine, toHex };
const W = {};
// before the fix there is no such block: the panel said ARENACLIENT.lockLine(lock) whatever became of the lock
const shown = a < 0 ? (storage, lock) => lockLine(lock) : new Function('window', 'ARENACLIENT', `${HTML.slice(a, b)}; return window.ARENA_LOCK_SHOWN_LINE;`)(W, ARENACLIENT);
const inPanel = /window\.ArenaText\.say\(document\.getElementById\('arena-owed'\), lockShown\s*\?\s*window\.ARENA_LOCK_SHOWN_LINE\(vault\(\), lockShown\)/.test(HTML);

const store = (recs) => { const m = new Map(Object.entries(recs)); return { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => m.get(k) ?? null }; };
const txid = Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? 0xb1 : 0xf0));
const lock = { outpoint: { txid, outIdx: 0 }, fields: { amountMsat: 99000n, expiration: 165386 } };
const rec = (done) => JSON.stringify({ roundIdHex: 'ed43c013', stakeLock: { outpoint: `${toHex(txid)}:0`, fields: {} }, done });

test('#3708 a refunded lock is not said as locked', () => {
  const s = store({ 'arena.collect.ed43c013.aa': rec({ payout: 'none: the order is refunded whole', stake: '100 sat back', tabMsat: '0' }) });
  const got = shown(s, lock);
  console.log('#3708 MEASURED refunded lock, record done:', JSON.stringify(got));
  assert.ok(!/stake locked/.test(got), 'the refunded lock still reads "stake locked"');
  assert.ok(inPanel, 'the wallet panel does not paint the lock line through ARENA_LOCK_SHOWN_LINE');
});

test('#3708 a lock still held is said as before', () => {
  const open = shown(store({ 'arena.collect.ed43c013.aa': rec(null) }), lock);
  assert.equal(open, lockLine(lock));
  assert.match(open, /^stake locked in the round's federation: 99000 msat at b1f0f0f0f0f0f0f0…:0 · back to your key from federation block 165386/);
  // another round's done record does not close this lock
  const other = JSON.stringify({ roundIdHex: 'ffff', stakeLock: { outpoint: `${'00'.repeat(32)}:0` }, done: { payout: 'x' } });
  assert.equal(shown(store({ 'arena.collect.ffff.bb': other }), lock), lockLine(lock));
});
