// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE WITHDRAW PANEL IN REACT (kanban #564; its cases were the page's page-withdraw and page-withdraw-at-once, plan comment 298 and
// kanban #539): the balance line - the balance the page already read said and usable at once, the exact amount replacing it, an empty
// wallet off for good, a balance that cannot be read; an invoice over the balance refused in the player's words before the wallet spends;
// an invoice within it withdrawn for its amount, every outcome said.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WithdrawPanel } from '../dist/test/withdraw.mjs';

const TOO_MUCH = 'Not enough to withdraw that amount after fees. Choose a smaller amount.';
const tick = () => new Promise((r) => setTimeout(r, 10));
function panel({ can, knownSat = null, invoiceMsat = null, send = async () => ({ ok: true, gateway: 'https://gw.example/x' }) }) {
  const calls = { send: [], said: [], sent: 0 };
  const m = new WithdrawPanel({ knownSat,
    readExact: async () => { if (can instanceof Error) throw can; return can; },
    invoiceAmount: (text) => (text && invoiceMsat !== null ? { ok: true, msat: invoiceMsat } : { ok: false, why: 'Paste a Lightning invoice.' }),
    send: async (o) => { calls.send.push(o); return send(o); }, say: (t) => calls.said.push(t), onSent: () => { calls.sent++; } });
  m.setState = (u) => Object.assign(m.state, typeof u === 'function' ? u(m.state) : u);
  m.componentDidMount();
  const html = () => renderToStaticMarkup(m.render());
  return { m, calls, html, type: (t) => m.read(t), go: () => m.go(), last: () => m.state.status };
}

test('the balance line: checking, then how much; an empty wallet off for good; a balance that cannot be read', async () => {
  const p = panel({ can: 50000n });
  // the same sentence while the balance is read, so the overlay keeps its size
  assert.match(p.html(), /^<div class="wd-panel empty"><div class="muted" id="arena-wd-amount">You can withdraw up to … sat \(checking\)\. Make an invoice in your own wallet for any amount up to that and paste it here\.<\/div><input id="arena-wd-invoice"[^>]*disabled=""/);
  await tick();
  assert.equal(p.m.state.amount, 'You can withdraw up to 50 sat. Make an invoice in your own wallet for any amount up to that and paste it here.');
  assert.match(p.html(), /^<div class="wd-panel">.*<button id="arena-wd-go" type="button">Withdraw<\/button><div class="pay-status" style="display:none">/);
  const empty = panel({ can: 0n });
  await tick();
  assert.equal(empty.m.state.amount, 'Your wallet is empty, so there is nothing to withdraw.');
  assert.match(empty.html(), /<button id="arena-wd-go" type="button" disabled="">/);
  const broken = panel({ can: new Error('the federation did not answer') });
  await tick();
  assert.equal(broken.m.state.amount, 'Your balance could not be read (the federation did not answer). Try again in a moment.');
});

test('a balance the page already read is said and usable at once, while the exact amount never answers; the exact one replaces it', async () => {
  const p = panel({ knownSat: 999, can: new Promise(() => {}) });
  assert.match(p.m.state.amount, /^You have 999 sat\. Make an invoice in your own wallet for a little less/);
  assert.match(p.html(), /^<div class="wd-panel">.*<button id="arena-wd-go" type="button">Withdraw/);
  const q = panel({ knownSat: 999, can: 990000n });
  await tick();
  assert.match(q.m.state.amount, /^You can withdraw up to 990 sat\./);
});

test('an invoice above the balance: the player\'s words at once, and on go the wallet is never asked to spend', async () => {
  const p = panel({ can: 50000n, invoiceMsat: 60000n });
  await tick();
  p.type('lnbc600n1over');
  assert.equal(p.m.state.chosenText, 'You withdraw 60 sat.');
  assert.deepEqual(p.last(), { step: 3, words: TOO_MUCH, kind: 'fail' });
  await p.go();
  assert.equal(p.calls.send.length, 0, 'the wallet\'s withdraw was not called');
  assert.deepEqual(p.last(), { step: 3, words: TOO_MUCH, kind: 'fail' });
  const none = panel({ can: 50000n, invoiceMsat: 30000n });
  await tick();
  await none.go();
  assert.deepEqual(none.calls.said, ['Paste an invoice first.']);
  assert.equal(none.calls.send.length, 0);
});

test('an invoice within the balance is withdrawn for its amount, and every outcome is said in the player\'s words', async () => {
  const cases = [
    [async () => ({ ok: true, gateway: 'https://gw.example/x' }), { step: 3, words: 'Done! 30 sat were sent to your Lightning wallet via gw.example.', kind: 'ok' }],
    [async () => ({ ok: false, state: 'Refunded' }), { step: 3, words: 'The payment could not be completed. Your 30 sat are back in your wallet.', kind: 'fail' }],
    [async () => ({ ok: false, withdrawableMsat: '20000', why: 'the fee' }), { step: 3, words: TOO_MUCH, kind: 'fail' }],
    [async () => ({ ok: false, why: 'no route' }), { step: 3, words: 'Withdrawal failed: no route', kind: 'fail' }],
    [async () => { throw new Error('the wallet closed'); }, { step: 3, words: 'Withdrawal failed: the wallet closed', kind: 'fail' }],
  ];
  for (const [send, said] of cases) {
    const p = panel({ can: 50000n, invoiceMsat: 30000n, send });
    await tick();
    p.type('  lnbc300n1ok  ');
    await p.go();
    assert.equal(p.calls.send.length, 1);
    assert.deepEqual([p.calls.send[0].amountMsat, p.calls.send[0].invoice], [30000n, 'lnbc300n1ok'], 'the invoice\'s amount, the pasted invoice trimmed');
    assert.deepEqual(p.last(), said);
  }
});
