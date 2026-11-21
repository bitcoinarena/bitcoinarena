// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2765 (feedback #066): the line under the loading bar said "Finding the nodes …" for as long as the player looked at the games chooser -
// 5 minutes and more, the nodes long found. While the chooser is open it says "Choose a game" (no loading line: the stall watch leaves it alone,
// ARENA_BOOT_STEP writes nothing over it), and once a game is chosen the step goes back to "Finding the nodes …", so the game's own steps follow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageFunction } from './page-script.js';

const PAGE = new URL('../../../src/arena-ui/index.html', import.meta.url);
const html = readFileSync(PAGE, 'utf8');
const SHOW = "          { const line = document.getElementById('stage'); if (line && line.textContent === 'Finding the nodes …') window.ArenaText.say(line, 'Choose a game'); }";
const HIDE = "        { const line = document.getElementById('stage'); if (line && line.textContent === 'Choose a game') window.ArenaText.say(line, 'Finding the nodes …'); }";

test('kanban #2765: the chooser line says "Choose a game", and the choice puts the loading step back', () => {
  const line = { textContent: 'Finding the nodes …' };
  const window = { ArenaText: { say: (el, t) => { el.textContent = t; } } };
  const document = { getElementById: (id) => (id === 'stage' ? line : null) };
  pageFunction(PAGE, ['window', 'document'], SHOW)(window, document);
  assert.equal(line.textContent, 'Choose a game');
  pageFunction(PAGE, ['window', 'document'], HIDE)(window, document);
  assert.equal(line.textContent, 'Finding the nodes …');
  // a later step stands when the chooser opened over another line (a game's own): nothing is written over it
  line.textContent = 'Reading the rounds …';
  pageFunction(PAGE, ['window', 'document'], SHOW)(window, document);
  assert.equal(line.textContent, 'Reading the rounds …');
});

test('kanban #2765: "Choose a game" is no loading line (the stall watch and ARENA_BOOT_STEP leave it), "Finding the nodes …" is', () => {
  const set = html.slice(html.indexOf('const LOADING_LINES = new Set(['), html.indexOf(']);', html.indexOf('const LOADING_LINES = new Set([')));
  assert.ok(set.includes("'Finding the nodes …'"));
  assert.ok(!set.includes('Choose a game'));
});
