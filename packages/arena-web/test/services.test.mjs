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

// A GATEWAY NEVER SET UP (kanban #711, 2026-10-26: "lightning gateway reports error and no hint about reason or how to solve it"): the
// card says why and sets it up on a click, the signed request its own action; while it runs the button says so and cannot be clicked twice
test('a gateway left for later in setup: the reason on the card and a button that sets it up', async () => {
  const gap = { id: 'gateway', title: 'Lightning gateway', running: false, detail: 'x', controls: [], bootSettable: false, why: null,
    probe: { ok: false, says: 'Not set up: Lightning was left for later in setup, so the gateway was never started.' },
    fix: { action: 'gateway/setup', label: 'Set up the gateway', busy: false } };
  const html = renderToStaticMarkup(React.createElement(ServicesPanel, { initial: { loaded: true, answer: { ok: true, command: 'bitcoinarena', services: [gap] } } }));
  assert.match(html, /<p class="svc-says">Not set up: Lightning was left for later in setup, so the gateway was never started\.<\/p>/);
  assert.match(html, /<button type="button" class="mini">Set up the gateway<\/button>/);
  assert.doesNotMatch(html, /runs outside the node|does not answer/);
  const sent = [];
  const api = { signed: async (action, args) => ({ action, args }), post: async (path, body) => { sent.push([path, body.action]); return path === '/owner/services' ? { ok: true, services: [{ ...gap, fix: { ...gap.fix, label: 'Setting up…', busy: true } }] } : { ok: true }; } };
  const c = driven(api, { initial: { loaded: true, answer: { ok: true, services: [gap] } } });
  await c.fix(gap);
  assert.deepEqual(sent, [['/owner/gateway/setup', 'gateway/setup']]);
  clearTimeout(c.timer); await c.reload(); clearTimeout(c.fixTimer);
  const busy = renderToStaticMarkup(React.createElement(ServicesPanel, { initial: { loaded: true, answer: c.state.answer } }));
  assert.match(busy, /<button type="button" class="mini" disabled="">Setting up…<\/button>/);
});

// LEFT FOR LATER IS NO FAULT (the owner 2026-10-27: "1 service not running" for a gateway set up later on purpose)
test('a gateway left for later reads "Left for later", grey, with its set-up button, and needs no attention', () => {
  const later = { id: 'gateway', title: 'Lightning gateway', running: false, later: true, detail: 'Not set up: Lightning was left for later in setup, so the gateway was never started.',
    probe: { ok: false, says: 'Not set up: Lightning was left for later in setup, so the gateway was never started.' }, fix: { action: 'gateway/setup', label: 'Set up the gateway', busy: false }, controls: [] };
  assert.equal(lightOf(later), '⚪');
  assert.equal(needsAttention([later]), 0);
  assert.equal(needsAttention([later, { ...later, later: false }]), 1, 'a gateway that stopped still counts');
  const html = renderToStaticMarkup(React.createElement(ServicesPanel, { initial: { loaded: true, answer: { ok: true, services: [later] } } }));
  assert.match(html, /Left for later/);
  assert.doesNotMatch(html, /Needs attention/);
  assert.match(html, /Set up the gateway/);
});
