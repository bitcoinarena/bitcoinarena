// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3889: Check my node shows the advertisement update's progress - sent, n of 6 confirmations, the census's next step, taken.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
// 2.0: Check my node (#3798, ReachCheckPanel, GET /reach-probe) is not on this branch - its parts of this test stay on 1.9.
import { AddressPanel } from '../dist/test/address.mjs';

const TX = 'cc'.repeat(32);
const reach = (progress, advertised = ['https://old.example.org']) => ({ ok: true, url: 'https://arena.example.org', stable: true, modes: {},
  follow: { censusRead: true, advertised, bonded: true, takesBlocks: 12, takesMinutes: 120, update: { txid: TX, endpoint: 'https://arena.example.org' }, progress } });

test('the Address card names the confirmations', () => {
  const h = renderToStaticMarkup(React.createElement(AddressPanel, { initial: { loaded: true, answer: reach({ step: 'confirming', txid: TX, depth: 2, need: 6, minutesLeft: 100 }) } }));
  assert.match(h, /data-check="update-progress"[^>]*>An advertisement update naming this address is on its way \(cccccccccccc…\), 2 of 6 confirmations/);
});
