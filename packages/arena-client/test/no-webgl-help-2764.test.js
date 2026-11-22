// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2764 (feedback #063): Next Block without WebGL said only Unity's words "Your browser does not support WebGL." - the page's fail() now
// says what to do (hardware acceleration, a current browser) and that the other games play without it; every other message is said as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageFunction } from './page-script.js';

const PAGE = new URL('../../../src/arena-ui/index.html', import.meta.url);
const html = readFileSync(PAGE, 'utf8');
const a = html.indexOf('    function fail(message) {');
const b = html.indexOf('\n    }\n', a) + 7;
const body = html.slice(a, b);

function said(message, refused = null) {
  const err = { classList: { add() {} } }, stage = {};
  const window = { ARENA_CLIENT_REFUSED: refused, ArenaText: { say: (el, t) => { el.text = t; } } };
  pageFunction(PAGE, ['window', 'err', 'stage', 'message'], body, 'fail(message);')(window, err, stage, message);
  return { err: err.text, stage: stage.text };
}

test('kanban #2764: no WebGL is said with what to do; other failures as before', () => {
  const w = said('Your browser does not support WebGL.');
  assert.match(w.err, /needs WebGL/);
  assert.match(w.err, /hardware acceleration/);
  assert.match(w.err, /Rock Paper Scissors and Bitcoin Up or Down play without WebGL/);
  assert.equal(w.stage, 'Could not start');
  assert.equal(said('the round is closed').err, 'the round is closed');
  assert.match(said('Your browser does not support WebGL.', 'hash 1234').err, /not the one the Arena pinned/);
});
