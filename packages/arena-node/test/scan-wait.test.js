// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #348: a UTXO scan another process runs on the same bitcoind is waited out, not died on (measured 2026-10-13: the second
// runner started on one bitcoind died on "Scan already in progress", error -8)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { regtest } from '../tools/regtest-bond.mjs';

test('a scan already in progress is waited for, then asked again; another error is thrown at once', () => {
  let busy = 2, scans = 0;
  const cli = (...a) => {
    if (a[0] === 'listwallets') return '["blwp"]';
    if (a[0] === 'scantxoutset') {
      scans++;
      if (busy-- > 0) { const e = new Error('Command failed'); e.stderr = 'error code: -8\nerror message:\nScan already in progress, use action "abort" or "status"\n'; throw e; }
      return JSON.stringify({ success: true, unspents: [] });
    }
    if (a[0] === 'getblockcount') return '100';
    if (a[0] === 'getnewaddress') return 'bcrt1qtest';
    if (a[0] === 'generatetoaddress') return '[]';
    if (a[0] === 'getrawtransaction' || a[0] === 'gettransaction') return '{}';
    throw new Error(`not in this test: ${a[0]}`);
  };
  const r = regtest(cli, { network: 'regtest' });
  const t0 = Date.now();
  const found = r.bondsOf({ pubkey: new Uint8Array(32).fill(2) });
  console.log('  SCANS:', scans, 'waited', Date.now() - t0, 'ms', 'found', Array.isArray(found) ? found.length : typeof found);
  assert.ok(scans >= 3, 'asked again after each busy answer');
  assert.ok(Date.now() - t0 >= 4000, 'two waits of 2 s');
  const broken = (...a) => { if (a[0] === 'listwallets') return '["blwp"]'; if (a[0] === 'scantxoutset') throw new Error('error code: -1 something else'); return '100'; };
  assert.throws(() => regtest(broken, { network: 'regtest' }).bondsOf({ pubkey: new Uint8Array(32).fill(2) }), /something else/);
});
