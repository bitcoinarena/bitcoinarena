// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE UPDATES SCREEN IN REACT (kanban #564): version, commit, protocols as ranges, the newest release or a new one, how to update; the
// page's badge told of a new release; a source checkout compares nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReleasePanel, protoRange, newRelease } from '../dist/test/release.mjs';

const v = { version: '2026.1.1', commit: '593de13e325790ae7852', protocols: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 19], update: 'arena-install --update <asset>',
  latest: { newer: true, latest: { version: '2026.1.2', release: 'https://github.com/x/releases/tag/v2026.1.2' } } };

test('the version, its protocols as ranges, a new release with its page; up to date; a source checkout', () => {
  assert.equal(protoRange(v.protocols), '1-16, 19');
  const html = renderToStaticMarkup(React.createElement(ReleasePanel, { initial: { loaded: true, version: v } }));
  assert.match(html, /2026\.1\.1/); assert.match(html, /593de13e3257/); assert.match(html, /1-16, 19/);
  assert.match(html, /A new release is available: 2026\.1\.2/); assert.match(html, /href="https:\/\/github\.com\/x\/releases\/tag\/v2026\.1\.2"/);
  const same = renderToStaticMarkup(React.createElement(ReleasePanel, { initial: { loaded: true, version: { ...v, latest: { newer: false, latest: { version: '2026.1.1' } } } } }));
  assert.match(same, /this node is up to date/);
  const src = { ...v, version: null };
  assert.match(renderToStaticMarkup(React.createElement(ReleasePanel, { initial: { loaded: true, version: src } })), /run from a source checkout/);
  assert.equal(newRelease(src), false, 'a checkout is never told of a new release');
});

test('read from the seat; the badge told of the new release', async () => {
  let told;
  const c = new ReleasePanel({ api: { get: async () => v }, onNewer: (x) => { told = x; } });
  c.setState = (u) => { Object.assign(c.state, typeof u === 'function' ? u(c.state) : u); };
  await c.componentDidMount();
  assert.deepEqual([c.state.loaded, told], [true, '2026.1.2']);
});
