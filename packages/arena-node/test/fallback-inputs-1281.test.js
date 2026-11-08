// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE FALLBACK CLAIM'S INPUTS FROM THE SEAT'S STORE (spec §23.2, kanban #1281): FINALs, the seats' signed results by content, the node row by time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { schnorr } from '@noble/curves/secp256k1.js';
import { taggedHash, toHex } from '../../arena-protocol/src/hash.js';
import { encodePlayerResult, joinSignedResult } from '../../arena-protocol/src/result.js';
import { fallbackInputs } from '../src/fallback-inputs.js';

const key = (i) => { const secret = taggedHash('TEST/fi', Uint8Array.of(i)); return { secret, pub: schnorr.getPublicKey(secret) }; };
const seats = Array.from({ length: 7 }, (_, i) => key(i));
const rid = taggedHash('TEST/fi-round', Uint8Array.of(1));
const eid = (i) => taggedHash('TEST/fi-entry', Uint8Array.of(i));
const player = (i) => taggedHash('TEST/fi-player', Uint8Array.of(i));

function store() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE entry_finals (round_id BLOB, entry_id BLOB, run_id TEXT, final_after_ms INTEGER, on_rerun INTEGER, at_ms INTEGER);
    CREATE TABLE results (round_id BLOB, entry_id BLOB, node_pubkey BLOB, result_id BLOB, bytes BLOB, seen_ms INTEGER);
    CREATE TABLE final_sigs (round_id BLOB, entry_id BLOB, run_id BLOB, signer_pubkey BLOB, bytes BLOB, seen_ms INTEGER);`);
  return db;
}
const result = (seat, entry, outcome, score, seenMs, db) => {
  const body = encodePlayerResult({ roundId: rid, playerPubkey: player(entry), outcome, score, transcriptHash: new Uint8Array(32).fill(9), simCoreHash: new Uint8Array(32).fill(8), nodePubkey: seats[seat].pub });
  db.prepare('INSERT INTO results VALUES (?, ?, ?, ?, ?, ?)').run(Buffer.from(rid), Buffer.from(eid(entry)), Buffer.from(seats[seat].pub), Buffer.alloc(32),
    Buffer.from(joinSignedResult(body, schnorr.sign(taggedHash('TEST', body), seats[seat].secret))), seenMs);
};

test('FINAL, four seats on one result content, as written; the node row by final_after + 60 s', () => {
  const db = store();
  const FA = 1_000_000;
  // entry 0: FINAL (kept), whatever the results say
  db.prepare('INSERT INTO entry_finals VALUES (?, ?, ?, ?, 0, ?)').run(Buffer.from(rid), Buffer.from(eid(0)), 'run', FA, FA);
  result(0, 0, 'DELIVERED', 5, FA - 100, db);
  // entry 1: no FINAL, seats 0 1 2 3 sign the same content (each its own signed result, its own node key): paid by it
  for (const s of [0, 1, 2, 3]) result(s, 1, 'FAILED', 0, FA + 1000, db);
  // entry 2: no FINAL, three seats only
  for (const s of [0, 1, 2]) result(s, 2, 'DELIVERED', 3, FA + 1000, db);
  // seat 4 signed only a FINAL signature, late; seat 5 a result one ms too late; seats 3 and 6 timely or silent as above
  db.prepare('INSERT INTO final_sigs VALUES (?, ?, ?, ?, ?, ?)').run(Buffer.from(rid), Buffer.from(eid(0)), Buffer.alloc(32), Buffer.from(seats[4].pub), Buffer.alloc(1), FA + 60_000);
  result(5, 0, 'DELIVERED', 5, FA + 60_001, db);
  const entries = [0, 1, 2].map((i) => ({ entryId: eid(i), pubkey: player(i), outcome: i === 0 ? 'DELIVERED' : 'ENTRY_VOID', score: i === 0 ? 5 : 0 }));
  const got = fallbackInputs({ db, roundIdBytes: rid, contract: { nodes: seats.map((s) => s.pub) }, entries, finalAfterMs: FA });
  assert.deepEqual(got.entries.map((e) => [e.outcome, e.by]), [['DELIVERED', 'final'], ['FAILED', 'four signatures'], ['ENTRY_VOID', 'as written']]);
  const seatHex = seats.map((s) => toHex(s.pub));
  assert.deepEqual([...got.eligible].sort(), [0, 1, 2, 3, 4].map((i) => seatHex[i]).sort(), 'seat 5 one ms late and seat 6 silent: no node row');
});

test('kanban #1347: the fallback takes an entry with no FINAL as written and pays it by four signatures - the claim still waits for it', async () => {
  const { LockSettlement } = await import('../src/settlement.js');
  const db = store();
  const FA = 1_000_000;
  // entry 0 FINAL; entry 1 no FINAL (a run that never reached one), four seats signed one result; entry 2 no FINAL, in a re-run window; entry 3 no quorum being decided
  db.prepare('INSERT INTO entry_finals VALUES (?, ?, ?, ?, 0, ?)').run(Buffer.from(rid), Buffer.from(eid(0)), 'run', FA, FA);
  result(0, 0, 'DELIVERED', 5, FA - 100, db);
  for (const s of [0, 1, 2, 3]) result(s, 1, 'DELIVERED', 4, FA + 1000, db);
  for (const s of [0, 1, 2]) result(s, 2, 'DELIVERED', 3, FA + 1000, db);
  const standings = [{ state: 'FINAL', rerunResult: { outcome: 'DELIVERED', score: 5 } }, { state: 'PROVISIONALLY_FINAL', why: 'no FINAL formed' }, { state: 'SUSPENDED', why: 'an objection' }, { state: null, holdsRound: true, why: 'no quorum' }];
  const ent = (i) => ({ entryId: eid(i), entry: { playerPubkey: player(i), stakeMsat: 100000n, feeMsat: 4000n, donationMsat: 0n, feePreimage: new Uint8Array(32) } });
  const round = { entriesOf: () => [0, 1, 2, 3].map(ent), stakeSeen: () => true, entryVoid: () => null, noQuorum: () => null, firstMarkHeld: () => true };
  const ls = new LockSettlement(round, { finalityOf: (_r, _rid, entryId) => standings[[0, 1, 2, 3].find((i) => toHex(eid(i)) === toHex(entryId))] });
  // the claim: refused while any entry has no FINAL
  const claim = ls.entriesOnRecord(rid, {});
  assert.equal(claim.ok, false);
  // the fallback: every entry on record, those with no FINAL as VOID marked noFinal
  const fb = ls.entriesOnRecord(rid, {}, { fallback: true });
  assert.equal(fb.ok, true, fb.why);
  assert.deepEqual(fb.entries.map((e) => [e.outcome, !!e.noFinal]), [['DELIVERED', false], ['VOID', true], ['VOID', true], ['VOID', true]]);
  const got = fallbackInputs({ db, roundIdBytes: rid, contract: { nodes: seats.map((s) => s.pub) }, entries: fb.entries, finalAfterMs: FA });
  assert.deepEqual(got.entries.map((e) => [e.outcome, e.score, e.by]), [['DELIVERED', 5, 'final'], ['DELIVERED', 4, 'four signatures'], ['VOID', 0, 'as written'], ['VOID', 0, 'as written']]);
  // a FINAL kept in the store for an entry the seat does not stand FINAL is not taken as its FINAL
  db.prepare('INSERT INTO entry_finals VALUES (?, ?, ?, ?, 0, ?)').run(Buffer.from(rid), Buffer.from(eid(2)), 'run', FA, FA);
  const again = fallbackInputs({ db, roundIdBytes: rid, contract: { nodes: seats.map((s) => s.pub) }, entries: fb.entries, finalAfterMs: FA });
  assert.equal(again.entries[2].by, 'as written');
});
