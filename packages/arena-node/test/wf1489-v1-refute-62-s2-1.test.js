// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute of #1472 (hexbox #005), reload path: a file kept before b6e80974b has the seed the old rule missed in its happened/expected
// COLUMNS (e.g. "1 abandon 2 ability ...", numbers without punctuation - the rule then took only "1." "2)" "3:"). Opening the file now scrubs only the
// stored event; the columns keep the raw seed and report(), list(), csv() and "My feedback" serve it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openFeedbackStore } from '../src/feedback-store.js';

const W = 'abandon ability able about above absent absorb abstract absurd abuse access accident'.split(' ');
test('#1472 refute: a file from before loses the raw seed of its happened/expected columns when opened', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'wf1489-62-s2-1-')), 'fb.sqlite');
  openFeedbackStore(path).close();
  const old = `My wallet showed nothing. Seed: ${W.map((w, i) => `${i + 1} ${w}`).join(' ')}`;
  const raw = { id: 'a'.repeat(64), pubkey: 'b'.repeat(64), sig: 'c'.repeat(128), kind: 27842, created_at: 1, tags: [['t', 'bug']],
    content: JSON.stringify({ happened: old, expected: old }) };
  const db = new DatabaseSync(path);
  db.prepare(`INSERT INTO reports (id, pubkey, type, signed_at, received_ms, happened, expected, event, number) VALUES (?, ?, 'bug', 1, 1, ?, ?, ?, 1)`).run(raw.id, raw.pubkey, old, old, JSON.stringify(raw));
  db.close();
  const s = openFeedbackStore(path);
  const r = s.report(raw.id);
  const csv = s.csv();
  s.close();
  assert.equal(r.happened.includes('abandon'), false, r.happened);
  assert.equal(r.expected.includes('abandon'), false, r.expected);
  assert.equal(String(csv).includes('abandon'), false, 'csv export still holds the seed');
});
