// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1160: the e-cash exchange received and sent outside its state write. A stop between the reissue of the player's notes and the
// row, and the retry was refused "received here before" - the notes kept, nothing paid; a stop (or a tool timeout) after the seat's
// notes left, and the retry paid again. Now the row is written before each side effect, the retry's AlreadyReceived is this exchange's own
// receive, and a retry in "sending" reads the keyed send back instead of spending twice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import * as ex from '../src/ecash-exchange.js';

const A = 'aa'.repeat(32), B = 'bb'.repeat(32);
const NOTES = 'fedimintA'.padEnd(40, 'x');

// a federation pair as the stake-lock tool answers it: the reissue is the string's own operation, a keyed send is in the operation log.
// `lostReceive` / `lostSend`: the federation does it, the answer is lost (a tool timeout, a seat that stopped). `oldTool`: a tool from
// before #1160 - no read-back, no amount on AlreadyReceived
function seat({ lostReceive = 0, lostSend = 0, oldTool = false, carries = 100_000n } = {}) {
  const calls = [], received = new Map(), log = new Map();
  let holdsB = 500_000n, n = 0;
  const ports = {
    [A]: { ecashBalance: async () => 0n,
      ecashReceive: async (e) => { calls.push('receive');
        if (received.has(e)) return oldTool ? { state: 'AlreadyReceived', msat: 0n } : { state: 'AlreadyReceived', msat: 0n, earlier: 'Success', carriedMsat: carries };
        received.set(e, carries);
        if (lostReceive > 0) { lostReceive--; throw new Error('arena-stake-lock ecash-receive timed out'); }
        return { state: 'Success', msat: carries }; } },
    [B]: { ecashBalance: async () => holdsB,
      ecashSend: async (m, { key = null } = {}) => { calls.push('send');
        if (key && !oldTool && log.has(key)) return { ...log.get(key), again: true };
        holdsB -= m; const out = { ecash: `fedimintB-${++n}-${m}`, msat: m };
        if (key && !oldTool) log.set(key, out);
        if (lostSend > 0) { lostSend--; throw new Error('arena-stake-lock ecash-send timed out'); }
        return out; },
      ...(oldTool ? {} : { ecashSent: async (key) => { calls.push('sent?'); return log.has(key) ? { found: true, ...log.get(key) } : { found: false }; } }) },
  };
  const x = ex.createEcashExchange({ db: new DatabaseSync(':memory:'), portOf: async (f) => ports[f] || null });
  return { x, calls, spent: () => 500_000n - holdsB };
}
const ask = (x) => x.exchange({ from: A, to: B, ecash: NOTES, amountMsat: '100000' }).catch((e) => ({ ok: false, status: 'threw', why: e.message }));

test('#1160 a stop between the reissue and the record: the retry pays, the notes were taken once', async () => {
  const s = seat({ lostReceive: 1 });
  const a = await ask(s.x);
  assert.equal(a.ok, false);
  const b = await ask(s.x);
  assert.equal(b.ok, true, b.why);
  assert.equal(b.msat, '100000');
  assert.equal(s.spent(), 100_000n, 'paid once');
  assert.equal(s.calls.filter((c) => c === 'receive').length, 2, 'asked twice, reissued once (the second is AlreadyReceived)');
});

test('#1160 a stop after the seat\'s notes left: the retry reads the keyed send back - the same e-cash, nothing paid twice', async () => {
  const s = seat({ lostSend: 1 });
  const a = await ask(s.x);
  assert.equal(a.ok, false); assert.equal(a.status, 503);
  const b = await ask(s.x);
  assert.equal(b.ok, true, b.why);
  assert.equal(b.ecash, 'fedimintB-1-100000', 'the e-cash that left the first time');
  assert.equal(s.spent(), 100_000n, 'spent once');
  const c = await ask(s.x);
  assert.deepEqual([c.ok, c.again, c.ecash], [true, true, b.ecash]);
});

test('#1160 with a tool from before the fix nothing is paid twice: a lost send or a lost receive holds the exchange', async () => {
  const s = seat({ lostSend: 1, oldTool: true });
  await ask(s.x);
  const b = await ask(s.x);
  assert.equal(b.ok, false); assert.equal(b.status, 503); assert.match(b.why, /nothing paid twice/);
  assert.equal(s.spent(), 100_000n, 'spent once');
  const r = seat({ lostReceive: 1, oldTool: true });
  await ask(r.x);
  const c = await ask(r.x);
  assert.equal(c.ok, false); assert.match(c.why, /held, nothing paid twice/);
  assert.equal(r.spent(), 0n);
});

test('#1160 one transition table: paid and refused go nowhere; a receive the federation refuses is refused for good', async () => {
  assert.ok(ex.EXCHANGE_NEXT, 'one transition table');
  assert.deepEqual(ex.EXCHANGE_NEXT[ex.EXCHANGE.PAID], []);
  assert.deepEqual(ex.EXCHANGE_NEXT[ex.EXCHANGE.REFUSED], []);
  assert.deepEqual(ex.EXCHANGE_NEXT.NONE, [ex.EXCHANGE.RECEIVING], 'the record comes before anything moves');
  let receives = 0;
  const ports = { [A]: { ecashBalance: async () => 0n, ecashReceive: async () => { receives++; return { state: 'Rejected', msat: 0n }; } },
    [B]: { ecashBalance: async () => 500_000n, ecashSend: async () => { throw new Error('never'); }, ecashSent: async () => ({ found: false }) } };
  const x = ex.createEcashExchange({ db: new DatabaseSync(':memory:'), portOf: async (f) => ports[f] || null });
  const a = await ask(x), b = await ask(x);
  assert.deepEqual([a.ok, a.status, b.ok, b.status], [false, 409, false, 409]);
  assert.equal(receives, 1, 'refused for good: not asked again');
});
