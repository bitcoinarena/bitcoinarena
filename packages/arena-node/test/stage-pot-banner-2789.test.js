// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #2789 (the owner 2026-11-15, stage only): the pot warning on the stage /bounty/ page and the stage Feedback form, per threshold with a simulated
// pot - under 90 % nothing; from 90 % yellow "Only N sats left ..."; from 98 % also "X other reports are still waiting for review ..."; used up red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../../../src/website-stage/stage-2641/pot-banner.js', import.meta.url), 'utf8');
const arenaPotBanner = new Function(`${src}; return arenaPotBanner;`)();
const NEXT = Date.parse('2026-11-21T07:12:35Z');
const pot = (usedSats, extra = {}) => ({ season: 2, potSats: 100000, usedSats, leftSats: 100000 - usedSats, usedUp: false, nextSeasonMs: NEXT, pendingNew: 4, ...extra });

test('#2789 under 90 %: no banner', () => {
  assert.equal(arenaPotBanner(pot(5875)), null);
  assert.equal(arenaPotBanner(pot(89999)), null);
  assert.equal(arenaPotBanner(null), null);
  assert.equal(arenaPotBanner({ potSats: 0 }), null);
});

test('#2789 from 90 %: yellow, the sats left and the next season\'s start', () => {
  assert.deepEqual(arenaPotBanner(pot(90000)), { level: 'warn', lines: ["Only 10,000 sats left in this season's pot - once it is used up, nothing is paid until Season 3 starts."] });
  assert.equal(arenaPotBanner(pot(97999)).lines.length, 1, 'the waiting line only from 98 %');
});

test('#2789 from 98 %: also the reports still waiting for review', () => {
  assert.deepEqual(arenaPotBanner(pot(98000)).lines, ["Only 2,000 sats left in this season's pot - once it is used up, nothing is paid until Season 3 starts.",
    '4 other reports are still waiting for review, so the pot is probably full.']);
  assert.equal(arenaPotBanner(pot(99000, { pendingNew: 1 })).lines[1], '1 other report is still waiting for review, so the pot is probably full.');
  assert.equal(arenaPotBanner(pot(99000, { pendingNew: 0 })).lines.length, 1, 'none waiting: no second line');
});

test('#2789 used up: red, the used-up text', () => {
  assert.deepEqual(arenaPotBanner(pot(99900, { usedUp: true })), { level: 'full',
    lines: ["This season's bounty pot is used up. Reports are still welcome, but nothing is paid until Season 3 starts."] });
});

test('#2789 the faucet\'s season answer carries pendingNew (a number only)', () => {
  const f = readFileSync(new URL('../tools/faucet.mjs', import.meta.url), 'utf8');
  assert.match(f, /pendingNew: FEEDBACK\.countNew\(seasonEndMs\(p\.season - 1, S2_START_MS\) \?\? 0\)/);
});

test('#2789 the report store counts reports still new since a time', async () => {
  const { openFeedbackStore } = await import('../src/feedback-store.js');
  const st = openFeedbackStore();
  assert.equal(st.countNew(0), 0);
});
