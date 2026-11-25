// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Audit hosting r3 (a8-3-1): GAP IN THE #3556 FIX. POST /round asks the round's run length without blocking (runLengthFitsAsync) and
// remembers a failed ask in FITS_FAILED so round.open's synchronous runLengthFits right after answers from the memo. But the memo takes
// at most 1024 lengths per core (memo.size < 1024) and is never emptied: once a hosted core's runTicksFits has thrown on 1024 lengths
// (cheap: the core throws at once on them), a failing length is no longer remembered, and round.open's runLengthFits asks the core again
// on the seat's own thread (Atomics.wait, ASK_MS = 2 s). A core spinning on one length the trial never asks then holds the seat ~2 s
// per POST /round, on the same length, forever (until restart, when the attacker fills the memo again).
//
// SAFE BEHAVIOUR asserted: after any number of failed lengths, what POST /round runs (runLengthFitsAsync, then round.open's runLengthFits)
// does not hold the seat's thread for a spinning length.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import * as plugins from '../src/plugins.js';
import { trialRun } from '../src/plugin-trial.js';

const DIR = mkdtempSync(join(process.env.TMPDIR || '.', 'audit-hosting-a8-3-1-'));

// passes the trial (it asks 1, runTicksMax and RUN_TICKS only); throws at once on 1000..2999; spins on 100..199
const SRC = `export const CORE = { name: 'fill-then-spin', RUN_TICKS: 600, INPUT_WORDS: 5,
  runTicksFits(t) {
    if (t >= 1000 && t < 3000) throw new Error('no');
    if (t >= 100 && t < 200) { let i = 1; while (i > 0) i++; }
    return t >= 1 && t <= 600; },
  start: () => ({ t: 0 }), eventsOf: () => ({ count: {}, before() {} }), step(st) { st.t++; }, stateHash: (st) => 'h' + st.t,
  result: (st) => ({ outcome: 'DELIVERED', score: st.t, heat: 0 }) };`;

async function heldWhile(run) {
  let last = performance.now(), worst = 0;
  const tick = setInterval(() => { const t = performance.now(); worst = Math.max(worst, t - last); last = t; }, 5);
  let value, why = null;
  try { value = await run(); } catch (e) { why = e.message; }
  await new Promise((r) => setTimeout(r, 20));
  clearInterval(tick);
  worst = Math.max(worst, performance.now() - last);
  return { worst, value, why };
}
/** What POST /round runs for one contract's blockTicks: the ask without blocking, then round.open's synchronous check. */
const postRound = async (core, ticks) => { await plugins.runLengthFitsAsync(core, {}, ticks); return plugins.runLengthFits(core, {}, ticks); };

test('a8-3-1: past 1024 failed run lengths, POST /round\'s run-length check holds the seat\'s thread again (gap in #3556)', { timeout: 600000 }, async () => {
  const file = join(DIR, 'core.mjs');
  writeFileSync(file, SRC);
  const core = { name: 'fill-then-spin', hash: createHash('sha256').update(SRC).digest('hex'), url: pathToFileURL(file).href };
  // the store's trial passes it (a replay game, runTicksMax 10800)
  const t = trialRun(SRC, { resultType: 1, runTicksMax: 10800 }, {});
  assert.equal(t.ok, true, `the trial passes it: ${t.why}`);

  // before the fill: a spinning length is asked without blocking, then answered from the memo (the #3556 behaviour)
  const before = await heldWhile(() => postRound(core, 100));
  console.log(`a8-3-1 before the fill: the seat's thread went ${before.worst.toFixed(0)} ms without a turn (${JSON.stringify(before.value)})`);
  assert.ok(before.worst < 300);

  // a stranger's POST /round with lengths 1000..2103 (distinct u16s under runTicksMax): each fails at once and fills the memo
  for (let base = 1000; base < 2100; base += 12) await Promise.all(Array.from({ length: 12 }, (_, i) => postRound(core, base + i)));

  // now one spinning length, POSTed twice: each time the seat's own thread waits on the core
  const held = [];
  for (let i = 0; i < 2; i++) { const r = await heldWhile(() => postRound(core, 150)); held.push(Math.round(r.worst)); }
  console.log(`a8-3-1 after 1104 failed lengths: one spinning length held the seat's thread ${held.join(', ')} ms per POST /round`);
  assert.ok(held.every((ms) => ms < 300), `the seat's thread was held ${Math.max(...held)} ms by one POST /round's run length`);
});
