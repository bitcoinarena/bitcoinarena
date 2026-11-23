// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2948: THE WALLET FILE IS NOT REWRITTEN AT EVERY KEY. The lock client's commit (lock-client store.rs commit_inner) calls
// put/remove once per key, synchronously; the donor's fileStore rewrote the whole wallet file at each one. Measured on the Beelink
// 2026-11-23, seat 2's dev-b: a 22.8 MB wallet, one donation redeemed - 2,428 MB written in 25 s. Now a commit's changes are one
// appended log line, and the snapshot is written again only when the log has outgrown it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { walletFileStore, LOG_COMPACT_MIN } from '../src/donor.js';

function fakeFs(initial = null) {
  const files = new Map(initial === null ? [] : [['w.json', initial]]);
  const wrote = { bytes: 0, snapshots: 0, appends: 0 };
  return {
    files, wrote,
    existsSync: (p) => files.has(p),
    readFileSync: (p) => { if (!files.has(p)) throw new Error('ENOENT'); return files.get(p); },
    writeFileSync: (p, s) => { wrote.bytes += String(s).length; if (p === 'w.json.tmp') wrote.snapshots++; files.set(p, String(s)); },
    appendFileSync: (p, s) => { wrote.bytes += String(s).length; wrote.appends++; files.set(p, (files.get(p) || '') + s); },
    renameSync: (a, b) => { files.set(b, files.get(a)); files.delete(a); },
  };
}
const tick = () => new Promise((r) => setImmediate(r));
const big = () => JSON.stringify(Object.fromEntries(Array.from({ length: 20000 }, (_, i) => [`k${i}`, 'ab'.repeat(256)])));   // ~10 MB

test('#2948 a commit of many keys on a large wallet writes its changes once, not the wallet once per key', async () => {
  const fs = fakeFs(big());
  const size = fs.files.get('w.json').length;
  const s = walletFileStore('w.json', fs);
  for (let i = 0; i < 50; i++) s.put(`n${i}`, 'ff');
  s.remove('k0');
  assert.equal(fs.wrote.bytes, 0, 'nothing written inside the commit');
  await tick();
  assert.equal(fs.wrote.appends, 1, 'one append for the commit');
  assert.equal(fs.wrote.snapshots, 0, 'the wallet itself is not rewritten');
  assert.ok(fs.wrote.bytes < 2000, `${fs.wrote.bytes} bytes written for a ${size}-byte wallet (was ${51 * size})`);
  const back = JSON.parse(walletFileStore('w.json', fs).entries());   // a restart: snapshot + log
  assert.equal(back.length, 20000 - 1 + 50);
  assert.ok(!back.some(([k]) => k === 'k0'));
});

test('#2948 a put of the value already held and a remove of a key not held write nothing', async () => {
  const fs = fakeFs(JSON.stringify({ a: '01', b: '02' }));
  const s = walletFileStore('w.json', fs);
  s.put('a', '01'); s.remove('zz');
  await tick();
  assert.equal(fs.wrote.bytes, 0);
});

test('#2948 a restart folds the log into the file; a torn last line (a crash inside the append) is skipped', async () => {
  const fs = fakeFs(JSON.stringify({ a: '01' }));
  const s = walletFileStore('w.json', fs);
  s.put('b', '02'); await tick();
  s.remove('a'); await tick();
  fs.files.set('w.json.log', fs.files.get('w.json.log') + '[["c","0');
  const r = walletFileStore('w.json', fs);
  assert.deepEqual(JSON.parse(r.entries()), [['b', '02']]);
  assert.deepEqual(JSON.parse(fs.files.get('w.json')), { b: '02' }, 'the file alone is the whole wallet again');
  assert.equal(fs.files.get('w.json.log'), '');
});

test('#2948 the snapshot is written again once the log outgrows it, and the log emptied', async () => {
  const fs = fakeFs(JSON.stringify({ a: '01' }));
  const s = walletFileStore('w.json', fs);
  const v = 'cd'.repeat(64 * 1024);   // 128 kB a commit
  const n = Math.ceil(LOG_COMPACT_MIN / v.length) + 2;
  for (let i = 0; i < n; i++) { s.put(`x${i % 3}`, v + i); await tick(); }
  assert.equal(fs.wrote.snapshots, 1);
  assert.ok(fs.files.get('w.json.log').length < LOG_COMPACT_MIN);
  const back = new Map(JSON.parse(walletFileStore('w.json', fs).entries()));
  assert.equal(back.get('a'), '01');
  assert.equal(back.get(`x${(n - 1) % 3}`), v + (n - 1));
});

test('#2948 flush() makes the file the whole wallet (before it is copied or renamed); a new wallet gets no file before its first commit', async () => {
  const fs = fakeFs();
  const s = walletFileStore('w.json', fs);
  assert.equal(fs.files.has('w.json'), false, 'no file at open: the donor asks whether one exists (an imported key is recovered)');
  s.put('x', '01');
  s.flush();
  assert.deepEqual(JSON.parse(fs.files.get('w.json')), { x: '01' });
  await tick();
  assert.equal(fs.files.get('w.json.log') || '', '', 'the commit flushed is not appended again');
});
