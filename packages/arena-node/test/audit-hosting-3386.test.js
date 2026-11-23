// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3386 (gap in #3067): instrumentCore wraps every default value and every class field initializer in an arrow of its own,
// which V8 compiles like any other function, and none of them was counted against CORE_FUNCTIONS_MAX. A 1.37 MB core of 350,000
// `x=0` destructuring defaults and one real function became 40 MB of source and 350,000 functions; its compile ran the core's
// thread out of heap inside CompileModule and aborted the whole seat process (SIGABRT), and worker.terminate() during the compile
// does not stop that. Safe: every wrapper is charged, the parse stops at CORE_TOKENS_MAX, the instrumented text is bounded, the
// package is refused and the seat process lives; what does pass the bounds compiles in half the core thread's heap.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { instrumentCore, coreBudget, CORE_FUNCTIONS_MAX, CORE_TOKENS_MAX } from '../src/core-depth.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ADAPTER = "export const DECIDE = { name: 'many', decide(moves) { const out = {}; for (const m of moves) out[m.key] = 'DRAW'; return out; } };\n";
const tooBig = /the core is too large/;

test('#3386 a package of 350,000 destructuring defaults is refused, and the seat process lives', { timeout: 240000 }, () => {
  const CHILD = `
import { createHash } from 'node:crypto';
import { verifyPackage } from '../src/plugin-package.js';
import { PEER_PACKAGE_BYTES } from '../src/peer-read.js';
import { verifyEd25519 } from '../src/ed25519.js';
import { testHeadToHeadGame, testDonationSet } from './plugins/sign.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { encodeManifest, gameIdOf } from '../../arena-protocol/src/manifest.js';
const sha = (b) => createHash('sha256').update(b).digest('hex');
const name = 'many';
const src = ${JSON.stringify(ADAPTER)} + 'let x;[' + 'x=0,'.repeat(350000) + ']=[];\\n';
const core = { name, hash: sha(Buffer.from(src)), configs: new Map([['11'.repeat(32), {}]]) };
const game = testHeadToHeadGame({ name, core, moveCount: 3 });
const pkg = { format: 'arena-plugin/v1', name, manifest: toHex(encodeManifest(game.manifest)),
  donationSet: testDonationSet(name).map((r) => ({ recipientPk: toHex(r.recipientPk), shareBps: r.shareBps, label: r.label })),
  cores: [{ hash: core.hash, name, configs: ['11'.repeat(32)], source: Buffer.from(src).toString('base64') }], clients: [] };
if (Buffer.byteLength(JSON.stringify(pkg)) > PEER_PACKAGE_BYTES) throw new Error('package over the peer bound');
const t0 = Date.now();
const v = verifyPackage(pkg, { verify: verifyEd25519, want: toHex(gameIdOf(game.manifest)) });
const held = Date.now() - t0;
await new Promise((r) => setTimeout(r, 3000));   // a thread that dies after the answer still takes the process
console.log('RESULT ' + JSON.stringify({ ok: v.ok, held, why: String(v.why || '').slice(0, 200) }));
`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', CHILD], { cwd: HERE, encoding: 'utf8', timeout: 200000, maxBuffer: 1 << 24 });
  const said = (r.stdout.match(/RESULT (.*)/) || [])[1];
  console.log(`  MEASURED: status ${r.status} signal ${r.signal} said ${said} stderr ${String(r.stderr).split('\n').filter((l) => /memory|Error/i.test(l)).slice(0, 2).join(' | ')}`);
  assert.equal(r.signal, null, `the seat process was killed by ${r.signal}`);
  assert.equal(r.status, 0, 'the seat process exits normally');
  const v = JSON.parse(said);
  assert.equal(v.ok, false, 'the package is refused');
  assert.match(v.why, tooBig, 'refused by the size bound, before any thread compiles it');
});

