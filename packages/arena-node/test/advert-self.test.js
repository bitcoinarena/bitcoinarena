// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #705: the seat's guardian_of check runs bitcoin-cli in a worker - the seat's loop keeps turning while a slow wallet answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { advertSelfInWorker } from '../src/advert-self.js';

test('a slow bond wallet does not hold the seat loop (#705)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'advert705-'));
  const cli = join(dir, 'slow-cli');
  writeFileSync(cli, '#!/bin/sh\nsleep 1\necho "[]"\n');      // every call takes a second, as scantxoutset did for minutes
  chmodSync(cli, 0o755);
  const before = process.env.ARENA_BOND_CLI;
  process.env.ARENA_BOND_CLI = `${cli} -rpcwallet=test`;
  try {
    let ticks = 0, worst = 0, at = Date.now();
    const t = setInterval(() => { const n = Date.now(); worst = Math.max(worst, n - at); at = n; ticks++; }, 20);
    const t0 = Date.now();
    const r = await advertSelfInWorker({ mine: [{ federationId: new Uint8Array(32), guardianKey: new Uint8Array(33) }], secret: new Uint8Array(32).fill(1), last: null });
    clearInterval(t);
    assert.equal(r, null);                                      // no bond in the wallet: nothing to do
    assert.ok(Date.now() - t0 >= 1000, 'the wallet was asked');
    assert.ok(ticks >= 30, `the loop turned ${ticks} times`);
    assert.ok(worst < 300, `longest loop gap ${worst} ms`);
  } finally {
    if (before === undefined) delete process.env.ARENA_BOND_CLI; else process.env.ARENA_BOND_CLI = before;
  }
});

test('no bond wallet named: nothing to do', async () => {
  const before = process.env.ARENA_BOND_CLI;
  delete process.env.ARENA_BOND_CLI;
  try { assert.equal(await advertSelfInWorker({ mine: [], secret: new Uint8Array(32), last: null }), null); }
  finally { if (before !== undefined) process.env.ARENA_BOND_CLI = before; }
});
