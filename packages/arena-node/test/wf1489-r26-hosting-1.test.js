// kanban #1489 round 26 (hosting): bypass of #2731 (and #2220 / #2476 / #2712). The sticky overflow is now set where a
// thrown value LEAVES one of the core's own functions - but a builtin handed straight to Promise.prototype.then (String,
// JSON.stringify, a bound Object.prototype.toLocaleString) runs as the promise job itself: no function of the core's is on the stack when V8's stack runs out, nothing
// is thrown out of core code, and the rejection reaches the core's next handler as a plain ARGUMENT, which no catch clause and
// no LEAVE ever sees. The core reads where the machine's stack ran out (a number set by the V8 build and arch) and branches on it.
// Safe behaviour: a core that overflows the stack is refused, however the RangeError reaches it.
// kanban #3540: the probe was String() of a 100000-deep array, which overflowed on the arm64 laptop it was sized on and fits on x86_64
// (node 24, CORE_STACK_MB 32). It was then Array.prototype.flat bound to an array that holds itself; since the cap on the built-ins that
// recurse on data (core-nest.js) refuses that at DEPTH_MAX, the reaction is Object.prototype.toLocaleString bound to an object whose
// toString is toLocaleString itself: a builtin as the job itself still (no core function on the stack), and a loop without end on one
// object, so it overflows on every machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCore } from '../src/core-sandbox.js';

test('#1489-r26-hosting-1: a builtin used directly as a promise reaction hides V8\'s stack overflow from the sticky check', () => {
  const src = `const loop = {}; loop.toString = Object.prototype.toLocaleString; const blow = Object.prototype.toLocaleString.bind(loop);
const SAID = await Promise.resolve(0).then(blow).then(() => 'fits', (e) => String(e && e.message));
const DEPTH = SAID.includes('call stack') ? 1 : 0;
export const DECIDE = { name: 'stack-' + DEPTH, decide(moves) { const out = {}; for (const m of moves) out[m.key] = DEPTH % 2 ? 'WIN' : 'LOSS'; return out; } };`;
  let box = null, why = 'loaded';
  try { box = loadCore({ files: new Map([['core.mjs', src]]), entry: 'core.mjs' }, { name: 'stack-reader-r26' }); } catch (e) { why = e.message; }
  let verdict = null;
  if (box) {
    try { verdict = box.call('decide', { moves: [{ key: 'a', move: 0 }, { key: 'b', move: 1 }] }); } catch (e) { why = e.message; }
    console.log(`meta.name: ${box.meta.name} (stack-1 = the core read V8's overflow); decide: ${JSON.stringify(verdict)}; why: ${why}`);
    box.end();
  } else console.log(`refused: ${why}`);
  assert.equal(box, null, `the core read the stack's end (${box && box.meta.name}) and branched on it, and was not refused`);
  assert.match(why, /overflowed the stack/);
});

test('#2852: the same overflow reached through catch(Array.of) or Promise.allSettled is refused too', () => {
  for (const read of ['await Promise.resolve(0).then(blow).catch(Array.of).then(([e]) => String(e && e.message))',
    'await Promise.allSettled([Promise.resolve(0).then(blow)]).then(([s]) => String(s.reason && s.reason.message))']) {
    const src = `const loop = {}; loop.toString = Object.prototype.toLocaleString; const blow = Object.prototype.toLocaleString.bind(loop);
const SAID = ${read};
export const DECIDE = { name: 'stack-' + (SAID.includes('call stack') ? 1 : 0), decide(moves) { const out = {}; for (const m of moves) out[m.key] = 'WIN'; return out; } };`;
    let box = null, why = 'loaded';
    try { box = loadCore({ files: new Map([['core.mjs', src]]), entry: 'core.mjs' }, { name: 'stack-reader-2852' }); } catch (e) { why = e.message; }
    if (box) box.end();
    assert.equal(box, null, `loaded as ${box && box.meta.name}: ${read}`);
    assert.match(why, /overflowed the stack/, read);   // kanban #3540: refused for the overflow, not for a load deadline
  }
});
