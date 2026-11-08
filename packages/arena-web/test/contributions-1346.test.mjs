// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// CONTRIBUTION AGREEMENTS ON THE OWNER PAGE AND THE EXPLORER (spec §27A.4.2, kanban #1346): the share paid now, each tranche with its live numbers,
// the attribution, identities and gross per site key, a leave or a termination - and the explorer's section from the seats' answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ContributionCard } from '../dist/test/contributions.mjs';
import { Metrics } from '../dist/test/explorer.mjs';

const site = '03' + 'ab'.repeat(32);
const a = { recipient: '02' + 'cd'.repeat(32), label: 'Marketing', shareBps: 500, vestedBps: 500, state: 'tail', ends: { leftAt: 410, terminatedAt: null },
  tranches: [{ milestone: 'first-paid', bps: 250, metAt: 301, vestedAt: 301 }, { milestone: 'retention', bps: 250, metAt: 312, vestedAt: 312 },
    { milestone: 'gross-share', bps: 250, metAt: null, vestedAt: null }, { milestone: 'new-share', bps: 250, metAt: null, vestedAt: null }],
  progress: { scale: { t1Identities: 3, t2Retained: 2, retentionBlocks: 6, t3GrossBps: 2000, t3WindowBlocks: 12, t4NewBps: 3000, t4Windows: 3, t4WindowBlocks: 6 },
    t1: { have: 3, need: 3 }, t2: { have: 2, need: 2, afterBlocks: 6 }, attribution: { bps: 10000, floorBps: 3000, windowBlocks: 12960 },
    sites: [{ siteKey: site, identities: 3, grossMsat: '50000000' }] },
  agreement: { startHeight: 0, siteKeys: [site], base: { targetBps: 250, cliffBlocks: 1000000, days: 730 }, tranches: [], attributionFloorBps: 3000, tailBlocks: 20 } };

test('the owner page\'s card: the share now, each tranche vested or not with its numbers, the site key, the leave', () => {
  const h = renderToStaticMarkup(React.createElement(ContributionCard, { a, height: 415 }));
  assert.match(h, /<span>Paid now<\/span><b>5 % of the developers&#x27; set/);
  assert.match(h, /left - the vested part pays through the tail/);
  assert.match(h, /<span>Left at block<\/span><b>410<\/b>/);
  assert.match(h, /vested at block 301.*3 of 3 new identities whose first paid entry came through his links/);
  assert.match(h, /vested at block 312.*2 of 2 of them back at least 6 blocks after their first/);
  assert.match(h, /not met yet/);
  assert.match(h, /3 identities · 50,000 sat gross/);
  assert.match(h, /<span>Tail after a leave<\/span><b>20 blocks<\/b>/);
});

test('the explorer\'s metrics: each agreement with how many nodes name its share', () => {
  const data = { volume: [], reserve: { msat: '0', federations: [] }, referral: { msat: '0', sites: [] }, readAt: new Date().toISOString(), seats: { reserves: 7, referral: 7, of: 7 },
    contributions: { answered: 7, of: 7, agreements: [{ ...a, height: 415, agreeing: 7, answered: 7 }] } };
  const h = renderToStaticMarkup(React.createElement(Metrics, { data }));
  assert.match(h, /<h2>Contribution agreements <span class="dim">7 of 7 nodes answered<\/span><\/h2>/);
  assert.match(h, /7 of 7 nodes name this share/);
  assert.match(h, /vested at block 301/);
});
