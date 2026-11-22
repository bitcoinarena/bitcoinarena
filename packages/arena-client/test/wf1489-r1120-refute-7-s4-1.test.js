// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute of #3087/#3098 (s4, a full browser between two writes): Rescan's 'returned' row is one localStorage write made
// right after recoverStuck has committed the reissue in the wallet's own db. A full browser (the very state behind #910: "Storage that
// was full when it was sent") refuses that write; ledgerAppend swallows it and nothing keeps the row to write later. The next page has
// nothing to write it from: the stuck machines were ended, issuingDetail now lists only the reissue (no txid), so recoverStuck is not
// called again - the sat land in the balance and the history never names them (the #368 report). Deposits handle the same refusal
// (#2534: the row first, the pending entry kept until the row is held, the next page writes it); this row has no such second chance.
// The page's own ARENA_ARRIVING_CHECK is cut from index.html and run twice (page 1 full, page 2 with room) against the BUILT bundle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { recordReceived, ledgerRows } from './bundle-shim-3087.mjs';

const page = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
const from = page.indexOf("const ARRIVING_KEY = 'arena.arriving';");
const head = page.indexOf('window.ARENA_ARRIVING_CHECK = async () => {', from);
let depth = 0, end = -1;
for (let i = page.indexOf('{', head); i < page.length; i++) { if (page[i] === '{') depth++; else if (page[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } } }
const src = page.slice(from, end) + ';';

const loadPage = (window, vault) => new Function('window', 'vault', 'ARENACLIENT', 'console', 'setTimeout', src + '\nreturn window.ARENA_ARRIVING_CHECK;')(
  window, vault, { recordReceived }, { log: () => {} }, (r) => r());

test('#3087 refute (s4): a reissue whose row the full browser refused still gets its row on the next page', async () => {
  assert.ok(from > 0 && head > from && end > head, 'the page code');
  const m = new Map(); let full = false;
  const st = { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => { if (full) throw Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' }); m.set(k, String(v)); },
    removeItem: (k) => m.delete(k) };
  const fed = 'cd'.repeat(32); const f = fed.slice(0, 16);
  // 95 sat "arriving" for over ten minutes behind a transaction the federation does not know (#908/#910)
  st.setItem('arena.arriving', JSON.stringify({ [f]: { why: 'x', sinceMs: Date.now() - 11 * 60000, etaMs: Date.now() - 10 * 60000, sats: 95, held: 0 } }));
  let reissued = false, recovers = 0;
  const wallet = {
    issuingDetail: async () => JSON.stringify(reissued ? [{ txid: null, msat: '589000', accepted: false }] : [{ txid: 'ee'.repeat(32), msat: '95000', accepted: false }]),
    // the reissue is committed in the wallet's own db: from here it lands by itself, on this page or the next
    recoverStuck: async () => { recovers++; reissued = true; return JSON.stringify({ ended: 1, reissuingMsat: 589000 }); },
    issuingMsat: async () => '589000',
  };
  const mkWindow = () => ({ ARENA_WALLET_BALANCE: { arriving: 95, parts: [{ federation: fed, arriving: 95, sats: 0 }] }, ARENA_WALLETS: new Map([[fed, wallet]]),
    ARENA_MONEY_ALERT: { credited: () => {}, creditedHas: () => false } });
  // page 1: the browser is full when the row is written
  full = true;
  await loadPage(mkWindow(), () => st)();
  assert.equal(recovers, 1, 'Rescan ran');
  // page 2: room again (the player cleared some), the reissue still landing
  full = false;
  await loadPage(mkWindow(), () => st)();
  const rows = ledgerRows(st, fed);
  assert.deepEqual(rows.map((x) => [x.kind, x.msat]), [['returned', '589000']],
    'the 589 sat fetched back are a history row once the browser has room; got ' + JSON.stringify(rows.map((x) => [x.kind, x.msat])));
});
