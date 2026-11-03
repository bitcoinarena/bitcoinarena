// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A TOOL PAST ITS TIME IS ENDED, AND STAYS ENDED (kanban #1078): a `--mode status` run that timed out was sent SIGTERM once;
// the tool ignored it, so it ran on for good - 234 of them on one seat in 15 h, each waiting on the read directory's
// client.db.lock. The fake below never answers and ignores SIGTERM, as those did.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as lockPort from '../src/stake-lock-port.js';

const { stakeLockPort } = lockPort;
const KILL_GRACE_MS = lockPort.KILL_GRACE_MS ?? 2000;   // (a build before #1078 has no grace: it never kills)

const b = (n, len = 32) => new Uint8Array(len).fill(n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// a tool deaf to SIGTERM that never answers: in serve mode it says it is ready and then answers nothing
function deafTool() {
  const dir = mkdtempSync(join(tmpdir(), 'stake-lock-deaf-'));
  const pids = join(dir, 'pids'), bin = join(dir, 'tool');
  writeFileSync(bin, `#!${process.execPath}
const fs = require('fs');
process.on('SIGTERM', () => {});
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(pids)}, JSON.stringify({ pid: process.pid, mode: a[a.indexOf('--mode') + 1] }) + '\\n');
if (a.includes('serve')) console.log(JSON.stringify({ mode: 'serve', ready: true }));
setInterval(() => {}, 1000);
`);
  chmodSync(bin, 0o755);
  const started = () => (existsSync(pids) ? readFileSync(pids, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { dir, bin, started };
}
const reap = (t) => { for (const { pid } of t.started()) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } };

test('a status run past its timeout is killed, though it ignores SIGTERM; the caller is answered at the timeout', async () => {
  const t = deafTool();
  const port = stakeLockPort({ bin: t.bin, dataDir: '/shared', timeoutMs: 500, serve: false });
  try {
    const t0 = Date.now();
    await assert.rejects(port.status({ txid: b(1), outIdx: 0 }), /arena-stake-lock status timed out after 500 ms/);
    assert.ok(Date.now() - t0 < 1500, `answered at the timeout, not when the tool went (${Date.now() - t0} ms)`);
    const [run] = t.started();
    assert.equal(run.mode, 'status');
    assert.ok(alive(run.pid), 'still there inside the grace (SIGTERM ignored)');
    await sleep(KILL_GRACE_MS + 700);
    assert.equal(alive(run.pid), false, 'gone after the grace: SIGKILL');
  } finally { port.close(); reap(t); }
});

test('the read server that does not answer, and the one run asked after it, are both killed', async () => {
  const t = deafTool();
  const port = stakeLockPort({ bin: t.bin, dataDir: join(t.dir, 'write'), readDataDir: join(t.dir, 'read'), timeoutMs: 500 });
  try {
    await assert.rejects(port.status({ txid: b(1), outIdx: 0 }), /status timed out after 500 ms/);
    assert.deepEqual(t.started().map((s) => s.mode), ['serve', 'status'], 'the server first, then one run the old way');
    await sleep(KILL_GRACE_MS + 700);
    for (const s of t.started()) assert.equal(alive(s.pid), false, `${s.mode} ${s.pid} gone`);
  } finally { port.close(); reap(t); }
});

test('a seat that exits takes its running tools with it (a signal ends main.js through process.exit)', async () => {
  const t = deafTool();
  const mod = fileURLToPath(new URL('../src/stake-lock-port.js', import.meta.url));
  const seat = spawn(process.execPath, ['--input-type=module', '-e', `
    const { stakeLockPort } = await import(${JSON.stringify(mod)});
    const port = stakeLockPort({ bin: ${JSON.stringify(t.bin)}, dataDir: '/shared', timeoutMs: 60000, serve: false });
    port.status({ txid: new Uint8Array(32), outIdx: 0 }).catch(() => {});
    process.on('SIGTERM', () => process.exit(0));
    console.log('asked');
  `], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    for (let i = 0; i < 100 && !t.started().length; i++) await sleep(50);
    const [run] = t.started();
    assert.ok(run && alive(run.pid), 'the tool runs while the seat waits on it');
    const exited = new Promise((r) => seat.once('exit', r));
    seat.kill('SIGTERM');
    await exited;
    await sleep(300);
    assert.equal(alive(run.pid), false, 'the tool did not outlive the seat');
  } finally { try { seat.kill('SIGKILL'); } catch { /* gone */ } reap(t); }
});
