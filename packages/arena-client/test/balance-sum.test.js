// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OWNER 2026-10-13 ~11:55Z: "Die Funds müssen immer sichtbar sein von allen Föderationen, ohne zwischen Federations zu klicken
// und zu wechseln, immer alle Balances summiert und ersichtlich" - the page's ARENA_SUM_BALANCES, run on its own source
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { federationHealth, reimbursementOf, capacityOf, medianBlockSeconds, explorerBaseFor } from '../src/balance-view.js';
import { readFileSync } from 'node:fs';

const HTML = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
const a = HTML.indexOf("      window.ARENA_WALLETS = window.ARENA_WALLETS || new Map();");
const b = HTML.indexOf('      // WHERE THE MONEY SITS, ON A TAP');
const src = HTML.slice(a, b);

test('the balance is every held federation\'s sum, a wallet opened for each held federation with a verified invite', async () => {
  assert.ok(a > 0 && b > a, 'the page carries the summing block');
  const A = 'aa'.repeat(32), B = 'bb'.repeat(32), C = 'cc'.repeat(32);
  const bal = { [A]: 1500000n, [B]: 2250000n };
  const opened = [];
  const window = { ARENA_FED_LOADS: new Map([[A, { federation: A, invite: 'invA' }], [B, { federation: B, invite: 'invB' }]]),
    ARENA_LOCK_WASM: async () => ({ default: async () => {}, LockClient: {} }), ARENA_PENDING_SATS: 0 };
  const client = (f) => ({ balanceMsat: async () => String(bal[f] || 0n) });
  const BLWPCLIENT = { ledgerFederations: () => [A, B, C], fromHex: (h) => Uint8Array.from(Buffer.from(h, 'hex')),
    openPlayerWallet: async ({ federationId }) => { const f = Buffer.from(federationId).toString('hex'); opened.push(f.slice(0, 2)); return client(f); } };
  const run = new Function('window', 'BLWPCLIENT', 'walletSeed', 'vault', src + '\nreturn window.ARENA_SUM_BALANCES;');
  const sum = run(window, BLWPCLIENT, () => new Uint8Array(32), () => ({}));
  window.ARENA_KEEP_WALLET(A, client(A));            // the round's wallet, kept as the page keeps it
  await sum();
  const got = window.ARENA_WALLET_BALANCE;
  console.log('  SUM:', JSON.stringify({ sats: got.sats, federation: got.federation, parts: got.parts.map((p) => p.federation.slice(0, 2) + ' ' + p.sats), opened }));
  assert.equal(got.sats, 3750, '1,500 + 2,250 sat');
  assert.equal(got.federation, '2 federations');
  assert.deepEqual(opened, ['bb'], 'B opened (held, invite verified); C held but no verified invite: not opened; A already kept');
});

// A SUM ASKED BEFORE ANY WALLET IS OPEN IS NOT THE LAST ONE (measured on preview UI 150, pinned seed 6b360bd8 restored
// in a fresh profile: the lock client held 4000000 msat and the page said 0 sat for 512 s and on - the first sum met no await, its
// own finally cleared `summing` before the assignment kept the finished promise, and every later call answered that one)
test('a sum asked before the wallet opens does not stop every later sum; notes still arriving are said and read again', async () => {
  const A = 'aa'.repeat(32);
  const window = { ARENA_FED_LOADS: new Map(), ARENA_LOCK_WASM: async () => ({ default: async () => {}, LockClient: {} }), ARENA_PENDING_SATS: 0 };
  const BLWPCLIENT = { ledgerFederations: () => [], fromHex: (h) => Uint8Array.from(Buffer.from(h, 'hex')), openPlayerWallet: async () => null,
    issuingMsat: async (c) => BigInt(await c.issuingMsat()) };
  const sum = new Function('window', 'BLWPCLIENT', 'walletSeed', 'vault', 'setTimeout', src + '\nreturn window.ARENA_SUM_BALANCES;')(window, BLWPCLIENT, () => null, () => ({}), () => 0);
  await sum();                                   // the restore's first sum: no wallet yet
  assert.equal(window.ARENA_WALLET_BALANCE, undefined);
  const w = { held: 3000000n, issuing: 1000000n, balanceMsat: async () => String(w.held), issuingMsat: async () => String(w.issuing) };
  window.ARENA_KEEP_WALLET(A, w);                 // the wallet opens
  await sum();
  assert.deepEqual([window.ARENA_WALLET_BALANCE.sats, window.ARENA_WALLET_BALANCE.arriving], [3000, 1000], 'summed, and the arriving notes said');
  w.held = 4000000n; w.issuing = 0n;             // the notes land
  await sum();
  assert.deepEqual([window.ARENA_WALLET_BALANCE.sats, window.ARENA_WALLET_BALANCE.arriving], [4000, 0]);
});

