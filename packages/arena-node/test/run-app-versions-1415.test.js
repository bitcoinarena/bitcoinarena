// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1415 (release gate VM 2026-11-10): a node updated from 2026.1.9.26 by its own updater kept apps= at nextblock v1-v6; the seat's
// start (run.js) now adds the release's registrations of the apps it already runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withReleaseAppVersions } from '../src/app-fetch.js';

const R = '/home/o/.bitcoinarena/releases/bitcoin-arena-node-2026.1.9.27-linux-arm64/packages';
const nb = (v) => `${R}/nextblock/plugin/nextblock${v === 1 ? '' : '-v' + v}.js`, rps = (v) => `${R}/rock-paper-scissors/plugin/rock-paper-scissors${v === 1 ? '' : '-v' + v}.js`;
const apps = [{ id: 'nextblock', registrations: [1, 2, 3, 4, 5, 6, 7].map(nb) }, { id: 'rps', registrations: [1, 2].map(rps) }, { id: 'updown', registrations: [`${R}/btc-updown/plugin/btc-updown.js`] }];

test('#1415 the seat start adds nextblock-v7.js to an apps= of v1-v6, keeps an app the owner left out out, adds nothing twice', () => {
  const r = withReleaseAppVersions([1, 2, 3, 4, 5, 6].map(nb).join(','), apps);
  console.log('  MEASURED #1415 run.js added:', r.added.map((f) => f.split('/').pop()).join(' '));
  assert.deepEqual(r.added, [nb(7)]);
  assert.equal(r.value, [1, 2, 3, 4, 5, 6, 7].map(nb).join(','));
  assert.ok(!r.value.includes('btc-updown') && !r.value.includes('rock-paper'), 'apps the owner did not list stay out');
  assert.deepEqual(withReleaseAppVersions(r.value, apps).added, [], 'a second start adds nothing');
  assert.deepEqual(withReleaseAppVersions('', apps), { value: '', added: [] });
  const win = withReleaseAppVersions('C:\\Users\\John Doe\\a\\packages\\nextblock\\plugin\\nextblock.js', [{ registrations: ['C:\\Users\\John Doe\\a\\packages\\nextblock\\plugin\\nextblock-v2.js'] }]);
  assert.equal(win.added.length, 1, 'Windows paths, a space in the home');
});
