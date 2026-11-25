// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// UP/DOWN READS EVERY VERSION (kanban #3674, feedback #461, live 2026-11-24 ~20:30Z-00:10Z): the day's tables were posted at v24
// (8e47d27f) while the seats already hosted v26 (f8df58ed); the tile opened v26 and the lobby read v26's rounds alone - "No window is
// open on these nodes right now" beside an open v24 window. v26 is v24 in every term but its client, so the v26 client trades a v24 round.
// The page's own code is run here: its everyVersion line and sameVersionPerSlot, taken from src/arena-ui/index.html.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
const V26 = 'f8'.repeat(32), V25 = '30'.repeat(32), V24 = '8e'.repeat(32);
const hex = (s) => Uint8Array.from(s.match(/../g).map((b) => parseInt(b, 16)));
const ARENACLIENT = { toHex: (u) => [...u].map((b) => b.toString(16).padStart(2, '0')).join('') };

// the line that sets ARENA_GAME_IDS for the chosen tile, run as the page runs it
function gameIdsFor(game) {
  const ev = html.match(/const everyVersion = [^;]+;/);
  const ids = html.match(/window\.ARENA_GAME_IDS = everyVersion [^;]+;/);
  assert.ok(ev && ids, 'index.html sets everyVersion and ARENA_GAME_IDS');
  const window = {};
  new Function('game', 'window', `${ev[0]}\n${ids[0]}`)(game, window);
  return window.ARENA_GAME_IDS;
}
// the page's sameVersionPerSlot, as written there
function sameVersionPerSlotFor(window) {
  const start = html.indexOf('function sameVersionPerSlot(rows, own) {');
  assert.ok(start > 0, 'index.html has sameVersionPerSlot');
  const end = html.indexOf('\n    }\n', start);
  return new Function('window', 'ARENACLIENT', `return (${html.slice(start, end + 6)})`)(window, ARENACLIENT);
}
// the lobby's draw: the chosen game's rows only, then one version per slot
function shownRows(game, rows) {
  const window = { ARENA_GAME_ID: game.id, ARENA_GAME_IDS: gameIdsFor(game) };
  const ids = new Set((window.ARENA_GAME_IDS || [window.ARENA_GAME_ID]).map((x) => String(x).toLowerCase()));
  const ofGame = rows.filter((r) => ids.has(String(r.game).toLowerCase()));
  return sameVersionPerSlotFor(window)(ofGame, game.id);   // the page calls it with the shown id (2.0 uses it)
}
const row = (gid, closeMs) => ({ id: `${gid.slice(0, 8)}-${closeMs}`, game: gid, entryCloseMs: closeMs, contract: { gameId: hex(gid) } });
const updown = { name: 'btc-updown-15m', id: V26, versions: [V26, V25, V24] };

test('#3674: a v26 tile with only v24 rounds in the window shows the v24 window', () => {
  const rows = [row(V24, 1795565700000), row(V24, 1795566600000)];
  assert.deepEqual(shownRows(updown, rows).map((r) => r.id), rows.map((r) => r.id));
});

test('#3674: a window that has the newest version shows only that one', () => {
  const rows = [row(V24, 1795565700000), row(V26, 1795565700000), row(V24, 1795566600000)];
  assert.deepEqual(shownRows(updown, rows).map((r) => r.game), [V26, V24]);
});

test('#3674: an order of an older listed version stays under My orders (market.orders)', () => {
  const line = html.split('\n').find((l) => /orders: \(\) => \{ marketViewLines\(\); return readPicks\(\)\.filter\(/.test(l));
  assert.ok(line, 'index.html has market.orders');
  assert.match(line, /ARENA_GAME_IDS/, 'market.orders keeps an order of any version the tile lists, not of game.id alone');
});
