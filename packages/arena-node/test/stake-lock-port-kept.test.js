// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE PORT'S KEPT READS (the join's 2-3 s): the first read waits; a fresh answer is served from memory; an answer past its
// minute is given at once and read again behind it; a failed re-read keeps the held answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync as put } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keptFor, stakeLockPort } from '../src/stake-lock-port.js';

test('a kept read: the first waits, a fresh one is held, a stale one is answered at once and read again behind it', async () => {
  let t = 0, reads = 0, fail = false;
  const read = keptFor(60000, async () => { reads++; if (fail) throw new Error('down'); return `v${reads}`; }, () => t);
  assert.equal(await read(), 'v1');
  assert.equal(reads, 1);
  t = 30000;
  assert.equal(await read(), 'v1', 'a fresh answer is served from memory');
  assert.equal(reads, 1);
  t = 61000;
  assert.equal(await read(), 'v1', 'a stale answer is given at once');
  await new Promise((r) => setImmediate(r));
  assert.equal(reads, 2, 'and read again behind it');
  assert.equal(await read(), 'v2', 'the re-read answer is served next');
  t = 200000; fail = true;
  assert.equal(await read(), 'v2', 'a held answer stands while a re-read fails');
  await new Promise((r) => setImmediate(r));
  assert.equal(await read(), 'v2');
});

test('a held answer on disk is given at once after a restart, and a read that fails does not refuse the door (#830)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'held-'));
  let t = 1000;
  put(join(dir, 'held-fees.json'), JSON.stringify({ atMs: 0, j: { fee_ppm: 3000, fee_base_msat: 0 } }));
  const port = stakeLockPort({ bin: '/nonexistent/arena-stake-lock', dataDir: dir, readDataDir: dir, serve: false, now: () => t });
  const t0 = Date.now();
  const fees = await port.fees();
  assert.equal(fees.ppm, 3000n);
  assert.ok(Date.now() - t0 < 1000, 'no wait on the failing tool');
  t = 7 * 3600000;
  const old = stakeLockPort({ bin: '/nonexistent/arena-stake-lock', dataDir: dir, readDataDir: dir, serve: false, now: () => t });
  await assert.rejects(old.fees(), 'an answer past its 6 h is not used');
});
