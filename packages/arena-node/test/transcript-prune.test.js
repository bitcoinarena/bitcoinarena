// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// TRANSCRIPTS LEAVE WITH THEIR CLAIM WINDOW (§342026-10-17: "Transcripts are deleted when the claim window ends,
// as §34 reads - not kept longer"): kept through W and the contract's claim_window_days, deleted after; a contract naming no claim
// window keeps them; the round, its entries and receipts stay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import { transcriptKeptUntil, pruneTranscripts, DAY_MS } from '../src/transcript-prune.js';

const W = 600000;
const live = { entryCloseMs: 1792298115000n, objectionWindowMs: BigInt(W), rules: { claimWindowDays: 1 } };   // a live 10-18 contract's

test('a transcript is kept until max(entry close, close here) + W + claim_window_days; no claim window named - kept', () => {
  assert.equal(transcriptKeptUntil(live), 1792298115000 + W + DAY_MS);
  assert.equal(transcriptKeptUntil(live, 1792298115000 + 90000), 1792298115000 + 90000 + W + DAY_MS, 'closed later here: from then');
  assert.equal(transcriptKeptUntil({ ...live, rules: { claimWindowDays: 0 } }), 1792298115000 + W, 'a window of 0 days: W only');
  assert.equal(transcriptKeptUntil({ entryCloseMs: 1n, objectionWindowMs: BigInt(W) }), null, 'no rules block: no window to end');
});