test('a tap on any balance opens the split: each federation\'s sats, its status and load, and the total', () => {
  const a2 = HTML.indexOf('      // WHERE THE MONEY SITS, ON A TAP');
  const src2 = HTML.slice(a2, HTML.indexOf('      // OUT OF A DRAINING FEDERATION, BY ITSELF'));
  const A = 'aa'.repeat(32), B = 'bb'.repeat(32);
  // a minimal document: elements that keep their children's text
  const mk = (tag) => { const e = { tag, children: [], style: {}, className: '', _t: '', listeners: {},
    append(...c) { this.children.push(...c); }, addEventListener(k, f) { this.listeners[k] = f; }, contains: () => false,
    set textContent(v) { this._t = v; this.children = []; }, get textContent() { return this._t + this.children.map((c) => c.textContent).join(' | '); } }; return e; };
  const split = mk('div'); split.style.display = 'none';
  // kanban #558: Settings' balance boxes are part of the Wallet itself, so they open nothing; the header's, the bar's and the lobby's open the Wallet
  const bars = { '#arena-wallet-bar .wb-bal': mk('span'), '#arena-lobby-balance': mk('div'), '#arena-hdr-bal': mk('button') };
  const document = { getElementById: (id) => (id === 'arena-bal-split' ? split : null), createElement: mk, createTextNode: (t) => ({ textContent: t }), querySelector: (sel) => bars[sel] || null, addEventListener: () => {} };
  const window = { ARENA_WALLET_BALANCE: { sats: 3750, pending: 0, parts: [{ federation: A, sats: 1500 }, { federation: B, sats: 2250 }] },
    ARENA_FED_LOADS: new Map([[A, { status: 'OPEN', load: 0.43 }], [B, { status: 'DRAINING', load: 0.12 }]]) };
  // the popup says each federation's health in words (kanban #545, balance-view.js)
  new Function('window', 'document', 'BLWPCLIENT', src2)(window, document, { federationHealth, reimbursementOf, capacityOf, medianBlockSeconds, explorerBaseFor });
  bars['#arena-wallet-bar .wb-bal'].listeners.click({ stopPropagation: () => {} });
  const text = split.textContent;
  console.log('  SPLIT:', text);
  assert.equal(split.style.display, '');
  assert.match(text, /Federation bbbbbbbb…[ |]*Draining · load 12 %[ |]*A guardian left\. Your funds move to a healthy federation by themselves\.[ |]*2,250 sat/);
  assert.match(text, /Federation aaaaaaaa…[ |]*Healthy · load 43 %[ |]*1,500 sat/);
  assert.match(text, /Total \(2 federations\) \| 3,750 sat/);
  assert.ok(text.indexOf('bbbbbbbb') < text.indexOf('aaaaaaaa'), 'the larger first');
  for (const sel of Object.keys(bars)) assert.equal(typeof bars[sel].listeners.click, 'function', sel + ' opens it');
});

// A HELD FEDERATION'S FUNDS ONCE ITS STATUS IS KNOWN (live UI 220 2026-10-18: the statuses landed ~15 s after the first
// sum; 2,500 sat in a second federation stayed out of the balance - 53 sat shown for 2,553 held - until some later read)
test('when the statuses land, a held federation with no wallet open is summed again; all open - nothing more is read', async () => {
  const A = 'aa'.repeat(32), B = 'bb'.repeat(32);
  const bal = { [A]: 53000n, [B]: 2500000n };
  const window = { ARENA_FED_LOADS: new Map(), ARENA_LOCK_WASM: async () => ({ default: async () => {}, LockClient: {} }), ARENA_PENDING_SATS: 0 };
  const client = (f) => ({ balanceMsat: async () => String(bal[f] || 0n) });
  let opens = 0;
  const BLWPCLIENT = { ledgerFederations: () => [A, B], fromHex: (h) => Uint8Array.from(Buffer.from(h, 'hex')),
    openPlayerWallet: async ({ federationId }) => { opens += 1; return client(Buffer.from(federationId).toString('hex')); } };
  new Function('window', 'BLWPCLIENT', 'walletSeed', 'vault', src)(window, BLWPCLIENT, () => new Uint8Array(32), () => ({}));
  window.ARENA_KEEP_WALLET(A, client(A));
  await window.ARENA_SUM_BALANCES();               // the page's first sum: no statuses yet, B cannot open
  assert.equal(window.ARENA_WALLET_BALANCE.sats, 53);
  window.ARENA_FED_LOADS = new Map([[A, { federation: A, invite: 'invA' }], [B, { federation: B, invite: 'invB' }]]);
  await window.ARENA_SUM_HELD();                    // the statuses land
  assert.deepEqual([window.ARENA_WALLET_BALANCE.sats, opens], [2553, 1], 'B opened and summed');
  assert.equal(window.ARENA_SUM_HELD(), null, 'every held federation open: no further read');
  const calls = HTML.split('window.ARENA_FED_LOADS = all;').slice(1).map((s) => s.split('\n').slice(0, 2).join('\n'));
  assert.equal(calls.length, 2, 'both places that set the statuses');
  for (const c of calls) assert.match(c, /if \(window\.ARENA_SUM_HELD\) window\.ARENA_SUM_HELD\(\);/);
});
