// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHAT THE PAGE HANDS THE WITHDRAW PANEL (kanban #564: the panel is React's, WithdrawPanel - its words and its early stop are tested in
// packages/arena-web/test/withdraw.test.mjs). index.html's openWithdraw is lifted out of the page by its text and run against stubs: the
// panel shown and the why-line cleared, the balance the page already read for this federation (kanban #539), the exact amount read with
// this round's wallet and noted for the probes, the wallet's withdraw with the panel's amount and invoice, the why-line and the history.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageFunction } from './page-script.js';

const PAGE = new URL('../../../src/arena-ui/index.html', import.meta.url);
const HTML = readFileSync(PAGE, 'utf8');
const SRC = (() => { const at = HTML.indexOf('    function openWithdraw(ctx) {'); assert.ok(at > 0); return HTML.slice(at, HTML.indexOf('\n    }\n', at) + 6); })();

function open({ parts, exact = 990000n }) {
  const els = { 'arena-withdraw-panel': { style: { display: 'none' } }, 'arena-money-why': { textContent: 'old words' } };
  const calls = { open: [], withdrawable: [], withdraw: [], history: 0, balance: 0 };
  const fid = new Uint8Array(32).fill(7);
  const window = { ARENA_WALLET_BALANCE: { parts }, ARENA_READ_BALANCE: () => { calls.balance++; },
    ARENA_LOCK_WASM: async () => ({ default: async () => {}, LockClient: { lock: true } }),
    ArenaWithdraw: { open: (host, props) => calls.open.push({ host, props }) } };
  const ARENACLIENT = { toHex: (b) => Buffer.from(b).toString('hex'), invoiceAmountMsat: (t) => ({ ok: true, msat: BigInt(t.length) }),
    playerWithdrawable: async (o) => { calls.withdrawable.push(o); return exact; },
    withdrawPlayerWallet: async (o) => { calls.withdraw.push(o); return { ok: true }; } };
  const fn = pageFunction(PAGE, ['document', 'window', 'ARENACLIENT', 'vault', 'paintHistory'], SRC, 'return openWithdraw;')(
    { getElementById: (id) => els[id] }, window, ARENACLIENT, () => ({ store: 1 }), () => { calls.history++; });
  const ctx = { round: { federationId: fid }, invite: 'fed1x', seed: 's', gateways: ['gw'] };
  fn(ctx);
  return { els, calls, window, ctx, props: calls.open[0].props, fidHex: Buffer.from(fid).toString('hex') };
}

test('the panel opens with the balance the page already read for this federation, or none', () => {
  const fidHex = Buffer.from(new Uint8Array(32).fill(7)).toString('hex');
  const p = open({ parts: [{ federation: 'ab'.repeat(32), sats: 5 }, { federation: fidHex, sats: 999 }] });
  assert.equal(p.els['arena-withdraw-panel'].style.display, '');
  assert.equal(p.els['arena-money-why'].textContent, '');
  assert.equal(p.calls.open[0].host, p.els['arena-withdraw-panel']);
  assert.equal(p.props.knownSat, 999);
  assert.equal(p.window.ARENA_WITHDRAW_SAID.knownSat, 999);
  assert.equal(open({ parts: [{ federation: 'ab'.repeat(32), sats: 500 }] }).props.knownSat, null);
});

test('the exact amount, the invoice\'s amount, the withdraw, the why-line and the history: the page\'s rules', async () => {
  const p = open({ parts: [] });
  assert.equal(await p.props.readExact(), 990000n);
  assert.deepEqual([p.calls.withdrawable[0].invite, p.calls.withdrawable[0].round, p.calls.withdrawable[0].LockClient], ['fed1x', p.ctx.round, { lock: true }]);
  assert.equal(p.window.ARENA_WITHDRAW_SAID.exact, '990000');
  assert.deepEqual(p.props.invoiceAmount('lnbc1'), { ok: true, msat: 5n });
  const onStep = () => {};
  assert.deepEqual(await p.props.send({ amountMsat: 30000n, invoice: 'lnbc300n1ok', onStep }), { ok: true });
  const w = p.calls.withdraw[0];
  assert.deepEqual([w.amountMsat, w.gateways, w.onStep, w.seed], [30000n, ['gw'], onStep, 's']);
  assert.deepEqual(await w.invoiceFor(), { ok: true, invoice: 'lnbc300n1ok' });
  p.props.say('Paste an invoice first.');
  assert.equal(p.els['arena-money-why'].textContent, 'Paste an invoice first.');
  p.props.onSent();
  assert.deepEqual([p.calls.history, p.calls.balance], [1, 1]);
});
