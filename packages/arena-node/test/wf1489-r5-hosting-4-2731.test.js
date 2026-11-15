// kanban #1489 round 5 (hosting): THE STICKY OVERFLOW IS SET ONLY IN A catch CLAUSE (bypass of #2220 / #2476).
// core-depth.js counts the depth of the core's own functions and makes V8's "Maximum call stack size exceeded" sticky - but
// only where the core takes the RangeError in a `catch (e)` clause (instrumentCore puts __arena$c(e) there). A builtin that
// recurses on its own (Array.prototype.join, JSON.stringify of nested arrays) overflows V8's stack with no core function on it, so the depth count
// never fires; and a promise's rejection handler takes the error as a plain argument, with no catch clause at all. A core
// awaits that at its top level (the sandbox lets a module's top-level await settle) and reads the depth at which the stack
// ran out - a number set by the machine's stack frames (V8 build, arm64 / x86), not by the round: seats on different
// machines answer the same call differently (#2220's own concern), and the core is never refused.
// Safe behaviour: a core that overflows the stack is refused, however it takes the RangeError.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCore } from '../src/core-sandbox.js';

test('#1489-r5-hosting-4: a core that reads V8\'s stack overflow through a promise handler is refused', () => {
  // one probe (each overflow costs the core a few seconds of its own thread): nested arrays 100000 deep, joined by String() -
  // V8's Array.prototype.join recurses into itself; on the MacBook (node 24, arm64) it runs out of stack there, JSON.stringify
  // of the same array does not - where each one ends is the machine's frame size
  const src = `const nest = (n) => { let a = 0; for (let i = 0; i < n; i++) a = [a]; return a; };
const SAID = await new Promise((ok) => ok(String(nest(100000)).length)).then(() => 'fits', (e) => String(e && e.message));
const DEPTH = SAID.includes('call stack') ? 1 : 0;
export const DECIDE = { name: 'stack-' + DEPTH, decide(moves) { const out = {}; for (const m of moves) out[m.key] = DEPTH % 2 ? 'WIN' : 'LOSS'; return out; } };`;
  let box = null, why = 'loaded';
  try { box = loadCore({ files: new Map([['core.mjs', src]]), entry: 'core.mjs' }, { name: 'stack-reader' }); } catch (e) { why = e.message; }
  let verdict = null;
  if (box) {
    try { verdict = box.call('decide', { moves: [{ key: 'a', move: 0 }, { key: 'b', move: 1 }] }); } catch (e) { why = e.message; }
    console.log(`meta.name: ${box.meta.name} (stack-1: String() of the 100000-deep array ran out of V8's stack on this machine, and the core took the RangeError in a promise handler); decide: ${JSON.stringify(verdict)}`);
    box.end();
  } else console.log(`refused: ${why}`);
  assert.equal(box, null, `the core read the stack's end (${box && box.meta.name}) and branched on it, and was not refused`);
});
