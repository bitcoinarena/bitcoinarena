// kanban #1489 r30-hosting-2: bypass of #3558. #3558 bounded a core's {"$big": digits} before the seat's own thread parses it
// (4 MB of digits cost ~1 s per decide). The sibling tag {"$u8": hex} in the same revive (core-sandbox.js) has no bound: a decide
// adapter (any game dev's App Store package) answers one 4 MB hex string and the seat's thread runs match(/../g) over it - 2 M
// strings - and parseInt on each, building a 2 MB Uint8Array the node never asked for. decide is not cached; every head-to-head
// close of that game on every seat that hosts it pays it. Safe behaviour: such an answer is refused (as a $big past BIG_DIGITS_MAX)
// and the seat's thread is not held for it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCore } from '../src/core-sandbox.js';

const load = (src, o = {}) => loadCore({ files: new Map([['core.mjs', src]]), entry: 'core.mjs' }, o);

test('r30-hosting-2: a decide answering a 4 MB $u8 is refused, not parsed in the seat thread', async () => {
  const box = load(`const H = 'ab'.repeat(1999990);
export const DECIDE = { name: 'u8', decide(moves) { return { a: { outcome: 'WIN', score: 1, tag: { $u8: H } } }; } };`);
  try {
    // the core's own time (its thread) measured apart: a call that answers a tiny value
    let got, err = null;
    const t0 = performance.now();
    try { got = await box.callAsync('decide', { moves: [], config: {} }); } catch (e) { err = e; }
    const ms = performance.now() - t0;
    // the part of it spent in this thread: the revive alone, timed on the same answer text
    const json = JSON.stringify({ a: { outcome: 'WIN', score: 1, tag: { $u8: 'ab'.repeat(1999990) } } });
    const t1 = performance.now();
    JSON.parse(json, (k, x) => (x && typeof x === 'object' && typeof x.$u8 === 'string' && Object.keys(x).length === 1
      ? Uint8Array.from(x.$u8.match(/../g) || [], (h) => parseInt(h, 16)) : x));
    const reviveMs = performance.now() - t1;
    console.log(`  decide answered ${err ? `refused: ${String(err.message).slice(0, 120)}` : `a ${got && got.a && got.a.tag && got.a.tag.length}-byte Uint8Array`} in ${ms.toFixed(0)} ms; the $u8 revive alone holds the seat thread ${reviveMs.toFixed(0)} ms`);
    assert.ok(err, `a 4 MB $u8 answer was parsed in the seat's thread (${got && got.a && got.a.tag && got.a.tag.length} bytes, revive ${reviveMs.toFixed(0)} ms per decide)`);
  } finally { box.end(); }
});
