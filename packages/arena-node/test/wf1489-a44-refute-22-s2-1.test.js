// kanban #1489 audit44 refute of #1623 (skeptic 2): #1623 took the seat's LOCALE out of a core's reach so one run hashes
// the same on every seat ("a core must not be able to read the machine it runs on"). The seat's INSTALL PATH is still in
// reach: V8's default stack text names the host's own frames below the core's (core-host.js, as file:///<install dir>/...),
// and Error.stackTraceLimit is the core's to raise. A core that puts `new Error().stack` (or one bit of it) in its state hash
// or result makes two seats installed in different directories (/home/alice/..., /opt/arena/...) sign different results for
// one run - and reads the operator's user name as well. Safe behaviour: the same core on the same input answers the same
// state hash wherever the seat is installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const DIR = mkdtempSync(join(tmpdir(), 'wf1489-a44-refute-22-s2-1-'));
const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const FILES = ['core-sandbox.js', 'core-supervisor.js', 'core-host.js', 'core-driver.js', 'core-hash.js'];
const install = (where) => {
  const d = join(DIR, where, 'src');
  mkdirSync(d, { recursive: true });
  writeFileSync(join(DIR, where, 'package.json'), '{"type":"module"}');
  for (const f of FILES) copyFileSync(join(SRC, f), join(d, f));
  return pathToFileURL(join(d, 'core-sandbox.js')).href;
};
const src = `export const CORE = Object.freeze({
  name: 'where', RUN_TICKS: 10, INPUT_WORDS: 5,
  start: (seed) => { Error.stackTraceLimit = 64; return { seed, t: 0, note: String(new Error('x').stack).length }; },
  eventsOf: () => ({ count: { liquidations: 0, loads: 0, samples: 0, tapes: 0 }, before() {} }),
  step(st, w) { st.t++; },
  stateHash: (st) => 'h:' + st.seed + ':' + st.t + ':' + st.note,
  result: (st) => ({ outcome: 'DELIVERED', score: st.note, heat: 0 }),
});`;
const file = join(DIR, 'core.js');
writeFileSync(file, src);
const core = { name: 'where', hash: createHash('sha256').update(src).digest('hex'), url: pathToFileURL(file).href };
const runFrom = (sandboxUrl) => execFileSync(process.execPath, ['--input-type=module', '-e', `import { sandboxFor } from ${JSON.stringify(sandboxUrl)};
const s = sandboxFor(${JSON.stringify(core)});
const r = s.call('replay', { seedWord: 1, config: {}, runTicks: 10, start: 0, words: [[0,0,0,0,0]], events: {}, marks: [], pictures: [] });
console.log(JSON.stringify({ stateHash: r.stateHash, score: r.score }));
process.exit(0);`], { encoding: 'utf8', timeout: 60000 }).trim();

test('one core, one input: the same state hash on a seat installed under /home/a and one under a longer path', () => {
  const a = runFrom(install('a'));
  const b = runFrom(install('operator-bob/bitcoin-arena'));
  assert.equal(b, a, `the core read the seat's install path: one seat answered ${a}, the other ${b}`);
});
