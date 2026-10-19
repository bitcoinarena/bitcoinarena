// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AN ENTRY'S ITEMS REACH THE CORE'S START AS THEIR UNLOCKS: the seat maps each item the entry names to its game's
// catalogue unlock (core.items, plugins.js itemUnlocksOf) and the sandbox's driver hands them to start() - only when there are some, so
// a core that sells nothing is started exactly as before; an item the game does not sell is not replayed. The same in a warm ghost.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { replay, unlocksOf, RunInProgress, replayInWorker } from '../src/replay.js';
import { itemUnlocksOf } from '../src/plugins.js';

// a core whose state says what its start was handed: whether an options.items key came at all, and which unlocks
const src = `export const CORE = Object.freeze({
  name: 'unlock-probe', RUN_TICKS: 10, INPUT_WORDS: 5,
  start: (seed, config, o = {}) => ({ seed, t: 0, has: Object.prototype.hasOwnProperty.call(o, 'items'), items: (o.items || []).join(',') }),
  eventsOf: () => ({ count: { liquidations: 0, loads: 0, samples: 0, tapes: 0 }, before() {} }),
  step(st) { st.t++; },
  stateHash: (st) => 'h:' + st.has + ':' + st.items + ':' + st.t,
  result: (st) => ({ outcome: 'DELIVERED', score: st.items ? 100 + st.t : st.t, heat: 0 }),
  picture: (st) => ({ items: st.items, has: st.has }),
});`;
const file = join(mkdtempSync(join(tmpdir(), 'unlock-core-')), 'core.js');
writeFileSync(file, src);
const U = 'aa'.repeat(32), V = 'bb'.repeat(32);
const core = { name: 'unlock-probe', hash: createHash('sha256').update(src).digest('hex'), url: pathToFileURL(file).href,
  items: { 'large-truck': U, 'other': V } };
const TWO = { ticks: [{ tick: 0, words: [1, 2, 3, 4, 5] }, { tick: 1, words: [1, 2, 3, 4, 5] }] };

test('the catalogue\'s unlocks by item id; an entry\'s items in its order; none is []; an unsold item is refused', () => {
  assert.deepEqual(itemUnlocksOf({ manifest: { items: [{ id: 'large-truck', unlock: new Uint8Array(32).fill(0xaa) }] } }), { 'large-truck': U });
  assert.deepEqual(itemUnlocksOf({ manifest: {} }), {});
  assert.deepEqual(unlocksOf({ joinTick: 0 }, core), { ok: true, unlocks: [] });
  assert.deepEqual(unlocksOf({ items: [{ itemId: 'other' }, { itemId: 'large-truck' }] }, core), { ok: true, unlocks: [V, U] });
  const no = unlocksOf({ items: [{ itemId: 'wings' }] }, core);
  assert.equal(no.ok, false);
  assert.match(no.why, /item "wings", which the round's game does not sell/);
});

test('a replay hands the unlocks to start() only when the entry names items; the score and state follow them', () => {
  const plain = replay(TWO, { joinTick: 0 }, { core, seedWord: 7 });
  assert.equal(plain.ok, true, plain.why);
  assert.equal(plain.stateHash, 'h:false::2', 'an entry without items: start() gets no items key at all');
  assert.equal(plain.score, 2);
  const big = replay(TWO, { joinTick: 0, items: [{ itemId: 'large-truck' }] }, { core, seedWord: 7 });
  assert.equal(big.ok, true, big.why);
  assert.equal(big.stateHash, `h:true:${U}:2`);
  assert.equal(big.score, 102);
  const refused = replay(TWO, { joinTick: 0, items: [{ itemId: 'wings' }] }, { core, seedWord: 7 });
  assert.equal(refused.ok, false);
  assert.match(refused.why, /does not sell/);
  console.log('  FACTS:', JSON.stringify({ plain: plain.stateHash, big: big.stateHash, score: [plain.score, big.score], refused: refused.why }));
});

test('a warm ghost opens its run with the same unlocks', () => {
  const g = new RunInProgress({ joinTick: 0, items: [{ itemId: 'large-truck' }] }, { core, seedWord: 7 });
  assert.notEqual(g.ok, false, g.why);
  assert.deepEqual(g.s.call('pose', { id: g.id }), { items: U, has: true }, 'the warm run started with the unlock');
  const plain = new RunInProgress({ joinTick: 0 }, { core, seedWord: 7 });
  assert.notEqual(plain.ok, false, plain.why);
  assert.deepEqual(plain.s.call('pose', { id: plain.id }), { items: '', has: false });
  const bad = new RunInProgress({ joinTick: 0, items: [{ itemId: 'wings' }] }, { core, seedWord: 7 });
  assert.equal(bad.ok, false);
  assert.match(bad.why, /does not sell/);
});

// THE SEATS' OWN PATH (measured live 2026-10-16 05:50Z): a close replays in a worker (replayInWorker, the pool), and the
// core crossed to it without its catalogue - every committee seat held the truck entry 3de8e94c "plays with item "large-truck", which
// the round's game does not sell". The worker's replay of an entry with items equals the in-thread one.
test('in the worker too: the unlocks reach start() and the run is the in-thread one', async () => {
  const inThread = replay(TWO, { joinTick: 0, items: [{ itemId: 'large-truck' }] }, { core, seedWord: 7 });
  const inWorker = await replayInWorker(TWO, { joinTick: 0, items: [{ itemId: 'large-truck' }] }, { core, seedWord: 7 });
  assert.equal(inWorker.ok, true, inWorker.why);
  assert.equal(inWorker.stateHash, inThread.stateHash);
  assert.equal(inWorker.stateHash, `h:true:${U}:2`);
  const plain = await replayInWorker(TWO, { joinTick: 0 }, { core, seedWord: 7 });
  assert.equal(plain.stateHash, 'h:false::2', 'no items: as before');
});
