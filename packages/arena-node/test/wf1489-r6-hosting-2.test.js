// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 round 6 (hosting): ONE GAME'S CORE ENDS ANOTHER GAME'S CORE, FOR GOOD.
// The RSS backstop (core-supervisor.js) ends a core when THE PROCESS has grown past the trigger (416 MB) since that core's call
// began - process.memoryUsage.rss(), the whole process, every thread. Cores of other games run in other threads at the same
// time (each replay is its own worker with its own supervisor and core threads; the warm ghost and decide run in the node's
// thread). A hostile game's core keeps arrays alive across calls - each call well inside its own 64 MB budget, its total inside
// its 256 MB live cap, so it is never ended itself - and an honest core whose call spans that growth is ended as if it had
// grown the node: "the core grew this node by N MB ... it is not run again". In the node's own thread the ended sandbox stays
// cached and asked for (askedAt is refreshed on every ask), so the honest game is dead on that seat until it restarts.
// Safe behaviour: an honest core that allocates nothing answers, whatever other cores in the process allocate meanwhile.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { sandboxFor } from '../src/core-sandbox.js';

const DIR = mkdtempSync(join(tmpdir(), 'wf1489-r6-h2-'));
const coreFile = (name, src) => { const f = join(DIR, `${name}.mjs`); writeFileSync(f, src); return { name, hash: createHash('sha256').update(src).digest('hex'), url: pathToFileURL(f).href }; };

// the honest core: allocates nothing, computes for a few seconds
const honest = coreFile('honest', `export const CORE = { name: 'honest', RUN_TICKS: 10, runTicks(c) { let x = 0; for (let i = 0; i < 2500000000; i++) x = (x + i) | 0; return 10 + (x & 0); },
  start: () => ({}), eventsOf: () => ({ count: {}, before() {} }), step() {}, stateHash: () => 'h', result: () => ({ outcome: 'DELIVERED', score: 0, heat: 0 }) };`);

// the hostile game's cores (another thread, as a replay worker is): 60 MB per call, kept - inside every limit of its own
const helper = join(DIR, 'helper.mjs');
writeFileSync(helper, `import { parentPort } from 'node:worker_threads';
import { sandboxFor } from ${JSON.stringify(new URL('../src/core-sandbox.js', import.meta.url).href)};
const hogs = ${JSON.stringify([1, 2, 3].map((i) => i))}.map((i) => ({ name: 'hog' + i, hash: process.env['H' + i], url: process.env['U' + i] }));
const boxes = hogs.map((h) => sandboxFor(h));
parentPort.postMessage('ready');
parentPort.once('message', () => {
  const said = [];
  for (const b of boxes) for (let k = 0; k < 4; k++) { try { b.call('decide', { moves: [] }); said.push('ok'); } catch (e) { said.push(e.message); } }
  parentPort.postMessage(said);
  setTimeout(() => {}, 20000);
});`);
const hogs = [1, 2, 3].map((i) => coreFile(`hog${i}`, `const kept = []; // ${i}
export const DECIDE = { name: 'hog ${i}', decide(moves) { const a = new Uint8Array(60 * 1048576); a.fill(${i}); kept.push(a); return {}; } };`));

test('#1489 r6 hosting-2: an honest core that allocates nothing is not ended for another game\'s core\'s memory', async () => {
  const env = {};
  hogs.forEach((h, i) => { env['H' + (i + 1)] = h.hash; env['U' + (i + 1)] = h.url; });
  const w = new Worker(helper, { env });
  try {
    await new Promise((ok, no) => { w.once('message', ok); w.once('error', no); });
    const box = sandboxFor(honest, { askMs: 60000 });
    const helperSaid = new Promise((ok) => w.once('message', ok));
    w.postMessage('go');
    let first = null, again = null;
    try { first = box.call('runTicks', { config: {} }); } catch (e) { first = e.message; }
    const hogsSaid = await helperSaid;
    assert.deepEqual(hogsSaid, Array(12).fill('ok'), 'the hostile cores themselves stay inside every limit and are never ended');
    try { again = sandboxFor(honest).call('runTicks', { config: {} }); } catch (e) { again = e.message; }
    assert.deepEqual([first, again], [10, 10], `the honest core's call: ${first} | asked again later: ${again}`);
  } finally { await w.terminate(); }
});
