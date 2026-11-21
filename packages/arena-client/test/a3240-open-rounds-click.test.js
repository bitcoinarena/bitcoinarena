// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3240 (feedback #377): in a game tile's "Open rounds" list a click on a round - its title, its tag, the row - did
// nothing (src/arena-ui/index.html window.ARENA_CHIP_LIST drew the rows with no handler). A click on a round's row now chooses
// the tile's game and joins that round from its lobby, as the lobby's PLAY joins it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const HTML = fs.readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
const START = HTML.indexOf("    (function () {\n      const pop = document.getElementById('arena-pop');");
const END = HTML.indexOf('    })();', START);
const CHIP_SRC = HTML.slice(START, END + '    })();'.length);
const GAME = 'ab'.repeat(32), RID = 'cd'.repeat(32), NOW = Date.now();

test('a3240: a click on a round in the Open rounds list chooses its game and joins that round', async () => {
  assert.ok(START > 0 && END > START, 'the chip code is found in index.html');
  const listeners = new Map(), cls = new Set();
  const mk = (name) => ({ name, querySelector: (s) => mk(s), addEventListener: (t, f) => listeners.set(name + ':' + t, f),
    classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c) } });
  const pop = mk('pop'), body = mk('.body'); body.children = [];
  pop.querySelector = (s) => (s === '.body' ? body : mk(s));
  const joined = [], chosen = [];
  const window = {
    ArenaText: { say() {} },
    ArenaChips: { draw(host, { blocks }) { host.children = blocks.map((b) => ({ parentNode: host, block: b })); } },
    ARENA_LOBBY_ACT: { join: (id) => { joined.push(id); return true; } },
    ARENA_LOBBY_ROWS: [{ id: RID, joinable: true }],
  };
  const ctx = vm.createContext({
    window, document: { getElementById: () => pop, addEventListener() {} }, ARENACLIENT: {}, console: { log() {}, warn() {} },
    fetch: async (u) => ({ ok: true, json: async () => (String(u).includes('/rounds') ? { nowMs: NOW, rounds: [{ id: RID, game: { id: GAME },
      startTime: new Date(NOW + 60000).toISOString(), endTime: new Date(NOW + 220000).toISOString(), stakeMsat: '100000', joined: 0 }] } : { nodes: [] }) }),
    setTimeout, AbortSignal, URL, Promise, Date, Math, Number, String, BigInt, Map, Set, Array, Object,
  });
  vm.runInContext(CHIP_SRC, ctx);
  const g = { nodes: ['https://seat.example/s1'], id: GAME, name: 'nextblock' };
  await window.ARENA_CHIP_LIST(g, 'rounds', (x) => chosen.push(x));
  const row = body.children.find((c) => c.block.row);
  assert.ok(row, 'the round is drawn as a row');
  const click = listeners.get('.body:click');
  assert.ok(click, 'the list listens for a click on its rows');
  click({ target: { closest: (s) => (s === '.row' ? row : null) } });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(chosen, [g], 'the tile\'s game is chosen');
  assert.deepEqual(joined, [RID], 'the clicked round is joined');
  assert.ok(!cls.has('show'), 'the list closes');
});
