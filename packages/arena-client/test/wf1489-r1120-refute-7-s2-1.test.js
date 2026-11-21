// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute of #3087/#3098 (skeptic 2): the page calls ARENACLIENT.recordReceived from src/arena-ui/arena-client.js - the
// BUILT bundle the page loads (tools/build-arena-page.mjs copies it as it is). #3087 taught packages/arena-client/src/page-lock.js the
// kind 'returned', but the committed bundle was not rebuilt: its recordReceived still returns early for anything but 'referral' and
// 'zap-in'. So the page's Rescan reissue block (index.html, #3098) writes NO history row - the #368 report ("589 sat credited, no row")
// is unchanged in the page this tree ships. The page's own block is cut from index.html and run against the bundle's functions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const bundleSrc = readFileSync(process.env.BUNDLE || new URL('../../../src/arena-ui/arena-client.js', import.meta.url), 'utf8');
const ctx = vm.createContext({ console, crypto: globalThis.crypto, TextEncoder, TextDecoder, setTimeout, clearTimeout, URL, Uint8Array, BigInt, Promise, atob, btoa, queueMicrotask, structuredClone, performance });
ctx.window = ctx; ctx.globalThis = ctx; ctx.self = ctx;
vm.runInContext(bundleSrc + '\n;globalThis.ARENACLIENT = ARENACLIENT;', ctx);
const ARENACLIENT = ctx.ARENACLIENT;

test('#3087 refute (bundle): the page bundle writes the reissued sat as a history row', async () => {
  const page = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
  const start = page.indexOf('if (Number(got.reissuingMsat) > 0) {');
  assert.ok(start > 0, 'the page block');
  let depth = 0, end = -1;
  for (let i = page.indexOf('{', start); i < page.length; i++) { if (page[i] === '{') depth++; else if (page[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } } }
  const block = page.slice(start, end);
  assert.ok(block.includes("kind: 'returned'"), 'the #3087 row is in the page block');
  const m = new Map(); const st = { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
  const fed = 'cd'.repeat(32);
  const window = { ARENA_NOTE_ARRIVING: () => {}, ARENA_MONEY_ALERT: { credited: () => {} } };
  const c = [fed, { issuingMsat: async () => '0' }];
  const got = { ended: 1, reissuingMsat: 589000, stuckTxids: 'aa'.repeat(32) };
  const fn = new Function('f', 'got', 'c', 'window', 'ARENACLIENT', 'vault', 'setTimeout', `return (async () => { ${block} })();`);
  await fn(fed.slice(0, 16), got, c, window, ARENACLIENT, () => st, (r) => r());
  const rows = JSON.parse(JSON.stringify(ARENACLIENT.ledgerRows(st, fed)));
  assert.deepEqual(rows.map((x) => [x.kind, x.msat]), [['returned', '589000']], 'the 589 sat that came back are a history row in the page bundle');
});

test('#3087 refute (bundle): the bundle recordReceived knows the kind the page draws as "Returned"', () => {
  const m = new Map(); const st = { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
  const fed = 'ef'.repeat(32);
  ARENACLIENT.recordReceived(st, fed, { kind: 'returned', msat: '95000', outpoint: 'reissue:' + 'bb'.repeat(32) });
  assert.equal(ARENACLIENT.ledgerRows(st, fed).length, 1, 'one returned row');
});
