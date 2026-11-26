// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AUDIT hosting a8-1-2 (P4/P5, seam opened by #3557/#3389): since #3557 EVERY hosted game's core thread runs in ONE shared child
// process (core-runner.js, started once by the seat's core supervisor). The per-core guards are per-ISOLATE: HEAP_LIMITS bounds one
// thread's V8 heap and the backstop (RSS_BACKSTOP, sampled every 2 ms) ends one thread by its own isolate's growth. But a V8
// FatalProcessOutOfMemory - a large/fast allocation in one core's thread (a Map/Array/Object grown in a loop) - aborts the whole
// PROCESS (SIGABRT, exit 134), as #3067/#3386 showed for the COMPILE. #3389 moved the compile to its own child but left RUN-time
// cores sharing one process ("decide whether running cores move to the child as well" was deferred). So one malicious core that
// aborts the shared process takes down every OTHER game's in-flight core call with it.
//
// Reachable by a game developer whose core PASSES the trial: a replay (CORE) game's trial (plugin-trial.js trialRunLength) only
// calls runTicks and runTicksFits - it NEVER runs start/step/result. A core that allocates to death inside step() is therefore
// never exercised by the trial, yet runs on every seat that replays one of its rounds (replay.js -> the 'replay' driver op).
//
// Safe behaviour: a malicious core's memory abuse ends that core's own call alone; a co-tenant honest game's core, mid-call in the
// same process, keeps answering (its own isolate limits applied to IT, never a shared-process abort).
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCore } from '../src/core-sandbox.js';

const load = (src, o = {}) => loadCore({ files: new Map([['core.mjs', src]]), entry: 'core.mjs' }, o);

// An honest tick game (Next Block-shaped): its warm ghost is kept and posed between the attacker's calls.
const HONEST = `export const CORE = { name: 'honest', RUN_TICKS: 10, INPUT_WORDS: 5, start: () => ({ t: 0 }),
  eventsOf: () => ({ count: {}, before() {} }), step(st) { st.t++; }, picture: (st) => ({ x: st.t, z: 0, heading: 0 }),
  stateHash: (st) => 'h' + st.t, result: (st) => ({ outcome: 'DELIVERED', score: st.t, heat: 0 }) };
export const DECIDE = { name: 'honest', decide(m) { const o = {}; for (const x of m) o[x.key] = 'DRAW'; return o; } };`;

// A malicious tick game whose runTicks/runTicksFits (all the trial exercises) are benign, but whose step() grows a Map without
// bound on one chosen input word. Passes trialRunLength; crashes at the seat's replay of a round whose words reach that input.
const BOMB = `export const CORE = { name: 'bomb', RUN_TICKS: 10, INPUT_WORDS: 5, runTicks: () => 10, runTicksFits: (t) => t >= 1 && t <= 10,
  start: () => ({ t: 0 }), eventsOf: () => ({ count: {}, before() {} }),
  step(st, w) { st.t++; if (w === 1) { const m = new Map(); for (let i = 0; i < 1e9; i++) m.set(i, i); st.n = m.size; } },
  picture: (st) => ({ x: st.t, z: 0, heading: 0 }), stateHash: (st) => 'h' + st.t, result: (st) => ({ outcome: 'DELIVERED', score: st.t, heat: 0 }) };`;

test('audit hosting a8-1-2: one hosted game\'s core that aborts the shared core process does not kill a co-tenant game\'s in-flight core call', () => {
  // an honest game hosted and replaying: its warm ghost kept in the shared process
  const honest = load(HONEST);
  const id = honest.call('open', { seedWord: 1, config: {}, runTicks: 10 });
  assert.ok(honest.call('pose', { id }), 'the honest game answers before the attack');

  // the attacker game's trial covers only runTicks/runTicksFits (both benign), so it is hosted
  const bomb = load(BOMB);
  assert.equal(bomb.call('runTicks', { config: {} }), 10);
  assert.equal(bomb.call('runTicksFits', { ticks: 5 }), true);

  // now a seat replays one of the attacker's rounds (the 'replay' driver op): the word 1 reaches step()
  let bombWhy = null;
  try { bomb.call('replay', { seedWord: 1, config: {}, runTicks: 10, start: 0, words: [0, 1], marks: [], pictures: [] }); }
  catch (e) { bombWhy = e.message; }
  console.log(`a8-1-2 attacker replay: ${bombWhy}`);
  assert.ok(bombWhy, 'the attacker core failed (its own call)');

  // SAFE: the honest co-tenant game, whose core shares the process, still answers. On BASE its thread died with the
  // shared process (exit 134), so this call throws "the core process ended": its honest rounds stop until a reload.
  let honestWhy = null;
  try { assert.ok(honest.call('pose', { id })); } catch (e) { honestWhy = e.message; }
  console.log(`a8-1-2 honest co-tenant after the attack: ${honestWhy || 'still answering'}`);
  honest.end(); bomb.end();
  assert.equal(honestWhy, null,
    'a co-tenant honest game\'s core was killed by another game\'s shared-process abort (#3557/#3389 run-time seam)');
});
