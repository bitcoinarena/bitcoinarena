// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE BALANCE POPUP (kanban #545): the page's own popup code, run on a small fake document - each federation that holds funds with its
// health; a HALTED one says when it pays back, in blocks and time; with the debug toggle on, every federation with its capacity and a
// Deposit here that opens the deposit fixed to that federation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { federationHealth, reimbursementOf, capacityOf, medianBlockSeconds, explorerBaseFor } from '../src/balance-view.js';

const HTML = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
const at = HTML.indexOf('      const splitEl = () => document.getElementById(\'arena-bal-split\');');
const SRC = HTML.slice(at, HTML.indexOf('      for (const sel of [\'#arena-wallet-bar .wb-bal\'', at));

function fakeDom() {
  const mk = (tag) => {
    const n = { tag, className: '', style: {}, children: [], listeners: {}, disabled: false, title: '', type: '',
      _text: '', get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); },
      set textContent(v) { this._text = String(v); this.children = []; },
      append(...xs) { for (const x of xs) this.children.push(typeof x === 'string' ? { textContent: x } : x); },
      addEventListener(k, f) { this.listeners[k] = f; }, get childElementCount() { return this.children.length; } };
    return n;
  };
  const split = mk('div'); split.style.display = 'none';
  return { split, document: { getElementById: (id) => (id === 'arena-bal-split' ? split : null), createElement: mk, createTextNode: (t) => ({ textContent: t }) } };
}
const BLWPCLIENT = { federationHealth, reimbursementOf, capacityOf, medianBlockSeconds, explorerBaseFor };
const A = 'aa'.repeat(32), H = 'bb'.repeat(32), C = 'cc'.repeat(32);
const loads = new Map([
  [A, { status: 'OPEN', federation: A, load: 0.72, reserveSats: '108000', exposureCapSats: '150000', signers: 7, invite: 'fed1a', network: 'testnet4' }],
  [H, { status: 'HALTED', federation: H, height: 157064, reserveSats: '0', exposureCapSats: '0', invite: 'fed1h', network: 'testnet4' }],
  [C, { status: 'OPEN', federation: C, load: 0.1, reserveSats: '15000', exposureCapSats: '150000', invite: 'fed1c', network: 'testnet4' }],
]);
function run({ debug }) {
  const { split, document } = fakeDom();
  const opened = [];
  const window = { ARENA_WALLET_BALANCE: { sats: 3000, parts: [{ federation: A, sats: 2000 }, { federation: H, sats: 1000 }] }, ARENA_FED_LOADS: loads,
    ARENA_BROWSER_STORE: () => ({ getItem: (k) => (k === 'arena.debugFederations' && debug ? '1' : null) }) };
  const fetch = async (u) => (u.endsWith('/blocks/tip/height') ? { text: async () => '157070' } : { json: async () => [5000, 3800, 2600, 1400].map((timestamp) => ({ timestamp })) });
  const openMoney = (...a) => { opened.push(a); return Promise.resolve({ ok: true }); };
  new Function('document', 'window', 'BLWPCLIENT', 'fetch', 'openMoney', 'AbortSignal', SRC)(document, window, BLWPCLIENT, fetch, openMoney, { timeout: () => undefined });
  return { split, window, opened };
}
const flat = (n) => [n, ...(n.children || []).flatMap(flat)];

test('the federations that hold funds, each with its health; a halted one says when it pays back once the chain is read', async () => {
  const { split, window } = run({ debug: false });
  window.ARENA_SHOW_BALANCE_SPLIT();
  assert.equal(split.style.display, '');
  assert.match(split.textContent, /Federation aaaaaaaa…Healthy · load 72 %2,000 sat/);
  assert.match(split.textContent, /Federation bbbbbbbb…Offline \(halted\)When it is paid back is read from the chain …1,000 sat/);
  await new Promise((r) => setTimeout(r, 20));
  assert.match(split.textContent, /Paid back in about 15 blocks \(~5 h\), at block 157,085\./, 'halt 157,064 + 12 + 9 on testnet4, tip 157,070, 20 min a block');
  assert.equal(flat(split).filter((n) => n.className === 'hl ok').length, 1);
  assert.equal(flat(split).filter((n) => n.className === 'hl bad').length, 1);
  assert.doesNotMatch(split.textContent, /All federations/, 'no debug rows with the toggle off');
});

test('debug on: every federation with its capacity, and Deposit here opens the deposit fixed to that federation', async () => {
  const { split, window, opened } = run({ debug: true });
  window.ARENA_SHOW_BALANCE_SPLIT();
  assert.match(split.textContent, /All federations \(debug\) · 3/);
  assert.match(split.textContent, /Federation cccccccc…OPEN · load 10 %reserve 15,000 \/ cap 150,000 sat · room 135,000 sat/);
  const buttons = flat(split).filter((n) => n.className === 'dep-here');
  assert.equal(buttons.length, 3);
  buttons[2].listeners.click({ stopPropagation() {} });
  assert.equal(split.style.display, 'none', 'the popup closes for the deposit window');
  assert.equal(opened.length, 1);
  assert.equal(opened[0][0], 'deposit');
  assert.equal(opened[0][2].federation.federation, C, 'that exact federation');
  assert.equal(opened[0][2].federation.invite, 'fed1c');
});

test('the page wires it: the toggle in Advanced settings, and openMoney\'s deposit into a fixed federation', () => {
  assert.match(HTML, /<input type="checkbox" id="arena-debug-feds">/);
  assert.match(HTML, /setItem\('arena\.debugFederations', dbg\.checked \? '1' : '0'\)/);
  assert.match(HTML, /if \(which === 'deposit' && opts\.federation && opts\.federation\.invite\) \{/);
  assert.match(HTML, /BLWPCLIENT\.walletDepositOffer\(\{ federationId, invite: fixed\.invite,/);
});
