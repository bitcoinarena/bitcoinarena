// THE CORE'S SANDBOX, ATTACKED (spec §0A.6, kanban #328): "no network, no file system, no clock, no randomness but the
// round's seed". One hostile core per attack, each a file of its own read and hashed by the node as any core is: refused
// when it is loaded (an import outside its files) or thrown inside the sandbox when it runs - the replay answers not ok,
// with the reason - and the node keeps answering after every one. And the census: what a core finds on its global object.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { sandboxFor } from '../src/core-sandbox.js';
import { replay } from '../src/replay.js';

const DIR = mkdtempSync(join(tmpdir(), 'hostile-core-'));
let n = 0;
/** A one-file core: `top` at its top level, `step` inside its step (st, w in scope), `head` its imports. */
function core({ head = '', top = '', step = '', start = '' }) {
  const src = `${head}
${top}
export const CORE = Object.freeze({
  name: 'hostile', RUN_TICKS: 10, INPUT_WORDS: 5,
  start: (seed) => { const st = { seed, t: 0, note: '' }; ${start}; return st; },
  eventsOf: () => ({ count: { liquidations: 0, loads: 0, samples: 0, tapes: 0 }, before() {} }),
  step(st, w) { ${step}; st.t++; },
  stateHash: (st) => 'h:' + st.seed + ':' + st.t + ':' + st.note,
  result: (st) => ({ outcome: 'DELIVERED', score: st.t, heat: 0 }),
});`;
  const file = join(DIR, `core-${++n}.js`);
  writeFileSync(file, src);
  return { name: `hostile ${n}`, hash: createHash('sha256').update(src).digest('hex'), url: pathToFileURL(file).href };
}
const ONE_TICK = { ticks: [{ tick: 0, words: [1, 2, 3, 4, 5] }] };
const run = (c) => replay(ONE_TICK, { joinTick: 0 }, { core: c, seedWord: 7 });

// a node object the core must never reach: if any attack returned it, the attack worked
const server = createServer((q, r) => r.end('still answering'));
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
after(() => { server.closeAllConnections(); server.close(); });
const PORT = server.address().port;
async function stillAnswering() {
  const r = await fetch(`http://127.0.0.1:${PORT}/`);
  assert.equal(await r.text(), 'still answering');
}

