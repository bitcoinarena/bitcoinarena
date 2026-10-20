// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE LOBBY ROW UNITY DRAWS, AS THE PAGE HANDS IT OVER (2026-10-06: "the lobby row must not read as if a
// round lasted 2 minutes"). index.html's lobbyViewRow is lifted out of the page by its text and run as it is. Each row
// carries startS - whole seconds until the round starts, 0 once it has started - and leftS, the seconds until its entry
// closes, both from the round's own times (not parsed back out of a text line). A row with no times says -1 for both.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageFunction } from './page-script.js';

const PAGE = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
const SRC = (() => {
  const at = PAGE.indexOf('      const lobbyViewRow = ');
  assert.ok(at > 0, 'index.html has no lobbyViewRow');
  return PAGE.slice(at, PAGE.indexOf('\n      };\n', at) + '\n      };\n'.length);
})();
const ARENACLIENT = { lobbyLine: (raw) => `line of ${raw.id}` };
const joinedOf = (line) => { const m = String(line).match(/(\d+) joined/); return m ? Number(m[1]) : 0; };
const lobbyViewRow = pageFunction(new URL('../../../src/arena-ui/index.html', import.meta.url), ['ARENACLIENT', 'joinedOf', 'window'], SRC, 'return lobbyViewRow;')(ARENACLIENT, joinedOf, {});   // window: the row's line reads the verified federation loads
const NOW = Date.UTC(2026, 9, 4, 11, 26, 15);
const raw = (startIn, closeIn, more) => ({ id: 'r1', phase: 'open', startTimeMs: NOW + startIn, entryCloseMs: NOW + closeIn, signerNodes: 7, ...more });
const row = (r, more) => ({ id: r.id, raw: r, free: false, signerNodesAgree: 7, needed: 5, join: true, stakeSats: '100', ...more });

test('a round not yet started: startS and leftS from its own times, whole seconds up', () => {
  const v = lobbyViewRow(row(raw(45000, 90000)), NOW);
  assert.deepEqual([v.startS, v.leftS, v.agree, v.needed, v.joinable, v.stakeSats], [45, 90, 7, 5, true, 100]);
  assert.equal(v.line, 'line of r1');
  assert.equal(lobbyViewRow(row(raw(44200, 89100)), NOW).startS, 45, 'a part second counts up, as the countdown shows it');
});

test('a started round (late join): startS 0, leftS still counts; an entry already closed is 0 and not joinable', () => {
  const late = lobbyViewRow(row(raw(-15000, 30000)), NOW);
  assert.deepEqual([late.startS, late.leftS, late.joinable], [0, 30, true]);
  const closed = lobbyViewRow(row(raw(-50000, -5000)), NOW);
  assert.deepEqual([closed.startS, closed.leftS, closed.joinable], [0, 0, false]);
});

test('a pending round has no entry countdown yet; a row without times gives -1 for both - no invented length', () => {
  const pending = lobbyViewRow(row(raw(120000, 165000, { phase: 'pending' })), NOW);
  assert.deepEqual([pending.startS, pending.leftS], [120, -1]);
  const bare = lobbyViewRow({ id: 'r2', line: 'old line', free: true, signerNodesAgree: 2, needed: 2, join: true }, NOW);
  assert.deepEqual([bare.startS, bare.leftS, bare.free, bare.line], [-1, -1, true, 'old line']);
});

test('each row carries its committee size (total) from the row\'s own signerNodes, -1 when the row does not say (follow-up)', () => {
  assert.equal(lobbyViewRow(row(raw(45000, 90000)), NOW).total, 7, 'a paid round of 7');
  assert.equal(lobbyViewRow(row(raw(45000, 90000, { signerNodes: 2 })), NOW).total, 2, 'a free pair of 2 - from the row, not a constant');
  const bare = lobbyViewRow({ id: 'r2', line: 'old line', free: true, signerNodesAgree: 2, needed: 2, join: true }, NOW);
  assert.equal(bare.total, -1);
});
