// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3889: Check my node shows the advertisement update's progress - sent, n of 6 confirmations, the census's next step, taken.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { diagnose, updateLine } from '../dist/test/reach-check.mjs';
import { AddressPanel } from '../dist/test/address.mjs';

const TX = 'cc'.repeat(32);
const reach = (progress, advertised = ['https://old.example.org']) => ({ ok: true, url: 'https://arena.example.org', stable: true, modes: {},
  follow: { censusRead: true, advertised, bonded: true, takesBlocks: 12, takesMinutes: 120, update: { txid: TX, endpoint: 'https://arena.example.org' }, progress } });

test('the progress line, step by step', () => {
  const line = (p) => diagnose({ reach: reach(p), probes: [] }).find((l) => l.id === 'update');
  assert.match(line({ step: 'sent', txid: TX, depth: 0, need: 6, minutesLeft: 120 }).says, /^Sent \(cccccccccccc…\), waiting for its first confirmation/);
  assert.match(line({ step: 'sent', txid: TX, depth: 0, need: 6, minutesLeft: 120 }).fix, /about 2 hours/);
  const c = line({ step: 'confirming', txid: TX, depth: 3, need: 6, minutesLeft: 90 });
  assert.equal(c.level, 'warn'); assert.match(c.says, /^3 of 6 confirmations/); assert.match(c.fix, /about 2 hours|about 90 minutes/);
  assert.match(line({ step: 'deep', txid: TX, depth: 7, need: 6, minutesLeft: 50 }).fix, /next step, in about 50 minutes/);
  const t = updateLine({ step: 'taken', txid: TX, need: 6, minutesLeft: 0 });
  assert.equal(t.level, 'ok'); assert.match(t.says, /^Taken: the census names your new address/);
  assert.equal(diagnose({ reach: reach(null), probes: [] }).some((l) => l.id === 'update'), false, 'no update on its way: no line');
});

test('the Address card names the confirmations', () => {
  const h = renderToStaticMarkup(React.createElement(AddressPanel, { initial: { loaded: true, answer: reach({ step: 'confirming', txid: TX, depth: 2, need: 6, minutesLeft: 100 }) } }));
  assert.match(h, /data-check="update-progress"[^>]*>An advertisement update naming this address is on its way \(cccccccccccc…\), 2 of 6 confirmations/);
});
