// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A BOLT11 INVOICE, READ - against the examples BOLT11 itself publishes
// (M3.2 6e). Their own bech32 checksums guard the strings: a copy that is off by
// a character does not decode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { decodeBolt11, hrpAmountMsat } from '../src/bolt11.js';

const HASH = '0001020304050607080900010203040506070809000102030405060708090102';
const hex = (b) => Buffer.from(b).toString('hex');
const CAKE = 'One piece of chocolate cake, one icecream cone, one pickle, one slice of swiss cheese, one slice of salami, one lollypop, one piece of cherry pie, one sausage, one cupcake, and one slice of watermelon';
const cakeHash = createHash('sha256').update(CAKE).digest('hex');

test('BOLT11\'s own examples: network, amount, payment hash, description or its hash', () => {
  const donation = decodeBolt11('lnbc1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmwwd5kgetjypeh2ursdae8g6twvus8g6rfwvs8qun0dfjkxaq9qrsgq357wnc5r2ueh7ck6q93dj32dlqnls087fxdwk8qakdyafkq3yap9us6v52vjjsrvywa6rt52cm9r9zqt8r2t7mlcwspyetp5h2tztugp9lfyql');
  assert.deepEqual([donation.network, donation.amountMsat, hex(donation.paymentHash)], ['bitcoin', null, HASH]);
  const coffee = decodeBolt11('lnbc2500u1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpu9qrsgquk0rl77nj30yxdy8j9vdx85fkpmdla2087ne0xh8nhedh8w27kyke0lp53ut353s06fv3qfegext0eh0ymjpf39tuven09sam30g4vgpfna3rh');
  assert.deepEqual([coffee.amountMsat, hex(coffee.paymentHash), coffee.description, coffee.descriptionHash], [250000000n, HASH, '1 cup coffee', null]);
  const cake = decodeBolt11('lnbc20m1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqhp58yjmdan79s6qqdhdzgynm4zwqd5d7xmw5fk98klysy043l2ahrqs9qrsgq7ea976txfraylvgzuxs8kgcw23ezlrszfnh8r6qtfpr6cxga50aj6txm9rxrydzd06dfeawfk6swupvz4erwnyutnjq7x39ymw6j38gp7ynn44');
  assert.deepEqual([cake.network, cake.amountMsat, hex(cake.paymentHash), hex(cake.descriptionHash)], ['bitcoin', 2000000000n, HASH, cakeHash]);
  const testnet = decodeBolt11('lntb20m1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygshp58yjmdan79s6qqdhdzgynm4zwqd5d7xmw5fk98klysy043l2ahrqspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqfpp3x9et2e20v6pu37c5d9vax37wxq72un989qrsgqdj545axuxtnfemtpwkc45hx9d2ft7x04mt8q7y6t0k2dge9e7h8kpy9p34ytyslj3yu569aalz2xdk8xkd7ltxqld94u8h2esmsmacgpghe9k8');
  assert.deepEqual([testnet.network, testnet.amountMsat, hex(testnet.paymentHash), hex(testnet.descriptionHash)], ['testnet', 2000000000n, HASH, cakeHash]);
});

test('the amount rules: each multiplier, a pico amount must end in 0, and no multiplier without an amount', () => {
  assert.equal(hrpAmountMsat('lnbc'), null);
  assert.equal(hrpAmountMsat('lnbc2500u'), 250000000n);
  assert.equal(hrpAmountMsat('lnbc20m'), 2000000000n);
  assert.equal(hrpAmountMsat('lnbcrt2000n'), 200000n);
  assert.equal(hrpAmountMsat('lnbc10p'), 1n);
  assert.equal(hrpAmountMsat('lnbc1'), 100000000000n);
  assert.throws(() => hrpAmountMsat('lnbc11p'), /must end in 0/);
  assert.throws(() => hrpAmountMsat('lnbcm'), /no amount/);
  assert.throws(() => hrpAmountMsat('lnxx20m'), /not a BOLT11 prefix/);
});

test('a character changed is no invoice', () => {
  assert.throws(() => decodeBolt11('lnbc2500u1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpu9qrsgquk0rl77nj30yxdy8j9vdx85fkpmdla2087ne0xh8nhedh8w27kyke0lp53ut353s06fv3qfegext0eh0ymjpf39tuven09sam30g4vgpfna3rj'), /checksum/);
});
