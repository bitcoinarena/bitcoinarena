// kanban #1489 round 5 (hosting): A CORE'S ANSWER IS UNBOUNDED, AND IT IS READ IN THE NODE'S OWN THREAD.
// core-sandbox.js waits for each core call against a deadline (ASK_MS 2 s for decide/meta/runTicks) and bounds the core's
// memory by its heap limit, its array budget and the RSS backstop - all while the core runs. The answer is then copied into
// the node's thread (receiveMessageOnPort) and parsed there with a reviver (`revive`), with no limit on its size. The driver
// runs in the core's realm and calls JSON.stringify as the core left it, so a core answers any JSON text it builds cheaply:
// a 32 MB '[0,0,0,...]' costs the core a String.prototype.repeat, and the node 16 million reviver calls and a 16-million-
// element array on its own heap, past every deadline and outside the backstop. verify.js asks the decide adapter on every
// head-to-head close; the plugin trial asks it up to 4000 times.
// Safe behaviour: one core call holds the node's thread no longer than its deadline - an answer the node cannot take in that
// time (or past a size bound) is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCore, ASK_MS } from '../src/core-sandbox.js';

test('#1489-r5-hosting-3: a core\'s oversized answer does not hold the node\'s thread past the call\'s deadline', () => {
  const src = `const N = 16 * 1048576;
const raw = JSON.stringify;
export const DECIDE = { name: 'flood', decide(moves) { JSON.stringify = (v) => (v && v.flood ? '[' + '0,'.repeat(N) + '0]' : raw(v)); return { flood: 1 }; } };`;
  const box = loadCore({ files: new Map([['core.mjs', src]]), entry: 'core.mjs' }, { name: 'flood' });
  try {
    const heap0 = process.memoryUsage().heapUsed;
    const t0 = Date.now();
    let got, why = 'answered';
    try { got = box.call('decide', { moves: [{ key: 'a', move: 0 }, { key: 'b', move: 1 }] }); } catch (e) { why = e.message; }
    const held = Date.now() - t0;
    const grewMb = Math.round((process.memoryUsage().heapUsed - heap0) / 1048576);
    console.log(`decide: held the node's thread ${held} ms (ASK_MS ${ASK_MS}); node heap grew ${grewMb} MB; ${why}${Array.isArray(got) ? ` (an array of ${got.length} elements)` : ''}`);
    assert.ok(held <= ASK_MS, `one decide call held the node's own thread ${held} ms, past its ${ASK_MS} ms deadline (${why})`);
  } finally { box.end(); }
});
