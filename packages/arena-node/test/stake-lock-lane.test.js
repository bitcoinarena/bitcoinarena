// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// ONE FALLBACK RUN AT A TIME PER READ DIRECTORY (kanban #1079): a seat started 26 one-shot status, gateways and fees runs at
// once on one federation's read directory; one held client.db/LOCK, the others waited on client.db.lock until they timed out.
// The fake tools below record how many of them run at once on the directory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stakeLockPort } from '../src/stake-lock-port.js';

const b = (n, len = 32) => new Uint8Array(len).fill(n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const lines = (f) => (existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

// a tool that holds the directory `holdMs` and answers a status, or (deaf) never answers and ignores SIGTERM. Each run writes
// itself into running/ and logs how many runs it finds there.
function tool({ holdMs = 200, deaf = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'stake-lock-lane-'));
  const running = join(dir, 'running'), log = join(dir, 'log'), bin = join(dir, 'tool');
  mkdirSync(running);
  writeFileSync(bin, `#!${process.execPath}
const fs = require('fs'), path = require('path');
const a = process.argv.slice(2);
const me = path.join(${JSON.stringify(running)}, String(process.pid));
fs.writeFileSync(me, '');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ pid: process.pid, mode: a[a.indexOf('--mode') + 1], outpoint: a[a.indexOf('--outpoint') + 1], atOnce: fs.readdirSync(${JSON.stringify(running)}).length }) + '\\n');
${deaf ? `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`
    : `setTimeout(() => { fs.rmSync(me); console.log(JSON.stringify({ block_count: 7, stored: null })); }, ${holdMs});`}
`);
  chmodSync(bin, 0o755);
  return { dir, bin, started: () => lines(log) };
}
const reap = (t) => { for (const { pid } of t.started()) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } };

test('six status reads asked at once on one read directory run one after another, and all are answered', async () => {
  const t = tool();
  const port = stakeLockPort({ bin: t.bin, dataDir: join(t.dir, 'client'), timeoutMs: 20000, serve: false });
  try {
    const answers = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => port.status({ txid: b(n), outIdx: 0 })));
    assert.deepEqual(answers.map((a) => a.blockCount), [7, 7, 7, 7, 7, 7]);
    const runs = t.started();
    assert.equal(runs.length, 6);
    assert.deepEqual(runs.map((r) => r.atOnce), [1, 1, 1, 1, 1, 1], `runs at once on the directory: ${runs.map((r) => r.atOnce)}`);
  } finally { port.close(); reap(t); }
});

test('the same question asked three times at once is one run', async () => {
  const t = tool();
  const port = stakeLockPort({ bin: t.bin, dataDir: join(t.dir, 'client'), timeoutMs: 20000, serve: false });
  try {
    const answers = await Promise.all([0, 1, 2].map(() => port.status({ txid: b(9), outIdx: 1 })));
    assert.equal(answers.length, 3);
    assert.equal(t.started().length, 1, 'one run answered all three');
  } finally { port.close(); reap(t); }
});

test('reads behind one that never answers wait their turn and are refused at their timeout without a run; the next waits until the killed one is gone', async () => {
  const t = tool({ deaf: true });
  const port = stakeLockPort({ bin: t.bin, dataDir: join(t.dir, 'client'), timeoutMs: 3000, serve: false });
  try {
    const t0 = Date.now();
    const got = await Promise.allSettled([1, 2, 3].map((n) => port.status({ txid: b(n), outIdx: 0 })));
    assert.ok(got.every((g) => g.status === 'rejected' && /timed out after 3000 ms/.test(g.reason.message)), JSON.stringify(got.map((g) => g.reason?.message)));
    assert.ok(Date.now() - t0 < 4000, `all three answered at their timeout (${Date.now() - t0} ms)`);
    assert.equal(t.started().length, 1, `one run on the directory, not ${t.started().length}`);
    const [first] = t.started();
    assert.ok(alive(first.pid), 'the killed run is still there inside its grace (SIGTERM ignored)');
    const t1 = Date.now();
    const next = port.status({ txid: b(4), outIdx: 0 }).catch(() => {});
    await sleep(500);
    assert.equal(t.started().length, 1, 'the next read waits while the killed run still holds the directory');
    for (let i = 0; i < 160 && t.started().length < 2; i++) await sleep(25);
    assert.equal(t.started().length, 2, `the next read did run (${Date.now() - t1} ms after it was asked)`);
    assert.equal(alive(first.pid), false, 'it started only once the killed run was gone');
    await next;
  } finally { port.close(); reap(t); }
});

test('two read directories do not wait on each other', async () => {
  const t = tool({ holdMs: 400 });
  const a = stakeLockPort({ bin: t.bin, dataDir: join(t.dir, 'a'), timeoutMs: 20000, serve: false });
  const c = stakeLockPort({ bin: t.bin, dataDir: join(t.dir, 'c'), timeoutMs: 20000, serve: false });
  try {
    const t0 = Date.now();
    await Promise.all([a.status({ txid: b(1), outIdx: 0 }), c.status({ txid: b(1), outIdx: 0 })]);
    assert.ok(Date.now() - t0 < 2 * 400 + 300, `in parallel (${Date.now() - t0} ms)`);
  } finally { a.close(); c.close(); reap(t); }
});
