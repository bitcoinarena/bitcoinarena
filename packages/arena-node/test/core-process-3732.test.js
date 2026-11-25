// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3732: ONE CORE PROCESS PER CORE, not one for the seat. A core's run-time heap overrun can abort its whole process (V8's
// FatalProcessOutOfMemory, SIGABRT); with #3557's one shared process that took every other game's core thread with it
// (audit-hosting-a8-1-2.test.js). Here: two different cores run in two processes, two loads of the same core share one, a process
// killed from outside ends only its own core's calls, and what a process costs is printed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { loadCore } from '../src/core-sandbox.js';

const load = (src, o = {}) => loadCore({ files: new Map([['core.mjs', src]]), entry: 'core.mjs' }, o);
const game = (name) => `export const CORE = { name: '${name}', RUN_TICKS: 10, INPUT_WORDS: 5, start: () => ({ t: 0 }), eventsOf: () => ({ count: {}, before() {} }),
  step(st) { st.t++; }, picture: (st) => ({ x: st.t, z: 0, heading: 0 }), stateHash: (st) => 'h' + st.t, result: (st) => ({ outcome: 'DELIVERED', score: st.t, heat: 0 }) };`;

/** The node processes running core-runner.js below this one (the runner itself, not a bwrap around it). */
function runners() {
  const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,rss=,args='], { encoding: 'utf8' }).split('\n')
    .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean).map(([, pid, ppid, rss, args]) => ({ pid: +pid, ppid: +ppid, rssKb: +rss, args }));
  const mine = new Set([process.pid]);
  for (let grew = true; grew;) { grew = false; for (const r of rows) if (mine.has(r.ppid) && !mine.has(r.pid)) { mine.add(r.pid); grew = true; } }
  return rows.filter((r) => r.pid !== process.pid && mine.has(r.pid) && /core-runner\.js$/.test(r.args) && !/bwrap/.test(r.args.split(' ')[0]));
}
/** The proportional set size of a process (its share of pages it shares with others), in kB, where /proc says it. */
const pssKb = (pid) => { try { return +(readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8').match(/^Pss:\s+(\d+)/m) || [])[1] || NaN; } catch { return NaN; } };

test('#3732: two different cores run in two core processes, two loads of the same core in one', () => {
  const a = load(game('a')), b = load(game('b')), a2 = load(game('a'));
  try {
    for (const box of [a, b, a2]) { const id = box.call('open', { seedWord: 1, config: {}, runTicks: 10 }); assert.ok(box.call('pose', { id })); }
    const rs = runners();
    console.log(`#3732 core processes for cores a, b, a again: ${rs.length} (${rs.map((r) => `${r.pid} rss ${Math.round(r.rssKb / 1024)} MB pss ${Math.round(pssKb(r.pid) / 1024)} MB`).join(', ')})`);
    assert.equal(rs.length, 2, 'one process for a\'s two loads and one for b');
  } finally { a.end(); b.end(); a2.end(); }
});

test('#3732: a core process killed from outside ends only its own core\'s calls; another core keeps answering', () => {
  const victim = load(game('victim'));
  const other = load(game('other'));
  try {
    const vid = victim.call('open', { seedWord: 1, config: {}, runTicks: 10 });
    const oid = other.call('open', { seedWord: 1, config: {}, runTicks: 10 });
    const before = new Set(runners().map((r) => r.pid));
    // kill the process that the victim's newest load started: the one that was not there before it
    const victim2 = load(game('victim-2'));
    const its = runners().find((r) => !before.has(r.pid));
    assert.ok(its, 'the new core started a process of its own');
    const v2id = victim2.call('open', { seedWord: 1, config: {}, runTicks: 10 });
    process.kill(its.pid, 'SIGABRT');
    let why = null;
    for (let i = 0; i < 50 && !why; i++) { try { victim2.call('pose', { id: v2id }); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20); } catch (e) { why = e.message; } }
    console.log(`#3732 the killed process's core: ${why}`);
    assert.match(String(why), /core process ended/);
    assert.ok(victim.call('pose', { id: vid }), 'a core of another process still answers');
    assert.ok(other.call('pose', { id: oid }), 'a core of another process still answers');
    victim2.end();
  } finally { victim.end(); other.end(); }
});
