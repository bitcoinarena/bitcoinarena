// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SERVICES SCREEN IN REACT (kanban #564 / #563): each service with its light, what it answers, its controls or the reason there are
// none; a control asks the seat and the list is read again; the page's badge told how many need attention.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ServicesPanel, lightOf, needsAttention } from '../dist/test/services.mjs';

const rows = [
  { id: 'node', title: 'Arena node (seat)', running: true, probe: { ok: true, says: 'answers' }, controls: ['restart'], bootSettable: true, atBoot: true },
  { id: 'gateway', title: 'Lightning gateway', running: false, probe: { ok: false, says: 'does not answer' }, controls: ['start'], bootSettable: true, atBoot: false },
  { id: 'announcements', title: 'Address announcements', running: true, inside: true, probe: { ok: true, says: 'announced 3 min ago' }, controls: ['stop', 'restart'], bootSettable: true, atBoot: true },
  { id: 'chain', title: 'Bitcoin (the chain it reads)', running: true, probe: { ok: true, says: 'at block 157,191' }, controls: [], bootSettable: false, why: 'runs outside the node: started and stopped on its machine' },
];
function driven(api, props = {}) {
  const c = new ServicesPanel({ api, ...props });
  c.setState = (u) => { Object.assign(c.state, typeof u === 'function' ? u(c.state) : u); };
  return c;
}

test('what it shows: the lights, what each answers, the controls where there are any, the reason where not', () => {
  const html = renderToStaticMarkup(React.createElement(ServicesPanel, { initial: { loaded: true, answer: { ok: true, command: null, services: rows } } }));
  assert.equal(needsAttention(rows), 1); assert.match(html, /<div class="summary bad"><div><b>1 needs attention<\/b><span class="sub">3 of 4 services answer<\/span>/);
  assert.match(html, /<div class="svc-card down" id="svc-gateway"><div class="svc-head"><span class="led down" aria-hidden="true"><\/span><b class="svc-name">/, 'the stopped gateway: a red card');
  assert.match(html, /<h3 class="sh">On this machine<\/h3>[\s\S]*<h3 class="sh">Inside the node<\/h3>/, 'grouped where they run');
  assert.deepEqual(rows.map(lightOf), ['🟢', '🔴', '🟢', '🟢']);
  assert.match(html, /<button type="button" class="mini">Start<\/button>/, 'the stopped gateway: Start');
  assert.match(html, />Stop<\/button><button type="button" class="mini">Restart</, 'the running announcements: Stop, Restart');
  assert.match(html, /id="boot-gateway"(?![^>]*checked)/, 'the gateway does not start at boot');
  assert.match(html, /runs outside the node/, 'the chain: why there are no buttons');
  assert.match(html, /Set up by hand/);
});

test('what it does: a control asks the seat with the owner\'s signature, then the list is read again; the badge is told; a refusal is shown', async () => {
  const sent = []; let attention = null;
  const api = { signed: async (action, args) => ({ action, args }),
    post: async (path, body) => { sent.push([path, body.action, body.args]); return path === '/owner/services' ? { ok: true, services: rows } : path === '/owner/service' && body.args.id === 'chain' ? { ok: false, why: 'set up by hand' } : { ok: true }; } };
  const c = driven(api, { onAttention: (n) => { attention = n; } });
  await c.reload();
  assert.deepEqual([c.state.loaded, attention], [true, 1]);
  await c.act('gateway', 'start');
  assert.deepEqual(sent[1], ['/owner/service', 'service', { id: 'gateway', action: 'start' }]);
  await new Promise((r) => setTimeout(r, 900));
  assert.equal(sent[2][0], '/owner/services', 'read again after the control');
  await c.act('chain', 'start');
  assert.equal(c.state.message, 'chain: set up by hand');
  c.componentWillUnmount();
});
