// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A STALL NAMES WHAT HELD THE LOOP, OR SAYS NOTHING NAMED DID (2026-09-17 19:15, the ghost lag).
//
// Measured from outside the Daily, 32 of the 34 stalls over 300 ms left had no phase name: a pinger can only say WHEN
// a node stopped answering. A stall cannot be read off a stack of what is open either - a timer cannot fire while the
// loop is held, so by the time the watcher runs the phase has returned. So every timed phase writes down the window it
// held and a stall is named by the windows inside it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timed, watchLoop, heldRecently } from '../src/slow.js';

const spin = (ms) => { const t = Date.now(); while (Date.now() - t < ms); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('a stall is named by the timed phase that ran inside it', async () => {
  const said = [];
  const watch = watchLoop({ every: 20, over: 80, say: (l) => said.push(l) });
  try {
    timed('a long sum', () => spin(200), { over: 1e9 });     // its own logging off: the watcher is what is measured
    await wait(120);
    assert.equal(said.length, 1, `the watcher said ${said.length} things: ${said.join(' | ')}`);
    assert.match(said[0], /the loop was held \d+ ms and in it ran 1 phase\(s\) totalling \d+ ms, longest a long sum \d+ ms/);
    // AND WHETHER THIS PROCESS WAS RUNNING: a spin uses the processor, so the line says so and does not blame the host.
    assert.match(said[0], /this thread used \d+ ms of processor in it/);
    assert.equal(/waiting for the machine/.test(said[0]), false, 'a spin was blamed on the machine');

    // AND A STALL IN SOMETHING NOBODY TIMED SAYS SO, in those words: that is the fact that says what to time next.
    said.length = 0;
    spin(200);
    await wait(120);
    assert.equal(said.length, 1, said.join(' | '));
    assert.match(said[0], /by something nobody timed/);

    // A LOOP HELD WITHOUT THIS PROCESS RUNNING SAYS THE MACHINE, not a phase: a sleeping timer thread is the same
    // shape as a descheduled process, which is what a host carrying a bitcoind at five cores does to a signer node.
    said.length = 0;
    const { execFileSync } = await import('node:child_process');
    execFileSync('sleep', ['0.25']);                 // the loop is held and this process burns nothing
    await wait(120);
    assert.equal(said.length, 1, said.join(' | '));
    assert.match(said[0], /waiting for the machine, not for itself/);

    // A QUIET LOOP SAYS NOTHING.
    said.length = 0;
    await wait(200);
    assert.deepEqual(said, []);
  } finally { watch.stop(); }
});

test('a phase too short to hold anything is not written down, and the ring is bounded', () => {
  const before = heldRecently().length;
  for (let i = 0; i < 50; i++) timed('a quick one', () => {}, { over: 1e9 });
  assert.equal(heldRecently().length, before, 'a phase under 5 ms was written down');
  for (let i = 0; i < 300; i++) timed('a slow one', () => spin(6), { over: 1e9 });
  assert.ok(heldRecently().length <= 2048, `the ring holds ${heldRecently().length}`);
  assert.equal(heldRecently().at(-1).label, 'a slow one');
});
