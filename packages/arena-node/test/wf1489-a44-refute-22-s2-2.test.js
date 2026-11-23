// kanban #2219 (#1489 audit44 refute of #1623): the stack text a core reads names only the core's own realm - never this
// node's files, its install path or node: frames - and the core cannot get the call sites back by raising
// Error.stackTraceLimit, replacing the global Error, or redefining the string methods the formatter uses. The honest path:
// a core still reads its own frame (core:/core.js) and the error's message.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { sandboxFor } from '../src/core-sandbox.js';

const DIR = mkdtempSync(join(tmpdir(), 'wf1489-a44-refute-22-s2-2-'));
const coreOf = (name, startBody) => {
  const src = `export const CORE = Object.freeze({
  name: '${name}', RUN_TICKS: 10, INPUT_WORDS: 5,
  start: (seed) => { let note; ${startBody}; return { seed, t: 0, note }; },
  eventsOf: () => ({ count: { liquidations: 0, loads: 0, samples: 0, tapes: 0 }, before() {} }),
  step(st, w) { st.t++; },
  stateHash: (st) => 'h:' + st.seed + ':' + st.t + ':' + JSON.stringify(st.note),
  result: (st) => ({ outcome: 'DELIVERED', score: 0, heat: 0 }),
});`;
  const file = join(DIR, name + '.js');
  writeFileSync(file, src);
  return { name, hash: createHash('sha256').update(src).digest('hex'), url: pathToFileURL(file).href };
};
const run = (c) => {
  const r = sandboxFor(c).call('replay', { seedWord: 1, config: {}, runTicks: 10, start: 0, words: [[0, 0, 0, 0, 0]], events: {}, marks: [], pictures: [] });
  return JSON.parse(r.stateHash.replace(/^h:\d+:\d+:/, ''));
};
const leaks = (s) => /file:|node:|core-host|arena-node|\/Users\/|\/home\//.test(s);

test('new Error().stack names the core\'s own frames and the message, and none of the node\'s', () => {
  const note = run(coreOf('own', "note = new Error('boom').stack"));
  assert.ok(note.startsWith('Error: boom'), note);
  assert.match(note, /core:\/core\.mjs:3:/);
  assert.ok(!leaks(note), note);
});

test('raising Error.stackTraceLimit, replacing Error or the string methods, or captureStackTrace leaks nothing', () => {
  const tries = [
    "try { Error.stackTraceLimit = 200; } catch (e) {} note = new Error('x').stack",
    "try { globalThis.Error = { prepareStackTrace: (e, s) => s.map((c) => String(c.getFileName())).join('|') }; } catch (e) {} note = String(new RangeError('x').stack)",
    "String.prototype.startsWith = () => true; String.prototype.includes = () => false; note = new Error('x').stack",
    "const o = {}; Error.captureStackTrace(o); note = o.stack",
    "const deep = (n) => n ? deep(n - 1) : new Error('d').stack; note = deep(3)",
  ];
  for (const [i, body] of tries.entries()) {
    const note = String(run(coreOf('try' + i, body)));
    assert.ok(!leaks(note), `try ${i}: ${note}`);
  }
});
