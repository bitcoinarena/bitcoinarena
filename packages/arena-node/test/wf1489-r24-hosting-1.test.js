// kanban #1489 round r24 (hosting): the depth limit of #2220/#2476 (core-depth.js) counts a call only once the callee's BODY is entered -
// a function's default parameter values run before that, so a core that recurses through a default value nests without any count and
// reaches V8's own stack overflow again, whose place moves with V8's tier-up (the #2220 non-determinism: the same call answers on one
// seat and fails on another). Safe behaviour: nesting past DEPTH_MAX is refused with DEPTH_SAID wherever the nested call is written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { loadCore, coreFiles } from '../src/core-sandbox.js';
import { DEPTH_MAX } from '../src/core-depth.js';

const DIR = mkdtempSync(join(tmpdir(), 'r24-hosting-1-'));
let n = 0;
const coreOf = (src) => {
  const d = join(DIR, String(n++)); mkdirSync(d, { recursive: true });
  const file = join(d, 'core.js'); writeFileSync(file, src);
  return { name: 'd', hash: createHash('sha256').update(src).digest('hex'), url: pathToFileURL(file).href };
};
const tail = `export const CORE = Object.freeze({ name: 'd', RUN_TICKS: R, INPUT_WORDS: 5, start: () => ({}), eventsOf: () => ({ count: {}, before() {} }),
  step() {}, stateHash: () => 'h', result: () => ({ outcome: 'DELIVERED', score: 0, heat: 0 }) });`;
const outcome = (src) => { try { const b = loadCore(coreFiles(coreOf(src))); const r = b.meta.RUN_TICKS; b.end(); return `ok ${r}`; } catch (e) { return `refused: ${String(e.message).slice(0, 90)}`; } };

test('recursion through a default parameter value is held to DEPTH_MAX like any other', () => {
  // the same nesting written in the body is refused at DEPTH_MAX (core-depth-2220.test.js); written in a default value it is not counted
  const body = `const f = (k) => { return k > 0 ? 1 + f(k - 1) : 0; }; const R = f(${5 * DEPTH_MAX});\n${tail}`;
  const param = `function f(k, d = k > 0 ? 1 + f(k - 1) : 0) { return d; } const R = f(${5 * DEPTH_MAX});\n${tail}`;
  const b = outcome(body), p = outcome(param);
  console.log(`body recursion ${5 * DEPTH_MAX} deep: ${b}`);
  console.log(`default-parameter recursion ${5 * DEPTH_MAX} deep: ${p}`);
  // and how deep it goes before V8's own overflow, cold and after a warm-up (the place moves with tier-up)
  for (const depth of [100000, 200000, 400000, 800000]) {
    const seen = new Set();
    for (let i = 0; i < 3; i++) seen.add(outcome(`function f(k, d = k > 0 ? 1 + f(k - 1) : 0) { return d; } for (let i = 0; i < 20000; i++) f(${i % 3}); const R = f(${depth});\n${tail}`).slice(0, 40));
    console.log(`warm default-parameter recursion ${depth} deep, 3 loads: ${[...seen].join(' | ')}`);
  }
  assert.match(b, /nested its calls/);
  assert.match(p, /nested its calls/, `a core nested ${5 * DEPTH_MAX} calls through a default parameter and was not stopped at DEPTH_MAX (${DEPTH_MAX}): ${p}`);
});
