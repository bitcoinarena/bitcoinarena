// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SITE'S SMALL PAGES IN REACT (kanban #564): the nodes' dashboards list - reading, not answering, or the node's key, today's profit and
// rounds; the guardian check - opening, sessions and time, or why not, with each federation's agreement once all answered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NodesList, GuardianCheck } from '../dist/test/site.mjs';

test('the nodes list: a link per node, reading, not answering, or its numbers', () => {
  assert.equal(renderToStaticMarkup(React.createElement(NodesList, {})), 'Reading the nodes’ routes…');
  const h = renderToStaticMarkup(React.createElement(NodesList, { rows: [
    { n: 1, href: 'https://x/guardian-1/dashboard', read: null }, { n: 2, href: 'https://x/guardian-2/dashboard', read: false },
    { n: 3, href: 'https://x/guardian-3/dashboard', read: { node: 'ab'.repeat(32), dayMsat: '12345', rounds: 40 } }] }));
  assert.match(h, /^<div class="row"><a href="https:\/\/x\/guardian-1\/dashboard">Node 1<\/a><span class="k">reading…<\/span><\/div>/);
  assert.match(h, /Node 2<\/a><span class="k">not answering now<\/span>/);
  assert.match(h, /Node 3<\/a><span class="k"><span>abababababab…<\/span> · today <span class="v">12\.3 sat<\/span> · 40 rounds checked<\/span>/);
});

test('the guardian check: opening, sessions, why not; the agreement once all answered', () => {
  const f = (r1, r2) => ({ feds: [{ name: 'Federation A', id: '337ae01a', paths: [{ url: 'wss://h/guardian-1/guardian', r: r1 }, { url: 'wss://h/guardian-2/guardian', r: r2 }] }] });
  const opening = renderToStaticMarkup(React.createElement(GuardianCheck, f(null, { ok: true, sessions: 900, ms: 120 })));
  assert.match(opening, /<h2>Federation A <span class="agree" id="agree-0">337ae01a…<\/span><\/h2>/);
  assert.match(opening, /<td class="state wait" id="s-0-0">opening…<\/td>.*<td class="state ok" id="s-0-1">900 sessions · 120 ms<\/td>/);
  const agreed = renderToStaticMarkup(React.createElement(GuardianCheck, f({ ok: true, sessions: 901, ms: 80 }, { ok: true, sessions: 900, ms: 120 })));
  assert.match(agreed, /337ae01a… · 2 of 2 answer · sessions 900–901, in agreement/);
  const split = renderToStaticMarkup(React.createElement(GuardianCheck, f({ ok: false, why: 'no answer in 20 s', ms: 20000 }, { ok: true, sessions: 900, ms: 120 })));
  assert.match(split, /337ae01a… · 1 of 2 answer · sessions 900, in agreement/);
  assert.match(split, /<td class="state bad" id="s-0-0">no answer in 20 s · 20000 ms<\/td>/);
});
