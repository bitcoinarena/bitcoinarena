// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 r5 entry 1: A STRANGER WRITES THE SEAT'S TRANSACTION RECORD (tx_steps) WITHOUT BOUND, UNDER ANY ID.
// The money doors keep one tx_steps row per request (step-log.js `keep`, tx-record.js) under the id the request names. POST /fee-lock
// names its step log by the ?entry= id BEFORE it asks whether this seat holds that entry, so a stranger's refused request (404, no entry)
// writes a row for any made-up id; POST /lock writes one per refused request under a real entry's id. Rows stay 14 days, nothing bounds them,
// and GET /tx (and GET /txs?full=1, the explorer's walk) hands every one back: a stranger fills the disk and an honest player's transaction
// record shows a stranger's refused lock attempts as doors it passed.
// SAFE: a request for an entry this seat does not hold keeps no row; a stranger's refused requests add a bounded number of rows to one id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { toHex } from '../../arena-protocol/src/hash.js';
import { lockFieldsToJson } from '../src/stake-lock-signer-node.js';
import { joinedWithLock } from './lock-fixture.js';

const N = 60;

test('wf1489 r5 entry 1: a stranger\'s refused lock requests write no unbounded transaction record', { timeout: 120000 }, async () => {
  const s = await joinedWithLock({});
  try {
    const base = `http://127.0.0.1:${s.d.port}`, id = toHex(s.eid);
    const junk = JSON.stringify(lockFieldsToJson({ ...s.fields, amountMsat: 1000n }));
    // 1) made-up ids the seat holds no entry for
    const made = [];
    for (let i = 0; i < N; i++) {
      const fake = toHex(new Uint8Array(randomBytes(32)));
      made.push(fake);
      const r = await fetch(`${base}/fee-lock?entry=${fake}`, { method: 'POST', body: junk });
      assert.equal(r.status, 404);
    }
    await new Promise((r) => setTimeout(r, 200));
    let rowsForMadeUp = 0;
    for (const fake of made) rowsForMadeUp += (await (await fetch(`${base}/tx?id=${fake}`)).json()).steps.length;
    // 2) a real player's entry: a stranger's refused stake locks
    const before = (await (await fetch(`${base}/tx?id=${id}`)).json()).steps.length;
    for (let i = 0; i < N; i++) {
      const r = await fetch(`${base}/lock?entry=${id}`, { method: 'POST', body: junk });
      assert.equal(r.status, 409);
      await new Promise((res) => setTimeout(res, 2));
    }
    await new Promise((r) => setTimeout(r, 200));
    const tx = await (await fetch(`${base}/tx?id=${id}`)).json();
    const added = tx.steps.length - before;
    console.log('MEASURED', JSON.stringify({ requests: N, rowsForMadeUp, playerRowsBefore: before, rowsAddedToPlayerTx: added, doors: tx.steps.slice(-3).map((x) => `${x.door}:${x.status}`) }));
    assert.equal(rowsForMadeUp, 0, `${rowsForMadeUp} transaction rows kept for ${N} made-up ids no seat ever held`);
    assert.ok(added <= 16, `${added} rows of a stranger's refused locks added to an honest player's transaction record`);
  } finally { await s.close(); }
});
