// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE INSTALLER'S MINIMUM BOND (install-minimum.js, kanban #543, spec §23A.3a): asked of two seats' GET /capacity, the larger when they
// differ, the floor by name when none answers; the wizard's deposit asks for it and its bond is never below it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installMinimum } from '../src/install-minimum.js';
import { depositParts, bondMinimumOf } from '../src/wizard.js';

const answer = (sats, band = 'PRESSURE') => ({ status: 200, json: async () => ({ network: { installMinimumBondSats: String(sats), band } }) });

test('two seats answer: the larger of their minimums; a seat that says nothing is skipped', async () => {
  const asked = [];
  const fetcher = async (url) => { asked.push(url); if (url.startsWith('https://a')) throw new Error('down');
    return url.startsWith('https://b') ? answer(120000) : answer(110000); };
  const m = await installMinimum({ seats: ['https://a/guardian-1', 'https://b/guardian-2/', 'https://c/fed2-1', 'https://d/guardian-3'], fetcher });
  assert.equal(m.sats, 120000);
  assert.deepEqual(m.from, ['https://b/guardian-2/', 'https://c/fed2-1']);
  assert.deepEqual(asked, ['https://a/guardian-1/capacity', 'https://b/guardian-2/capacity', 'https://c/fed2-1/capacity'], 'two answers, then no more asking');
  assert.match(m.why, /the network's bond target \(band PRESSURE\): 120000 sat/);
});

test('no seat answers /capacity (a seat before #543): the floor, said by name; never below the floor', async () => {
  const none = await installMinimum({ seats: ['https://x', 'https://y'], fetcher: async () => ({ status: 404, json: async () => ({}) }) });
  assert.deepEqual([none.sats, none.from.length], [50000, 0]);
  assert.match(none.why, /no seat answered GET \/capacity: the floor, 50000 sat/);
  const low = await installMinimum({ seats: ['https://x', 'https://y'], fetcher: async () => answer(30000, 'CALM') });
  assert.equal(low.sats, 50000);
});

test('the wizard\'s deposit asks for the minimum the seats said', () => {
  assert.equal(depositParts({ roles: [] }, 0).bond, 50000);
  const s = { roles: [], bondMinimum: { sats: 120000 } };
  assert.equal(bondMinimumOf(s), 120000);
  assert.equal(depositParts(s, 0).bond, 120000);
  assert.equal(bondMinimumOf({ bondMinimum: { sats: 10 } }), 50000, 'never below the floor');
});

// ONLY UNDER PRESSURE (the installer walk of fd47329c: 36,570,000 sat asked at band CALM)
test('a CALM network asks the floor, whatever its target; a pressed one its target', async () => {
  const calm = await installMinimum({ seats: ['https://a', 'https://b'], fetcher: async () => answer(36570000, 'CALM') });
  assert.equal(calm.sats, 50000);
  assert.match(calm.why, /the network is CALM \(its bond target, 36570000 sat, applies under capacity pressure\)/);
  const pressed = await installMinimum({ seats: ['https://a', 'https://b'], fetcher: async (u) => answer(u.startsWith('https://a') ? 260000 : 250000, u.startsWith('https://a') ? 'PRESSURE' : 'CALM') });
  assert.equal(pressed.sats, 260000, 'the pressed seat\'s target');
});
