// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 round 4 (hosting): sandboxFor() keeps a refused core refused for the life of the thread, and #1586 exempted ONE
// transient cause - "a busy node can miss LOAD_MS once, and a refusal kept for the thread's life left every later close of that
// game ... failing until a restart" - by matching only "did not stop within N ms (loading)". loadCore's first act after the load
// is the meta ask (ASK_MS, 2 s), and a busy seat missing THAT deadline throws "did not stop within N ms (meta)": cached as a
// refusal for good. A refused entry also never gets an askedAt, so endIdleCores never sweeps it - only a restart brings the game
// back. Every 15 idle minutes a core is ended and reloaded on its next ask (CORE_IDLE_MS), so each reload is another chance:
// one moment of load (a peer hammering the seat, a replay burst) and every round of that game on this seat fails from then on
// ("decide adapter does not load in its sandbox") while seats that were not busy at that moment answer.
// Safe behaviour: a meta ask that only ran out of time is not kept as a refusal - the next ask loads the core again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { sandboxFor, endIdleCores } from '../src/core-sandbox.js';

const DIR = mkdtempSync(join(tmpdir(), 'wf1489-r4-hosting-6-'));
const coreOf = (src) => {
  const d = join(DIR, 'c'); mkdirSync(d, { recursive: true });
  const file = join(d, 'core.js'); writeFileSync(file, src);
  return { name: 'slowmeta', hash: createHash('sha256').update(src).digest('hex'), url: pathToFileURL(file).href };
};
// an honest decide adapter (since kanban #2730 a DECIDE's fields are read at load, so no core code runs in the meta ask itself: a busy
// moment is what makes it miss its deadline - stood in for here by an ask with no time at all)
const SRC = `export const DECIDE = Object.freeze({ name: 'slow-meta', decide: (moves) => Object.fromEntries(moves.map((m) => [m.key, 'DRAW'])) });`;

test('a meta ask that only ran out of time on a busy moment is not kept as a refusal', () => {
  const core = coreOf(SRC);
  // the busy moment: the meta ask misses its deadline (a short askMs stands in for a starved thread)
  assert.throws(() => sandboxFor(core, { askMs: 0 }), /did not stop within \d+ ms \(meta\)/);
  // the seat is idle again, and the idle sweep has run: the same core, asked as verify.js asks it
  endIdleCores(0);
  let box = null, why = null;
  try { box = sandboxFor(core); } catch (e) { why = e.message; }
  assert.equal(why, null, `the core stays refused after one slow meta ask: ${why}`);
  assert.equal(box.meta.decide, true);
});
