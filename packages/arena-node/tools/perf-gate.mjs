#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE RELEASE'S PERFORMANCE RUN (kanban #928). On a devnet that is up (tools/devnet.mjs up): the same plays, one after another, while every process of the devnet is sampled.
//
//   DEVNET_DIR=<dir> node tools/perf-gate.mjs record <label> [--plays 10] [--every 5] [--out perf]     writes perf/<label>.json
//   node tools/perf-gate.mjs compare <older.json> <newer.json>                                       exit 1 when the newer one is worse (src/perf-gate.js)
//
// Run it on a quiet machine, the same machine for both releases, on the code of the release it names: another load in the room is measured with it.
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpuSeconds, perfRecord, comparePerf, PERF_LIMIT } from '../src/perf-gate.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const flag = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function sampleOf(dir) {
  const groups = new Set(readdirSync(join(dir, 'pids')).filter((f) => f.endsWith('.pid')).map((f) => { try { return JSON.parse(readFileSync(join(dir, 'pids', f), 'utf8')).pgid; } catch { return null; } }).filter(Boolean));
  const rows = execFileSync('ps', ['-A', '-o', 'pid=,pgid=,rss=,time=,comm='], { encoding: 'utf8', maxBuffer: 1 << 24 }).split('\n').map((l) => l.trim().split(/\s+/)).filter((r) => r.length >= 5);
  const procs = rows.filter((r) => groups.has(Number(r[1]))).map((r) => ({ pid: Number(r[0]), program: basename(r.slice(4).join(' ')), rssKb: Number(r[2]), cpuS: cpuSeconds(r[3]) }));
  const storeKb = Number(execFileSync('du', ['-sk', dir], { encoding: 'utf8' }).split(/\s+/)[0]);
  return { atMs: Date.now(), storeKb, procs };
}

const play = () => new Promise((ok, no) => {
  const c = spawn(process.execPath, [join(HERE, 'devnet.mjs'), 'play'], { stdio: ['ignore', 'ignore', 'inherit'], env: process.env });
  c.on('exit', (code) => (code === 0 ? ok() : no(new Error(`a play ended with ${code}`))));
});

async function record(label) {
  if (!label) throw new Error('name the release: record <label>');
  const dir = resolve(process.env.DEVNET_DIR || 'devnet-data'), plays = Number(flag('plays', 10)), everyMs = Number(flag('every', 5)) * 1000, out = resolve(flag('out', 'perf'));
  const samples = [sampleOf(dir)];
  const timer = setInterval(() => { try { samples.push(sampleOf(dir)); } catch { /* the next one */ } }, everyMs);
  let done = 0;
  for (; done < plays; done++) { await play(); console.log(JSON.stringify({ play: done + 1, of: plays })); }
  clearInterval(timer);
  samples.push(sampleOf(dir));
  let commit = null; try { commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: HERE, encoding: 'utf8' }).trim(); } catch { /* an unpacked release */ }
  const r = perfRecord({ label, commit, plays: done, samples });
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `${label}.json`), `${JSON.stringify(r, null, 2)}\n`);
  console.log(JSON.stringify(r));
}

function compare(a, b) {
  const before = JSON.parse(readFileSync(a, 'utf8')), now = JSON.parse(readFileSync(b, 'utf8'));
  const c = comparePerf(before, now);
  for (const r of c.rows) console.log(`${r.worse ? 'WORSE' : 'ok   '} ${r.name}: ${r.before} -> ${r.now}${r.ratio === null ? '' : ` (x ${r.ratio})`}`);
  console.log(c.ok ? `${now.label} passes against ${before.label}` : `${now.label} FAILS against ${before.label}: more than x ${PERF_LIMIT}`);
  process.exit(c.ok ? 0 : 1);
}

const [cmd, a, b] = process.argv.slice(2);
if (cmd === 'record') await record(a);
else if (cmd === 'compare') compare(a, b);
else { console.error('use: record <label> | compare <older.json> <newer.json>'); process.exit(2); }
