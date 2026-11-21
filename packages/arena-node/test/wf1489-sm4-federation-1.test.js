// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 sm4-find-federation 1 (state machine audit, federation; timeout + interleaving): AN E-CASH EXCHANGE TAKES THE CLIENT'S
// BALANCE CHANGE FOR WHAT THE PLAYER'S NOTES CARRIED.
// The seat's stake-lock tool answers a Success receive with "msat": the seat client's balance after the reissue less its balance before
// (tools/stake-lock/src/main.rs ecash_receive: `after.saturating_sub(before)`), and ecash-exchange.js books that as the row's in_msat and
// pays min(in_msat, asked). The client's balance is not the reissue's alone: a reissue whose tool run was killed at its timeout (the
// exchange answered 503, its row RECEIVING with receive_asked = 1) is a persisted fedimint state machine that finishes in whatever run
// opens the client next - here the next exchange's. That run's delta carries the earlier exchange's notes too, so the next exchange is
// booked as carrying them and is paid what it asked although its notes are worth 1 sat; the earlier exchange's retry then answers
// AlreadyReceived with the notes' own amount (carried_msat) and is paid as well. The same notes are paid out twice. (And the other way:
// a balance that has not risen inside the tool's 10 s wait books a Success as 0 msat - TAKEN with in_msat 0, refused "carried nothing"
// at every retry, the notes kept by the seat for good.)
// Invariant: what the seat pays out for exchanges never exceeds what the notes handed in carried.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createEcashExchange } from '../src/ecash-exchange.js';

const A = 'aa'.repeat(32), B = 'bb'.repeat(32);
const N1 = 'fedimint' + 'a'.repeat(40);   // the honest player's notes: 100 sat
const N2 = 'fedimint' + 'b'.repeat(40);   // the second player's notes: 1 sat
const VALUE = new Map([[N1, 100_000n], [N2, 1_000n]]);

test('wf1489-sm4-federation-1: an exchange is paid at most what its own notes carried, whatever else lands in the client during its run', async () => {
  const db = new DatabaseSync(':memory:');
  // THE SEAT'S CLIENT OF FEDERATION A, as the tool sees it: a balance, the reissues it holds, and the reissue state machines a killed run
  // left behind - fedimint resumes them when the client is next opened (the next tool run), and they credit the balance there
  let balanceA = 0n; const received = new Map(); const pending = [];
  let killNext = true;
  const portA = {
    ecashBalance: async () => balanceA,
    async ecashReceive(ecash) {
      // the client opens: the state machines a killed run left are driven to their end during this run
      const before = balanceA;
      if (received.has(ecash)) {
        for (const p of pending.splice(0)) balanceA += p;
        return { state: 'AlreadyReceived', msat: 0n, earlier: 'Success', carriedMsat: VALUE.get(ecash) };   // main.rs: e.amount()
      }
      received.set(ecash, true);
      if (killNext) { killNext = false; pending.push(VALUE.get(ecash)); throw new Error('arena-stake-lock ecash-receive timed out after 120000 ms'); }
      for (const p of pending.splice(0)) balanceA += p;          // the earlier, killed reissue finishes now
      balanceA += VALUE.get(ecash);                              // and this one
      return { state: 'Success', msat: balanceA - before };       // main.rs: after.saturating_sub(before)
    },
  };
  let holdsB = 1_000_000n; let paid = 0n; let n = 0;
  const portB = {
    ecashBalance: async () => holdsB,
    ecashSend: async (m) => { holdsB -= m; paid += m; return { ecash: `fedimintb${++n}`, msat: m }; },
    ecashSent: async () => ({ found: false }),
  };
  const x = createEcashExchange({ db, portOf: async (f) => (f === A ? portA : f === B ? portB : null) });

  // 1. the honest player hands 100 sat of A's notes: the reissue is submitted, the tool run is killed at its timeout - 503, ask again
  const e1 = await x.exchange({ from: A, to: B, ecash: N1, amountMsat: '100000' });
  assert.equal(e1.status, 503);
  // 2. the next exchange: 1 sat of notes, 100 sat asked. Its run finishes the killed reissue: the balance rises by 101 sat
  const e2 = await x.exchange({ from: A, to: B, ecash: N2, amountMsat: '100000' });
  // 3. the honest player asks again with the same notes: AlreadyReceived, this row asked before, carried 100 sat - paid
  const e1b = await x.exchange({ from: A, to: B, ecash: N1, amountMsat: '100000' });
  const rows = db.prepare('SELECT id, state, in_msat, pay_msat, out_msat FROM ecash_exchanges').all().map((r) => ({ ...r, id: r.id.slice(0, 8) }));
  const notesIn = VALUE.get(N1) + VALUE.get(N2);
  console.log('  MEASURED:', JSON.stringify({ e2: { ok: e2.ok, msat: e2.msat }, e1Retry: { ok: e1b.ok, msat: e1b.msat }, rows, notesInMsat: String(notesIn), paidOutMsat: String(paid) }));
  assert.ok(paid <= notesIn, `the seat paid ${paid} msat out for notes carrying ${notesIn} msat: the 1-sat exchange was booked with the other exchange's notes`);
});

