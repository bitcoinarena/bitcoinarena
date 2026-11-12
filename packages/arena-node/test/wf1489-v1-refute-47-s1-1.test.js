// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute of #1532: the relay cap is ONE pool for everybody. A stranger who holds one entry (its own, in any round
// this seat holds) sends many DIFFERENT decodable transcripts of that entry (random signed-checkpoint-sized marks: decodeTranscript
// does not check them) until `relayed` reaches RELAY_MOST. From then on every honest relay - another player's real transcript, a
// slash proof - gets 507 until the attacker's round passes its claim window (never, for a contract with no claim window).
// Safe behaviour: what one entry (one party) can park is bounded far below the pool, so honest transcripts are still kept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

process.env.ARENA_RELAY_MOST = String(4 * 1024 * 1024);   // a small pool so the test is quick; the live 256 MiB fills the same way
const { serve } = await import('../src/server.js');
const { openStore } = await import('../src/store.js');
const { transcriptBytesHash } = await import('../../arena-protocol/src/posting.js');
const { encodeTranscript } = await import('../../arena-protocol/src/transcript.js');
const { SIGNED_CHECKPOINT_BYTES } = await import('../../arena-protocol/src/checkpoint.js');
const { toHex } = await import('../../arena-protocol/src/hash.js');

test('one held entry fills the shared relay pool; an honest transcript of another entry is then refused', async () => {
  const db = openStore(':memory:');
  const r = (n) => new Uint8Array(randomBytes(n));
  const rid = r(32), attackerEntry = r(32), honestEntry = r(32);
  db.prepare('INSERT INTO rounds (round_id, contract, opened_ms) VALUES (?, ?, 0)').run(rid, r(8));
  for (const e of [attackerEntry, honestEntry]) db.prepare('INSERT INTO entries (entry_id, round_id, contract, joined_ms) VALUES (?, ?, ?, 0)').run(e, rid, r(8));
  const seat = await serve(db, { port: 0 });
  const put = async (bytes) => { const x = await fetch(`http://127.0.0.1:${seat.port}/transcript/${toHex(transcriptBytesHash(bytes))}`, { method: 'PUT', body: bytes }); await x.text(); return x.status; };
  try {
    const marks = Math.floor((512 * 1024) / SIGNED_CHECKPOINT_BYTES);
    let kept = 0, status = 201;
    for (let i = 0; i < 64 && status === 201; i++) {
      status = await put(encodeTranscript({ roundId: rid, entryId: attackerEntry, batches: [], marks: Array.from({ length: marks }, () => r(SIGNED_CHECKPOINT_BYTES)) }));
      if (status === 201) kept++;
    }
    // and tops the pool up to the byte with smaller ones (halving the marks until one mark no longer fits)
    for (let m = marks; m >= 1; m = Math.floor(m / 2)) {
      while (await put(encodeTranscript({ roundId: rid, entryId: attackerEntry, batches: [], marks: Array.from({ length: m }, () => r(SIGNED_CHECKPOINT_BYTES)) })) === 201) kept++;
    }
    console.log(`attacker transcripts of ONE entry kept: ${kept}, pool ${db.prepare('SELECT SUM(LENGTH(bytes)) AS n FROM relayed').get().n} of ${process.env.ARENA_RELAY_MOST} bytes`);
    // an honest run's transcript: a few signed marks (here 4 random ones - the door does not check them either)
    const honest = encodeTranscript({ roundId: rid, entryId: honestEntry, batches: [], marks: Array.from({ length: 4 }, () => r(SIGNED_CHECKPOINT_BYTES)) });
    const got = await put(honest);
    console.log(`honest transcript of another entry: ${got}`);
    assert.equal(got, 201, `an honest transcript was refused with ${got} after one entry's junk filled the shared pool`);
  } finally { await seat.close(); }
});
