// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1413 (Daniel 2026-11-10: "Gib jedem feedback eine unique number also Feedback #001 etc wie eine Ticket Number die überall angezeigt wird"):
// every report its number, in the order they came, kept over a reopen; a file from before is numbered once; a duplicate can be named by number.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openFeedbackStore, FEEDBACK_KIND, STATES, feedbackLabel } from '../src/feedback-store.js';
import { eventId } from '../src/nostr-relay.js';

const hex = (b) => Buffer.from(b).toString('hex');
const key = (n) => { const secret = new Uint8Array(32).fill(n); return { secret, pubkey: hex(schnorr.getPublicKey(secret)) }; };
const report = (k, text) => { const e = { pubkey: k.pubkey, created_at: Math.floor(Date.now() / 1000), kind: FEEDBACK_KIND, tags: [['t', 'bug']],
  content: JSON.stringify({ happened: `${text} Steps: opened the lobby, joined a round, watched the screen.`, expected: 'it to work' }) };
  e.id = eventId(e); e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), k.secret)); return e; };

test('#1413 reports are numbered 1, 2, 3 in the order they came; a second post of one keeps its number; the numbers survive a reopen', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'fb1413-')), 'fb.db');
  const s = openFeedbackStore(file);
  const a = s.take(report(key(1), 'first report')), b = s.take(report(key(2), 'second report')), again = s.take(report(key(1), 'first report'));
  const c = s.take(report(key(3), 'third report'));
  console.log(`  MEASURED #1413: ${[a, b, again, c].map((x) => `${x.label}${x.kept ? '' : ' (again)'}`).join(', ')}`);
  assert.deepEqual([a.number, b.number, c.number], [1, 2, 3]);
  assert.equal(again.kept, false); assert.equal(again.label, 'Feedback #001');
  const reopened = openFeedbackStore(file);
  assert.deepEqual(reopened.list({}).map((r) => r.label).sort(), ['Feedback #001', 'Feedback #002', 'Feedback #003']);
  assert.equal(reopened.take(report(key(4), 'fourth report')).label, 'Feedback #004');
  assert.match(reopened.csv().split('\n')[1], /^"Feedback #00\d"/);
  assert.equal(feedbackLabel(1234), 'Feedback #1234');
});

test('#1413 a file from before (no numbers) is numbered once, oldest first; a duplicate is named by its number', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'fb1413-')), 'fb.db');
  const s = openFeedbackStore(file);
  const first = s.take(report(key(5), 'older report')); const later = s.take(report(key(6), 'newer report'));
  { const db = new DatabaseSync(file); db.exec('DROP INDEX reports_by_number; UPDATE reports SET number = NULL'); db.close(); }
  const r = openFeedbackStore(file);
  const nums = Object.fromEntries(r.list({}).map((x) => [x.id, x.number]));
  assert.deepEqual([nums[first.id], nums[later.id]], [1, 2]);
  const d = r.move(later.id, STATES.DUPLICATE, { duplicateOf: '#1', by: 'admin' });
  assert.equal(d.ok, true, d.why); assert.equal(d.report.duplicateOf, first.id);
});
