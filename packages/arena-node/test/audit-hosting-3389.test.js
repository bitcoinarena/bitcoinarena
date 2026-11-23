// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3389: a core that runs out of heap WHILE V8 COMPILES IT must not abort the seat, whatever the size bounds let through.
// Measured before the fix (test laptop, node 24): core-depth.js bounds raised, a DECIDE adapter plus 400,000 `(a)=>a` in a core thread
// of 16 MB old generation - the seat process died, exit 134, "FATAL ERROR: Reached heap limit Allocation failed" (the same with
// 1.8M at the shipped 128 MB, #3067's package). Now the core is compiled first in a process of its own (core-compile-apart.js):
// the seat stands in a child process here, and must exit normally with the core refused - and a normal core still loads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compileApart, apartMb } from '../src/core-compile-apart.js';

const SEAT = `
import { loadCore } from '../src/core-sandbox.js';
const DECIDE = "export const DECIDE = { name: 'big', decide(moves) { const out = {}; for (const m of moves) out[m.key] = 'DRAW'; return out; } };\\n";
const heap = { maxOldGenerationSizeMb: 16, maxYoungGenerationSizeMb: 2 };
const budget = { bytes: 64 * 1024 * 1024, functions: 4000000 };
const out = {};
try { const c = loadCore({ files: new Map([['core.mjs', DECIDE + 'export const F = [' + '(a)=>a,'.repeat(400000) + '];\\n']]), entry: 'core.mjs' }, { heap, budget, name: 'big' }); out.big = 'loaded'; c.end(); }
catch (e) { out.big = String(e.message).slice(0, 200); }
try { const c = loadCore({ files: new Map([['core.mjs', DECIDE]]), entry: 'core.mjs' }, { heap, name: 'small' }); out.small = c.meta.decide; c.end(); }
catch (e) { out.small = String(e.message).slice(0, 200); }
await new Promise((r) => setTimeout(r, 2000));   // a thread that dies after the answer still takes the process
console.log('RESULT ' + JSON.stringify(out));
`;

test('#3389 a core that overruns the heap while it compiles is refused, and the seat process lives', { timeout: 150000 }, () => {
  const dir = fileURLToPath(new URL('.', import.meta.url));
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', SEAT], { cwd: dir, encoding: 'utf8', timeout: 120000, maxBuffer: 1 << 24 });
  const said = (r.stdout.match(/RESULT (.*)/) || [])[1];
  console.log(`  MEASURED: status ${r.status} signal ${r.signal} said ${said} stderr ${String(r.stderr).split('\n').filter((l) => /memory|FATAL/i.test(l)).slice(0, 2).join(' | ')}`);
  assert.equal(r.signal, null, `the seat process was killed by ${r.signal}`);
  assert.equal(r.status, 0, 'the seat process exits normally');
  const o = JSON.parse(said);
  assert.match(o.big, /runs out of heap while it compiles/);
  assert.equal(o.small, true, 'a normal core still loads under the same heap');
});

test('#3389 compileApart: a normal core compiles, a syntax error is left to the core thread, the child gets less heap than the thread', () => {
  assert.deepEqual(compileApart(new Map([['core.mjs', 'export const A = 1;\n']]), { maxOldGenerationSizeMb: 128 }, 10000), { ok: true });
  assert.equal(compileApart(new Map([['core.mjs', 'export const = ;\n']]), { maxOldGenerationSizeMb: 128 }, 10000).ok, true);
  assert.equal(apartMb(128), 112);
  assert.equal(apartMb(16), 12);
  assert.ok(apartMb(4) >= 4);
});
