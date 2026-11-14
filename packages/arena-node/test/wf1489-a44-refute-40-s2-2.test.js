// kanban #1489 a44 refute of #1624 / #2152 / #2220, skeptic 2 (a seat's own admission and its close, across reloads). The kept
// thread still has the 4 MB stack, and the core's meta is read there (core-sandbox.js loadCore callHere('meta')): what a seat
// decides from meta moves with the depth at which V8 overflowed. (1) round.js POST /round asks runLengthFits, which for a core
// without runTicksFits compares the round's blockTicks with meta.RUN_TICKS - so one seat takes a round and the next refuses it,
// and the same seat flips after endIdleCores reloads the core. (2) verify.js #headToHeadClose refuses to decide when meta.decide
// is false ("decide adapter is not installed") - so some seats of a head-to-head round sign and some sign nothing.
// Safe behaviour: one answer, whichever seat or load asks. The one-shot thread (1 GB) never overflows, so the plugin trial passes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { loadCore, coreFiles, endIdleCores } from '../src/core-sandbox.js';
import { runLengthFits } from '../src/plugins.js';

const DIR = mkdtempSync(join(tmpdir(), 'wf1489-a44-refute-40-s2-2-'));
const PROBE = `let d = 0; const f = (x, n) => { d++; return n > 0 ? f(x + 1, n - 1) + 1 : 0; };
const depth = () => { d = 0; try { f(0, 200000); } catch { return d; } return 0; };
let sum = 0; for (let k = 0; k < 12; k++) { for (let i = 0; i < 300; i++) f(0, 50); sum += depth() % 97; }`;
const write = (name, src, i = 0) => {
  const d = join(DIR, name + i); mkdirSync(d, { recursive: true });
  const file = join(d, 'core.js'); writeFileSync(file, src);
  return { name, hash: createHash('sha256').update(src).digest('hex'), url: pathToFileURL(file).href };
};

test('a round\'s run length is taken or refused alike over 16 loads of its core', () => {
  // 90 or 91 ticks by the parity of the overflow depths; on a 1 GB stack it is 90 every time
  const src = `${PROBE}
export const CORE = Object.freeze({ name: 'fits', RUN_TICKS: 90 + (sum % 2), INPUT_WORDS: 5,
  start: () => ({}), eventsOf: () => ({ count: {}, before() {} }), step() {}, stateHash: () => 'h', result: () => ({ outcome: 'DELIVERED', score: 0, heat: 0 }) });`;
  const core = write('fits', src);
  const seen = new Set();
  for (let i = 0; i < 16; i++) { endIdleCores(0); const r = runLengthFits(core, {}, 90); seen.add(r.ok ? 'taken' : 'refused: ' + r.why); }
  endIdleCores(0);
  assert.equal(seen.size, 1, `a round of 90 ticks: ${[...seen].join(' | ')}`);
});

test('every load of a head-to-head core says alike whether it decides', () => {
  const src = `${PROBE}
const decide = (moves) => moves.map(() => 'DRAW');
export const DECIDE = Object.freeze({ name: 'h2h', ...(sum % 2 ? {} : { decide }) });`;
  const core = write('h2h', src);
  const seen = new Set();
  for (let i = 0; i < 16; i++) { const box = loadCore(coreFiles(core), { name: 'h2h' }); seen.add(box.meta.decide); box.end(); }
  assert.equal(seen.size, 1, `meta.decide answered: ${[...seen].join(' | ')}`);
});
