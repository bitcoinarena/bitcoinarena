// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute of #1472 (hexbox #005), reload path on disk: a file from before is "scrubbed in place when opened", but SQLite rewrites the row
// without secure_delete, so the raw seed of the old event stays in the file's freed bytes (and in a WAL frame) - readable with strings(1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openFeedbackStore } from '../src/feedback-store.js';

const SEED = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
test('#1472 refute: after the in-place scrub no byte of the database files holds the raw seed', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'wf1489-62-s2-4-')), 'fb.sqlite');
  openFeedbackStore(path).close();
  const raw = { id: 'a'.repeat(64), pubkey: 'b'.repeat(64), sig: 'c'.repeat(128), kind: 27842, created_at: 1, tags: [['t', 'bug']],
    content: JSON.stringify({ happened: 'x', expected: 'y', debug: `state ${'z'.repeat(6000)} seed ${SEED}` }) };
  const db = new DatabaseSync(path);
  db.prepare(`INSERT INTO reports (id, pubkey, type, signed_at, received_ms, happened, expected, event, number) VALUES (?, ?, 'bug', 1, 1, 'x', 'y', ?, 1)`).run(raw.id, raw.pubkey, JSON.stringify(raw));
  db.close();
  openFeedbackStore(path).close();
  const files = [path, `${path}-wal`].filter((f) => existsSync(f));
  for (const f of files) assert.equal(readFileSync(f).includes(Buffer.from(SEED)), false, `${f} still holds the raw seed`);
});
