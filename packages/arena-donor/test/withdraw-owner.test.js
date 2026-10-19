// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OWNER'S WITHDRAWAL: an invoice's amount read from its human-readable part, a Lightning address resolved through
// LNURL-pay, and one invoice paid from the wallet through the named gateways - with the federation and the address faked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { invoiceMsat, lightningAddressInvoice, payInvoice } from '../src/donor.js';

test('an invoice names its amount in its human-readable part; none is null; below a msat is refused', () => {
  assert.equal(invoiceMsat('lntb10u1pqqqqqq'), 1000000n);
  assert.equal(invoiceMsat('lntb1500n1pxyz'), 150000n);
  assert.equal(invoiceMsat('LNTB2m1qq'), 200000000n);
  assert.equal(invoiceMsat('lntb20p1qq'), 2n);
  assert.equal(invoiceMsat('lnbc1qqq'), null);
  assert.throws(() => invoiceMsat('lntb25p1qq'), /below one msat/);
  assert.throws(() => invoiceMsat('bitcoin:tb1q'), /not a Lightning invoice/);
});

const fakeAddress = (pr, { min = 1000, max = 100000000 } = {}) => async (url) => {
  const u = String(url);
  if (u === 'https://pay.example/.well-known/lnurlp/dev') return { json: async () => ({ tag: 'payRequest', callback: 'https://pay.example/cb', minSendable: min, maxSendable: max }) };
  if (u.startsWith('https://pay.example/cb?amount=')) return { json: async () => ({ pr: pr(BigInt(new URL(u).searchParams.get('amount'))) }) };
  throw new Error(`unexpected ${u}`);
};

test('a Lightning address gives the invoice for the amount asked, and a wrong amount or range is refused', async () => {
  const pr = await lightningAddressInvoice('dev@pay.example', 21000n, { fetcher: fakeAddress((m) => `lntb${m / 100n}n1pqq`) });
  assert.equal(invoiceMsat(pr), 21000n);
  await assert.rejects(lightningAddressInvoice('dev@pay.example', 500n, { fetcher: fakeAddress(() => 'lntb1u1pqq') }), /takes 1000 to/);
  await assert.rejects(lightningAddressInvoice('dev@pay.example', 21000n, { fetcher: fakeAddress(() => 'lntb1u1pqq') }), /made an invoice for 100000 msat/);
  await assert.rejects(lightningAddressInvoice('not an address', 1000n, { fetcher: fakeAddress(() => '') }), /name@domain/);
});

const wallet = (can, answers) => {
  let held = can; const calls = [];
  return { calls, withdrawableMsat: async () => String(held),
    withdraw: async (inv, gw) => { calls.push(gw || null); const a = answers.shift(); if (a === 'Success' || a === 'Lost') held = 0n; return JSON.stringify({ state: a === 'Lost' ? 'Failed' : a, preimage: a === 'Success' ? 'aa' : undefined }); } };
};

test('an invoice is paid through the named gateways first; a refund tries the next; e-cash gone without Success is not tried again', async () => {
  const w = wallet(50000n, ['Refunded', 'Success']);
  const r = await payInvoice({ client: w, invoice: 'lntb100n1pqq', gateways: ['https://g1/', 'https://g2/'] });
  assert.equal(r.paid, true); assert.equal(r.msat, 10000n); assert.deepEqual(w.calls, ['https://g1/', 'https://g2/']);
  const lost = wallet(50000n, ['Lost']);
  const l = await payInvoice({ client: lost, invoice: 'lntb100n1pqq', gateways: ['https://g1/', 'https://g2/'] });
  assert.equal(l.paid, false); assert.deepEqual(lost.calls, ['https://g1/']);
});

test('an invoice above what the wallet can send, or without an amount, is refused before anything is sent', async () => {
  const w = wallet(5000n, []);
  const big = await payInvoice({ client: w, invoice: 'lntb100n1pqq' });
  assert.equal(big.state, 'Refused'); assert.match(big.why, /can send 5000 msat/);
  const none = await payInvoice({ client: w, invoice: 'lntb1pqq' });
  assert.equal(none.state, 'Refused'); assert.equal(w.calls.length, 0);
});
