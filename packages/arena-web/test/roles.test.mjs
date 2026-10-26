// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ROLES SCREEN IN REACT (kanban #564): rendered on the server for what it shows, and its class driven for what it does - read the
// node's roles, a switch flipped, the change counted, Review asks the seat for the fee, Confirm sends it, Undo puts it back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RolesPanel, switchesOf, changedOf, askOf } from '../dist/test/roles.mjs';

const mine = { node: 'me', roles: ['game', 'verify', 'settlement'], guardianCapable: true };
const answers = { '/roles': { nodes: [mine] }, '/guardian': null, '/gateway-claim': { gatewayUrl: 'https://x/gateway/' }, '/liquidity-claim': null };

/** The class run without a DOM: setState applied at once, so each step can be checked. */
function driven(api) {
  const c = new RolesPanel({ api, node: 'me' });
  c.setState = (u) => { Object.assign(c.state, typeof u === 'function' ? u(c.state) : u); };
  return c;
}

test('what it shows: six tiles, a switch for each advertised role and custody, the gateway on, no save bar while nothing changed', () => {
  const was = switchesOf(mine);
  const html = renderToStaticMarkup(React.createElement(RolesPanel, { node: 'me', initial: { loaded: true, mine, gateway: answers['/gateway-claim'], was, now: { ...was } } }));
  assert.equal((html.match(/class="tile[ "]/g) || []).length, 6);
  for (const k of ['play', 'settlement', 'custody']) assert.match(html, new RegExp(`id="rl-${k}"`));
  assert.match(html, /class="tile on" id="tile-play"/);
  // relay: always on, no switch (2026-10-26: "Clarify why relay is not default on. It should always be on")
  assert.doesNotMatch(html, /id="rl-relay"/);
  assert.match(html, /class="tile on" id="tile-relay"[\s\S]*?Every node does this: it serves round data to players and other nodes\. Always on\./);
  assert.match(html, />Manage →</, 'the gateway is on');
  assert.doesNotMatch(html, /savebar/);
});

test('what it does: read from the seat, a switch flipped and counted, Review asks for the fee, Confirm sends, Undo puts it back', async () => {
  const posts = [];
  const api = { get: async (p) => answers[p], signed: async (action, args) => ({ action, args }),
    post: async (path, body) => { posts.push(body.args); return body.args.post ? { ok: true, update: { txid: 'ab'.repeat(32) } } : { ok: true, plan: { feeSats: 612 } }; } };
  const c = driven(api);
  await c.componentDidMount();
  assert.deepEqual([c.state.loaded, c.state.was], [true, { play: true, settlement: true, relay: true, custody: true }]);
  c.toggle('settlement', false);
  assert.deepEqual(changedOf(c.state.was, c.state.now), ['settlement']);
  assert.match(renderToStaticMarkup(c.render()), /1 change not saved/);
  await c.review();
  assert.deepEqual([c.state.step, c.state.plan.feeSats], ['review', 612]);
  assert.match(renderToStaticMarkup(c.render()), /Fee <b>612 sat<\/b>/);
  await c.confirm();
  assert.equal(c.state.step, 'sent');
  assert.deepEqual(posts, [{ roles: ['game', 'verify', 'relay'], custody: true, post: false }, { roles: ['game', 'verify', 'relay'], custody: true, post: true }]);
  const d = driven(api); await d.componentDidMount(); d.toggle('play', false); d.undo();
  assert.deepEqual(changedOf(d.state.was, d.state.now), []);
});

