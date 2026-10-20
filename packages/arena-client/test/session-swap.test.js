// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A JOIN OF ANOTHER ROUND CLOSES THE SESSION ON THE ONE BEFORE (2026-09-18 18:00).
//
// Measured in two real browsers: pressing PLAY again joined the next round at the page's level - both tabs on one
// round id, each with a client and a ghost field - while the bridge kept the session of the round before, because
// that client had never said it was `over`. It sat in "opening", `net.where` went on naming the FIRST round three and
// a half minutes later, and it kept publishing into a run that had already ended: 902 ticks of it. Neither tab was in
// the second round at all, which is why neither was ever shown the other, and that is the owner's 12:02 shot.
//
// `arena.jslib` is the one file these suites cannot import - it is Emscripten glue, not a module - so what is checked
// here is the same thing the ghost rules check: that the rule is written in it, and that every ARENACLIENT function it
// leans on is actually exported by the bundle the page loads. A guard that calls an undefined function would throw in
// the browser and nowhere else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../../../', import.meta.url).pathname;
const jslib = readFileSync(root + 'unity-proto/Assets/Plugins/WebGL/arena.jslib', 'utf8');
const bundle = readFileSync(root + 'packages/arena-client/dist/arena-client.js', 'utf8');

test('the bridge closes a session whose round is not the one the page has joined', () => {
  // THE COMPARISON: the round the session is bound to against the round the page now names.
  assert.match(jslib, /Module\.blwpNet\.where && Module\.blwpNet\.where\.roundId/,
    'the bridge does not read which round its session is bound to');
  assert.match(jslib, /ARENACLIENT\.roundId\(window\.BLWP_ROUND\)/,
    'the bridge does not read which round the page has joined');
  // AND THE TEARDOWN, not a wait for a word that never comes.
  assert.match(jslib, /was\.close\(\)/, 'the bridge never closes the old client');
  assert.match(jslib, /Module\.blwpNet\.client = null/, 'the bridge keeps the old client after closing it');
  // AND THE SAME ROUND IS STILL LEFT ALONE: a slow session on the round being played is not torn down.
  assert.match(jslib, /if \(!was \|\| !was\.over\) return 1;\s+\/\/ already running, on this same round/,
    'the bridge no longer keeps a live session on the round it is already playing');
});

test('every client function that teardown leans on is exported by the bundle the page loads', () => {
  for (const name of ['roundId', 'toHex']) {
    assert.match(bundle, new RegExp(`${name}:\\s*${name}`),
      `ARENACLIENT.${name} is not exported, so the bridge's teardown would throw in a browser`);
  }
});
