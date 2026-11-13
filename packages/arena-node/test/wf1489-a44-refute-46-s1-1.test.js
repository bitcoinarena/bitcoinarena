// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 a44 refute 46 (variant of kanban #1688): #1688 bounds only REFUSED (>= 400) tx_steps rows per id; "answered steps are kept as before".
// A stranger replays the honest player's own lock: GET /txs names the entry id, GET /order-locks?entry= hands back the verified stake and fee
// lock fields to anyone, and POST /lock / POST /fee-lock with those same fields is answered 201 again (the lock already stakes this very entry),
// so each replay keeps one more row under the player's transaction for 14 days - unbounded, a stranger's attempts in the honest player's record.
// SAFE: a stranger's requests add a bounded number of rows to one id, whatever they are answered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toHex } from '../../arena-protocol/src/hash.js';
import { lockFieldsToJson } from '../src/stake-lock-signer-node.js';
import { joinedWithLock } from './lock-fixture.js';

const N = 60;

test('wf1489 a44 refute 46: a stranger replaying a player\'s verified lock writes no unbounded transaction record', { timeout: 120000 }, async () => {
  const s = await joinedWithLock({});
  try {
    const base = `http://127.0.0.1:${s.d.port}`, id = toHex(s.eid);
    // the honest player's own stake lock
    const own = await fetch(`${base}/lock?entry=${id}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(s.fields)) });
    assert.equal(own.status, 201, await own.text());
    // a stranger: the id from GET /txs, the fields from GET /order-locks
    const txs = await (await fetch(`${base}/txs`)).json();
    assert.ok(txs.txs.some((t) => t.id === id));
    const locks = await (await fetch(`${base}/order-locks?entry=${id}`)).json();
    assert.ok(locks.stake && locks.fee, 'GET /order-locks hands the lock fields to anyone');
    await new Promise((r) => setTimeout(r, 100));
    const before = (await (await fetch(`${base}/tx?id=${id}`)).json()).steps.length;
    const statuses = {};
    for (let i = 0; i < N; i++) {
      const a = await fetch(`${base}/lock?entry=${id}`, { method: 'POST', body: JSON.stringify(locks.stake) }); await a.text();
      const b = await fetch(`${base}/fee-lock?entry=${id}`, { method: 'POST', body: JSON.stringify(locks.fee) }); await b.text();
      statuses[a.status] = (statuses[a.status] || 0) + 1; statuses['fee' + b.status] = (statuses['fee' + b.status] || 0) + 1;
      await new Promise((r) => setTimeout(r, 2));
    }
    await new Promise((r) => setTimeout(r, 200));
    const tx = await (await fetch(`${base}/tx?id=${id}`)).json();
    const added = tx.steps.length - before;
    console.log('MEASURED', JSON.stringify({ requests: 2 * N, statuses, playerRowsBefore: before, rowsAddedToPlayerTx: added, doors: tx.steps.slice(-3).map((x) => `${x.door}:${x.status}`) }));
    assert.ok(added <= 16, `${added} rows of a stranger's replayed (201) locks added to an honest player's transaction record`);
  } finally { await s.close(); }
});
