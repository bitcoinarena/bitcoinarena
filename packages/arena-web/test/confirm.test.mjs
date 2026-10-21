// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE PAGE'S CONFIRMATIONS IN REACT (kanban #564): one frame for "Trust this federation?" (rows, guardians from the census or the words
// when none were read), "Before you stake" and "Enter by swap" (the items); answered once - a second press is not a second answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfirmCard } from '../dist/test/confirm.mjs';

test('the federation: its id and status, each guardian with its bond, node key and endpoint; none read says so', () => {
  const h = renderToStaticMarkup(React.createElement(ConfirmCard, { title: 'Trust this federation?', sub: 'Not on the known-good list.', rows: [['Federation', 'ab'.repeat(32)], ['Status', 'OPEN · 7 of 7 guardians signed']],
    guardians: [{ operator: 'op-1', bondSats: '50000', nodeKey: 'cd'.repeat(32), endpoint: 'wss://g1.example' }, { operator: '', bondSats: '50000', nodeKey: 'ef'.repeat(32), endpoint: '' }], yes: 'I trust this federation' }));
  assert.match(h, /<h2>Trust this federation\?<\/h2><p class="afc-sub">Not on the known-good list\.<\/p><div class="afc-row"><span>Federation<\/span><b>abab/);
  assert.match(h, /<div class="afc-g"><b>op-1<\/b> · bond <span>50,000<\/span> sat<br\/><code>node cdcd[0-9a-f]*<\/code><br\/><code>wss:\/\/g1.example<\/code><\/div>/);
  assert.match(h, /<b>\(no operator name\)<\/b>[\s\S]*<code>\(no endpoint\)<\/code>/);
  assert.match(h, /<button type="button" class="primary">I trust this federation<\/button><button type="button">Cancel<\/button>/);
  assert.match(renderToStaticMarkup(React.createElement(ConfirmCard, { title: 't', sub: 's', guardians: [], guardiansEmpty: 'Its guardians could not be read from the census.', yes: 'y' })), /<div class="afc-guardians">Its guardians could not be read from the census\.<\/div>/);
});

test('warnings and the swap as items; one answer only', () => {
  assert.match(renderToStaticMarkup(React.createElement(ConfirmCard, { title: 'Enter by swap', sub: 'from 337ae01a to 4dc88be7', items: ['Move 100 sat through a gateway that serves both.', 'Fee: 2 sat.'], yes: 'Swap and enter' })),
    /<ul><li>Move 100 sat through a gateway that serves both\.<\/li><li>Fee: 2 sat\.<\/li><\/ul><div class="afc-buttons"><button type="button" class="primary">Swap and enter<\/button>/);
  const got = [];
  const c = new ConfirmCard({ title: 't', sub: 's', yes: 'y', onAnswer: (v) => got.push(v) });
  c.setState = (u) => Object.assign(c.state, u);
  c.answer(false); c.answer(true);
  assert.deepEqual(got, [false]);
});
