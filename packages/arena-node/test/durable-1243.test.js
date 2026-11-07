// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1243 (audit 3 #1210 CRASH-2): the store runs synchronous = NORMAL, so a commit reaches the disk only at the next WAL sync, and a power
// loss could take the very record a write-ahead fix stands on - an exchange's RECEIVING row with the notes already in the seat's client, a send
// FUNDING row, a settlement SUBMITTING row. Each write-ahead now commits with synchronous = FULL (its WAL fsynced) before its effect.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStore, durably } from '../src/store.js';
import { Round } from '../src/round.js';
import * as ex from '../src/ecash-exchange.js';

const level = (db) => Number(Object.values(db.prepare('PRAGMA synchronous').get())[0]);
// every switch of the level, in order, beside the effects it must come before
const spy = (db, log) => { const exec = db.exec.bind(db); db.exec = (sql) => { if (/PRAGMA synchronous = FULL/.test(sql)) log.push('durable'); return exec(sql); }; return db; };

test('#1243 durably: FULL inside, the level it found after; inside a transaction nothing is switched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'durable-1243-'));
  try {
    const db = openStore(join(dir, 'n.db'));
    const before = level(db); let inside = null;
    durably(db, () => { inside = level(db); });
    const after = level(db);
    db.exec('BEGIN'); let inTx = null; durably(db, () => { inTx = level(db); }); db.exec('COMMIT');
    console.log('  MEASURED #1243 levels:', JSON.stringify({ before, inside, after, inTransaction: inTx }));
    assert.deepEqual([before, inside, after, inTx], [1, 2, 1, 1]);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('#1243 the exchange\'s RECEIVING, asked and SENDING rows are durable before the federation is asked', async () => {
  const A = 'aa'.repeat(32), B = 'bb'.repeat(32);
  const B32 = '0123456789abcdefghijklmnopqrstuv';
  const encode = (bytes) => { let out = '', buf = 0, bits = 0; for (const b of bytes) { buf |= b << bits; bits += 8; while (bits >= 5) { out += B32[buf & 31]; buf >>>= 5; bits -= 5; } } if (bits > 0) out += B32[buf & 31]; return `fedimint${out}`; };
  const NOTES = encode(Uint8Array.from({ length: 41 }, (_, i) => (i * 37 + 11) & 0xff));
  const log = [];
  const raw = new DatabaseSync(':memory:'); raw.exec('PRAGMA synchronous = NORMAL');   // as the store runs (a bare connection starts at FULL)
  const db = spy(raw, log);
  const ports = {
    [A]: { ecashBalance: async () => 0n, ecashReceive: async () => { log.push('receive'); return { state: 'Success', msat: 100_000n }; } },
    [B]: { ecashBalance: async () => 10_000_000n, ecashSend: async (m) => { log.push('send'); return { ecash: 'fedimintb-1', msat: m }; }, ecashSent: async () => ({ found: false }) },
  };
  const x = ex.createEcashExchange({ db, portOf: async (f) => ports[f] || null, perHourMsat: 1_000_000_000n });
  const got = await x.exchange({ from: A, to: B, ecash: NOTES, amountMsat: '100000' });
  console.log('  MEASURED #1243 exchange order:', JSON.stringify(log));
  assert.equal(got.ok, true, got.why);
  const r = log.indexOf('receive'), s = log.indexOf('send');
  assert.ok(r > 0 && log.slice(0, r).filter((e) => e === 'durable').length >= 2, 'the RECEIVING row and its asked mark were not durable before the receive');
  assert.ok(s > r && log.slice(r, s).includes('durable'), 'the SENDING row was not durable before the send');
});

test('#1243 a send marked FUNDING and a settlement SUBMITTING row are durable; other states are not switched', () => {
  const log = [];
  const store = openStore(':memory:'); spy(store, log);
  const round = new Round(store);
  const RID = new Uint8Array(32).fill(5), E = new Uint8Array(32).fill(6), b = new Uint8Array(4).fill(1);
  round.db.exec('PRAGMA foreign_keys = OFF');   // the round is this test's stub, not a row
  round.putSendPlan({ entryId: E, roundId: RID, attempt: 0, address: 'a@example.org', invoice: 'lnbc1', paymentHash: '11'.repeat(32), invoiceMsat: 1n, payoutMsat: 1n,
    owedMsat: 1n, gatewayUrl: 'https://gw', gatewayPk: '02' + 'cd'.repeat(32), expiration: 100n, why: 'test' });
  const n0 = log.length;
  const moved = round.markSend({ entryId: E, attempt: 0, state: 'FUNDING', why: 'test' });
  const n1 = log.length;
  round.putLockSettlement({ roundId: RID, txid: 't', message: b, signature: b, state: 'SUBMITTING', why: '' });
  const n2 = log.length;
  round.putLockSettlement({ roundId: RID, txid: 't', message: b, signature: b, state: 'ACCEPTED', why: '' });
  console.log('  MEASURED #1243 rows:', JSON.stringify({ funding: { moved, durable: n1 - n0 }, submitting: n2 - n1, accepted: log.length - n2 }));
  assert.equal(moved, true);
  assert.equal(n1 - n0, 1); assert.equal(n2 - n1, 1); assert.equal(log.length - n2, 0);
});
