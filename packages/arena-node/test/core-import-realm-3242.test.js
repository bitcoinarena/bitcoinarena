// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3242 (audit r10 hosting 1, critical): a refused import() must reject with an Error of the core's own realm, so that
// e.constructor.constructor cannot generate code. The core reads the outcome on a later call, after the microtask has run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { sandboxFor } from '../src/core-sandbox.js';

test('#3242: no code-generating Function is reachable from a refused import()', async () => {
  const src = `
const box = { got: 'none' };
import('node:fs').then(() => { box.got = 'LOADED'; }, (e) => {
  try { box.got = 'CODEGEN:' + e.constructor.constructor('return 1+1')(); } catch (x) { box.got = 'blocked'; }
});
export const CORE = Object.freeze({
  name: 'probe', RUN_TICKS: 10, INPUT_WORDS: 5,
  start: (seed) => ({ seed, t: 0 }),
  eventsOf: () => ({ count: { liquidations: 0, loads: 0, samples: 0, tapes: 0 }, before() {} }),
  step(st) { st.t++; },
  stateHash: () => 'h:' + box.got,
  result: (st) => ({ outcome: 'DELIVERED', score: st.t, heat: 0 }),
});`;
  const dir = mkdtempSync(join(tmpdir(), 'core-3242-'));
  const file = join(dir, 'core.js');
  writeFileSync(file, src);
  const s = sandboxFor({ name: 'probe', hash: createHash('sha256').update(src).digest('hex'), url: pathToFileURL(file).href });
  const ask = () => s.call('replay', { seedWord: 1, config: {}, runTicks: 10, start: 0, words: [], events: {}, marks: [], pictures: [] }).stateHash;
  let seen = ask();
  for (let i = 0; i < 20 && seen === 'h:none'; i++) { await new Promise((r) => setTimeout(r, 25)); seen = ask(); }
  assert.notEqual(seen, 'h:LOADED', 'import() loaded a module');
  assert.doesNotMatch(seen, /CODEGEN/, 'a code-generating Function was reachable from the refused import()');
  assert.equal(seen, 'h:blocked');
});
