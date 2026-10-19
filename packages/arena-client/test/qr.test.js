// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE DEPOSIT QR (2026-09-30): an SVG of lightning:<INVOICE>, and nothing drawn for what is not an invoice.
import test from 'node:test';
import assert from 'node:assert/strict';
import { invoiceQrSvg } from '../src/qr.js';

const INVOICE = 'lntb98676340p1p4t6qy6pp5cu6l78q6g0uyw8gsx9y8wjz0d9c7pk6k9u5x2y3z4a5b6c7d8e9f0gh';
test('an invoice becomes an SVG QR code, the same every time', () => {
  const a = invoiceQrSvg(INVOICE), b = invoiceQrSvg(INVOICE.toUpperCase());
  assert.match(a, /^<svg[\s\S]*<\/svg>$/);
  assert.equal(a, b, 'the case of the invoice changed the code');
  assert.ok(a.length > 1000);
});
test('what is not an invoice draws nothing', () => {
  assert.throws(() => invoiceQrSvg('<script>'), /not a Lightning invoice/);
  assert.throws(() => invoiceQrSvg(''), /not a Lightning invoice/);
});
