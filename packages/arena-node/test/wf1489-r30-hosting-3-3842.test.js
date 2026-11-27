// kanban #1489 r30-hosting-3: since #3732 every core (its files' hash) gets a node process of its own, kept IDLE_MS (60 s) after its last
// thread ends - and nothing bounds how many there are. One signed version may name MAX_PACKAGE_CORES (32) cores; registrationFromPackage
// and hostedPlugins load each of them at install, at every autoUpdate take and at every start (sandboxChecked), so a game developer's
// package of 32 tiny cores starts 32 core processes on the seat at once, each a whole node runtime. Before #3732 these were 32 threads in one
// process. Safe behaviour: the core processes a seat runs at once are bounded (or a checked core's process is not kept idle), so one
// package cannot multiply the seat's memory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { sandboxChecked } from '../src/core-sandbox.js';

const coreProcesses = () => execFileSync('ps', ['-A', '-o', 'pid=,ppid=,rss=,command='], { encoding: 'utf8' }).split('\n')
  .map((l) => l.trim().split(/\s+/)).filter((f) => f.length > 3 && Number(f[1]) === process.pid && f.slice(3).join(' ').includes('core-runner.js'))
  .map((f) => ({ pid: Number(f[0]), rssKb: Number(f[2]) }));

test('r30-hosting-3: one 32-core package does not start 32 core processes on the seat', { timeout: 120000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'r30-hosting-3-'));
  const before = coreProcesses().length;
  for (let i = 0; i < 32; i++) {
    const src = `export const DECIDE = { name: 'c${i}', decide(moves) { const o = {}; for (const m of moves) o[m.key] = 'DRAW'; return o; } };\n`;
    const file = join(dir, `core-${i}.mjs`);
    writeFileSync(file, src);
    sandboxChecked({ name: `c${i}`, hash: createHash('sha256').update(src).digest('hex'), url: pathToFileURL(file).href });
  }
  const live = coreProcesses();
  const mb = Math.round(live.reduce((s, p) => s + p.rssKb, 0) / 1024);
  console.log(`  core processes before ${before}, after loading one 32-core package's cores: ${live.length}, ${mb} MB RSS together`);
  assert.ok(live.length - before <= 4, `one package's cores left ${live.length - before} core processes running (${mb} MB RSS)`);
});
