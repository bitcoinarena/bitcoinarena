// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Audit hosting a7-1-2 (find only): ONE GAME'S CORE HOLDS EVERY OTHER GAME'S REPLAYS. A seat replays every run of every hosted game
// through one ReplayPool (verify.js `pool = new ReplayPool()`: workers 1), FIFO among unobjected closes, and a replay may run CALL_MS
// (120 s) before core-sandbox.js ends it. The store's trial for a replayed game (plugin-trial.js trialRunLength, kanban #2807) asks only
// runTicks / runTicksFits and never replays, so a store game whose core spins in its replay (on every run, or on a word its developer
// plays) passes scan and trial; each of its runs then holds the seat's one replay worker 120 s, and the closes of every other game on the
// seat (Next Block's included) wait behind it. Safe behaviour: one game's replay that does not stop does not hold another game's close
// longer than a short bound.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { ReplayPool } from '../src/pool.js';
import { trialRun } from '../src/plugin-trial.js';
import { scanSource } from '../src/plugin-check.js';
import { RESULT_TYPE } from '../../arena-protocol/src/manifest.js';

const DIR = mkdtempSync(join(tmpdir(), 'audit-hosting-a7-1-2-'));
const coreSrc = (step) => `export const CORE = Object.freeze({
  name: 'tick', RUN_TICKS: 10, INPUT_WORDS: 5,
  start: (seed) => ({ seed, t: 0 }),
  eventsOf: () => ({ count: { liquidations: 0, loads: 0, samples: 0, tapes: 0 }, before() {} }),
  step(st, w) { ${step} st.t++; },
  stateHash: (st) => String(st.t),
  result: (st) => ({ outcome: 'DELIVERED', score: st.t, heat: 0 }),
});
`;
const SPIN = coreSrc('if (w[0] === 4242) { let i = 1; while (i > 0) i++; }');   // the developer's own run carries word 4242
const FAIR = coreSrc('');
const coreOf = (src, n) => { const f = join(DIR, `core-${n}.mjs`); writeFileSync(f, src);
  return { name: `g${n}`, hash: createHash('sha256').update(src).digest('hex'), url: pathToFileURL(f).href, runTicks: 10 }; };
const job = (core, key, word) => ({ key, core, objected: false, transcript: { ticks: Array.from({ length: 3 }, (_, i) => ({ tick: i, words: [word, 0, 0, 0, 0] })) },
  entry: { joinTick: 0 }, options: { seedWord: 7 } });

test('a7-1-2: one hosted game\'s replay that does not stop does not hold another game\'s close for CALL_MS', { timeout: 200000 }, async () => {
  // the spinning game passes the store's scan and trial (no replay is run by the trial)
  assert.deepEqual(scanSource(SPIN), [], 'the scan finds nothing');
  const t = trialRun(SPIN, { resultType: RESULT_TYPE.REPLAY, runTicksMax: 10 });
  console.log('  a7-1-2 trial:', JSON.stringify(t));
  assert.equal(t.ok, true, `the trial passes it: ${t.why}`);
  const pool = new ReplayPool();   // what verify.js builds for a seat
  const t0 = Date.now();
  const spun = pool.submit(job(coreOf(SPIN, 1), 'evil:run', 4242));
  const fair = pool.submit(job(coreOf(FAIR, 2), 'nextblock:run', 1));
  const BOUND = 15000;
  const first = await Promise.race([fair.then((a) => ({ fair: a })), new Promise((r) => setTimeout(() => r({ late: true }), BOUND))]);
  console.log(`  a7-1-2: after ${Date.now() - t0} ms: ${first.late ? 'the other game\'s close is still waiting behind the spinning replay' : `answered ${JSON.stringify(first.fair).slice(0, 120)}`}`);
  const late = !!first.late;
  // let both finish so the file ends cleanly (the spinning replay is ended at CALL_MS)
  const [a, b] = await Promise.all([spun.catch((e) => ({ why: e.message })), fair.catch((e) => ({ why: e.message }))]);
  console.log(`  a7-1-2: spinning replay ${JSON.stringify(a).slice(0, 160)}; other game's close answered after ${Date.now() - t0} ms (ok ${b.ok})`);
  assert.equal(late, false, `the other game's close waited more than ${BOUND} ms behind one spinning replay of a store game`);
  // AND THE FIX (kanban #3578): the core whose replay did not stop is struck on this pool (one job at a time, never in a spare slot)
  assert.equal(b.ok, true, b.why);
  assert.equal(pool.struck.size, 1, 'the spinning core was not remembered');
  assert.equal(pool.running, 0);
});
