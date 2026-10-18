// TRANSCRIPTS LEAVE WITH THEIR CLAIM WINDOW (§34, kanban #33; the owner 2026-10-17: "Transcripts are deleted when the claim window ends,
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
