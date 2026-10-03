// /Dashboard (the owner 2026-10-01 15:44): the figures and the page every node serves. An empty store says nothing earned,
// every category present, the guardian third and the costs at 0 with the reason named; the page reads dashboard.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { dashboardData, dashboardHtml } from '../src/dashboard.js';

test('an empty node: every category and period is there, at 0, with 30 days of chart', () => {
  const d = dashboardData(new Round(openStore(), () => Date.UTC(2026, 9, 3, 12)), { nowMs: Date.UTC(2026, 9, 3, 12) });
  for (const p of ['day', 'month', 'year', 'owed'])
    for (const k of ['gameVerifyMsat', 'settlementMsat', 'guardianMsat', 'otherMsat', 'lightningCostMsat', 'gatewayCostMsat', 'profitMsat'])
      assert.equal(d.totals[p][k], '0', `${p}.${k}`);
  assert.equal(d.days.length, 30);
  assert.equal(d.days.at(-1).day, '2026-10-03');
  assert.equal(d.roundsChecked, 0);
  assert.match(d.notes.guardian, /guardian third/);
  assert.equal(typeof d.node, 'string');
});

test('the page draws dashboard.json and names every category', () => {
  const h = dashboardHtml();
  assert.match(h, /<title>Node Dashboard<\/title>/);
  assert.match(h, /fetch\('dashboard\.json'/);
  for (const n of ['Game/verify fee', 'Settlement fee', 'Guardian/custody fee', 'Other earnings', 'Lightning costs', 'Gateway costs', 'Absolute profit'])
    assert.ok(h.includes(n), n);
});
