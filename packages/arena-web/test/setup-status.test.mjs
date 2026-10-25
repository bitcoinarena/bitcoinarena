// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SETUP CARD ON BOTH DASHBOARDS (kanban #635; the owner 2026-10-25: "lnd status and everything else that may be in progress"): a row for
// each part under way, a problem marked and counted in the heading, "complete" when all are done.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SetupStatus } from '../dist/test/setup-status.mjs';

const card = (status) => renderToStaticMarkup(React.createElement(SetupStatus, { status: { ok: true, ...status } }));

test('every part under way, in words; a problem counted in the heading', () => {
  const html = card({ tip: 157559,
    address: { ok: false, url: 'https://n.example', why: 'ENOTFOUND' },
    faucet: { txid: 'fa'.repeat(32), sats: 52000, seen: true, confirmations: 2 },
    bond: { txid: 'b0'.repeat(32), sats: '50000', seen: true, confirmations: 0, confirmBy: 157700 },
    lnd: { ok: true, synced: true, height: 157559, channels: 1, pending: 1 },
    gateway: { ok: false, syncing: true, why: 'syncing' },
    updates: [{ what: 'the newest games and protocols in the advertisement', txid: '9a'.repeat(32), seen: true, confirmations: 3, needed: 6, counts: false }],
    oldBonds: [{ sats: '50000', maturity: 157600, blocksLeft: 41, back: false }] });
  assert.match(html, /<h3>Setup <span class="bad">1 needs attention<\/span><\/h3>/);
  assert.match(html, /id="setup-address"><span class="bad">!<\/span>[\s\S]*https:\/\/n\.example does not answer as your node \(ENOTFOUND\)/);
  assert.match(html, /Test coins<\/b> <span class="sub">52,000 sat arrived, 2 confirmations/);
  assert.match(html, /LND<\/b> <span class="sub">synced at block 157,559, 1 open channel, 1 opening/);
  assert.match(html, /Gateway<\/b> <span class="sub">waiting for LND to sync/);
  assert.match(html, /the newest games and protocols in the advertisement: 3 of 6 confirmations, in force at 6/);
  assert.match(html, /50,000 sat under your old key, locked for 41 more blocks \(until block 157,600\)/);
});

test('all done: complete; nothing to show: nothing', () => {
  const html = card({ address: { ok: true, url: 'https://n.example' }, lnd: { ok: true, synced: true, height: 1, channels: 2, pending: 0 }, gateway: { ok: true, federations: 1 } });
  assert.match(html, /<h3>Setup <span class="ok">complete<\/span><\/h3>/);
  assert.equal(card({}), '');
});
