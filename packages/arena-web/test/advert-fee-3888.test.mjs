// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3888: the Address card and Check my node say the wallet cannot pay the update - the amount and the deposit address.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AddressPanel } from '../dist/test/address.mjs';
import { diagnose } from '../dist/test/reach-check.mjs';

const fee = { ok: true, enough: false, haveSats: '600', needSats: '1452', sendSats: '852', deposit: 'tb1pexampleaddress' };
const answer = { ok: true, mode: 'permanent', url: 'https://arena.example.org', stable: true, modes: {}, follow: { censusRead: true, advertised: ['https://old.example.org'], bonded: true,
  update: { endpoint: 'https://arena.example.org', why: 'the node wallet holds 600 sat', fee } } };

test('the amount and the deposit address on the Address card and on Check my node', () => {
  const h = renderToStaticMarkup(React.createElement(AddressPanel, { initial: { loaded: true, answer } }));
  assert.match(h, /data-check="fee"/);
  assert.match(h, /holds 600 sat and the update needs 1452 sat/);
  assert.match(h, /Send at least <b>852 sat<\/b> to <code>tb1pexampleaddress<\/code>/);
  const c = diagnose({ reach: answer, probes: [{ seat: 's', body: { ok: true, census: ['https://old.example.org'], results: [] } }] }).find((l) => l.id === 'census');
  assert.match(c.fix, /send at least 852 sat to tb1pexampleaddress/);
});
