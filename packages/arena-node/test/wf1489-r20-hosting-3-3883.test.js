// kanban #1489 round 20 (hosting): A WARM GHOST THAT ANSWERS JUST INSIDE ITS DEADLINE HOLDS THE SEAT'S THREAD ON EVERY PICTURE (bypass of #3556).
// #3556 made the warm ghost (open, pose, stepTo, drop - the KEPT ops ghosts.js/replay.js WarmRun ask with Atomics.wait in the seat's own
// thread) refused after KEPT_MISSES_MAX deadline MISSES. A store core (installed by the owner or taken by autoUpdate - trialRunLength
// only asks runTicks/runTicksFits, never open/pose/stepTo) whose picture() or step() spins to just below its deadline never misses:
// pose (ASK_MS 2000 - not STEP_MS) answers after ~1.5 s, every time, and is never counted. Every picture of every truck of that game
// (ghosts.js latest -> WarmRun.stepTo -> pose) holds the seat's thread - which signs, serves rounds and answers peers - that long, without end.
// SAFE: the seat's thread is held by one core's warm ghost at most a bounded total (here: refused once its asks held the thread more than
// 2 x ASK_MS in all), as a core that misses is refused after KEPT_MISSES_MAX.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import * as sandbox from '../src/core-sandbox.js';

const DIR = mkdtempSync(join(tmpdir(), 'wf1489-r20-hosting-3-'));
function coreOf(src) {
  const file = join(DIR, 'core.mjs');
  writeFileSync(file, src);
  return { name: 'slow picture', hash: createHash('sha256').update(src).digest('hex'), url: pathToFileURL(file).href };
}
// the step's second word sets how long picture() works (a player-chosen input, or simply always): no clock is needed to stay under a deadline
const SLOW_PICTURE = `export const CORE = { name: 'slow-picture', RUN_TICKS: 600, INPUT_WORDS: 5,
  start: () => ({ t: 0, n: 0 }), eventsOf: () => ({ count: {}, before() {} }),
  step(st, w) { st.t++; st.n = w[1] * 1000; },
  picture(st) { let x = 0; for (let i = 0; i < st.n; i++) x = (x * 31 + i) | 0; return { x: x & 1, z: 0, heading: 0 }; },
  stateHash: (st) => 'h' + st.t, result: (st) => ({ outcome: 'DELIVERED', score: st.t, heat: 0 }) };`;

test('#1489-r20-hosting-3: a warm ghost answering just inside its deadline is refused before it holds the seat\'s thread without bound', () => {
  const box = sandbox.sandboxFor(coreOf(SLOW_PICTURE));
  const events = { liquidations: [], loads: [], samples: [], tapes: [] };
  const id = box.call('open', { seedWord: 1, config: {}, runTicks: 600 });
  // calibrate the loop on this machine: aim at ~65 % of STEP_MS (stepTo answers its pose too), well inside every deadline
  let from = 1, kc = 1000, base = 0, t0;
  for (; kc < 1e7; kc *= 2) {
    box.call('stepTo', { id, events, from: from++, words: [[0, kc, 0, 0, 0]] });
    t0 = performance.now(); box.call('pose', { id }); base = performance.now() - t0;
    if (base > 80) break;
  }
  const k = Math.max(1, Math.round(kc * (0.65 * sandbox.STEP_MS) / Math.max(1, base)));
  const held = [];
  let refused = null;
  // what ghosts.js latest asks per picture of one truck: stepTo (its answer is the pose) and pose - each just inside its deadline
  for (let i = 0; i < 10; i++) {
    t0 = performance.now();
    try { if (i % 2 === 0) box.call('stepTo', { id, events, from: from + i / 2, words: [[0, k, 0, 0, 0]] }); else box.call('pose', { id }); } catch (e) { refused = e.message; }
    held.push(Math.round(performance.now() - t0));
    if (refused) break;
  }
  const total = held.reduce((a, b) => a + b, 0);
  console.log('  FACTS:', JSON.stringify({ calibrationMs: Math.round(base), k, askMs: sandbox.ASK_MS, keptMissesMax: sandbox.KEPT_MISSES_MAX, heldMs: held, totalMs: total, refused }));
  assert.ok(held.every((ms) => ms < sandbox.STEP_MS), 'each ask answered inside its deadline (no miss was counted)');
  assert.ok(total <= 2 * sandbox.ASK_MS + 500, `one core's warm ghost held the seat's thread ${total} ms over ${held.length} pictures and was never refused`);
});
