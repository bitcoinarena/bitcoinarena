// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3556 (RCE audit #3552, medium): A CORE THAT SPINS ON CHOSEN INPUTS DOES NOT HOLD THE SEAT'S THREAD. core-sandbox.js waited for
// every core call with Atomics.wait in the calling thread: a registered game whose decide, stepTo or runTicksFits spins only on chosen
// inputs (so it passes the install trial) held the seat's own thread - which signs, serves rounds and answers peers - ASK_MS (2 s) per
// decide, STEP_MS (30 s) per warm-ghost step and ASK_MS per new run length at POST /round, again and again. The PoC measured 10 s.
// Now decide and the run length are waited for without blocking (Atomics.waitAsync), and the warm ghost - which must answer in the
// seat's thread - has a short deadline and is refused after KEPT_MISSES_MAX misses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import * as sandbox from '../src/core-sandbox.js';
import * as verify from '../src/verify.js';
import * as plugins from '../src/plugins.js';
import { headToHeadResults } from '../../arena-protocol/src/head-to-head.js';

const DIR = mkdtempSync(join(tmpdir(), 'core-main-3556-'));
let n = 0;
function coreOf(src) {
  const file = join(DIR, `core-${++n}.mjs`);
  writeFileSync(file, src);
  return { name: `spin ${n}`, hash: createHash('sha256').update(src).digest('hex'), url: pathToFileURL(file).href };
}

/** The longest the seat's event loop went without a turn while `run` ran (a 5 ms ticker). */
async function heldWhile(run) {
  let last = performance.now(), worst = 0;
  const tick = setInterval(() => { const t = performance.now(); worst = Math.max(worst, t - last); last = t; }, 5);
  let why = null, value;
  try { value = await run(); } catch (e) { why = e.message; }
  await new Promise((r) => setTimeout(r, 20));
  clearInterval(tick);
  worst = Math.max(worst, performance.now() - last);
  return { worst, why, value };
}

const SPIN_DECIDE = `export const DECIDE = { name: 'spin-on-7', decide(moves) {
  if (moves.some((m) => m.move === 7)) { let i = 1; while (i > 0) i++; }
  const out = {}; for (const m of moves) out[m.key] = 'DRAW'; return out; } };`;

test('#3556: a decide that spins on a chosen move does not hold the seat\'s thread (the close is decided without blocking)', async () => {
  const box = sandbox.sandboxFor(coreOf(SPIN_DECIDE));
  const list = [{ key: 'ab'.repeat(32), move: 7 }, { key: 'cd'.repeat(32), move: 1 }];
  // what verify.js's head-to-head close runs (before #3556 it had only the synchronous form)
  const close = verify.headToHeadResultsAsync
    ? () => verify.headToHeadResultsAsync(list, (moves, config) => box.callAsync('decide', { moves, config }), {}, { players: 2 })
    : async () => headToHeadResults(list, (moves, config) => box.call('decide', { moves, config }), {}, { players: 2 });
  const r = await heldWhile(close);
  console.log(`#3556 spinning decide: ${r.why}; the seat's thread went ${r.worst.toFixed(0)} ms without a turn`);
  assert.match(String(r.why), /did not stop within/);
  assert.ok(r.worst < 300, `the seat's thread was held ${r.worst.toFixed(0)} ms by one decide`);
  // an honest move list is decided the same way as ever, and gives the synchronous answer
  const fair = [{ key: 'ab'.repeat(32), move: 1 }, { key: 'cd'.repeat(32), move: 2 }];
  const sync = headToHeadResults(fair, (moves, config) => box.call('decide', { moves, config }), {}, { players: 2 });
  if (verify.headToHeadResultsAsync)
    assert.deepEqual(await verify.headToHeadResultsAsync(fair, (moves, config) => box.callAsync('decide', { moves, config }), {}, { players: 2 }), sync);
});

const SPIN_FITS = `export const CORE = { name: 'spin-fits', RUN_TICKS: 600, INPUT_WORDS: 5,
  runTicksFits(t) { if (t === 77) { let i = 1; while (i > 0) i++; } return t >= 1 && t <= 600; },
  start: () => ({ t: 0 }), eventsOf: () => ({ count: {}, before() {} }), step(st) { st.t++; }, stateHash: (st) => 'h' + st.t,
  result: (st) => ({ outcome: 'DELIVERED', score: st.t, heat: 0 }) };`;

test('#3556: a runTicksFits that spins on a chosen run length does not hold the seat\'s thread at POST /round', async () => {
  const core = coreOf(SPIN_FITS);
  const ask = plugins.runLengthFitsAsync
    ? () => plugins.runLengthFitsAsync(core, {}, 77)
    : async () => plugins.runLengthFits(core, {}, 77);
  const r = await heldWhile(ask);
  console.log(`#3556 spinning runTicksFits: ${JSON.stringify(r.value)}; the seat's thread went ${r.worst.toFixed(0)} ms without a turn`);
  assert.equal(r.value.ok, false);
  assert.ok(r.worst < 300, `the seat's thread was held ${r.worst.toFixed(0)} ms by one run length`);
  // round.open's own synchronous ask after it answers the same refusal at once
  const t0 = performance.now();
  assert.equal(plugins.runLengthFits(core, {}, 77).ok, false);
  assert.ok(performance.now() - t0 < 100);
  assert.deepEqual(plugins.runLengthFits(core, {}, 600), { ok: true });
});

const SPIN_STEP = `export const CORE = { name: 'spin-step', RUN_TICKS: 600, INPUT_WORDS: 5,
  start: () => ({ t: 0, x: 0 }), eventsOf: () => ({ count: {}, before() {} }),
  step(st, w) { if (w[0] === 9) { let i = 1; while (i > 0) i++; } st.t++; st.x += w[0]; },
  picture: (st) => ({ x: st.x, z: 0, heading: 0 }), stateHash: (st) => 'h' + st.t,
  result: (st) => ({ outcome: 'DELIVERED', score: st.t, heat: 0 }) };`;

test('#3556: a warm ghost that spins on a chosen input holds the seat\'s thread at most STEP_MS, and only KEPT_MISSES_MAX times', () => {
  const box = sandbox.sandboxFor(coreOf(SPIN_STEP));
  const events = { liquidations: [], loads: [], samples: [], tapes: [] };
  const spins = [];
  let refusedMs = null, refused = null;
  for (let i = 0; i < 4; i++) {
    let id = null;
    try { id = box.call('open', { seedWord: 1, config: {}, runTicks: 600 }); } catch (e) { refused = e.message; }
    const t0 = performance.now();
    try { box.call('stepTo', { id, events, from: 1, words: [[9, 0, 0, 0, 0]] }); } catch (e) { refused = e.message; }
    const ms = performance.now() - t0;
    if (/not asked again here/.test(String(refused))) { refusedMs = ms; break; }
    spins.push(Math.round(ms));
    if (ms >= 1500) break;   // (before #3556: 30 s a step)
  }
  console.log(`#3556 spinning stepTo held the seat's thread ${spins.join(', ')} ms; then: ${refused} (${refusedMs && refusedMs.toFixed(1)} ms)`);
  assert.ok(spins.every((ms) => ms < 1500), `a ghost step held the seat's thread ${Math.max(...spins)} ms`);
  assert.ok(spins.length <= 2, `the spinning ghost was asked ${spins.length} times`);
  assert.ok(refusedMs !== null && refusedMs < 50, 'the ghost is refused at once after its misses');
});
