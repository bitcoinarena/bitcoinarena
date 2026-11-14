// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A CLOSED LOCK ROUND NOBODY SETTLED IS ASKED AGAIN (kanban #803). Measured on testnet4 2026-11-01: three paid rounds, all FINAL, every
// committee seat building the same bytes, stood at NONE because the asker's one settle at the close had met two seats still reading the
// book, and no path reached them again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, CLOSED, OPEN } from '../src/store.js';
import { Round } from '../src/round.js';
import { LockSettlement } from '../src/settlement.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const rid = (n) => new Uint8Array(32).fill(n);
const NOW = 2_000_000_000_000, MIN = 60000;

function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'retry-unsettled-'));
  const db = openStore(join(dir, 'n.db'));
  try { return fn(db); } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
}
function round(db, n, { state = CLOSED, closedMs = NOW - 30 * MIN, lock = true } = {}) {
  db.prepare('INSERT INTO rounds (round_id, contract, state, opened_ms, closed_ms) VALUES (?, ?, ?, ?, ?)').run(rid(n), new Uint8Array(1), state, closedMs - MIN, closedMs);
  if (lock) db.prepare('INSERT INTO stake_locks (entry_id, round_id, outpoint, fields, contract_id, verified_ms) VALUES (?, ?, ?, ?, ?, ?)').run(rid(n + 100), rid(n), 'x:0', '{}', 'c', closedMs);
}
const settled = (db, n, state) => db.prepare('INSERT INTO lock_settlements (round_id, txid, message, signature, state, why, made_ms) VALUES (?, ?, ?, ?, ?, ?, ?)')
  .run(rid(n), 'aa', new Uint8Array(32), new Uint8Array(64), state, 'x', NOW);
const fedSettled = (db, n, fed, state) => db.prepare('INSERT INTO fed_lock_settlements (round_id, federation_id, txid, message, signature, state, why, made_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
  .run(rid(n), fed, 'aa', new Uint8Array(32), new Uint8Array(64), state, 'x', NOW);
const listed = (db) => Round.prototype.closedLockRoundsUnsettled.call({ db }, NOW - 1440 * MIN, NOW - 15 * MIN).map((r) => r[0]).sort((a, b) => a - b);

test('only closed lock rounds with no accepted settlement, inside the window, are listed', () => withStore((db) => {
  round(db, 1);                                         // the measured case: closed, a lock, no row
  round(db, 2); settled(db, 2, 'ACCEPTED');             // settled
  round(db, 3); settled(db, 3, 'REFUSED');              // refused, asked again
  round(db, 4, { lock: false });                        // free
  round(db, 5, { state: OPEN });                        // still open
  round(db, 6, { closedMs: NOW - 5 * MIN });            // its close is still running
  round(db, 7, { closedMs: NOW - 1500 * MIN });         // too old
  round(db, 8); fedSettled(db, 8, 'a', 'ACCEPTED');     // every federation in
  db.prepare('INSERT INTO fed_lock_split (round_id, federation_id) VALUES (?, ?)').run(rid(8), 'a');   // kanban #2352: its split kept, as #settleFederations does
  round(db, 9); fedSettled(db, 9, 'a', 'ACCEPTED'); fedSettled(db, 9, 'b', 'SUBMITTING');   // one short
  assert.deepEqual(listed(db), [1, 3, 9]);
}));

function seat({ rounds, committee = true, seats = 1, place = 0, mine = true, answer = async () => ({ ok: false, why: 'peers refused' }) }) {
  const me = new Uint8Array(33).fill(2);
  const asked = [];
  let clock = NOW;
  const s = new LockSettlement({ pubkey: me, signerNodes: () => [committee ? me : new Uint8Array(33).fill(3), ...Array.from({ length: seats - 1 }, (_, i) => new Uint8Array(33).fill(10 + i))], closedLockRoundsUnsettled: () => rounds }, { now: () => clock, port: {} });
  s.turn = async () => ({ mine, place });
  s.settle = async (r) => { asked.push(toHex(r)); return answer(r); };
  return { s, asked, tick: (ms) => { clock += ms; } };
}

test('a round is asked at most every 5 minutes, and a repeated refusal is said once', async () => {
  const { s, asked, tick } = seat({ rounds: [rid(1)] });
  assert.equal((await s.retryUnsettled()).length, 1);
  assert.equal(asked.length, 1);
  tick(MIN);
  assert.equal((await s.retryUnsettled()).length, 0);
  assert.equal(asked.length, 1, 'asked again inside 5 minutes');
  tick(5 * MIN);
  assert.equal((await s.retryUnsettled()).length, 0, 'the same refusal was said twice');
  assert.equal(asked.length, 2);
});

test('an accepted retry is said, and a seat off the committee asks nothing', async () => {
  const ok = seat({ rounds: [rid(1)], answer: async () => ({ ok: true, state: 'ACCEPTED', why: 'claimed' }) });
  assert.deepEqual((await ok.s.retryUnsettled()).map((d) => d.state), ['ACCEPTED']);
  const off = seat({ rounds: [rid(1)], committee: false });
  assert.equal((await off.s.retryUnsettled()).length, 0);
  assert.equal(off.asked.length, 0);
});

test('seats past the takeover height ask in turn: over six windows each of six seats asks once, never two in one window', async () => {
  const at = new Map();
  for (let place = 0; place < 6; place++) {
    const { s, asked, tick } = seat({ rounds: [rid(1)], seats: 6, place });
    for (let w = 0; w < 6; w++) { const was = asked.length; await s.retryUnsettled(); if (asked.length > was) at.set(w, (at.get(w) || 0) + 1); tick(5 * MIN); }
    assert.equal(asked.length, 1, `place ${place}`);
  }
  assert.deepEqual([...at.values()], [1, 1, 1, 1, 1, 1]);
});

test('a seat not on turn asks nothing', async () => {
  const { s, asked } = seat({ rounds: [rid(1)], mine: false });
  await s.retryUnsettled();
  assert.equal(asked.length, 0);
});

test('a throwing settle does not stop the rounds after it', async () => {
  const { s, asked } = seat({ rounds: [rid(1), rid(2)], answer: async (r) => { if (r[0] === 1) throw new Error('boom'); return { ok: true, state: 'ACCEPTED', why: 'x' }; } });
  const said = await s.retryUnsettled();
  assert.equal(asked.length, 2);
  assert.equal(said[0].why, 'boom');
});
