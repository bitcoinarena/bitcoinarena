// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE GAME STAYS IN THE ADDRESS (measured on live UI 136 03:37Z): PLAY on a Tick Tock round ahead wrote the round's
// link without game=, and a reload - holding the join to its start on the bare path - came up on the game chooser, Unity not
// loaded. index.html's gameOnly and withGame are lifted out of the page by their text and run under a stand-in location; the
// round address (PLAY) and the held link's lobby address must use them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageFunction } from './page-script.js';

const URL_ = new URL('../../../src/arena-ui/index.html', import.meta.url);
const PAGE = readFileSync(URL_, 'utf8');
const line = (head) => { const at = PAGE.indexOf(head); assert.ok(at > 0, `index.html has no ${head}`); return PAGE.slice(at, PAGE.indexOf('\n', at) + 1); };
const at = (search) => pageFunction(URL_, ['location'], [line('    function gameOnly() '), line('    function withGame(search) ')], 'return { gameOnly, withGame };')({ search });

test('on a game\'s lobby the round address keeps game=; without one, and when it already names one, it is as it was', () => {
  const on = at('?game=nextblock');
  assert.equal(on.gameOnly(), '?game=nextblock');
  assert.equal(on.withGame('?node=a&round=ab&play=1'), '?node=a&round=ab&play=1&game=nextblock');
  assert.equal(on.withGame('?game=rps&round=ab'), '?game=rps&round=ab', 'a game it names is kept');
  assert.equal(on.withGame(''), '?game=nextblock');
  const off = at('');
  assert.equal(off.gameOnly(), '');
  assert.equal(off.withGame('?node=a&round=ab&play=1'), '?node=a&round=ab&play=1');
  assert.equal(at('?node=x&round=ab&play=1&game=btc%20updown').gameOnly(), '?game=btc%20updown', 'an id or name with odd characters, encoded');
});

test('PLAY writes the round address with the game, and every way back to the lobby from a round link keeps it', () => {
  assert.match(PAGE, /history\.replaceState\(null, '', location\.pathname \+ withGame\(r\.join \+ '&play=1'\)\);/);
  const held = PAGE.slice(PAGE.indexOf('async function heldRoundLink()'), PAGE.indexOf('const joinOrBackToTheLobby'));
  assert.match(held, /history\.replaceState\(null, '', location\.pathname \+ gameOnly\(\)\);/, 'the held link\'s lobby keeps the game');
  assert.doesNotMatch(held, /history\.replaceState\(null, '', location\.pathname\);/, 'no bare path in the held link');
  const after = PAGE.slice(PAGE.indexOf('const joinOrBackToTheLobby'), PAGE.indexOf('const joinOrBackToTheLobby') + 4000);
  assert.doesNotMatch(after, /history\.replaceState\(null, '', location\.pathname\);/, 'no bare path on the way back from a refused link');
});

test('a round link held to its start tells Unity not to drive on its play=1; any other outcome tells it to drive', () => {
  const held = PAGE.slice(PAGE.indexOf('async function heldRoundLink()'), PAGE.indexOf('const joinOrBackToTheLobby'));
  const hold = held.indexOf("window.ARENA_LINK_AUTOPLAY = false;");
  assert.ok(hold > held.indexOf('if (!(startMs - Date.now() > 5000)) return false;'), 'held: no drive, once the round is known to be ahead');
  assert.ok(hold < held.indexOf('ARENA_LOBBY_ACT.join(id'), '... before the lobby\'s join writes play=1 into the address again');
  const init = /window\.ARENA_LINK_AUTOPLAY = (.+) \? null : true;/.exec(PAGE);
  assert.ok(init, 'undecided while the address names a round with play=1');
  const undecided = new Function('location', `return ${init[1]};`);
  assert.equal(undecided({ search: '?node=a&round=ab&play=1&game=nextblock' }), true);
  assert.equal(undecided({ search: '?game=nextblock' }), false);
  assert.equal(undecided({ search: '?round=ab&play=10' }), false);
  const after = PAGE.slice(PAGE.indexOf('const joinOrBackToTheLobby'), PAGE.indexOf('const joinOrBackToTheLobby') + 600);
  assert.match(after, /window\.ARENA_LINK_AUTOPLAY = !held;\n {6}if \(held\) return;/, 'decided as soon as the link is held or not');
  const jslib = readFileSync(new URL('../../nextblock/unity/Assets/Plugins/WebGL/arena.jslib', import.meta.url), 'utf8');
  assert.match(jslib, /ArenaLinkAutoPlay: function \(\) \{\n {4}var v = window\.ARENA_LINK_AUTOPLAY;\n {4}return v === null \? -1 : v === false \? 0 : v === true \? 1 : 2;/);
});
