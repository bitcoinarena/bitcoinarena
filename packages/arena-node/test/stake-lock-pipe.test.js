// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SERVER ENDED WHILE AN ASK IS WRITTEN (kanban #831, 2026-11-01 23:16Z): an unanswered ask ended the stake-lock server, the next ask
// wrote into its closed pipe, and the EPIPE had no listener: the whole seat went down. The ask fails, the seat stays.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { stakeLockServer } from '../src/stake-lock-port.js';

function fakeServer() {
  const c = new EventEmitter();
  c.kill = () => {};
  c.stdout = new EventEmitter(); c.stdout.setEncoding = () => {};
  c.stdin = new EventEmitter();
  c.stdin.write = () => { setImmediate(() => c.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))); return false; };
  setImmediate(() => c.stdout.emit('data', '{"mode":"serve","ready":true}\n'));
  return c;
}

test('a write into a closed pipe fails the ask and leaves the seat up', async () => {
  const s = stakeLockServer({ bin: 'x', dataDir: 'y', spawnFn: fakeServer, log: () => {} });
  await assert.rejects(s.ask('status', {}), /pipe: write EPIPE/);
  await assert.rejects(s.ask('status', {}), /down for a minute/);
  s.close();
});
