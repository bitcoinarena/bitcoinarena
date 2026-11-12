// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute of #1532: the relay prune never runs for a round whose contract names no claim window (no rules block - the duty
// poster's DUTY_TEMPLATE and every contract without `rules`). transcriptKeptUntil answers null there, pruneRelayed skips the row, so junk
// transcripts of an entry in such a round stay in `relayed` for ever - and with them the shared RELAY_MOST pool stays full (see -1):
// one entry in one such round shuts the seat's relay door for every honest transcript and slash proof, permanently.
// Safe behaviour: a relayed copy is not kept for ever; what the door took for such a round leaves at some bound.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openStore } from '../src/store.js';
import { pruneRelayed, DAY_MS } from '../src/transcript-prune.js';
import { encodeTranscript } from '../../arena-protocol/src/transcript.js';
import { SIGNED_CHECKPOINT_BYTES } from '../../arena-protocol/src/checkpoint.js';
import { encodeRoundContract, decodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { contractFor } from './window-fixture.js';

test('relayed junk of an entry in a round with no claim window is never pruned', async () => {
  const db = openStore(':memory:');
  const r = (n) => new Uint8Array(randomBytes(n));
  const bytes = encodeRoundContract(contractFor([r(32), r(32)]));
  const c = decodeRoundContract(bytes);
  assert.equal(c.rules ?? null, null, 'the round names no rules block (as the duty template)');
  const rid = roundId(c), eid = r(32);
  db.prepare('INSERT INTO rounds (round_id, contract, opened_ms, closed_ms) VALUES (?, ?, 0, 0)').run(rid, bytes);
  db.prepare('INSERT INTO entries (entry_id, round_id, contract, joined_ms) VALUES (?, ?, ?, 0)').run(eid, rid, r(8));
  const put = db.prepare('INSERT INTO relayed (hash, bytes, seen_ms) VALUES (?, ?, 0)');
  for (let i = 0; i < 5; i++) put.run(r(32), encodeTranscript({ roundId: rid, entryId: eid, batches: [], marks: [r(SIGNED_CHECKPOINT_BYTES)] }));
  put.run(r(32), Uint8Array.of(...eid, 0xff));
  const tenYears = Number(c.entryCloseMs) + 3650 * DAY_MS;
  const p = pruneRelayed({ db, nowMs: tenYears });
  const left = db.prepare('SELECT COUNT(*) AS n FROM relayed').get().n;
  console.log(`ten years after entry close: deleted ${p.deleted}, left ${left}`);
  assert.equal(left, 0, `${left} relayed copies of a round with no claim window are kept for ever`);
});
