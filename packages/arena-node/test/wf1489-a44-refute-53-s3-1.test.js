// kanban #1489 a44 refute #1695 (skeptic 3): AN ARRAY-LIKE'S LENGTH IS "ONLY A FIRST GUESS, COUNTED AGAIN BELOW" - BUT BELOW
// NEVER RUNS WHEN THE COPY THROWS. core-host.js's wrapped constructor takes x.length * size before the allocation (a core's
// array-like answers 0 there), lets V8 allocate the real length (read once more, now N), and counts the real byte length only
// after construct returns. V8 fills the new array through the array-like's own element getters - core code, after the
// allocation - so a getter that throws on the last index skips the after-count: N bytes allocated (and touched: undefined is
// NaN in a Float64Array), `used` never moves, `over` never set, the core catches the error and goes on. The original attack of
// #1695 ("gave its source an own length of 0") on an array-like source instead of a typed array.
// Safe behaviour: an allocation the per-call budget cannot hold is refused before it is made, or the call fails.
// (kanban #2475 fix) the wrapper now copies an array-like itself on ONE length read, as the spec does: a source that lies 0
// there gets a 0-length array, and its N-1 getter is never reached - nothing allocated. Each case is run with the lie on the
// first 1, 2 and 3 reads, and with no lie at all (N every read): refused, or no N-element array made (`reached` never set).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { sandboxFor } from '../src/core-sandbox.js';
import { trialRun } from '../src/plugin-trial.js';
import { RESULT_TYPE } from '../../arena-protocol/src/manifest.js';
import { scanSource } from '../src/plugin-check.js';

const DIR = mkdtempSync(join(tmpdir(), 'wf1489-a44-53-s3-'));
let n = 0;
function core(top, step) {
  const src = `${top}
const kept = [];
export const CORE = Object.freeze({
  name: 'hostile', RUN_TICKS: 10, INPUT_WORDS: 5,
  start: (seed) => ({ seed, t: 0 }),
  eventsOf: () => ({ count: { liquidations: 0, loads: 0, samples: 0, tapes: 0 }, before() {} }),
  step(st, w) { ${step}; st.t++; },
  stateHash: (st) => 'h:' + st.seed + ':' + st.t,
  result: (st) => ({ outcome: 'DELIVERED', score: kept.length, heat: 0 }),
});`;
  const file = join(DIR, `core-${++n}.js`);
  writeFileSync(file, src);
  return { name: `hostile ${n}`, hash: createHash('sha256').update(src).digest('hex'), url: pathToFileURL(file).href };
}
const MB = 1048576;
const REPLAY = { seedWord: 1, config: {}, runTicks: 10, start: 0, words: [[0, 0, 0, 0, 0]], events: {}, marks: [], pictures: [] };
const attempt = (c, budget = 4 * MB) => { try { const r = sandboxFor(c, { arrayBudget: budget }).call('replay', REPLAY); return `answered (${r.score} uncounted allocations)`; } catch (e) { return e.message; } };
// an array-like whose length reads 0 to the wrapper (it reads it twice) and N to V8; its last element's getter proves the
// N-element array exists, then throws so the after-count never runs
const TOP = (LIES) => `function lying(N) {
  let reads = 0, reached = false;
  const al = { get length() { return reads++ < ${LIES} ? 0 : N; } };
  Object.defineProperty(al, N - 1, { get() { reached = true; throw new Error('stop'); } });
  return { al, reached: () => reached };
}`;
const SAFE = /asked for more than 4 MB of arrays|answered \(0 uncounted allocations\)/;
const ONE = (N, K) => `if (st.t === 0) for (let i = 0; i < ${K}; i++) { const l = lying(${N}); try { new Float64Array(l.al); } catch {} if (l.reached()) kept.push(1); }`;

test('control: one honest 32 MB Float64Array under a 4 MB budget is refused', () => {
  assert.match(attempt(core('', 'if (st.t === 0) kept.push(new Float64Array(4 * 1048576))')), /asked for more than 4 MB of arrays/);
});

test('a44-53-s3: 8 x 32 MB Float64Arrays made from a lying array-like under a 4 MB budget are refused (256 MB past 4 MB)', () => {
  for (const lies of [0, 1, 2, 3]) {
    const got = attempt(core(TOP(lies), ONE(4 * MB, 8)));
    console.log(`8 x 32 MB, ${lies} lying reads: ${got}`);
    assert.match(got, lies === 0 ? /asked for more than 4 MB of arrays/ : SAFE);
  }
});

test('a44-53-s3: one 512 MB Float64Array (pages written) from a lying array-like under a 4 MB budget is refused', () => {
  const before = process.memoryUsage().rss;
  let peak = before;
  const tick = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 5);
  for (const lies of [0, 1, 2, 3]) {
    const got = attempt(core(TOP(lies), ONE(64 * MB, 1)));
    peak = Math.max(peak, process.memoryUsage().rss);
    console.log(`512 MB, ${lies} lying reads: ${got}`);
    assert.match(got, lies === 0 ? /asked for more than 4 MB of arrays/ : SAFE);
  }
  clearInterval(tick);
  peak = Math.max(peak, process.memoryUsage().rss);
  console.log(`rss before ${Math.round(before / MB)} MB, peak ${Math.round(peak / MB)} MB`);
  assert.ok(peak - before < 128 * MB, `the node grew by ${Math.round((peak - before) / MB)} MB`);
});

test('a44-53-s3: a plugin adapter making 64 MB per decide through a lying array-like does not pass the trial', () => {
  // the adapter answers DRAW only when its N-1 getter was never reached (no 64 MB array made); once it was, it answers junk,
  // which no trial passes - so a passing trial means nothing was allocated, and a refusal is the budget
  for (const lies of [0, 1, 2, 3]) {
    const adapter = `function lying(N, r) {
  let reads = 0;
  const al = { get length() { return reads++ < ${lies} ? 0 : N; } };
  Object.defineProperty(al, N - 1, { get() { r.reached = true; throw new Error('stop'); } });
  return al;
}
export const DECIDE = { name: 'hog', decide(moves) { const r = { reached: false }; try { new Float64Array(lying(8 * 1048576, r)); } catch {} const out = {}; for (const m of moves) out[m.key] = r.reached ? 'JUNK' : 'DRAW'; return out; } };`;
    assert.deepEqual(scanSource(adapter), [], 'the adapter passes the plugin scan');
    const t = trialRun(adapter, { resultType: RESULT_TYPE.HEAD_TO_HEAD, moveCount: 3, players: 2 });
    console.log(`trial, ${lies} lying reads: ok=${t.ok} cases=${t.cases} why=${t.why || ''}`);
    if (lies === 0) assert.equal(t.ok, false, 'an adapter asking for 64 MB per decide passed the trial');
    else if (t.ok) assert.ok(true, 'passed: its 64 MB array was never made');
    else assert.doesNotMatch(String(t.why), /JUNK|not one of|outcome/i, `refused for the junk answer - its 64 MB array was made: ${t.why}`);
  }
});
