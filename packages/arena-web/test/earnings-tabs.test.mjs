// kanban #847: the Earnings periods are real tabs, only the chosen one in the tab order, tied to their panel
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Earnings } from '../dist/test/dashboard.mjs';

test('one tab in the tab order, each naming the panel', () => {
  const html = renderToStaticMarkup(React.createElement(Earnings, { totals: { day: {}, month: {}, year: {}, owed: {} }, period: 'month', onPeriod: () => {} }));
  assert.equal((html.match(/tabindex="0"/g) || []).length, 1);
  assert.match(html, /aria-controls="earn-panel"/);
  assert.match(html, /role="tabpanel" id="earn-panel"/);
});
