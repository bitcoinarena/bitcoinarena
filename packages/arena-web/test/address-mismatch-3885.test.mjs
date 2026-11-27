// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3885: public_url in arena.conf differs from the advertisement - the Address card says so loudly and offers the update; Check my node
// names it on its second line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AddressPanel } from '../dist/test/address.mjs';
// 2.0: Check my node (#3798, ReachCheckPanel, GET /reach-probe) is not on this branch - its parts of this test stay on 1.9.

const OLD = 'https://op-node.tail1234.ts.net', NEW = 'https://arena.example.org';
const mm = { conf: NEW, installer: OLD, advertised: [OLD], confDiffers: true, censusDiffers: true, adoptable: true, quick: false, bonded: true };
const answer = { ok: true, mode: 'tailscale', url: OLD, stable: true, serving: NEW, modes: { tailscale: 'Funnel' }, follow: { censusRead: true, advertised: [OLD], bonded: true, mismatch: mm } };

test('the Address card says the difference and offers the update; asked, it posts { adopt: public_url }', async () => {
  const html = renderToStaticMarkup(React.createElement(AddressPanel, { initial: { loaded: true, answer } }));
  assert.match(html, /address and its advertisement differ/);
  assert.match(html, /public_url in arena\.conf is <code>https:\/\/arena\.example\.org<\/code>/);
  assert.match(html, /Post the advertisement update for https:\/\/arena\.example\.org/);
  // seen in the Chrome check: the installer's address in the census is not "this address" once public_url was edited; the census alone behind is no red box
  const named = renderToStaticMarkup(React.createElement(AddressPanel, { initial: { loaded: true, answer: { ...answer, follow: { ...answer.follow, censusNamesNew: true } } } }));
  assert.doesNotMatch(named, /The census names this address/);
  const behind = renderToStaticMarkup(React.createElement(AddressPanel, { initial: { loaded: true, answer: { ...answer, follow: { ...answer.follow, mismatch: { ...mm, confDiffers: false } } } } }));
  assert.doesNotMatch(behind, /address and its advertisement differ/);
  const quick = renderToStaticMarkup(React.createElement(AddressPanel, { initial: { loaded: true, answer: { ...answer, follow: { ...answer.follow, mismatch: { ...mm, adoptable: false, quick: true } } } } }));
  assert.doesNotMatch(quick, /Post the advertisement update/);
  assert.match(quick, /never put on chain/);
  const asked = [];
  const api = { signed: async (_a, args) => ({ args }), post: async (_p, b) => { asked.push(b.args); return { ...answer, follow: { ...answer.follow, mismatch: null } }; } };
  const c = new AddressPanel({ api, initial: { loaded: true, answer } }); c.setState = (u) => { Object.assign(c.state, typeof u === 'function' ? u(c.state) : u); };
  await c.adopt(NEW);
  assert.deepEqual(asked[0], { adopt: NEW });
  assert.equal(c.state.answer.follow.mismatch, null);
});
