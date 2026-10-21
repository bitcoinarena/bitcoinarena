// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE STANDING SCREEN IN REACT (kanban #564): the figures and every warning in plain words; the badge told of missed draws.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StandingPanel, warningsOf } from '../dist/test/standing.mjs';

const st = { ownBondSats: '100000', ownWeight: 0.0312, bracketsServed: { eligible: 9, of: 12 }, headroom: 0.75, commonBondMinSats: '200000',
  bondMin: { inForce: '50000', noticeBlocks: 2016, pending: { value: '75000', effectiveAt: 158000 } },
  warnings: [{ kind: 'losing brackets', urgent: true, says: 'the common bracket asks 200,000 sat' }, { kind: 'address changed', urgent: true, says: 'answers at A, advertised B' }] };
const seat = { missedInARow: 3, warning: { says: 'missed 3 draws', update: 'ARENA_ADVERT_SERVING=false' } };

test('the figures, the minimum with its rise, and the warnings in plain words; none when all is well', () => {
  const html = renderToStaticMarkup(React.createElement(StandingPanel, { initial: { loaded: true, seat, standing: st } }));
  assert.match(html, /Draws missed in a row<\/span><b>3/);
  assert.match(html, /3\.1 %/); assert.match(html, /9 of 12/); assert.match(html, /0\.75× of 200,000 sat/);
  assert.match(html, /rising to 75,000 sat at block 158000 if it holds \(notice 2016 blocks\)/);
  for (const k of ['Missed draws', 'Bond below the minimum', 'Address changed']) assert.match(html, new RegExp(`<b>${k}</b>`));
  assert.match(html, /ARENA_ADVERT_SERVING=false/);
  assert.equal(warningsOf(seat, st).length, 3);
  const calm = renderToStaticMarkup(React.createElement(StandingPanel, { initial: { loaded: true, seat: { missedInARow: 0 }, standing: { ...st, warnings: [], bondMin: null } } }));
  assert.match(calm, /No warning/);
});

test('read from the seat; the page\'s badge told of missed draws', async () => {
  let told = null;
  const c = new StandingPanel({ api: { get: async (p) => (p === '/owner/seatings' ? seat : st) }, onMissed: (k) => { told = k; } });
  c.setState = (u) => { Object.assign(c.state, typeof u === 'function' ? u(c.state) : u); };
  await c.componentDidMount();
  assert.deepEqual([c.state.loaded, told], [true, 3]);
});