test('a node not in the census yet: no switches, the reason said; the seat refusing the change is shown', async () => {
  const html = renderToStaticMarkup(React.createElement(RolesPanel, { node: 'me', initial: { loaded: true, mine: null, was: {}, now: {} } }));
  assert.doesNotMatch(html, /id="rl-/); assert.match(html, /isn.{1,6}t in the census yet/);
  const c = driven({ get: async (p) => answers[p], signed: async () => ({}), post: async () => ({ ok: false, why: 'the bond wallet holds 200 sat' }) });
  await c.componentDidMount(); c.toggle('settlement', false); await c.review();
  assert.deepEqual([c.state.step, c.state.message], ['idle', 'the bond wallet holds 200 sat']);
  assert.deepEqual(askOf({ play: false, settlement: true, relay: false, custody: false }), { roles: ['settlement'], custody: false });
});

test('an unanswered /roles is not "not in the census": asked three times, then said, and Try again reads it (2026-10-22, guardian-6)', async () => {
  let calls = 0, down = true;
  const api = { get: async (p) => { if (p === '/roles') { calls++; if (down) throw new Error('502'); } return answers[p]; } };
  const c = new RolesPanel({ api, node: 'me', pause: async () => {} });
  c.setState = (u) => { Object.assign(c.state, typeof u === 'function' ? u(c.state) : u); };
  await c.componentDidMount();
  assert.deepEqual([calls, c.state.loaded, c.state.unread], [3, true, true]);
  const html = renderToStaticMarkup(c.render());
  assert.doesNotMatch(html, /not in the census/); assert.doesNotMatch(html, /class="tile/); assert.match(html, /Couldn.{1,6}t load the roles/); assert.match(html, />Try again</);
  down = false;
  await c.retry();
  assert.deepEqual([c.state.unread, c.state.was], [false, { play: true, settlement: true, relay: true, custody: true }]);
  assert.match(renderToStaticMarkup(c.render()), /class="tile on" id="tile-play"/);
});

test('a gateway that runs but holds no seat yet says Waiting, not Off (kanban #563, installer C 2026-10-21)', async () => {
  const api = { get: async (p) => ({ ...answers, '/gateway-claim': null })[p], signed: async (action) => ({ action }),
    post: async (path) => (path === '/owner/services' ? { ok: true, services: [{ id: 'gateway', running: true }] } : { ok: true }) };
  const c = driven(api);
  await c.componentDidMount();
  assert.equal(c.state.gatewayRuns, true);
  const html = renderToStaticMarkup(c.render());
  assert.match(html, /id="tile-gateway"[\s\S]*?<span class="pill wait">Waiting<\/span>/);
  assert.match(html, /takes its federation&#x27;s gateway seat once the federation is founded and its peg-in counts/);
  assert.match(html, />Manage →</);
});

// WHAT IT WAITS FOR (2026-10-26, the owner on "Waiting": "What is it waiting for??" - "Clarify what it is waiting for")
test('a waiting gateway names what it waits for: the founding with its count, then its peg-in\'s confirmations', async () => {
  const { gatewayWaitsFor } = await import('../dist/test/roles.mjs');
  assert.equal(gatewayWaitsFor({ founding: { waiting: true, ready: 3, needed: 10 } }), 'Waiting for its federation to be founded: 3 of 10 nodes ready. Then it pegs in and takes the gateway seat.');
  assert.equal(gatewayWaitsFor({ pegIn: { txid: 'e6'.repeat(32), confirmations: 37, needed: 100 } }), 'Waiting for its peg-in: 37 of 100 confirmations. Then it takes the gateway seat.');
  assert.match(gatewayWaitsFor({ pegIn: { txid: 'e6'.repeat(32), credited: true } }), /peg-in is credited/);
  const api = { get: async (p) => ({ ...answers, '/gateway-claim': null, '/setup-status': { ok: true, founding: { waiting: true, ready: 3, needed: 10 } } })[p], signed: async (action) => ({ action }),
    post: async (path) => (path === '/owner/services' ? { ok: true, services: [{ id: 'gateway', running: true }] } : { ok: true }) };
  const c = driven(api);
  await c.componentDidMount();
  assert.match(renderToStaticMarkup(c.render()), /id="tile-gateway"[\s\S]*?Waiting for its federation to be founded: 3 of 10 nodes ready/);
});
