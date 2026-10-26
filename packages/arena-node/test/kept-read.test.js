// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// GET /pending KEPT (kanban #686, measured 2026-10-26: 6.7 s warm and past 20 s cold on a node reading its chain through the bridge): the
// kept answer at once - fresh, or older while it is read again behind it - one read at a time, and only the first read ever waited on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { keptRead } from '../src/kept-read.js';

const later = () => { let open; const p = new Promise((r) => { open = r; }); return { p, open }; };

test('the first read is waited on; a fresh one of the same tip answered from the kept one, no read', async () => {
  let now = 0, reads = 0;
  const k = keptRead({ freshMs: 60000, now: () => now });
  const compute = async () => ({ n: ++reads });
  assert.deepEqual(await k.get('100:a', compute), { n: 1 });
  now = 59000;
  assert.deepEqual(await k.get('100:a', compute), { n: 1 });
  assert.equal(reads, 1);
});

test('older than freshMs, or of another tip: the kept answer at once, read again behind it, one read for many askers', async () => {
  let now = 0, reads = 0;
  const k = keptRead({ freshMs: 60000, now: () => now });
  await k.get('100:a', async () => ({ n: ++reads }));
  const gate = later();
  const slow = async () => { await gate.p; return { n: ++reads }; };
  now = 61000;
  // the slow read is not waited on - by any of the three
  assert.deepEqual(await Promise.all([k.get('100:a', slow), k.get('101:b', slow), k.get('101:b', slow)]), [{ n: 1 }, { n: 1 }, { n: 1 }]);
  gate.open(); await new Promise((r) => setImmediate(r));
  assert.equal(reads, 2, 'one read behind the kept answer');
  assert.deepEqual(await k.get('100:a', slow), { n: 2 });
  assert.equal(k.kept().key, '100:a', 'kept as of the tip the read began at');
});

test('forget(): the next ask waits for a read of its own; a read begun before is not kept', async () => {
  let now = 0, reads = 0;
  const k = keptRead({ now: () => now });
  await k.get('t', async () => ({ n: ++reads }));
  now = 70000;
  const gate = later();
  assert.deepEqual(await k.get('t', async () => { await gate.p; return { old: true }; }), { n: 1 });
  k.forget();   // e.g. POST /expected took a new grid
  assert.deepEqual(await k.get('t', async () => ({ n: ++reads })), { n: 2 });
  gate.open(); await new Promise((r) => setImmediate(r));
  assert.deepEqual(await k.get('t', async () => ({ n: ++reads })), { n: 2 }, 'the read from before the change is not kept');
});

test('a read that fails is not kept, and the next ask reads again', async () => {
  const k = keptRead();
  await assert.rejects(k.get('t', async () => { throw new Error('the chain did not answer'); }), /did not answer/);
  assert.equal(k.kept(), null);
  assert.deepEqual(await k.get('t', async () => ({ ok: true })), { ok: true });
});
