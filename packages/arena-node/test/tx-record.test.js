// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// EVERY ORDER'S TRANSACTION AT THE SEAT (kanban #624): GET /tx names the entry, its locks with their federation transaction ids and every door
// it passed here with each step's time (its handout's too); GET /txs lists the newest; POST /tx-timing keeps the page's own timing only when
// the order's session key signed it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { lockFieldsToJson } from '../src/stake-lock-signer-node.js';
import { joinedWithLock } from './lock-fixture.js';
import { timingMessage, createTxRecord } from '../src/tx-record.js';
import { DatabaseSync } from 'node:sqlite';

test('a transaction: its entry, its locks\' txids, each door with its steps, and the page\'s signed timing', async () => {
  const sessionSecret = ed25519.utils.randomSecretKey();
  const s = await joinedWithLock({}, { sessionSecret });
  try {
    const base = `http://127.0.0.1:${s.d.port}`, id = toHex(s.eid);
    assert.equal((await fetch(`${base}/lock?entry=${id}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(s.fields)) })).status, 201);
    const tx = await (await fetch(`${base}/tx?id=${id}`)).json();
    assert.equal(tx.known, true);
    assert.equal(tx.entry.round, toHex(s.rid));
    assert.equal(tx.locks.stake.txid, toHex(s.outpoint.txid), 'the stake lock\'s federation transaction');
    assert.ok(tx.storedAt);
    const doors = tx.steps.map((x) => `${x.door}:${x.status}`);
    for (const d of ['handout:201', 'entry:201', 'fee-lock:201', 'lock:201']) assert.ok(doors.includes(d), `${d} in ${doors}`);
    assert.ok(tx.steps.every((x) => Number.isFinite(x.atMs) && Array.isArray(x.steps)));
    assert.equal(tx.client, null);
    // who processes its round: the asker one of the round's nodes, no outcome yet, nothing this seat did to settle it yet
    assert.ok(tx.processed && /^[0-9a-f]{64}$/.test(tx.processed.asker), 'the round\'s asker');
    assert.deepEqual(tx.processed.outcomes, []);
    assert.deepEqual(tx.processed.mine, []);
    // the page's timing: refused unsigned or signed by another key, kept when the order's session key signed it
    const timing = { pressedAt: '2026-10-24T18:08:15.300Z', submittedMs: 28900, placedMs: 29980, lockMs: 29800, steps: [{ step: 'committee', ms: 27000 }] };
    const tj = JSON.stringify(timing);
    const post = (sig) => fetch(`${base}/tx-timing?id=${id}`, { method: 'POST', body: JSON.stringify({ timing, sig }) });
    assert.equal((await post('00'.repeat(64))).status, 403);
    assert.equal((await post(toHex(ed25519.sign(timingMessage(id, tj), ed25519.utils.randomSecretKey())))).status, 403);
    assert.equal((await post(toHex(ed25519.sign(timingMessage(id, tj), sessionSecret)))).status, 201);
    const again = await (await fetch(`${base}/tx?id=${id}`)).json();
    assert.equal(again.client.submittedMs, 28900);
    assert.equal(again.client.steps[0].step, 'committee');
    const list = await (await fetch(`${base}/txs?since=0`)).json();
    assert.ok(list.txs.some((t) => t.id === id && t.round === toHex(s.rid) && t.app && /^[0-9a-f]{64}$/.test(t.federation)), JSON.stringify(list.txs));
    assert.equal((await fetch(`${base}/tx?id=${'00'.repeat(32)}`)).status, 404);
    // the explorer's read: every row with its whole record, as GET /tx answers it
    const fullList = await (await fetch(`${base}/txs?since=0&full=1`)).json();
    const row = fullList.txs.find((t) => t.id === id);
    assert.deepEqual(row.detail.entry, again.entry);
    assert.equal(row.detail.client.submittedMs, 28900);
  } finally { await s.close(); }
});

test('what a seat did to settle a round is kept in order, the same step said again in a row once', () => {
  let t = 1000;
  const r = createTxRecord({ db: new DatabaseSync(':memory:'), now: () => t });
  const round = 'ab'.repeat(32);
  r.keepRound({ round, what: 'committed to the settlement' });
  t += 5; r.keepRound({ round, what: 'committed to the settlement' });
  t += 5; r.keepRound({ round, what: 'gave its signature share', detail: '5 signers' });
  r.keepRound({ round: 'not a round', what: 'x' });
  assert.deepEqual(r.roundEvents(round).map((x) => [x.atMs, x.what, x.detail]), [[1000, 'committed to the settlement', null], [1010, 'gave its signature share', '5 signers']]);
});
