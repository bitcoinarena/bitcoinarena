// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3557 (RCE audit #3552, medium): A GAME'S CORE DOES NOT RUN IN THE PROCESS THAT HOLDS THE SEAT'S KEYS. Each core ran in a
// vm context in a worker thread of the seat process - the same address space and user as the seat's identity secret, its DKG shares
// and the guardian admin password - so one V8 or vm escape was all of them (node says vm is not a security boundary). Now the core
// threads run in a child process (core-runner.js) started with an empty environment under node's permission model (it reads only the
// node's own code, writes nothing, starts no process), inside bubblewrap where the machine has it (no network, none of the seat's files).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import * as sandbox from '../src/core-sandbox.js';
import * as supervisor from '../src/core-supervisor.js';

const DIR = mkdtempSync(join(tmpdir(), 'core-process-3557-'));
const load = (src, o = {}) => sandbox.loadCore({ files: new Map([['core.mjs', src]]), entry: 'core.mjs' }, o);

/** Every process below this one whose command line names `what` (its pid and command). */
function descendants(what) {
  const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,args='], { encoding: 'utf8' }).split('\n')
    .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean).map(([, pid, ppid, args]) => ({ pid: +pid, ppid: +ppid, args }));
  const mine = new Set([process.pid]);
  for (let grew = true; grew;) { grew = false; for (const r of rows) if (mine.has(r.ppid) && !mine.has(r.pid)) { mine.add(r.pid); grew = true; } }
  return rows.filter((r) => r.pid !== process.pid && mine.has(r.pid) && r.args.includes(what));
}

test('#3557: a core runs in a process of its own, not in the seat\'s', () => {
  const box = load(`export const DECIDE = { name: 'here', decide() { return 'DRAW'; } };`, { oneThread: true });
  try {
    assert.equal(box.call('decide', { moves: [], config: {} }), 'DRAW');
    const runners = descendants('core-runner.js');
    console.log(`#3557 core processes under this seat: ${runners.map((r) => `${r.pid} ${r.args.slice(0, 160)}`).join(' | ') || 'none'}`);
    assert.ok(runners.length >= 1, 'no core process: the core ran in a thread of the seat process');
  } finally { box.end(); }
});

test('#3557: the core process reads no file of the seat\'s, starts no process and has no environment', () => {
  assert.equal(typeof supervisor.runnerCommand, 'function', 'there is no core process command');
  const secret = join(DIR, 'seat-identity.secret');
  writeFileSync(secret, 'not for a core');
  const [cmd, args] = supervisor.runnerCommand();
  // the core process's own command, its script swapped for what an escaped core would try first
  const probe = `import { readFileSync } from 'node:fs'; import cp from 'node:child_process';
const out = {};
try { readFileSync(${JSON.stringify(secret)}, 'utf8'); out.read = 'READ'; } catch (e) { out.read = e.code; }
try { cp.execFileSync('/bin/sh', ['-c', 'true']); out.spawn = 'SPAWNED'; } catch (e) { out.spawn = e.code; }
out.env = Object.keys(process.env).filter((k) => !/^(NODE_CHANNEL_|__CF_)/.test(k) && !(k === 'PWD' && process.env.PWD === '/'));
console.log(JSON.stringify(out));`;
  const r = spawnSync(cmd, [...args.slice(0, -1), '--input-type=module', '-e', probe], { env: {}, encoding: 'utf8', timeout: 30000 });
  const said = JSON.parse(String(r.stdout).trim().split('\n').pop() || '{}');
  console.log(`#3557 the core process (${cmd.split('/').pop()}): ${JSON.stringify(said)}`);
  assert.notEqual(said.read, 'READ', 'the core process read a file of the seat\'s');
  assert.ok(['ERR_ACCESS_DENIED', 'ENOENT'].includes(said.read), `read: ${said.read}`);
  assert.notEqual(said.spawn, 'SPAWNED', 'the core process started a process');
  assert.deepEqual(said.env, []);
});

test('#3557: a core process that dies takes only its cores: the call fails, the next core starts a new process', () => {
  const box = load(`export const DECIDE = { name: 'spin', decide(m) { if (m[0] === 7) { let i = 1; while (i > 0) i++; } return 'DRAW'; } };`, { oneThread: true });
  const before = descendants('core-runner.js').map((r) => r.pid);
  assert.ok(before.length >= 1);
  // the process ended from outside while the core spins (what a crash in it, or the kernel's OOM killer, does)
  spawnSync('/bin/sh', ['-c', `(sleep 0.3; kill -9 ${before.join(' ')}) >/dev/null 2>&1 &`]);
  const t0 = Date.now();
  let why = null;
  try { box.call('decide', { moves: [7], config: {} }); } catch (e) { why = e.message; }
  const ms = Date.now() - t0;
  console.log(`#3557 core process killed mid-call: ${why} (${ms} ms)`);
  assert.match(String(why), /core process ended|died/);
  assert.ok(ms < 1900, `the node waited ${ms} ms for a core whose process was gone`);
  const again = load(`export const DECIDE = { name: 'after', decide() { return 'WIN'; } };`);
  try { assert.equal(again.call('decide', { moves: [], config: {} }), 'WIN'); } finally { again.end(); }
  assert.ok(descendants('core-runner.js').every((r) => !before.includes(r.pid)));
});

test('#3557: what a call costs through the core process (printed for the card)', async () => {
  const kept = load(`export const CORE = { name: 'cost', RUN_TICKS: 10, INPUT_WORDS: 5, start: () => ({ t: 0 }), eventsOf: () => ({ count: {}, before() {} }),
    step(st) { st.t++; }, picture: (st) => ({ x: st.t, z: 0, heading: 0 }), stateHash: (st) => 'h' + st.t, result: (st) => ({ outcome: 'DELIVERED', score: st.t, heat: 0 }) };
export const DECIDE = { name: 'cost', decide() { return 'DRAW'; } };`);
  try {
    const id = kept.call('open', { seedWord: 1, config: {}, runTicks: 10 });
    let t0 = performance.now();
    for (let i = 0; i < 200; i++) kept.call('pose', { id });
    const poseMs = (performance.now() - t0) / 200;
    t0 = performance.now();
    for (let i = 0; i < 20; i++) kept.call('decide', { moves: [], config: {} });
    const freshMs = (performance.now() - t0) / 20;
    t0 = performance.now();
    for (let i = 0; i < 20; i++) await kept.callAsync('decide', { moves: [], config: {} });
    const asyncMs = (performance.now() - t0) / 20;
    console.log(`#3557 per call: kept thread ${poseMs.toFixed(2)} ms, a call's own thread ${freshMs.toFixed(1)} ms (async ${asyncMs.toFixed(1)} ms)`);
    assert.ok(poseMs < 50 && freshMs < 500);
  } finally { kept.end(); }
});