// [attack, kind, core source parts, what the refusal says]
const LOAD = [
  ['network: a static import of node:net', 'network', { head: "import net from 'node:net';" }, /imports "node:net", and a core may import only its own files/],
  ['network: a static import of node:http', 'network', { head: "import * as h from 'node:http';" }, /imports "node:http"/],
  ['network: node:child_process', 'network', { head: "import cp from 'node:child_process';" }, /imports "node:child_process"/],
  ['file system: a static import of node:fs', 'file system', { head: "import fs from 'node:fs';" }, /imports "node:fs"/],
  ['file system: a file outside its hashed set', 'file system', { head: "import x from '../../src/main.js';" }, /not one of its hashed files/],
  ['file system: an absolute path', 'file system', { head: "import x from '/etc/passwd';" }, /a core may import only its own files/],
  ['file system: a file: URL', 'file system', { head: "import x from 'file:///etc/passwd';" }, /a core may import only its own files/],
  ['a package by name', 'network', { head: "import { sha256 } from '@noble/hashes/sha2.js';" }, /imports "@noble\/hashes\/sha2.js"/],
  ['endless loop at load', 'endless loop', { top: 'for (;;) {}' }, /did not stop within 400 ms \(loading\): its thread was ended/],
  ['clock at load: Date.now()', 'clock', { top: 'const t0 = Date.now();' }, /Date is not defined/],
];
const RUN = [
  ['network: fetch', 'network', { step: "fetch('http://127.0.0.1:" + '${PORT}' + "/')" }, /fetch is not defined/],
  ['network: require', 'network', { step: "require('node:net')" }, /require is not defined/],
  ['network: process.binding', 'network', { step: "process.binding('tcp_wrap')" }, /process is not defined/],
  ['network: WebSocket', 'network', { step: "new WebSocket('ws://127.0.0.1:1')" }, /WebSocket is not defined/],
  ['file system: Buffer and process.cwd', 'file system', { step: 'process.cwd()' }, /process is not defined/],
  ['clock: Date.now()', 'clock', { step: 'st.note = Date.now()' }, /Date is not defined/],
  ['clock: new Date()', 'clock', { step: 'st.note = String(new Date())' }, /Date is not defined/],
  ['clock: performance.now()', 'clock', { step: 'st.note = performance.now()' }, /performance is not defined/],
  ['clock: setTimeout', 'clock', { step: 'setTimeout(() => {}, 1)' }, /setTimeout is not defined/],
  ['clock: setInterval / setImmediate / queueMicrotask', 'clock', { step: 'setImmediate(() => {})' }, /setImmediate is not defined/],
  ['clock: Intl.DateTimeFormat().format()', 'clock', { step: 'st.note = Intl.DateTimeFormat().format()' }, /Intl is not defined/],
  ['clock: SharedArrayBuffer + Atomics.wait', 'clock', { step: 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1)' }, /Atomics is not defined/],
  ['clock: process.hrtime', 'clock', { step: 'process.hrtime()' }, /process is not defined/],
  ['randomness: Math.random()', 'randomness', { step: 'st.note = Math.random()' }, /Math\.random is not a function/],
  ['randomness: crypto.getRandomValues', 'randomness', { step: 'crypto.getRandomValues(new Uint8Array(4))' }, /crypto is not defined/],
  ['randomness: WeakRef / FinalizationRegistry (GC timing)', 'randomness', { step: 'new WeakRef({})' }, /WeakRef is not defined/],
  ['generated code: eval', 'generated code', { step: "eval('1')" }, /eval is not defined/],
  ['generated code: Function', 'generated code', { step: "Function('return 1')()" }, /Function is not defined/],
  ['generated code: a function\'s constructor', 'generated code', { step: "(() => {}).constructor('return 1')()" }, /Code generation from strings disallowed/],
  ['generated code: WebAssembly', 'generated code', { step: 'WebAssembly.compile(new Uint8Array(8))' }, /WebAssembly is not defined/],
  ['escape: through the words handed in', 'escape', { step: "st.note = w.constructor.constructor('return process')()" }, /Code generation from strings disallowed/],
  ['escape: through the global\'s prototype', 'escape', { step: "Object.getPrototypeOf(globalThis).constructor.constructor('return process')()" }, /Code generation from strings disallowed/],
  ['escape: Error.prepareStackTrace for the node\'s frames', 'escape', { step: 'Error.prepareStackTrace = (e, s) => s' }, /read only|Cannot assign/],
  ['escape: the global\'s console / Buffer / structuredClone', 'escape', { step: 'console.log(Buffer, structuredClone)' }, /console is not defined/],
  ['endless loop in a step', 'endless loop', { step: 'for (;;) {}' }, /did not stop within 400 ms \(replay\): its thread was ended/],
  ['endless microtask chain', 'endless loop', { step: 'const go = () => Promise.resolve().then(go); go()' }, /did not stop within 400 ms \(replay\): its thread was ended/],
];

const rows = [];
test('every load-time attack is refused before a line of the core runs, and the node keeps answering', async () => {
  for (const [name, kind, parts, says] of LOAD) {
    const c = core(parts);
    assert.throws(() => sandboxFor(c, { loadMs: 400 }), says, name);
    const r = run(c);
    assert.equal(r.ok, false, name);
    assert.match(r.why, /does not load in one/, name);
    await stillAnswering();
    rows.push([kind, name, 'refused at load', r.why.replace(/^.*does not load in one: /, '')]);
  }
});

test('every run-time attack throws inside the sandbox: the replay is not ok, with the reason, and the node keeps answering', async () => {
  for (const [name, kind, parts, says] of RUN) {
    const c = core({ ...parts, step: parts.step.replace('${PORT}', String(PORT)) });
    sandboxFor(c, { callMs: 400 });
    const r = run(c);
    assert.equal(r.ok, false, `${name}: ${JSON.stringify(r)}`);
    assert.match(r.why, says, name);
    await stillAnswering();
    rows.push([kind, name, 'thrown in the run', r.why]);
  }
});

test('a dynamic import() gets no module: the core cannot even learn one exists', async () => {
  const c = core({ step: "import('node:net').then(() => { globalThis.got = 'net'; }, (e) => { globalThis.got = 'refused: ' + e.code; })", start: "st.note = String(globalThis.got)" });
  assert.equal(run(c).ok, true);
  // the second run reads what the first one's import() came to
  const s = sandboxFor(c);
  const out = s.call('replay', { seedWord: 1, config: {}, runTicks: 10, start: 0, words: [[0, 0, 0, 0, 0]], events: {}, marks: [], pictures: [] });
  assert.match(out.stateHash, /refused: ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING/);
  rows.push(['network', 'a dynamic import()', 'rejected in the sandbox', out.stateHash.replace(/^h:\d+:\d+:/, '')]);
  await stillAnswering();
});

test('the census: what a sandboxed core finds on its global object', () => {
  const c = core({ start: "st.note = JSON.stringify({ names: Object.getOwnPropertyNames(globalThis).sort(), random: typeof Math.random, mathKeys: Object.getOwnPropertyNames(Math).length, prepare: Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace') })" });
  const out = sandboxFor(c).call('replay', { seedWord: 1, config: {}, runTicks: 10, start: 0, words: [], events: {}, marks: [], pictures: [] });
  const census = JSON.parse(out.stateHash.replace(/^h:\d+:\d+:/, ''));
  const FORBIDDEN = ['fetch', 'process', 'require', 'module', 'Buffer', 'setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask',
    'clearTimeout', 'performance', 'crypto', 'WebSocket', 'XMLHttpRequest', 'navigator', 'console', 'structuredClone', 'global',
    'Date', 'Intl', 'WebAssembly', 'SharedArrayBuffer', 'Atomics', 'eval', 'Function', 'WeakRef', 'FinalizationRegistry'];
  for (const k of FORBIDDEN) assert.ok(!census.names.includes(k), `${k} is on the core's global`);
  assert.equal(census.random, 'undefined');
  assert.equal(census.prepare.writable, false);
  console.log('CENSUS ' + JSON.stringify(census.names));
  console.log('CENSUS-ABSENT ' + JSON.stringify(FORBIDDEN));
});

test('a good core still replays after every attack, and the report', async () => {
  const c = core({ step: 'st.note = String(w[0] + w[4])' });
  const r = run(c);
  assert.equal(r.ok, true, r.why);
  assert.equal(r.stateHash, 'h:7:1:6');
  await stillAnswering();
  for (const row of rows) console.log('ROW ' + JSON.stringify(row));
});
