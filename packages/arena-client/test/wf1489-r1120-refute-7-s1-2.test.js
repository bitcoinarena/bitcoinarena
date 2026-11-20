// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute of #3087: Rescan's reissue writes its 'returned' row only inside the page's 90 s poll, and only when the wallet's
// WHOLE issuing amount is 0. Any other output still in issuance then (the change of a stake, a payout being collected) keeps
// issuingMsat above 0 for the 90 s: the reissued sat land in the balance and no row is ever written (nor after a reload: the stuck
// machines are ended, so the next load has nothing to recover) - balance and history disagree, the #368 report unchanged.
// The block below is the page's own code, cut from index.html and run with fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// kanban #3111: the page block runs against the BUILT bundle the page loads, not the module (a stale bundle fails here)
import { recordReceived, ledgerRows } from './bundle-shim-3087.mjs';

test('#3087 refute: the reissued sat get their row while another output is still being issued', async () => {
  const page = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
  const start = page.indexOf('if (Number(got.reissuingMsat) > 0) {');
  assert.ok(start > 0, 'the page block');
  let depth = 0, end = -1;
  for (let i = page.indexOf('{', start); i < page.length; i++) { if (page[i] === '{') depth++; else if (page[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } } }
  const block = page.slice(start, end);
  assert.ok(block.includes("kind: 'returned'"), 'the #3087 row is in the block');
  const m = new Map(); const st = { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
  const fed = 'cd'.repeat(32);
  let credited = 0;
  const window = { ARENA_NOTE_ARRIVING: () => {}, ARENA_MONEY_ALERT: { credited: () => { credited++; } } };
  // 589 sat reissued and landed at once; 95 sat of a stake's change still in issuance the whole time
  const c = [fed, { issuingMsat: async () => '95000' }];
  const got = { ended: 1, reissuingMsat: 589000 };
  const fn = new Function('f', 'got', 'c', 'window', 'ARENACLIENT', 'vault', 'setTimeout', `return (async () => { ${block} })();`);
  await fn(fed.slice(0, 16), got, c, window, { recordReceived }, () => st, (r) => r());
  const rows = ledgerRows(st, fed);
  assert.deepEqual(rows.map((x) => [x.kind, x.msat]), [['returned', '589000']], 'the 589 sat that came back are a history row');
});
