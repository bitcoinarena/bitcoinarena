// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpuSeconds, perfRecord, comparePerf } from '../src/perf-gate.js';

test('cpu time reads the forms ps writes', () => {
  assert.equal(cpuSeconds('0:01.50'), 1.5);
  assert.equal(cpuSeconds('01:02:03'), 3723);
  assert.equal(cpuSeconds('1-00:00:10'), 86410);
  assert.equal(cpuSeconds('2:03,25'), 123.25);
});

const sample = (atMs, storeKb, procs) => ({ atMs, storeKb, procs });
const p = (pid, program, cpuS, rssKb) => ({ pid, program, cpuS, rssKb });

test('a record: cpu used between first and last sample, a process that ended still counted, memory the highest moment', () => {
  const r = perfRecord({ label: 'x', plays: 4, samples: [
    sample(0, 1024, [p(1, 'node', 10, 2048), p(2, 'fedimintd', 5, 1024)]),
    sample(5000, 2048, [p(1, 'node', 12, 4096), p(2, 'fedimintd', 7, 1024), p(3, 'arena-stake-lock', 0, 1024)]),
    sample(10000, 5120, [p(1, 'node', 18, 2048), p(3, 'arena-stake-lock', 1, 1024)]),
  ] });
  assert.deepEqual(r.cpuByProgram, { node: 8, fedimintd: 2, 'arena-stake-lock': 1 });
  assert.equal(r.cpuSeconds, 11);
  assert.equal(r.cpuPerPlay, 2.75);
  assert.equal(r.cores, 1.1);
  assert.equal(r.rssMaxMb, 6);
  assert.equal(r.diskGrowthMb, 4);
  assert.equal(r.diskPerPlayMb, 1);
  assert.throws(() => perfRecord({ label: 'x', plays: 0, samples: [sample(0, 0, []), sample(1, 0, [])] }), /one play/);
});

test('the gate: past 15 % fails by name, inside it passes, noise under a floor says nothing', () => {
  const a = { cpuPerPlay: 10, rssMaxMb: 1000, diskPerPlayMb: 2 };
  assert.equal(comparePerf(a, { cpuPerPlay: 11, rssMaxMb: 1100, diskPerPlayMb: 2.2 }).ok, true);
  const bad = comparePerf(a, { cpuPerPlay: 12, rssMaxMb: 1000, diskPerPlayMb: 2 });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.rows.filter((r) => r.worse).map((r) => r.name), ['CPU per play']);
  assert.equal(comparePerf({ cpuPerPlay: 0.1, rssMaxMb: 10, diskPerPlayMb: 0.1 }, { cpuPerPlay: 0.5, rssMaxMb: 40, diskPerPlayMb: 0.5 }).ok, true);
});