test('the prune deletes only the rounds whose window ended, from ticks, batches and checkpoints; the rest stays', () => {
  const db = openStore(':memory:');
  const id = (n) => Buffer.alloc(32, n);
  const until = new Map([[id(1).toString('hex'), 1000], [id(2).toString('hex'), 5000], [id(3).toString('hex'), null]]);
  for (const n of [1, 2, 3]) {
    db.prepare('INSERT INTO rounds (round_id, contract, opened_ms) VALUES (?, ?, 0)').run(id(n), Buffer.from([n]));
    db.prepare('INSERT INTO entries (entry_id, round_id, contract, joined_ms) VALUES (?, ?, ?, 0)').run(id(10 + n), id(n), Buffer.from([n]));
    for (let t = 0; t < 3; t++) db.prepare('INSERT INTO ticks (round_id, entry_id, tick, words) VALUES (?, ?, ?, ?)').run(id(n), id(10 + n), t, Buffer.from([t]));
    db.prepare('INSERT INTO batches (round_id, entry_id, seq, batch_id, bytes) VALUES (?, ?, 0, ?, ?)').run(id(n), id(10 + n), id(20 + n), Buffer.from([1]));
    db.prepare('INSERT INTO checkpoints (round_id, entry_id, tick, checkpoint_id, bytes, received_ms) VALUES (?, ?, 0, ?, ?, 0)').run(id(n), id(10 + n), id(30 + n), Buffer.from([1]));
  }
  const keptUntil = (row) => until.get(Buffer.from(db.prepare('SELECT round_id FROM rounds WHERE contract = ?').get(row.contract).round_id).toString('hex'));
  const r = pruneTranscripts({ db, nowMs: 2000, keptUntil });
  assert.deepEqual([r.pruned, r.kept, r.rows], [[id(1).toString('hex')], 2, 5], 'round 1 only: 3 ticks + 1 batch + 1 checkpoint');
  const n = (t, k) => db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE round_id = ?`).get(id(k)).c;
  assert.deepEqual([n('ticks', 1), n('batches', 1), n('checkpoints', 1)], [0, 0, 0]);
  assert.deepEqual([n('ticks', 2), n('ticks', 3)], [3, 3], 'round 2 (window open) and round 3 (no window) keep theirs');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM rounds').get().c, 3, 'the rounds stay');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM entries').get().c, 3, 'and their entries');
  const later = pruneTranscripts({ db, nowMs: 6000, keptUntil });
  assert.deepEqual([later.pruned, later.kept], [[id(2).toString('hex')], 1], 'round 2 once its window ends; round 3 never');
});

// ROUNDS NOBODY USED LEAVE TOO ("make it lean"; a copy of second-host seat 2: 154,244 of 206,582 rounds unused and past their
// windows, 675 -> 199 MB): an unused round past its end + W + claim window goes with its committee and seating rows; a used one -
// any row in a table outside that set, an entry or an equivocation proof alike - and a future one stay; passes go in batches.
test('unused rounds past their time go with every committee and seating row; used and future rounds stay; batches resume', async () => {
  const { pruneUnusedRounds, unusedRoundGoesAt, usedMarkerTables, COMMITTEE_TABLES } = await import('../src/transcript-prune.js');
  assert.equal(unusedRoundGoesAt({ objectionWindowMs: 600000n, rules: { claimWindowDays: 1 } }, 1000), 1000 + 600000 + DAY_MS);
  assert.equal(unusedRoundGoesAt({ objectionWindowMs: 600000n }, 1000), 1000 + 600000 + DAY_MS, 'no claim window named: a day');
  const db = openStore(':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS seat_presents (round_id BLOB, role TEXT, node TEXT, bytes BLOB);
    CREATE TABLE IF NOT EXISTS seat_sigs (round_id BLOB, role TEXT, seating TEXT, node TEXT, signature BLOB);
    CREATE TABLE IF NOT EXISTS seat_certs (round_id BLOB, role TEXT, cert BLOB);
    CREATE TABLE IF NOT EXISTS seat_signed (round_id BLOB, role TEXT, seated TEXT, signature BLOB);
    CREATE TABLE IF NOT EXISTS seat_equivocations (round_id BLOB, role TEXT, a BLOB, b BLOB);
    CREATE TABLE IF NOT EXISTS seat_seatings (round_id BLOB, role TEXT, seating TEXT, seated TEXT);
    CREATE TABLE IF NOT EXISTS seat_withheld (round_id BLOB, role TEXT, node TEXT);`);
  assert.ok(!usedMarkerTables(db).some((t) => COMMITTEE_TABLES.includes(t)), 'the committee set never marks a round used');
  assert.ok(usedMarkerTables(db).includes('entries') && usedMarkerTables(db).includes('seat_equivocations'));
  const id = (n) => Buffer.alloc(32, n);
  const goes = new Map();   // contract byte -> time
  const add = (n, at) => {
    goes.set(n, at);
    db.prepare('INSERT INTO rounds (round_id, contract, opened_ms) VALUES (?, ?, 0)').run(id(n), Buffer.from([n]));
    db.prepare('INSERT INTO signer_nodes (round_id, pubkey) VALUES (?, ?)').run(id(n), id(100 + n));
    db.prepare('INSERT INTO round_beacons (round_id, hash, height, time_ms) VALUES (?, ?, 1, 0)').run(id(n), id(200));
    for (const t of ['seat_presents', 'seat_sigs', 'seat_certs', 'seat_signed']) db.prepare(`INSERT INTO ${t} (round_id) VALUES (?)`).run(id(n));
  };
  add(1, 1000);                      // unused, past: goes
  add(2, 1000);                      // used: an entry
  db.prepare('INSERT INTO entries (entry_id, round_id, contract, joined_ms) VALUES (?, ?, ?, 0)').run(id(50), id(2), Buffer.from([2]));
  add(3, 1000);                      // used: an equivocation proof
  db.prepare('INSERT INTO seat_equivocations (round_id, role) VALUES (?, ?)').run(id(3), 'settlement');
  add(4, 9000);                      // unused, its time not come
  add(5, 1000);                      // unused, past: goes
  const goesAt = (row) => goes.get(Buffer.from(row.contract)[0]);
  const forgot = [];
  const p1 = pruneUnusedRounds({ db, nowMs: 2000, batch: 3, goesAt, onDeleted: (rid) => forgot.push(Buffer.from(rid)[0]) });
  assert.deepEqual([p1.deleted, p1.looked, p1.done], [1, 3, false], 'the first batch of 3: round 1 only');
  assert.equal(p1.rows, 1 + 1 + 4 + 1, 'its signer node, beacon, four seating rows and the round');
  const p2 = pruneUnusedRounds({ db, nowMs: 2000, batch: 3, afterRowid: p1.lastRowid, goesAt, onDeleted: (rid) => forgot.push(Buffer.from(rid)[0]) });
  assert.deepEqual([p2.deleted, p2.looked, p2.done], [1, 2, true], 'then round 5; the table is done');
  assert.deepEqual(forgot, [1, 5], 'each deleted round handed on (the seating agent forgets its certificates)');
  const has = (t, n) => db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE round_id = ?`).get(id(n)).c;
  for (const t of [...COMMITTEE_TABLES]) { assert.equal(has(t, 1), 0, `${t} of round 1`); assert.equal(has(t, 5), 0, `${t} of round 5`); }
  for (const n of [2, 3, 4]) { assert.equal(has('rounds', n), 1, `round ${n} stays`); assert.equal(has('signer_nodes', n), 1); assert.equal(has('seat_certs', n), 1); }
  assert.equal(has('entries', 2), 1, 'the entry untouched');
});

test('a contract this seat cannot read goes a week after it was stored, unless something marks it used', async () => {
  const { pruneUnusedRounds, UNREADABLE_KEEP_MS } = await import('../src/transcript-prune.js');
  const db = openStore(':memory:');
  const id = (n) => Buffer.alloc(32, n);
  const now = 100 * DAY_MS;
  for (const [n, opened] of [[1, now - UNREADABLE_KEEP_MS - 1], [2, now - DAY_MS], [3, now - UNREADABLE_KEEP_MS - 1]])
    db.prepare('INSERT INTO rounds (round_id, contract, opened_ms) VALUES (?, ?, ?)').run(id(n), Buffer.from([0x5e, n]), opened);
  db.prepare('INSERT INTO entries (entry_id, round_id, contract, joined_ms) VALUES (?, ?, ?, 0)').run(id(50), id(3), Buffer.from([3]));
  const r = pruneUnusedRounds({ db, nowMs: now });
  assert.deepEqual([r.deleted, r.looked, r.done], [1, 3, true], 'round 1 (unreadable, stored over a week ago) only');
  const left = db.prepare('SELECT round_id FROM rounds ORDER BY rowid').all().map((x) => Buffer.from(x.round_id)[0]);
  assert.deepEqual(left, [2, 3], 'round 2 (stored a day ago) and round 3 (entered) stay');
});
