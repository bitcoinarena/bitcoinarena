// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute of #3087 (s4, the honest path's amounts): what Rescan reissues (mintv2-recover-stuck.rs: "what this seed was issued
// and neither holds nor has spent") is notes the history never took off - a stake's change (the stake row books only the stake, -100,
// not the 1000 of notes that went in), or the inputs of a transaction the federation never knew. The page books the whole reissue as a
// plus row 'returned', so the history's rows add the same sat a second time: deposit +1000, stake -100, returned +900 says 1800 while the
// wallet holds 900 (before #3087 the rows said 900). The page's own Rescan block is cut from index.html and run against the BUILT bundle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { recordReceived, ledgerRows } from './bundle-shim-3087.mjs';

const PLUS = new Set(['deposit', 'winnings', 'refund', 'returned', 'slash-payout', 'moved-in', 'swapped-in', 'referral', 'zap-in']);
test("#3087 refute (s4): a stake's change fetched back by Rescan is not added to the history a second time", async () => {
  const page = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
  const start = page.indexOf('if (Number(got.reissuingMsat) > 0) {');
  assert.ok(start > 0, 'the page block');
  let depth = 0, end = -1;
  for (let i = page.indexOf('{', start); i < page.length; i++) { if (page[i] === '{') depth++; else if (page[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } } }
  const block = page.slice(start, end);
  const m = new Map(); const st = { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
  const fed = 'cd'.repeat(32);
  // the history as the page keeps it: a deposit of 1000 sat, one note set; a stake of 100 sat paid from it (accepted), its 900 sat change
  // in an output machine the full store lost - those 900 sat are the wallet's and were never a minus row
  st.setItem(`arena.ledger.${fed}`, JSON.stringify([{ atMs: 1, kind: 'deposit', msat: '1000000' }, { atMs: 2, kind: 'stake', round: 'ab'.repeat(32), msat: '100000' }]));
  const net0 = ledgerRows(st, fed).reduce((n, x) => n + (PLUS.has(x.kind) ? 1n : -1n) * BigInt(x.msat), 0n);
  const window = { ARENA_NOTE_ARRIVING: () => {}, ARENA_MONEY_ALERT: { credited: () => {} } };
  // Rescan fetches the 900 sat back (the change's issuance requests: issued by the federation, neither held nor spent)
  const c = [fed, { issuingMsat: async () => '0' }];
  const got = { ended: 1, reissuingMsat: 900000, stuckTxids: 'ee'.repeat(32) };
  const fn = new Function('f', 'got', 'c', 'window', 'ARENACLIENT', 'vault', 'setTimeout', `return (async () => { ${block} })();`);
  await fn(fed.slice(0, 16), got, c, window, { recordReceived }, () => st, (r) => r());
  const rows = ledgerRows(st, fed);
  const net = rows.reduce((n, x) => n + (PLUS.has(x.kind) ? 1n : -1n) * BigInt(x.msat), 0n);
  assert.equal(net0, 900000n, 'the history before Rescan: +1000 -100');
  assert.equal(net, 900000n, 'the wallet holds 900 sat after Rescan, the history adds to ' + net / 1000n + ' sat: ' + JSON.stringify(rows.map((x) => [x.kind, x.msat])));
});