test('#3386 every default value and class field instrumentCore wraps costs one function', () => {
  const n = CORE_FUNCTIONS_MAX;
  assert.throws(() => instrumentCore(`let x;[${'x=0,'.repeat(n + 1)}]=[];`), tooBig, 'destructuring defaults');
  assert.throws(() => instrumentCore(`function g(${Array.from({ length: n + 1 }, (_, i) => `a${i}=0`).join(',')}){}`), tooBig, 'parameter defaults');
  assert.throws(() => instrumentCore(`class C{${'x=0;'.repeat(n + 1)}}`), tooBig, 'class fields');
  // wrappers and functions share one budget, over all of the core's files
  const budget = coreBudget();
  instrumentCore(`let x;[${'x=0,'.repeat(n / 2)}]=[];`, 'a.js', budget);
  assert.throws(() => instrumentCore(`export const S=[${'()=>0,'.repeat(n / 2 + 1)}];`, 'b.js', budget), tooBig, 'the second file pays for the first');
  // under the bound, both still instrument (the depth count of #2837 and the field initializers are unchanged)
  assert.match(instrumentCore(`let x;[${'x=0,'.repeat(n - 10)}]=[];`), /\(\(\)=>\{__arena\$e\(\);try\{return \(0\);/);
  assert.match(instrumentCore('class C{ a = 1; b; }'), /a = \(\(\)=>\{__arena\$e\(\);try\{return \(1\);/);
});

test('#3386 the parse stops at CORE_TOKENS_MAX tokens, and the instrumented text is bounded before it is joined', () => {
  assert.throws(() => instrumentCore(`export const B=[${'0,'.repeat(CORE_TOKENS_MAX)}];`), tooBig, 'tokens');
  instrumentCore(`export const B=[${'0,'.repeat(CORE_TOKENS_MAX / 2 - 20)}];`);
  // the other bounds keep any core well below CORE_INSTRUMENTED_MAX, so the output bound is shown with a smaller budget
  const src = 'try{}finally{}'.repeat(1000);
  const plain = instrumentCore(src).length;
  assert.throws(() => instrumentCore(src, 'core', { ...coreBudget(), out: plain - 1 }), tooBig, 'one byte short of the instrumented text');
  assert.equal(instrumentCore(src, 'core', { ...coreBudget(), out: plain }).length, plain);
});

test('#3386 the shipped cores fit every bound with room to spare', () => {
  const dir = fileURLToPath(new URL('../../../src/arena-ui/', import.meta.url));
  const files = readdirSync(dir).filter((f) => /core.*\.js$/.test(f) && !/arena-client/.test(f));
  assert.ok(files.length > 0, 'shipped cores found');
  for (const f of files) {
    const budget = coreBudget(), full = coreBudget();
    instrumentCore(readFileSync(dir + f, 'utf8'), f, budget);
    for (const k of Object.keys(full)) assert.ok(full[k] - budget[k] < full[k] / 4, `${f} uses ${full[k] - budget[k]} of ${full[k]} ${k}`);
  }
});

test('#3386 what passes the bounds compiles in half the core thread\'s heap', { timeout: 240000 }, () => {
  // the heaviest shapes measured at the bounds (their largest accepted size), each compiled in a worker as core-host.js does, in a
  // child process so a fatal OOM fails this test and not the runner
  const CHILD = `
import { Worker } from 'node:worker_threads';
import { instrumentCore, CORE_FUNCTIONS_MAX as F, CORE_TOKENS_MAX as T } from '../src/core-depth.js';
import { HEAP_LIMITS } from '../src/core-sandbox.js';
const shapes = {
  defaults_then_finally: "let x;[" + 'x=0,'.repeat(F - 40) + "]=[];\\n" + 'try{}finally{}'.repeat(Math.floor((T - 4 * (F - 40) - 200) / 6)),
  try_finally_tokens: 'try{}finally{}'.repeat(Math.floor((T - 200) / 6)),
  destructure_catch: 'try{}catch({a}){}'.repeat(Math.floor((T - 200) / 11)),
};
const heap = { maxOldGenerationSizeMb: HEAP_LIMITS.maxOldGenerationSizeMb / 2, maxYoungGenerationSizeMb: HEAP_LIMITS.maxYoungGenerationSizeMb };
const body = "const { parentPort, workerData } = require('node:worker_threads'); const vm = require('node:vm');"
  + "new vm.SourceTextModule(workerData.text, { context: vm.createContext({}) });"
  + "parentPort.postMessage(Math.round(require('node:v8').getHeapStatistics().used_heap_size / 1048576));";
for (const [name, src] of Object.entries(shapes)) {
  const text = instrumentCore(${JSON.stringify(ADAPTER)} + src);
  const said = await new Promise((done) => {
    const w = new Worker(body, { eval: true, workerData: { text }, resourceLimits: heap, execArgv: ['--experimental-vm-modules', '--disable-warning=ExperimentalWarning'] });
    w.on('message', (mb) => done({ mb })); w.on('error', (e) => done({ error: e.code || e.message }));
  });
  console.log('RESULT ' + JSON.stringify({ name, instrumentedMb: +(text.length / 1048576).toFixed(2), ...said }));
}
`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', CHILD], { cwd: HERE, encoding: 'utf8', timeout: 200000, maxBuffer: 1 << 24 });
  const said = [...r.stdout.matchAll(/RESULT (.*)/g)].map((m) => JSON.parse(m[1]));
  console.log(`  MEASURED: status ${r.status} signal ${r.signal} ${JSON.stringify(said)} ${String(r.stderr).match(/FATAL[^\n]*|Error[^\n]*/)?.[0] || ''}`);
  assert.equal(r.signal, null, `the compile took the process: ${r.signal}`);
  assert.equal(r.status, 0);
  assert.equal(said.length, 3, 'every shape answered');
  for (const s of said) assert.ok(s.mb !== undefined, `${s.name} compiles in half the heap (${s.error})`);
});
