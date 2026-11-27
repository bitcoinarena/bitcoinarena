// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3888: the Address card and Check my node say the wallet cannot pay the update - the amount and the deposit address.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AddressPanel } from '../dist/test/address.mjs';
// 2.0: Check my node (#3798, ReachCheckPanel, GET /reach-probe) is not on this branch - its parts of this test stay on 1.9.

const fee = { ok: true, enough: false, haveSats: '600', needSats: '1452', sendSats: '852', deposit: 'tb1pexampleaddress' };
const answer = { ok: true, mode: 'permanent', url: 'https://arena.example.org', stable: true, modes: {}, follow: { censusRead: true, advertised: ['https://old.example.org'], bonded: true,
  update: { endpoint: 'https://arena.example.org', why: 'the node wallet holds 600 sat', fee } } };

test('the amount and the deposit address on the Address card', () => {
  const h = renderToStaticMarkup(React.createElement(AddressPanel, { initial: { loaded: true, answer } }));
  assert.match(h, /data-check="fee"/);
  assert.match(h, /holds 600 sat and the update needs 1452 sat/);
  assert.match(h, /Send at least <b>852 sat<\/b> to <code>tb1pexampleaddress<\/code>/);
});
