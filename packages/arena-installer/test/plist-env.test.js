// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A LAUNCHD AGENT SAVED AGAIN, AND ITS OWN VARIABLES (kanban #574, 2026-10-22): the three test installers' agents were re-saved one value
// per line when FM_BLWP_FINALITY_DELAY=12 was added by hand; the updater read "no service names a release", and its rewrite dropped the
// variable. The release is read with whitespace between key and value, and the agent's variables are written again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { releaseOfPlist, envOfPlist } from '../src/update.js';
import { launchdPlist } from '../src/service.js';

const resaved = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
	<key>EnvironmentVariables</key>
	<dict>
		<key>FM_BLWP_FINALITY_DELAY</key>
		<string>12</string>
		<key>A_B</key>
		<string>x &amp; y</string>
	</dict>
	<key>Label</key>
	<string>io.bitcoin-arena.node</string>
	<key>RunAtLoad</key>
	<false/>
	<key>WorkingDirectory</key>
	<string>/Users/a/home/releases/arena-node-2026.1.1-darwin-arm64/packages/arena-node</string>
</dict>
</plist>`;

test('an agent saved one value per line: its release and its variables are read', () => {
  assert.equal(releaseOfPlist(resaved), '/Users/a/home/releases/arena-node-2026.1.1-darwin-arm64');
  assert.deepEqual(envOfPlist(resaved), { FM_BLWP_FINALITY_DELAY: '12', A_B: 'x & y' });
  assert.deepEqual(envOfPlist('<plist><dict><key>Label</key><string>x</string></dict></plist>'), {});
});

test('the agent written again keeps those variables, and one without any is written as before', () => {
  const again = launchdPlist({ node: '/n', release: '/Users/a/home/releases/arena-node-2026.1.2-darwin-arm64', home: '/Users/a/home', port: 8470, env: envOfPlist(resaved) });
  assert.deepEqual(envOfPlist(again), { FM_BLWP_FINALITY_DELAY: '12', A_B: 'x & y' });
  assert.equal(releaseOfPlist(again), '/Users/a/home/releases/arena-node-2026.1.2-darwin-arm64');
  const plain = launchdPlist({ node: '/n', release: '/r', home: '/h', port: 8470 });
  assert.doesNotMatch(plain, /EnvironmentVariables/);
  assert.equal(plain, launchdPlist({ node: '/n', release: '/r', home: '/h', port: 8470, env: {} }));
});
