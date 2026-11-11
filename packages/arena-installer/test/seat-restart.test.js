// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SEAT READS WHAT ITS SETTINGS SAY (kanban #577, measured 2026-10-22 on the second machine): a quick tunnel's name comes after the seat has
// started, and with it a custody node's guardian and founding settings. Installer nodes 3-7 ran on the 15 settings they started with, no
// guardian, never drawn into a founding. The wizard restarts the seat - never its tunnel - when its settings changed after the start.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { seatNeedsRestart } from '../src/wizard.js';
import { mergeSeatConf } from '../src/state.js';
import { parseConf } from '../../arena-node/src/arena-conf.js';

// THE WRITE GOES THROUGH writeSeatConf (commit 662eedcd6, kanban #1442: "All three writers now go through state.js writeSeatConf -> mergeSeatConf:
// the file as it is, with the keys seatConf owns (SEAT_CONF_KEYS) set from the state"): the quick tunnel's rename writes the state the restart
// compares (`after` = seatConf({ ...s, port, bridgePort })), and the owner's own keys, which the rename does not touch, stay in the file.
const WRITE_AFTER = String.raw`writeSeatConf\(state, \{ \.\.\.s, port, bridgePort \}, \{ home: state\.home, release \}\);`;
const AFTER_IS = /after = seatConf\(\{ \.\.\.s, port, bridgePort \}, \{ home: state\.home, release \}\);/;

test('the seat restarts when its settings changed after it started, and only then', () => {
  const start = 'port=9500\nroles=verify,settlement,custody\n';
  const named = `${start}public_url=https://x.trycloudflare.com\nfounding=1\nfedimintd=/r/fedimintd\nguardian_endpoint=wss://x.trycloudflare.com/guardian\n`;
  assert.equal(seatNeedsRestart(start, named), true, 'the tunnel\'s name brought the custody settings');
  assert.equal(seatNeedsRestart(named, named), false, 'nothing changed: no restart');
});

test('the rename merged into a file the owner set keeps the owner\'s keys and still restarts the seat (kanban #1442 with #577)', () => {
  const start = 'port=9500\nroles=verify,settlement,custody\n';
  const named = `${start}public_url=https://x.trycloudflare.com\nfounding=1\n`;
  const file = `${start}auto_update=0\nduty_post=off\n`;   // what the owner set with bitcoinarena config set after the start
  const written = parseConf(mergeSeatConf(file, named)).values;
  assert.equal(written.public_url, 'https://x.trycloudflare.com', 'the tunnel\'s name reaches the file');
  assert.equal(written.founding, '1');
  assert.deepEqual([written.auto_update, written.duty_post], ['0', 'off'], 'the owner\'s settings stay');
  assert.equal(seatNeedsRestart(start, named), true, 'and the seat restarts on them');
});

test('the wizard restarts the seat alone after the quick tunnel\'s name is written', () => {
  const src = readFileSync(new URL('../src/wizard.js', import.meta.url), 'utf8');
  const at = src.indexOf("if (s.reach.mode === 'quick') {");
  const block = src.slice(at, src.indexOf('// workers.dev', at));
  assert.match(block, AFTER_IS);
  assert.match(block, new RegExp(WRITE_AFTER + String.raw`[\s\S]*if \(seatNeedsRestart\(before, after\)\) \{ (?:stage\('restart'\); )?const rs = await restartSeat\(state\.home\)`));
  assert.match(src, /restartSeat = \(home\) => control\('restart', 'node', \{ home \}\)/, 'the seat (node), not its tunnel');
});

test('an installer rerun with a new quick tunnel name reaches the gateway (kanban #818)', () => {
  const src = readFileSync(new URL('../src/wizard.js', import.meta.url), 'utf8');
  const at = src.indexOf("if (s.reach.mode === 'quick') {");
  const block = src.slice(at, src.indexOf('// workers.dev', at));
  assert.match(block, new RegExp(WRITE_AFTER + String.raw`[\s\S]*if \(s\.gateway\) \{ const f = await followTunnel\(state\.home\)`), 'after the settings took the new name');
  assert.match(src, /followTunnel = \(home\) => followTunnelNow\(\{ home \}\)/);
});
