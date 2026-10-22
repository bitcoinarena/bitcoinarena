// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SEAT READS WHAT ITS SETTINGS SAY (kanban #577, measured 2026-10-22 on the second machine): a quick tunnel's name comes after the seat has
// started, and with it a custody node's guardian and founding settings. Installer nodes 3-7 ran on the 15 settings they started with, no
// guardian, never drawn into a founding. The wizard restarts the seat - never its tunnel - when its settings changed after the start.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { seatNeedsRestart } from '../src/wizard.js';

test('the seat restarts when its settings changed after it started, and only then', () => {
  const start = 'port=9500\nroles=verify,settlement,custody\n';
  const named = `${start}public_url=https://x.trycloudflare.com\nfounding=1\nfedimintd=/r/fedimintd\nguardian_endpoint=wss://x.trycloudflare.com/guardian\n`;
  assert.equal(seatNeedsRestart(start, named), true, 'the tunnel\'s name brought the custody settings');
  assert.equal(seatNeedsRestart(named, named), false, 'nothing changed: no restart');
});

test('the wizard restarts the seat alone after the quick tunnel\'s name is written', () => {
  const src = readFileSync(new URL('../src/wizard.js', import.meta.url), 'utf8');
  const at = src.indexOf("if (s.reach.mode === 'quick') {");
  const block = src.slice(at, src.indexOf('// workers.dev', at));
  assert.match(block, /state\.writeSecret\('arena\.conf', after\);[\s\S]*if \(seatNeedsRestart\(before, after\)\) \{ const rs = await restartSeat\(state\.home\)/);
  assert.match(src, /restartSeat = \(home\) => control\('restart', 'node', \{ home \}\)/, 'the seat (node), not its tunnel');
});
