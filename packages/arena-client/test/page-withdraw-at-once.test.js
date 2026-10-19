// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WITHDRAW SAYS THE BALANCE AT ONCE (kanban #539, the owner 2026-10-19 ~20:02Z: "Withdrawing ... just says checking for a long time.
// Eventually it works"). The exact amount after fees waits on every gateway the federation lists, and one that does not answer from the
// player's network is waited out (measured 26-30 s). The page's own openWithdraw, run on stubs: with the balance the page already read
// for this federation the sheet says it and takes an invoice at once, even while the exact read never answers; the exact amount
// replaces it when it comes; with no balance read yet the sheet says "checking" as before and stays closed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageFunction } from './page-script.js';

const PAGE = new URL('../../../src/arena-ui/index.html', import.meta.url);
const HTML = readFileSync(PAGE, 'utf8');
const at = HTML.indexOf('    function openWithdraw(ctx) {');
const SRC = HTML.slice(at, HTML.indexOf('\n    }\n', HTML.indexOf("      document.getElementById('arena-wd-go').onclick", at)) + 6);

function page({ balanceParts, exact }) {
  const els = {};
  const el = (id) => (els[id] ||= { id, textContent: '', value: '', disabled: false, style: {}, parentNode: { insertBefore() {} }, nextSibling: null,
    classList: { on: new Set(), toggle(c, v) { if (v) this.on.add(c); else this.on.delete(c); }, contains(c) { return this.on.has(c); } } });
  const document = { getElementById: el };
  const fid = new Uint8Array(32).fill(7);
  const window = { ARENA_WALLET_BALANCE: balanceParts ? { parts: balanceParts } : undefined,
    ARENA_LOCK_WASM: async () => ({ default: async () => {}, LockClient: {} }) };
  const BLWPCLIENT = { toHex: (b) => Buffer.from(b).toString('hex'), invoiceAmountMsat: () => ({ ok: false, why: '' }),
    playerWithdrawable: () => exact };
  const payStatus = () => ({ hide() {}, set() {} });
  const fn = pageFunction(PAGE, ['document', 'window', 'BLWPCLIENT', 'payStatus', 'vault', 'paintHistory'], SRC, 'return openWithdraw;')(
    document, window, BLWPCLIENT, payStatus, () => ({}), () => {});
  fn({ round: { federationId: fid }, invite: 'fed1x', seed: 's', gateways: [] });
  return { el, window, fidHex: Buffer.from(fid).toString('hex') };
}

test('a balance the page already read is said and usable at once, while the exact amount never answers', async () => {
  const fidHex = Buffer.from(new Uint8Array(32).fill(7)).toString('hex');
  const p = page({ balanceParts: [{ federation: fidHex, sats: 999 }], exact: new Promise(() => {}) });
  assert.match(p.el('arena-wd-amount').textContent, /^You have 999 sat\. Make an invoice in your own wallet for a little less/);
  assert.equal(p.el('arena-wd-invoice').disabled, false, 'the invoice field takes a paste now');
  assert.equal(p.el('arena-wd-go').disabled, false, 'and Withdraw is pressable');
  assert.equal(p.window.ARENA_WITHDRAW_SAID.knownSat, 999);
});

test('the exact amount replaces it when it comes', async () => {
  const fidHex = Buffer.from(new Uint8Array(32).fill(7)).toString('hex');
  const p = page({ balanceParts: [{ federation: fidHex, sats: 999 }], exact: Promise.resolve(990000n) });
  await new Promise((r) => setTimeout(r, 20));
  assert.match(p.el('arena-wd-amount').textContent, /^You can withdraw up to 990 sat\./);
  assert.equal(p.window.ARENA_WITHDRAW_SAID.exact, '990000');
});

test('no balance read for this federation: "checking" as before, closed until the amount comes', async () => {
  const p = page({ balanceParts: [{ federation: 'ab'.repeat(32), sats: 500 }], exact: new Promise(() => {}) });
  assert.match(p.el('arena-wd-amount').textContent, /\(checking\)/);
  assert.equal(p.el('arena-wd-invoice').disabled, true);
});
