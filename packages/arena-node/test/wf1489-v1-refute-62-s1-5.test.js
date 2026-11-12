// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1737, #1799, #1843, #1858 (refute of #1472): colons between the words hide nothing, a label before the seed stays, ordinary text stays,
// the log masker finds the same runs, and a file kept before the fix loses the raw seed of its stored events when opened.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { scrubKeys, openFeedbackStore } from '../src/feedback-store.js';
import { redact } from '../src/log-level.js';

const W = 'abandon ability able about above absent absorb abstract absurd abuse access accident'.split(' ');
test('colons, mixed separators and capitals hide nothing; a labelled seed keeps its label; 11 words and a sentence stay', () => {
  assert.equal(scrubKeys(`x ${W.join(': ')} y`), 'x [removed] y');
  assert.equal(scrubKeys(`seed: ${W.map((w, i) => (i % 2 ? w.toUpperCase().slice(0, 4) : w)).join(' / ')}`), 'seed: [removed]');
  assert.equal(scrubKeys(`words 1: ${W.map((w, i) => `${w} ${i + 2}:`).join(' ')}`).includes('abandon'), false);
  const sentence = 'The withdraw button did nothing when I clicked it twice after the round closed again today, about absent access.';
  assert.equal(scrubKeys(sentence), sentence);
  assert.equal(scrubKeys(W.slice(0, 11).join(', ')), W.slice(0, 11).join(', '));
  assert.equal(redact(`k ${W.map((w) => w.slice(0, 4)).join('_')}`), 'k ***(seed words)');
});
test('a report kept before the fix has its stored event scrubbed when the file is opened', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'wf1489-62-s1-')), 'fb.sqlite');
  openFeedbackStore(path).close();
  const raw = { id: 'a'.repeat(64), pubkey: 'b'.repeat(64), sig: 'c'.repeat(128), kind: 27842, created_at: 1, tags: [['t', 'bug'], ['note', W.join(' ')]],
    content: JSON.stringify({ happened: 'x', expected: 'y', debug: `seed ${W.join(' ')}`, lnAddress: 'a@b.cd' }) };
  const db = new DatabaseSync(path);
  db.prepare(`INSERT INTO reports (id, pubkey, type, signed_at, received_ms, happened, expected, event, number) VALUES (?, ?, 'bug', 1, 1, 'x', 'y', ?, 1)`).run(raw.id, raw.pubkey, JSON.stringify(raw));
  db.close();
  openFeedbackStore(path).close();
  const db2 = new DatabaseSync(path);
  const ev = db2.prepare('SELECT event FROM reports WHERE id = ?').get(raw.id).event;
  db2.close();
  assert.equal(ev.includes('abandon'), false, ev);
  const kept = JSON.parse(ev);
  assert.equal(kept.sig, raw.sig);
  assert.equal(JSON.parse(kept.content).lnAddress, 'a@b.cd');
});