test('wf1489-sm4-federation-1b: a Success whose balance had not risen yet is not booked as notes that carried nothing', async () => {
  const db = new DatabaseSync(':memory:');
  let late = true;
  const portA = { ecashBalance: async () => 0n,
    // the reissue succeeded, but the balance read in the tool's 10 s wait had not risen (measured before, kanban #614 note in main.rs)
    ecashReceive: async (e) => (late ? (late = false, { state: 'Success', msat: 0n }) : { state: 'AlreadyReceived', msat: 0n, earlier: 'Success', carriedMsat: VALUE.get(e) }) };
  let paid = 0n;
  const portB = { ecashBalance: async () => 1_000_000n, ecashSend: async (m) => { paid += m; return { ecash: 'fedimintbx', msat: m }; }, ecashSent: async () => ({ found: false }) };
  const x = createEcashExchange({ db, portOf: async (f) => (f === A ? portA : f === B ? portB : null) });
  const first = await x.exchange({ from: A, to: B, ecash: N1, amountMsat: '100000' });
  const again = await x.exchange({ from: A, to: B, ecash: N1, amountMsat: '100000' });
  const row = db.prepare('SELECT state, in_msat FROM ecash_exchanges').get();
  console.log('  MEASURED:', JSON.stringify({ first: { ok: first.ok, status: first.status, why: first.why }, again: { ok: again.ok, status: again.status, why: again.why }, row: { ...row }, paidOutMsat: String(paid) }));
  assert.equal(paid, VALUE.get(N1), `the seat took 100 sat of notes (Success) and paid ${paid} msat: the row is ${row.state} with in_msat ${row.in_msat} for good`);
});

test('wf1489-sm4-federation-1c (kanban #1936): a row left TAKEN with in_msat 0 by an older build is read back and paid once', async () => {
  const db = new DatabaseSync(':memory:');
  let paid = 0n; let sends = 0;
  const portA = { ecashBalance: async () => 0n, ecashReceive: async (e) => ({ state: 'AlreadyReceived', msat: 0n, earlier: 'Success', carriedMsat: VALUE.get(e) }) };
  const portB = { ecashBalance: async () => 1_000_000n, ecashSend: async (m) => { paid += m; sends++; return { ecash: 'fedimintby', msat: m }; }, ecashSent: async () => ({ found: false }) };
  const x = createEcashExchange({ db, portOf: async (f) => (f === A ? portA : f === B ? portB : null) });
  const { noteKey } = await import('../src/ecash-exchange.js');
  db.prepare("INSERT INTO ecash_exchanges (id, from_fed, to_fed, in_msat, state, made_ms, want_msat, receive_asked) VALUES (?, ?, ?, '0', 'taken', 0, '100000', 1)").run(noteKey(N1), A, B);
  const first = await x.exchange({ from: A, to: B, ecash: N1, amountMsat: '100000' });
  const again = await x.exchange({ from: A, to: B, ecash: N1, amountMsat: '100000' });
  assert.equal(first.ok, true); assert.equal(again.ok, true); assert.equal(again.again, true);
  assert.equal(paid, VALUE.get(N1)); assert.equal(sends, 1);
});
