// kanban #1489 round 5 (hosting): THE STICKY OVERFLOW IS SET ONLY IN A catch CLAUSE (bypass of #2220 / #2476).
// core-depth.js counts the depth of the core's own functions and makes V8's "Maximum call stack size exceeded" sticky - but
// only where the core takes the RangeError in a `catch (e)` clause (instrumentCore puts __arena$c(e) there). A builtin that
// recurses on its own (Array.prototype.join, JSON.stringify of nested arrays, a loop of built-ins) overflows V8's stack with no core function on it, so the depth count
// never fires; and a promise's rejection handler takes the error as a plain argument, with no catch clause at all. A core
// awaits that at its top level (the sandbox lets a module's top-level await settle) and reads the depth at which the stack
// ran out - a number set by the machine's stack frames (V8 build, arm64 / x86), not by the round: seats on different
// machines answer the same call differently (#2220's own concern), and the core is never refused.
// Safe behaviour: a core that overflows the stack is refused, however it takes the RangeError.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCore } from '../src/core-sandbox.js';

test('#1489-r5-hosting-4: a core that reads V8\'s stack overflow through a promise handler is refused', () => {
  // one probe: a builtin that recurses into itself with no core function on the stack while it does. The probe was String() of
  // nested arrays 100000 deep (Array.prototype.join): on the arm64 laptop it was sized on that ran out of stack, on x86_64 (node 24,
  // CORE_STACK_MB 32) it fits (kanban #3540) - where a fixed depth ends is the machine's frame size. Since the cap on the built-ins
  // that recurse on data (core-nest.js) such data is refused at DEPTH_MAX; the probe is a loop of built-ins on one object that never
  // ends (its toString is Object.prototype.toLocaleString, which calls this.toString), so it overflows on every machine
  const src = `const loop = {}; loop.toString = Object.prototype.toLocaleString;
const SAID = await new Promise((ok) => ok(String(loop).length)).then(() => 'fits', (e) => String(e && e.message));
const DEPTH = SAID.includes('call stack') ? 1 : 0;
export const DECIDE = { name: 'stack-' + DEPTH, decide(moves) { const out = {}; for (const m of moves) out[m.key] = DEPTH % 2 ? 'WIN' : 'LOSS'; return out; } };`;
  let box = null, why = 'loaded';
  try { box = loadCore({ files: new Map([['core.mjs', src]]), entry: 'core.mjs' }, { name: 'stack-reader' }); } catch (e) { why = e.message; }
  let verdict = null;
  if (box) {
    try { verdict = box.call('decide', { moves: [{ key: 'a', move: 0 }, { key: 'b', move: 1 }] }); } catch (e) { why = e.message; }
    console.log(`meta.name: ${box.meta.name} (stack-1: the toLocaleString loop ran out of V8's stack, and the core took the RangeError in a promise handler); decide: ${JSON.stringify(verdict)}`);
    box.end();
  } else console.log(`refused: ${why}`);
  assert.equal(box, null, `the core read the stack's end (${box && box.meta.name}) and branched on it, and was not refused`);
  assert.match(why, /overflowed the stack/);   // kanban #3540: refused for the overflow, not for a load deadline
});
