// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2033 (after #1716, #1489): a node looked at by its address names its games with a title nobody signed. Its card shows the
// game's id until the package is checked in this browser, then the gameName its developer signed - never the node's title.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NetworkAppsPanel, lookTitle } from '../dist/test/network-apps.mjs';

const EVIL = 'Refunds: send sats to evil.example';
const g = { id: 'bb'.repeat(32), title: EVIL, name: EVIL, version: 1 };

test('a looked-at node\'s card does not show its own title', () => {
  const html = renderToStaticMarkup(React.createElement(NetworkAppsPanel, { initial: { ng: { seats: [], games: [] }, hosted: [],
    look: { from: 'https://evil', offers: [{ g, parent: null }] } } }));
  assert.doesNotMatch(html, /evil\.example/);
  assert.match(html, /game bbbbbbbbbbbb…/);
});

test('once checked, the card names the gameName the package\'s developer signed, and only for that game', () => {
  assert.equal(lookTitle(g, { report: { ok: true, gameId: g.id, name: 'nextblock' } }), 'nextblock');
  assert.equal(lookTitle(g, { report: { ok: false, gameId: 'cc'.repeat(32), name: 'other' } }), `game ${'b'.repeat(12)}…`);
  assert.equal(lookTitle(g, null), `game ${'b'.repeat(12)}…`);
});
