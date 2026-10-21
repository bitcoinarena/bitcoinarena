// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OVERVIEW'S "WHAT NEEDS YOU" IN REACT (kanban #564): urgent first, each with its section's link; nothing needs you when empty.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NeedsPanel, ordered } from '../dist/test/needs.mjs';

test('urgent first with its link; a calm node told so', () => {
  const items = [{ level: 'warn', text: 'A new release is out: 2026.1.2.', section: 'release' }, { level: 'bad', text: 'Your node missed 3 draws in a row: check its services.', section: 'services' }];
  assert.deepEqual(ordered(items).map((x) => x.section), ['services', 'release']);
  const html = renderToStaticMarkup(React.createElement(NeedsPanel, { items }));
  assert.match(html, /<p class="err">🔴 Your node missed 3 draws in a row: check its services\. <a href="#services">Open<\/a><\/p><p class="warnline">🟡 A new release/);
  assert.match(renderToStaticMarkup(React.createElement(NeedsPanel, { items: [] })), /Nothing needs you ✓/);
});
