// kanban #1489 audit44 refute of #1623 (skeptic 3): #1623 and #2219 took the seat's locale and install path out of a core's
// reach ("a core must not be able to read the machine it runs on"), but the core's realm still starts with what the seat's
// own V8 flags set - process-wide, so the core thread's empty execArgv does not reset them. NODE_OPTIONS (or the node
// command line) of the operator: --stack-trace-limit sets Error.stackTraceLimit (and how many of the core's own frames its
// stack text lists), --expose-gc puts a `gc` global into every new context. A core that reads either answers a different
// state hash on two seats of one committee. Safe behaviour: one core, one input, one state hash, whatever the seat's flags.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const DIR = mkdtempSync(join(tmpdir(), 'wf1489-a44-refute-22-s3-1-'));
const SANDBOX = pathToFileURL(fileURLToPath(new URL('../src/core-sandbox.js', import.meta.url))).href;
const src = `export const CORE = Object.freeze({
  name: 'flags', RUN_TICKS: 10, INPUT_WORDS: 5,
  start: (seed) => {
    const deep = (n) => n ? deep(n - 1) : String(new Error('d').stack).split('\\n').length;
    return { seed, t: 0, note: String(Error.stackTraceLimit) + '/' + deep(30) + '/' + typeof globalThis.gc };
  },
  eventsOf: () => ({ count: { liquidations: 0, loads: 0, samples: 0, tapes: 0 }, before() {} }),
  step(st, w) { st.t++; },
  stateHash: (st) => 'h:' + st.seed + ':' + st.t + ':' + st.note,
  result: (st) => ({ outcome: 'DELIVERED', score: 0, heat: 0 }),
});`;
const file = join(DIR, 'core.js');
writeFileSync(file, src);
const core = { name: 'flags', hash: createHash('sha256').update(src).digest('hex'), url: pathToFileURL(file).href };
const runWith = (nodeOptions) => execFileSync(process.execPath, ['--input-type=module', '-e', `import { sandboxFor } from ${JSON.stringify(SANDBOX)};
const s = sandboxFor(${JSON.stringify(core)});
const r = s.call('replay', { seedWord: 1, config: {}, runTicks: 10, start: 0, words: [[0,0,0,0,0]], events: {}, marks: [], pictures: [] });
console.log(r.stateHash);
process.exit(0);`], { encoding: 'utf8', timeout: 60000, env: { ...process.env, NODE_OPTIONS: nodeOptions } }).trim();

test('one core, one input: the same state hash on a seat started with --stack-trace-limit=50 and one with the defaults', () => {
  const a = runWith('');
  const b = runWith('--stack-trace-limit=50');
  assert.equal(b, a, `the core read the seat's node flags: default ${a}, --stack-trace-limit=50 ${b}`);
});

test('one core, one input: the same state hash on a seat started with --expose-gc and one with the defaults', () => {
  const a = runWith('');
  const b = runWith('--expose-gc');
  assert.equal(b, a, `the core read the seat's node flags: default ${a}, --expose-gc ${b}`);
});
