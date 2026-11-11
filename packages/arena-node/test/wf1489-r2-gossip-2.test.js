// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 round 2 (gossip): PUT /transcript/<hash> KEEPS ANY BYTES FROM ANYONE, FOR EVER. The door checks only that the bytes hash to
// the name in the path, so a stranger with no round, no key and no stake sends random bytes up to the body limit (8 MiB) under their own
// hash, as often as it likes; every one goes into the `relayed` table (INSERT OR IGNORE, nothing ever deletes it). The seat's disk fills.
// Safe behaviour: bytes that are no transcript of a run this seat knows are refused, or what a stranger can put there is bounded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { serve } from '../src/server.js';
import { openStore } from '../src/store.js';
import { transcriptBytesHash } from '../../arena-protocol/src/posting.js';
import { toHex } from '../../arena-protocol/src/hash.js';

test('a stranger cannot store 48 MiB of random bytes as "transcripts" of no round', async () => {
  const db = openStore(':memory:');
  const seat = await serve(db, { port: 0 });
  try {
    let kept = 0;
    for (let i = 0; i < 48; i++) {
      const bytes = new Uint8Array(randomBytes(1024 * 1024));
      const r = await fetch(`http://127.0.0.1:${seat.port}/transcript/${toHex(transcriptBytesHash(bytes))}`, { method: 'PUT', body: bytes });
      await r.text();
      if (r.status === 201) kept++;
    }
    console.log(`random 1 MiB blobs naming no round, kept: ${kept} of 48`);
    assert.ok(kept < 48, `the seat kept ${kept} MiB of random bytes from a stranger`);
  } finally { await seat.close(); }
});

// kanban #1532: what the relay door kept leaves with its round's claim window, as the round's own transcript does
test('relayed transcripts of a round past its claim window are deleted; others and slash proofs stay', async () => {
  const { pruneRelayed } = await import('../src/transcript-prune.js');
  const { encodeTranscript } = await import('../../arena-protocol/src/transcript.js');
  const db = openStore(':memory:');
  const r = (n) => new Uint8Array(randomBytes(n));
  const oldR = r(32), newR = r(32), e1 = r(32), e2 = r(32), e3 = r(32);
  db.prepare('INSERT INTO rounds (round_id, contract, opened_ms) VALUES (?, ?, 0)').run(oldR, Uint8Array.of(1));
  db.prepare('INSERT INTO rounds (round_id, contract, opened_ms) VALUES (?, ?, 0)').run(newR, Uint8Array.of(2));
  for (const [e, rid] of [[e1, oldR], [e2, newR], [e3, oldR]]) db.prepare('INSERT INTO entries (entry_id, round_id, contract, joined_ms) VALUES (?, ?, ?, 0)').run(e, rid, Uint8Array.of(0));
  const put = db.prepare('INSERT INTO relayed (hash, bytes, seen_ms) VALUES (?, ?, 0)');
  put.run(r(32), encodeTranscript({ roundId: oldR, entryId: e1, batches: [], marks: [] }));
  put.run(r(32), encodeTranscript({ roundId: newR, entryId: e2, batches: [], marks: [] }));
  put.run(r(32), Uint8Array.of(...e3, 0xff));                       // a reveal record of the old round's entry
  put.run(r(32), r(200));                                            // something else (a slash proof)
  const p = pruneRelayed({ db, nowMs: 1000, keptUntil: (row) => (row.contract[0] === 1 ? 500 : 5000) });
  assert.equal(p.deleted, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM relayed').get().n, 2);
});
