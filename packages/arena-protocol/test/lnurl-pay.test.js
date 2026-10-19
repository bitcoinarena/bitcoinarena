// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// LNURL-PAY, THE DONOR'S CHECKS (LUD-06, LUD-12; M3.2 6e). An invoice is paid
// only if it is exactly the share, under the endpoint's own metadata hash.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { payRequestStands, callbackFor, invoiceAnswersPayRequest, COMMENT_KEY_CHARS, lightningAddressEndpoint } from '../src/lnurl-pay.js';

const CAKE = 'One piece of chocolate cake, one icecream cone, one pickle, one slice of swiss cheese, one slice of salami, one lollypop, one piece of cherry pie, one sausage, one cupcake, and one slice of watermelon';
const CAKE_INVOICE = 'lnbc20m1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqhp58yjmdan79s6qqdhdzgynm4zwqd5d7xmw5fk98klysy043l2ahrqs9qrsgq7ea976txfraylvgzuxs8kgcw23ezlrszfnh8r6qtfpr6cxga50aj6txm9rxrydzd06dfeawfk6swupvz4erwnyutnjq7x39ymw6j38gp7ynn44';
const COFFEE_INVOICE = 'lnbc2500u1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpu9qrsgquk0rl77nj30yxdy8j9vdx85fkpmdla2087ne0xh8nhedh8w27kyke0lp53ut353s06fv3qfegext0eh0ymjpf39tuven09sam30g4vgpfna3rh';
const ask = { tag: 'payRequest', callback: 'http://127.0.0.1:18777/lnurlp/blwp-test-a/cb', metadata: '[["text/plain","test"]]', minSendable: 1000, maxSendable: 100000000 };

test('a pay request stands only with its tag, a callback, metadata, and a range holding the share', () => {
  const ok = payRequestStands(ask, 1334n);
  assert.deepEqual([ok.ok, ok.callback, ok.commentAllowed], [true, ask.callback, 0]);
  for (const [said, why] of [
    [null, /did not answer/], [{ status: 'ERROR', reason: 'down' }, /refused: down/],
    [{ ...ask, tag: 'withdrawRequest' }, /not a payRequest/], [{ ...ask, callback: 'ftp://x' }, /no callback/],
    [{ ...ask, metadata: undefined }, /no metadata/], [{ ...ask, minSendable: 5, maxSendable: 4 }, /no sendable range/],
  ]) assert.match(payRequestStands(said, 1334n).why, why);
  assert.match(payRequestStands(ask, 999n).why, /outside what the endpoint takes/);
  assert.match(payRequestStands(ask, 100000001n).why, /outside/);
});

test('the callback asks exactly the share, and carries the player key only where 64 characters fit', () => {
  const key = 'ab'.repeat(32);
  assert.equal(COMMENT_KEY_CHARS, 64);
  const plain = new URL(callbackFor({ callback: ask.callback, amountMsat: 1334n, comment: key, commentAllowed: 63 }));
  assert.equal(plain.searchParams.get('amount'), '1334');
  assert.equal(plain.searchParams.get('comment'), null, 'an endpoint taking 63 characters gets no comment');
  const keyed = new URL(callbackFor({ callback: `${ask.callback}?k=1`, amountMsat: 666n, comment: key, commentAllowed: 64 }));
  assert.deepEqual([keyed.searchParams.get('k'), keyed.searchParams.get('amount'), keyed.searchParams.get('comment')], ['1', '666', key]);
});

test('the invoice is exactly the share, under the endpoint\'s own metadata hash, on the round\'s network', () => {
  const ok = invoiceAnswersPayRequest({ invoice: CAKE_INVOICE, amountMsat: 2000000000n, metadata: CAKE });
  assert.equal(ok.ok, true, ok.why);
  assert.match(invoiceAnswersPayRequest({ invoice: CAKE_INVOICE, amountMsat: 1334n, metadata: CAKE }).why, /asks 2000000000 msat, and this recipient's share is 1334/);
  assert.match(invoiceAnswersPayRequest({ invoice: CAKE_INVOICE, amountMsat: 2000000000n, metadata: 'other' }).why, /description hash is not the endpoint's own metadata/);
  assert.match(invoiceAnswersPayRequest({ invoice: COFFEE_INVOICE, amountMsat: 250000000n, metadata: '1 cup coffee' }).why, /description hash/, 'a plain description is not the metadata hash');
  assert.match(invoiceAnswersPayRequest({ invoice: CAKE_INVOICE, amountMsat: 2000000000n, metadata: CAKE, network: 'regtest' }).why, /for bitcoin, and this round is on regtest/);
  assert.match(invoiceAnswersPayRequest({ invoice: 'lnbc1xyz', amountMsat: 1n, metadata: '' }).why, /not an invoice/);
  assert.match(invoiceAnswersPayRequest({ amountMsat: 1n, metadata: '' }).why, /handed no invoice/);
});

// A LIGHTNING ADDRESS (LUD-16), because winnings must be able to leave without NWC (2026-09-21
// 13:54): a player with no wallet connected names an address once, and the node LNURL-pays it exactly what
// the pool owes. It is where money LEAVES for, so it is read strictly.
test('name@host is that host\'s well-known endpoint, and nothing is guessed', () => {
  assert.deepEqual(lightningAddressEndpoint('alice@example.com'),
    { ok: true, url: 'https://example.com/.well-known/lnurlp/alice', name: 'alice', host: 'example.com' });
  // Case is not a second address.
  assert.equal(lightningAddressEndpoint('Alice@Example.COM').url, 'https://example.com/.well-known/lnurlp/alice');
  // A port is part of the host, and survives.
  assert.equal(lightningAddressEndpoint('a@127.0.0.1:18777').url, 'https://127.0.0.1:18777/.well-known/lnurlp/a');
});

test('onion is the one host that may be http, because it cannot hold a certificate', () => {
  assert.match(lightningAddressEndpoint('a@abcdef.onion').url, /^http:\/\/abcdef\.onion\//);
  assert.match(lightningAddressEndpoint('a@abcdef.onion:8080').url, /^http:\/\/abcdef\.onion:8080\//);
});

test('anything that is not name@host is refused rather than normalised', () => {
  for (const [bad, why] of [
    ['', /no Lightning address/],
    ['alice', /it is name@host/],
    ['@example.com', /it is name@host/],
    ['a@b@c', /it is name@host/],
    ['al ice@example.com', /letters, digits, dot, dash or underscore/],
    ['alice@exa mple.com', /is not a host/],
    ['alice@example.com/pay', /is not a host/],
    ['alice@.example.com', /is not a host/],
    ['alice@example.com.', /is not a host/],
  ]) {
    const got = lightningAddressEndpoint(bad);
    assert.equal(got.ok, false, bad);
    assert.match(got.why, why, bad);
  }
});
