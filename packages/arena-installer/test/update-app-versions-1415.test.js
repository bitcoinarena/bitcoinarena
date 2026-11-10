// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1415: an update adds the new release's versions of the apps the node runs (Daniel's node on 2026.1.9.26 listed nextblock v1-v6, the release shipped v7)
import test from 'node:test';
import assert from 'node:assert/strict';
import { withNewAppVersions } from '../src/update.js';

const R = '/home/o/.arena-node/releases/arena-node-2026.1.9.26-darwin-arm64';
const nb = (v) => `${R}/packages/nextblock/plugin/nextblock${v === 1 ? '' : '-v' + v}.js`;
const rps = (v) => `${R}/packages/rock-paper-scissors/plugin/rock-paper-scissors${v === 1 ? '' : '-v' + v}.js`;
const updown = `${R}/packages/btc-updown/plugin/btc-updown.js`;

test('#1415 the release\'s nextblock-v7.js joins apps= after v1-v6; an app the owner left out stays out; other lines untouched', () => {
  const conf = ['# the app plugins the seat loads', `apps=${[1, 2, 3, 4, 5, 6].map(nb).join(',')},${rps(1)}`, 'port=8770', ''].join('\n');
  const want = [...[1, 2, 3, 4, 5, 6, 7].map(nb), updown, rps(1), rps(2)].join(',');
  const out = withNewAppVersions(conf, R, want);
  const apps = /^apps=(.*)$/m.exec(out)[1].split(',');
  console.log('  MEASURED #1415 apps added:', apps.filter((a) => !conf.includes(a)).map((a) => a.split('/').pop()).join(' '));
  assert.deepEqual(apps, [...[1, 2, 3, 4, 5, 6].map(nb), rps(1), nb(7), rps(2)]);
  assert.ok(!out.includes('btc-updown'), 'an app not in apps= is not added');
  assert.match(out, /^port=8770$/m);
  assert.equal(withNewAppVersions(out, R, want), out, 'a second update adds nothing');
});

test('#1415 a Windows conf keeps its CRLF; a conf without apps= is left alone', () => {
  const conf = `apps=${nb(1)}\r\nport=1\r\n`;
  assert.equal(withNewAppVersions(conf, R, [nb(1), nb(2)].join(',')), `apps=${nb(1)},${nb(2)}\r\nport=1\r\n`);
  assert.equal(withNewAppVersions('port=1\n', R, nb(1)), 'port=1\n');
});
