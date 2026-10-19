// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE WITHDRAW PANEL'S EARLY STOP AND ITS WORDS (plan comment 298, Go 2026-10-05). index.html's
// openWithdraw is lifted out of the page by its text and run as it is, against a fake panel, a fake status bar and fake
// BLWPCLIENT readers. The page refuses an invoice above the readable balance before the wallet spends - the library checks
// too, but the page's own stop and the words the player sees are what is measured here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageFunction } from './page-script.js';

const PAGE = readFileSync(new URL('../../../unity-proto/Assets/WebGLTemplates/NextBlock/index.html', import.meta.url), 'utf8');
const SRC = (() => { const at = PAGE.indexOf('    function openWithdraw(ctx) {'); assert.ok(at > 0); return PAGE.slice(at, PAGE.indexOf('\n    }\n', at) + 6); })();
const TOO_MUCH = 'Not enough to withdraw that amount after fees. Choose a smaller amount.';
const tick = () => new Promise((r) => setTimeout(r, 10));

function panel({ can, invoiceMsat = null, withdraw = async () => ({ ok: true, gateway: 'https://gw.example/x' }) }) {
  const el = (id) => ({ id, style: {}, textContent: '', value: '', disabled: false, classList: { on: new Set(), toggle(c, v) { if (v) this.on.add(c); else this.on.delete(c); } } });
  const els = Object.fromEntries(['arena-withdraw-panel', 'arena-wd-amount', 'arena-wd-invoice', 'arena-wd-chosen', 'arena-money-why', 'arena-wd-go'].map((id) => [id, el(id)]));
  const status = { shown: [], set(step, words, kind) { this.shown.push({ step, words, kind }); }, hide() { this.shown.push({ hidden: true }); } };
  const calls = { withdraw: [] };
  const BLWPCLIENT = {
    invoiceAmountMsat: (text) => (text && invoiceMsat !== null ? { ok: true, msat: invoiceMsat } : { ok: false, why: 'Paste a Lightning invoice.' }),
    playerWithdrawable: async () => { if (can instanceof Error) throw can; return can; },
    withdrawPlayerWallet: async (o) => { calls.withdraw.push(o); return withdraw(o); },
  };
  const window = { ARENA_LOCK_WASM: async () => ({ default: async () => {}, LockClient: {} }) };
  const document = { getElementById: (id) => els[id] };
  const openWithdraw = pageFunction(new URL('../../../unity-proto/Assets/WebGLTemplates/NextBlock/index.html', import.meta.url), ['document', 'window', 'BLWPCLIENT', 'payStatus', 'vault', 'paintHistory'], SRC, 'return openWithdraw;')(
    document, window, BLWPCLIENT, () => status, () => ({}), () => {});
  openWithdraw({ round: {}, invite: 'fed1', seed: new Uint8Array(32), gateways: [] });
  const type = (text) => { els['arena-wd-invoice'].value = text; els['arena-wd-invoice'].oninput(); };
  const go = () => els['arena-wd-go'].onclick();
  const last = () => status.shown.filter((s) => !s.hidden).at(-1);
  return { els, status, calls, type, go, last };
}

test('the balance line: how much can be withdrawn; an empty wallet; a balance that cannot be read', async () => {
  const p = panel({ can: 50000n });
  // the same sentence while the balance is read, so the overlay keeps its size
  assert.equal(p.els['arena-wd-amount'].textContent, 'You can withdraw up to \u2026 sat (checking). Make an invoice in your own wallet for any amount up to that and paste it here.');
  await tick();
  assert.equal(p.els['arena-wd-amount'].textContent, 'You can withdraw up to 50 sat. Make an invoice in your own wallet for any amount up to that and paste it here.');
  assert.deepEqual([p.els['arena-wd-invoice'].disabled, p.els['arena-wd-go'].disabled], [false, false]);
  const empty = panel({ can: 0n });
  await tick();
  assert.equal(empty.els['arena-wd-amount'].textContent, 'Your wallet is empty, so there is nothing to withdraw.');
  assert.deepEqual([empty.els['arena-wd-invoice'].disabled, empty.els['arena-wd-go'].disabled], [true, true], 'off for good at 0');
  const broken = panel({ can: new Error('the federation did not answer') });
  await tick();
  assert.equal(broken.els['arena-wd-amount'].textContent, 'Your balance could not be read (the federation did not answer). Try again in a moment.');
});

test('an invoice above the balance: the player\'s words at once, and on go the wallet is never asked to spend', async () => {
  const p = panel({ can: 50000n, invoiceMsat: 60000n });
  await tick();
  p.type('lnbc600n1over');
  assert.equal(p.els['arena-wd-chosen'].textContent, 'You withdraw 60 sat.');
  assert.deepEqual(p.last(), { step: 3, words: TOO_MUCH, kind: 'fail' });
  await p.go();
  assert.equal(p.calls.withdraw.length, 0, 'the wallet\'s withdraw was not called');
  assert.deepEqual(p.last(), { step: 3, words: TOO_MUCH, kind: 'fail' });
  const none = panel({ can: 50000n, invoiceMsat: 30000n });
  await tick();
  await none.go();
  assert.equal(none.els['arena-money-why'].textContent, 'Paste an invoice first.');
  assert.equal(none.calls.withdraw.length, 0);
});

test('an invoice within the balance is withdrawn for its amount, and every outcome is said in the player\'s words', async () => {
  const cases = [
    [async () => ({ ok: true, gateway: 'https://gw.example/x' }), { step: 3, words: 'Done! 30 sat were sent to your Lightning wallet via gw.example.', kind: 'ok' }],
    [async () => ({ ok: false, state: 'Refunded' }), { step: 3, words: 'The payment could not be completed. Your 30 sat are back in your wallet.', kind: 'fail' }],
    [async () => ({ ok: false, withdrawableMsat: '20000', why: 'the fee' }), { step: 3, words: TOO_MUCH, kind: 'fail' }],
    [async () => ({ ok: false, why: 'no route' }), { step: 3, words: 'Withdrawal failed: no route', kind: 'fail' }],
    [async () => { throw new Error('the wallet closed'); }, { step: 3, words: 'Withdrawal failed: the wallet closed', kind: 'fail' }],
  ];
  for (const [withdraw, said] of cases) {
    const p = panel({ can: 50000n, invoiceMsat: 30000n, withdraw });
    await tick();
    p.type('  lnbc300n1ok  ');
    await p.go();
    assert.equal(p.calls.withdraw.length, 1);
    assert.equal(p.calls.withdraw[0].amountMsat, 30000n, 'the invoice\'s amount');
    assert.deepEqual(await p.calls.withdraw[0].invoiceFor(), { ok: true, invoice: 'lnbc300n1ok' }, 'the pasted invoice, trimmed');
    assert.deepEqual(p.last(), said);
  }
});
